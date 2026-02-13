import argparse
import json
import os
import re
import sys
from pathlib import Path

from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
import contextlib
import io
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload


def resolve_service_account_key() -> str:
    env_key = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    secrets_dir = os.environ.get("MEAL_PLANNER_SECRETS_DIR", "").strip()
    candidates = []
    if env_key:
        candidates.append(Path(env_key))
    if secrets_dir:
        candidates.append(Path(secrets_dir) / "service_accounts" / "chatgpt-recettes-access.json")
    candidates.append(Path.home() / "meal-planner-secrets" / "service_accounts" / "chatgpt-recettes-access.json")
    for p in candidates:
        if p and p.exists():
            return str(p)
    return ""


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


def resolve_oauth_token_file() -> str:
    secrets_dir = os.environ.get("MEAL_PLANNER_SECRETS_DIR", "").strip()
    if secrets_dir:
        return str(Path(secrets_dir) / "drive_oauth_token.json")
    return str(Path.home() / "meal-planner-secrets" / "drive_oauth_token.json")


def resolve_folder_id(drive):
    env_id = os.environ.get("RECETTES_FOLDER_ID", "").strip()
    if env_id:
        return env_id

    id_file = Path(__file__).resolve().parent / "recettes_id.txt"
    if id_file.exists():
        return id_file.read_text(encoding="utf-8").strip()

    resp = drive.files().list(
        q="name = 'Recettes' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields="files(id, name)",
        pageSize=10,
        corpora="allDrives",
        includeItemsFromAllDrives=True,
        supportsAllDrives=True
    ).execute()
    files = resp.get("files", [])
    if not files:
        return ""
    folder_id = files[0]["id"]
    id_file.write_text(folder_id, encoding="utf-8")
    return folder_id


def sanitize_filename(title: str) -> str:
    name = title.strip()
    name = re.sub(r"[\\/]+", "-", name)
    name = re.sub(r"[:*?\"<>|]", "-", name)
    name = re.sub(r"\s+", " ", name).strip()
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name


def find_existing(drive, folder_id: str, filename: str):
    resp = drive.files().list(
        q=f"'{folder_id}' in parents and name = '{filename}' and trashed = false",
        fields="files(id, name, webViewLink)",
        pageSize=1,
        includeItemsFromAllDrives=True,
        supportsAllDrives=True
    ).execute()
    files = resp.get("files", [])
    return files[0] if files else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--title", required=True)
    args = parser.parse_args()

    pdf_path = Path(args.pdf).expanduser().resolve()
    if not pdf_path.exists():
        print(json.dumps({"ok": False, "error": "pdf_not_found", "path": str(pdf_path)}))
        return 2

    oauth_client = resolve_oauth_client_file()
    service_account_key = resolve_service_account_key()
    token_path = resolve_oauth_token_file()
    scopes = ["https://www.googleapis.com/auth/drive.file"]
    creds = None

    # Prefer OAuth when available (user consented account has storage quota)
    if oauth_client:
        oauth_port = int(os.environ.get("DRIVE_OAUTH_PORT", "51763"))
        if os.path.exists(token_path):
            creds = Credentials.from_authorized_user_file(token_path, scopes=scopes)
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                try:
                    creds.refresh(Request())
                except Exception:
                    # Refresh token invalid/revoked -> force re-consent
                    try:
                        Path(token_path).unlink(missing_ok=True)
                    except Exception:
                        pass
                    creds = None
            if not creds or not creds.valid:
                flow = InstalledAppFlow.from_client_secrets_file(oauth_client, scopes=scopes)
                flow.redirect_uri = f"http://localhost:{oauth_port}/"
                try:
                    buf = io.StringIO()
                    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                        creds = flow.run_local_server(
                            host="0.0.0.0",
                            port=oauth_port,
                            prompt="consent"
                        )
                except Exception:
                    auth_url, _ = flow.authorization_url(prompt="consent", access_type="offline")
                    print(json.dumps({"ok": False, "error": "oauth_authorization_required", "auth_url": auth_url}))
                    return 5
            if isinstance(creds, Credentials):
                Path(token_path).write_text(creds.to_json(), encoding="utf-8")
    else:
        key_path = service_account_key
        if not key_path:
            print(json.dumps({"ok": False, "error": "missing_oauth_client"}))
            return 3
        creds = service_account.Credentials.from_service_account_file(
            key_path, scopes=scopes
        )

    drive = build("drive", "v3", credentials=creds)

    folder_id = resolve_folder_id(drive)
    if not folder_id:
        print(json.dumps({"ok": False, "error": "missing_drive_folder"}))
        return 4

    filename = sanitize_filename(args.title)
    existing = find_existing(drive, folder_id, filename)
    if existing:
        print(json.dumps({
            "ok": True,
            "already_exists": True,
            "file_id": existing.get("id"),
            "name": existing.get("name"),
            "webViewLink": existing.get("webViewLink"),
            "drive_path": f"drive://{existing.get('id')}"
        }))
        return 0

    media = MediaFileUpload(str(pdf_path), mimetype="application/pdf", resumable=True)
    file_meta = {
        "name": filename,
        "parents": [folder_id]
    }
    created = drive.files().create(
        body=file_meta,
        media_body=media,
        fields="id, name, webViewLink",
        supportsAllDrives=True
    ).execute()

    print(json.dumps({
        "ok": True,
        "already_exists": False,
        "file_id": created.get("id"),
        "name": created.get("name"),
        "webViewLink": created.get("webViewLink"),
        "drive_path": f"drive://{created.get('id')}"
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
