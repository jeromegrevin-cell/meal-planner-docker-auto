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
            oauth_port = int(os.environ.get("DRIVE_OAUTH_PORT", "3002"))
            creds = flow.run_local_server(port=oauth_port, prompt="consent")
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
                # stop at first blank after ingredients section
                continue
            continue
        low = l.lower()
        if "ingr" in low and "ingr" == low[:4]:
            capture = True
            continue
        if capture:
            # stop when steps section starts
            if low.startswith("etape") or low.startswith("préparation") or low.startswith("preparation"):
                break
            if low.startswith("steps") or low.startswith("method"):
                break
            # accept list items
            if l.startswith("-") or l.startswith("•") or re.match(r"^\d", l):
                ingredients.append(l.lstrip("-•").strip())
            else:
                # heuristic: short line as ingredient
                if len(l) <= 80:
                    ingredients.append(l)
    # de-dupe
    seen = set()
    out = []
    for i in ingredients:
        key = re.sub(r"\s+", " ", i.lower()).strip()
        if key and key not in seen:
            out.append(i)
            seen.add(key)
    return out


def extract_ingredients_fallback(text: str):
    lines = [l.strip() for l in text.splitlines()]
    # find first steps header to bound ingredients block
    step_idx = None
    for i, line in enumerate(lines):
        low = line.lower().strip()
        if low.startswith("etape") or low.startswith("préparation") or low.startswith("preparation"):
            step_idx = i
            break
        if low.startswith("steps") or low.startswith("method"):
            step_idx = i
            break
    if step_idx is None:
        return []
    candidates = [l for l in lines[:step_idx] if l.strip()]
    if not candidates:
        return []
    # drop likely title line
    first = candidates[0]
    if (
        not re.search(r"\d", first)
        and not first.startswith(("-", "•"))
        and len(first) > 18
    ):
        candidates = candidates[1:]
    unit_rx = re.compile(
        r"(kg|g|gr|mg|ml|cl|l|c\. ?a|c\. ?à|cuill|tbsp|tsp|cup|pinc[ée]e|sachet|tranche|gousse|piece|pi[eè]ce)",
        re.IGNORECASE,
    )
    ingredients = []
    for l in candidates:
        if l.startswith(("-", "•")) or re.match(r"^\d", l) or unit_rx.search(l):
            ingredients.append(l.lstrip("-•").strip())
    # de-dupe
    seen = set()
    out = []
    for i in ingredients:
        key = re.sub(r"\s+", " ", i.lower()).strip()
        if key and key not in seen:
            out.append(i)
            seen.add(key)
    return out


def insert_ingredients_section(docs_service, doc_id: str, ingredients):
    if not ingredients:
        return False
    # Prepend a section at top
    header = "Ingrédients\\n"
    body = "\n".join([f"- {i}" for i in ingredients]) + "\n\n"
    insert_text = header + body
    docs_service.documents().batchUpdate(
        documentId=doc_id,
        body={"requests": [{"insertText": {"location": {"index": 1}, "text": insert_text}}]},
    ).execute()
    return True


def main():
    parser = argparse.ArgumentParser(description="Auto-fix missing ingredients in Google Docs")
    parser.add_argument(
        "--folder",
        default="TO_FIX_missing_ingredients",
        help="Drive folder with docs to fix",
    )
    parser.add_argument("--limit", type=int, default=0, help="Max docs to process (0=all)")
    args = parser.parse_args()

    drive = get_drive_client()
    docs_service = build("docs", "v1", credentials=drive._http.credentials)

    folder_id = find_folder_id(drive, args.folder)
    if not folder_id:
        raise SystemExit(f"Folder not found: {args.folder}")
    recettes_folder_id = find_folder_id(drive, "Recettes")

    docs = list_docs_in_folder(drive, folder_id)
    fixed = 0
    skipped = 0
    if args.limit and args.limit > 0:
        docs = docs[: args.limit]

    for d in docs:
        text = get_doc_text(docs_service, d["id"])
        ingredients = extract_ingredients(text)
        if not ingredients:
            ingredients = extract_ingredients_fallback(text)
        if not ingredients:
            skipped += 1
            continue
        ok = insert_ingredients_section(docs_service, d["id"], ingredients)
        if ok:
            fixed += 1
            if recettes_folder_id:
                # move out of TO_FIX folder back to Recettes
                drive.files().update(
                    fileId=d["id"],
                    addParents=recettes_folder_id,
                    removeParents=folder_id,
                    fields="id,parents",
                ).execute()
    print({"fixed": fixed, "skipped": skipped, "total": len(docs)})


if __name__ == "__main__":
    sys.exit(main())
