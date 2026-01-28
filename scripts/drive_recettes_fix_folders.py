#!/usr/bin/env python3
import argparse
import json
import os
import re
from pathlib import Path

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from google_auth_oauthlib.flow import InstalledAppFlow


def resolve_oauth_token_file() -> str:
    secrets_dir = os.environ.get("MEAL_PLANNER_SECRETS_DIR", "").strip()
    if secrets_dir:
        return str(Path(secrets_dir) / "drive_oauth_token.json")
    return str(Path.home() / "meal-planner-secrets" / "drive_oauth_token.json")


def resolve_oauth_client_file() -> str:
    env_path = os.environ.get("DRIVE_OAUTH_CLIENT", "").strip()
    secrets_dir = os.environ.get("MEAL_PLANNER_SECRETS_DIR", "").strip()
    candidates = []
    if env_path:
        candidates.append(Path(env_path))
    if secrets_dir:
        candidates.append(Path(secrets_dir) / "drive_oauth_client.json")
    candidates.append(Path.home() / "meal-planner-secrets" / "drive_oauth_client.json")
    for p in candidates:
        if p and p.exists():
            return str(p)
    return ""


def get_drive_client():
    token_path = resolve_oauth_token_file()
    scopes = ["https://www.googleapis.com/auth/drive.file"]
    creds = None
    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, scopes=scopes)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            oauth_client = resolve_oauth_client_file()
            if not oauth_client:
                raise SystemExit("Missing OAuth client (drive_oauth_client.json).")
            flow = InstalledAppFlow.from_client_secrets_file(oauth_client, scopes=scopes)
            creds = flow.run_local_server(port=0, prompt="consent")
        Path(token_path).write_text(creds.to_json(), encoding="utf-8")
    return build("drive", "v3", credentials=creds)


def normalize_name(name: str) -> str:
    base = re.sub(r"\.pdf$", "", name.strip(), flags=re.IGNORECASE)
    base = re.sub(r"\s+", " ", base).strip()
    return base


def find_folder_id(drive, name: str) -> str:
    resp = drive.files().list(
        q=f"name = '{name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields="files(id, name)",
        pageSize=10,
    ).execute()
    files = resp.get("files", [])
    return files[0]["id"] if files else ""


def ensure_subfolder(drive, parent_id: str, name: str) -> str:
    resp = drive.files().list(
        q=(
            f"'{parent_id}' in parents and name = '{name}' "
            "and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
        ),
        fields="files(id, name)",
        pageSize=10,
    ).execute()
    files = resp.get("files", [])
    if files:
        return files[0]["id"]
    created = drive.files().create(
        body={
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id],
        },
        fields="id",
    ).execute()
    return created["id"]


def list_docs_in_folder(drive, folder_id: str):
    docs = {}
    page_token = None
    while True:
        resp = drive.files().list(
            q=(
                f"'{folder_id}' in parents and "
                "mimeType = 'application/vnd.google-apps.document' and trashed = false"
            ),
            fields="nextPageToken, files(id, name, webViewLink, parents)",
            pageSize=1000,
            pageToken=page_token,
        ).execute()
        for f in resp.get("files", []):
            docs[normalize_name(f["name"]).lower()] = f
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return docs


def add_parent(drive, file_id: str, parent_id: str):
    drive.files().update(
        fileId=file_id,
        addParents=parent_id,
        fields="id, parents",
    ).execute()


def main():
    parser = argparse.ArgumentParser(description="Tag missing recipes directly in Drive/Recettes")
    parser.add_argument(
        "--index",
        default="/Users/Jerome/meal-planner-docker-auto/recettes_index.json",
        help="Path to recettes_index.json",
    )
    parser.add_argument(
        "--folder",
        default="Recettes",
        help="Drive folder name containing Google Docs",
    )
    args = parser.parse_args()

    index_path = Path(args.index)
    if not index_path.exists():
        raise SystemExit(f"Index not found: {index_path}")

    idx = json.loads(index_path.read_text())

    drive = get_drive_client()
    folder_id = find_folder_id(drive, args.folder)
    if not folder_id:
        raise SystemExit(f"Drive folder not found: {args.folder}")

    docs = list_docs_in_folder(drive, folder_id)

    to_fix = {
        "missing_ingredients": [],
        "missing_steps": [],
        "missing_both": [],
    }

    for r in idx:
        has_ing = bool(r.get("ingredients"))
        has_steps = bool(r.get("steps"))
        if has_ing and has_steps:
            continue
        title = r.get("title") or ""
        key = normalize_name(title).lower()
        doc = docs.get(key)
        if not doc:
            continue
        if not has_ing and not has_steps:
            to_fix["missing_both"].append(doc)
        elif not has_ing:
            to_fix["missing_ingredients"].append(doc)
        else:
            to_fix["missing_steps"].append(doc)

    sub_ids = {
        "missing_ingredients": ensure_subfolder(drive, folder_id, "TO_FIX_missing_ingredients"),
        "missing_steps": ensure_subfolder(drive, folder_id, "TO_FIX_missing_steps"),
        "missing_both": ensure_subfolder(drive, folder_id, "TO_FIX_missing_both"),
    }

    for key, docs_list in to_fix.items():
        for doc in docs_list:
            add_parent(drive, doc["id"], sub_ids[key])

    print(
        json.dumps(
            {
                "ok": True,
                "missing_ingredients": len(to_fix["missing_ingredients"]),
                "missing_steps": len(to_fix["missing_steps"]),
                "missing_both": len(to_fix["missing_both"]),
            }
        )
    )


if __name__ == "__main__":
    main()
