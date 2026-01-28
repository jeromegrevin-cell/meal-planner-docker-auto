#!/usr/bin/env python3
import argparse
import os
import re
import sys
from pathlib import Path

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build


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


def find_folder_id(drive, name: str) -> str:
    resp = drive.files().list(
        q=f"name = '{name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields="files(id, name)",
        pageSize=10,
    ).execute()
    files = resp.get("files", [])
    return files[0]["id"] if files else ""


def list_docs_in_folder(drive, folder_id: str):
    docs = []
    page_token = None
    while True:
        resp = drive.files().list(
            q=(
                f"'{folder_id}' in parents and "
                "mimeType = 'application/vnd.google-apps.document' and trashed = false"
            ),
            fields="nextPageToken, files(id, name)",
            pageSize=1000,
            pageToken=page_token,
        ).execute()
        docs.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return docs


def get_doc_text(docs_service, doc_id: str) -> str:
    doc = docs_service.documents().get(documentId=doc_id).execute()
    parts = []
    for el in doc.get("body", {}).get("content", []):
        par = el.get("paragraph")
        if not par:
            continue
        for r in par.get("elements", []):
            t = r.get("textRun", {}).get("content")
            if t:
                parts.append(t)
    return "".join(parts)


def extract_ingredients(text: str):
    lines = [l.strip() for l in text.splitlines()]
    ingredients = []
    capture = False
    for line in lines:
        l = line.strip()
        if not l:
            if capture:
                continue
            continue
        low = l.lower()
        if "ingr" in low and "ingr" == low[:4]:
            capture = True
            continue
        if capture:
            if low.startswith("etape") or low.startswith("préparation") or low.startswith("preparation"):
                break
            if low.startswith("steps") or low.startswith("method"):
                break
            if l.startswith("-") or l.startswith("•") or re.match(r"^\d", l):
                ingredients.append(l.lstrip("-•").strip())
            else:
                if len(l) <= 80:
                    ingredients.append(l)
    seen = set()
    out = []
    for i in ingredients:
        key = re.sub(r"\s+", " ", i.lower()).strip()
        if key and key not in seen:
            out.append(i)
            seen.add(key)
    return out


def extract_steps(text: str):
    lines = [l.strip() for l in text.splitlines()]
    steps = []
    capture = False
    for line in lines:
        l = line.strip()
        if not l:
            if capture:
                continue
            continue
        low = l.lower()
        if low.startswith("etape") or low.startswith("préparation") or low.startswith("preparation"):
            capture = True
            continue
        if low.startswith("steps") or low.startswith("method"):
            capture = True
            continue
        if capture:
            if l.startswith("-") or l.startswith("•") or re.match(r"^\d", l):
                steps.append(l.lstrip("-•").strip())
            else:
                if len(l) <= 140:
                    steps.append(l)
    seen = set()
    out = []
    for s in steps:
        key = re.sub(r"\s+", " ", s.lower()).strip()
        if key and key not in seen:
            out.append(s)
            seen.add(key)
    return out


def insert_sections(docs_service, doc_id: str, ingredients, steps):
    blocks = []
    if ingredients:
        blocks.append("Ingrédients")
        blocks.extend([f"- {i}" for i in ingredients])
        blocks.append("")
    if steps:
        blocks.append("Étapes")
        blocks.extend([f"{i+1}. {s}" for i, s in enumerate(steps)])
        blocks.append("")
    if not blocks:
        return False
    insert_text = "\n".join(blocks) + "\n"
    docs_service.documents().batchUpdate(
        documentId=doc_id,
        body={"requests": [{"insertText": {"location": {"index": 1}, "text": insert_text}}]},
    ).execute()
    return True


def main():
    parser = argparse.ArgumentParser(description="Auto-fix missing ingredients+steps in Google Docs")
    parser.add_argument("--folder", default="TO_FIX_missing_both", help="Drive folder to fix")
    parser.add_argument("--limit", type=int, default=0, help="Max docs to process (0=all)")
    args = parser.parse_args()

    drive = get_drive_client()
    docs_service = build("docs", "v1", credentials=drive._http.credentials)

    folder_id = find_folder_id(drive, args.folder)
    if not folder_id:
        raise SystemExit(f"Folder not found: {args.folder}")

    docs = list_docs_in_folder(drive, folder_id)
    if args.limit and args.limit > 0:
        docs = docs[: args.limit]

    fixed = 0
    skipped = 0
    for d in docs:
        text = get_doc_text(docs_service, d["id"])
        ingredients = extract_ingredients(text)
        steps = extract_steps(text)
        ok = insert_sections(docs_service, d["id"], ingredients, steps)
        if ok:
            fixed += 1
        else:
            skipped += 1
    print({"fixed": fixed, "skipped": skipped, "total": len(docs)})


if __name__ == "__main__":
    sys.exit(main())
