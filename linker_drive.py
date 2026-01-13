# linker_drive.py
import unicodedata
from pathlib import Path
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

# Chemin vers la clé JSON (dans le sous-dossier credentials)
SERVICE_ACCOUNT_JSON = str(Path(__file__).parent / "credentials" / "chatgpt-recettes-access.json")

# ID du dossier "Recettes"
FOLDER_ID = "0B42O_BX-8zVLNjIwN2ZiZWQtMjUwYy00MzA1LWJlYTctZThhZDk1M2UyNGFi"

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

def _norm(s: str) -> str:
    """Normalise (sans accents, minuscule) pour comparer les titres."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    return s.lower().strip()

def _build_drive():
    creds = Credentials.from_service_account_file(SERVICE_ACCOUNT_JSON, scopes=SCOPES)
    return build("drive", "v3", credentials=creds)

def _list_recipes_in_folder(service):
    q = f"'{FOLDER_ID}' in parents and trashed = false"
    fields = "nextPageToken, files(id, name, mimeType, webViewLink)"
    files, token = [], None
    while True:
        resp = service.files().list(
            q=q, fields=fields, pageToken=token,
            orderBy="name", supportsAllDrives=True, includeItemsFromAllDrives=True
        ).execute()
        files += resp.get("files", [])
        token = resp.get("nextPageToken")
        if not token:
            break
    return files

def link_titles_to_drive(titles):
    """Prend une liste de titres et renvoie [{title, drive_link}] si trouvé."""
    service = _build_drive()
    files = _list_recipes_in_folder(service)

    # Index des fichiers (clé normalisée)
    bucket = { _norm(f["name"]): f for f in files }

    out = []
    for t in titles:
        nt = _norm(t)
        match = bucket.get(nt)

        if not match:
            # Correspondance approximative: tous les mots (>=3 lettres) doivent être présents
            parts = [p for p in nt.split() if len(p) > 2]
            candidates = []
            for k, f in bucket.items():
                if all(p in k for p in parts):
                    candidates.append(f)

            # Score: PDF > Google Docs > longueur du nom
            def score(f):
                mime = f.get("mimeType", "")
                return (("pdf" in mime) * 3) + (("document" in mime) * 2) + len(f["name"])
            candidates.sort(key=score, reverse=True)

            match = candidates[0] if candidates else None

        out.append({
            "title": t,
            "drive_link": match.get("webViewLink") if match else None
        })
    return out

if __name__ == "__main__":
    sample = [
        "Parmentier de canard",
        "Poulet au yaourt au curry",
        "Rôti de porc braisé",
        "Saumon au four citron et herbes"
    ]
    print(link_titles_to_drive(sample))