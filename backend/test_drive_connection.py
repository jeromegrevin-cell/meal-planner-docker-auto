from pathlib import Path
from googleapiclient.discovery import build
from google.oauth2 import service_account

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

# Point to your actual file in /credentials
SERVICE_ACCOUNT_FILE = Path(__file__).resolve().parent.parent / "credentials" / "chatgpt-recettes-access.json"
# If your test file sits directly in backend/, use:
# SERVICE_ACCOUNT_FILE = Path(__file__).resolve().parent.parent / "credentials" / "chatgpt-recettes-access.json"

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

