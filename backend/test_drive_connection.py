import os
from pathlib import Path
from googleapiclient.discovery import build
from google.oauth2 import service_account

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

_env_key = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
_secrets_dir = os.environ.get("MEAL_PLANNER_SECRETS_DIR", "").strip()
SERVICE_ACCOUNT_FILE = (
    Path(_env_key)
    if _env_key
    else (Path(_secrets_dir) / "service_accounts" / "chatgpt-recettes-access.json" if _secrets_dir else None)
)

if not SERVICE_ACCOUNT_FILE:
    raise SystemExit("MEAL_PLANNER_SECRETS_DIR or GOOGLE_APPLICATION_CREDENTIALS is required.")
if not SERVICE_ACCOUNT_FILE.exists():
    raise SystemExit(f"Service account JSON not found: {SERVICE_ACCOUNT_FILE}")

creds = service_account.Credentials.from_service_account_file(
    str(SERVICE_ACCOUNT_FILE), scopes=SCOPES
)
service = build("drive", "v3", credentials=creds)

results = service.files().list(
    q="name contains 'Recettes' and mimeType='application/vnd.google-apps.folder'",
    fields="files(id, name)"
).execute()

for f in results.get("files", []):
    print(f"✅ Found folder: {f['name']} — ID: {f['id']}")
if not results.get("files"):
    print("⚠️ Folder not found or not shared with this service account.")
