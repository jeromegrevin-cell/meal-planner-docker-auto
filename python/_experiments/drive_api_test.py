# drive_api_test.py
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SERVICE_ACCOUNT_JSON = "chatgpt-recettes-access.json"   # ta clé JSON
FOLDER_ID = "0B42O_BX-8zVLNjIwN2ZiZWQtMjUwYy00MzA1LWJlYTctZThhZDk1M2UyNGFi"  # ID du dossier Recettes
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

def main():
    creds = Credentials.from_service_account_file(SERVICE_ACCOUNT_JSON, scopes=SCOPES)
    service = build("drive", "v3", credentials=creds)

    query = f"'{FOLDER_ID}' in parents and trashed = false"
    fields = "nextPageToken, files(id, name, mimeType, webViewLink)"
    page_token = None
    files = []

    while True:
        resp = service.files().list(
            q=query,
            fields=fields,
            pageToken=page_token,
            orderBy="name",
            supportsAllDrives=True,
            includeItemsFromAllDrives=True
        ).execute()
        files += resp.get("files", [])
        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    if not files:
        print("Aucun fichier trouvé. Vérifie que le dossier 'Recettes' est bien partagé en LECTEUR avec le service account.")
        return

    print(f"✅ {len(files)} fichier(s) trouvé(s) :\n")
    for f in files:
        print(f"- {f['name']}  |  {f['mimeType']}  |  {f['webViewLink']}")

    targets = [
        "Parmentier de canard",
        "Poulet au yaourt au curry",
        "Rôti de porc braisé",
        "Saumon au four citron"
    ]
    print("\n🔎 Correspondances :")
    for t in targets:
        match = next((x for x in files if t.lower() in x["name"].lower()), None)
        print(f"• {t} → {match['webViewLink'] if match else 'non trouvé'}")

if __name__ == "__main__":
    main()
