from google.oauth2 import service_account
from googleapiclient.discovery import build

# chemin vers ton fichier JSON
SERVICE_ACCOUNT_FILE = r"C:\Users\Jerome\meal-planner-docker-auto\credentials\chatgpt-recettes-access.json"
SCOPES = ['https://www.googleapis.com/auth/drive.readonly']

# authentification
creds = service_account.Credentials.from_service_account_file(
    SERVICE_ACCOUNT_FILE, scopes=SCOPES)

service = build('drive', 'v3', credentials=creds)

# test : liste des 10 premiers fichiers du dossier Recettes
# results = service.files().list(
#    q="name contains 'Recettes'",
#    pageSize=10,
#    fields="files(id, name)").execute()
results = service.files().list(
    pageSize=20,
    fields="files(id, name, mimeType, owners)"
).execute()
items = results.get('files', [])

if not items:
    print('Aucun fichier trouvé.')
else:
    print('Fichiers trouvés :')
    for item in items:
        print(f"{item['name']} ({item['id']})")
