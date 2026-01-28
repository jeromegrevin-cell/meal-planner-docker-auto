#!/usr/bin/env python3
import os
from pathlib import Path

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build


def resolve_token():
    secrets = os.environ.get("MEAL_PLANNER_SECRETS_DIR", "").strip()
    if secrets:
        return str(Path(secrets) / "drive_oauth_token.json")
    return str(Path.home() / "meal-planner-secrets" / "drive_oauth_token.json")


def find_folder(drive, name):
    resp = drive.files().list(
        q=f"name = '{name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields="files(id,name)",
        pageSize=10,
    ).execute()
    files = resp.get("files", [])
    return files[0]["id"] if files else None


def list_docs(drive, folder_id):
    docs = []
    token = None
    while True:
        resp = drive.files().list(
            q=f"'{folder_id}' in parents and mimeType = 'application/vnd.google-apps.document' and trashed = false",
            fields="nextPageToken, files(id,name,webViewLink)",
            pageSize=1000,
            pageToken=token,
        ).execute()
        docs += resp.get("files", [])
        token = resp.get("nextPageToken")
        if not token:
            break
    return docs


def get_text(docs_api, doc_id):
    doc = docs_api.documents().get(documentId=doc_id).execute()
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


def extract_any(text):
    t = text.lower()
    return ("ingr" in t) or ("etape" in t) or ("préparation" in t) or ("preparation" in t)


def main():
    token_path = resolve_token()
    scopes = ["https://www.googleapis.com/auth/drive.file"]
    creds = Credentials.from_authorized_user_file(token_path, scopes=scopes)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
    drive = build("drive", "v3", credentials=creds)
    docs_api = build("docs", "v1", credentials=creds)

    folder_id = find_folder(drive, "TO_FIX_missing_both")
    if not folder_id:
        raise SystemExit("Folder TO_FIX_missing_both not found")

    docs = list_docs(drive, folder_id)
    for d in docs:
        text = get_text(docs_api, d["id"])
        if not extract_any(text):
            print("SKIPPED:", d["name"], d.get("webViewLink", ""))


if __name__ == "__main__":
    main()
