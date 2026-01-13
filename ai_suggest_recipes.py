#!/usr/bin/env python3
import os, json, re, argparse, time
from pathlib import Path
from typing import List, Dict, Any, Optional
from random import choice, randint

# ---- Optional OpenAI support (set OPENAI_API_KEY env var to enable) ----
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
USE_OPENAI = bool(OPENAI_API_KEY)

# ---- Project structure / paths ----
REPO = Path(__file__).resolve().parent
INDEX = REPO / "recettes_index.json"
OUT_DIR = REPO / "generated_recipes"
OUT_DIR.mkdir(exist_ok=True)

# ---- Google Drive upload (uses your existing service account path) ----
from pathlib import Path as _Path
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
import io

SCOPES = ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/drive.readonly"]
# Try the same candidate paths your sync script uses
CANDIDATE_KEYS = [
    REPO / "credentials" / "chatgpt-recettes-access.json",
    REPO.parent / "credentials" / "chatgpt-recettes-access.json",
    _Path("/Users/Jerome/meal-planner-docker-auto/credentials/chatgpt-recettes-access.json"),
]
SERVICE_ACCOUNT_FILE = next((str(p) for p in CANDIDATE_KEYS if _Path(p).exists()), None)

def connect_drive():
    if not SERVICE_ACCOUNT_FILE:
        raise SystemExit("❌ Clé de service introuvable pour l’upload Drive.")
    creds = service_account.Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE, scopes=SCOPES)
    return build("drive", "v3", credentials=creds)

def find_recettes_folder_id(drive, folder_name="Recettes") -> Optional[str]:
    res = drive.files().list(
        q=f"name = '{folder_name}' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields="files(id,name)", pageSize=10
    ).execute()
    items = res.get("files", [])
    return items[0]["id"] if items else None

def upload_json_to_drive(drive, folder_id: str, local_path: Path):
    body = {
        "name": local_path.name,
        "parents": [folder_id],
        "mimeType": "application/json",
    }
    with open(local_path, "rb") as f:
        media = MediaIoBaseUpload(io.BytesIO(f.read()), mimetype="application/json")
    file = drive.files().create(body=body, media_body=media, fields="id,name").execute()
    return file["id"]

# ---- Helpers ----
def norm(s: str) -> str:
    return (s or "").strip().lower()

def slugify(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9-_ ]", "", name).strip().replace(" ", "_")
    return re.sub(r"_+", "_", s)[:80] or f"recipe_{int(time.time())}"

def load_index() -> List[Dict[str, Any]]:
    if not INDEX.exists():
        return []
    data = json.loads(INDEX.read_text(encoding="utf-8"))
    # Keep title + kcal if present
    out = []
    for r in data:
        title = (r.get("title") or "").strip()
        kcal = r.get("kcal_per_portion") or r.get("total_kcal")
        portions = r.get("portions")
        if kcal and r.get("kcal_per_portion") is None and portions:
            try:
                kcal = round(int(r["total_kcal"]) / max(int(portions),1))
            except Exception:
                pass
        out.append({"title": title, "kcal": (int(kcal) if str(kcal).isdigit() else None)})
    # dedupe
    seen, uniq = set(), []
    for r in out:
        k = norm(r["title"])
        if k and k not in seen:
            seen.add(k); uniq.append(r)
    return uniq

BASE_STYLES = [
    "cuisine familiale française", "méditerranéenne légère", "bistrot rapide",
    "légumes rôtis + céréales", "poisson express", "poulet + légumes",
    "pâtes légères", "soupe-repas", "veggie protéiné"
]
PROTEINS = ["poulet", "dinde", "saumon", "cabillaud", "thon", "porc maigre", "tofu", "pois chiches", "œufs"]
SIDES = ["riz", "quinoa", "polenta", "pâtes", "patate douce", "semoule", "lentilles", "légumes rôtis"]
VEG = ["courgettes", "poivron", "brocoli", "carottes", "épinards", "tomates", "poireau", "champignons"]

def rule_based_recipe(target_kcal=500) -> Dict[str, Any]:
    prot = choice(PROTEINS)
    side = choice(SIDES)
    veg1, veg2 = choice(VEG), choice(VEG)
    while veg2 == veg1:
        veg2 = choice(VEG)
    style = choice(BASE_STYLES)

    # crude kcal model: base around 480-540
    kcal = randint(target_kcal-40, target_kcal+40)
    title = f"{prot.capitalize()} {style} ({veg1} & {veg2}) avec {side}"
    ingredients = [
        f"{prot} ~150 g",
        f"{veg1} 150 g",
        f"{veg2} 150 g",
        f"{side} 60 g (sec)",
        "huile d’olive 1 cs",
        "ail 1 gousse",
        "sel, poivre, herbes",
    ]
    steps = [
        f"Cuire {side} selon le paquet.",
        f"Saisir {prot} avec huile, ail. Saler/poivrer.",
        f"Ajouter {veg1} et {veg2} en dés, cuire 6–8 min.",
        f"Mélanger avec {side}. Rectifier l’assaisonnement.",
    ]
    return {
        "title": title,
        "kcal_per_portion": kcal,
        "portions": 3,
        "ingredients": ingredients,
        "steps": steps,
        "source": "AI-rulebased"
    }

def openai_generate_n(n=4, target_kcal=500) -> List[Dict[str, Any]]:
    if not USE_OPENAI:
        return [rule_based_recipe(target_kcal) for _ in range(n)]
    # OpenAI path
    try:
        from openai import OpenAI
        client = OpenAI(api_key=OPENAI_API_KEY)
        prompt = f"""Génère {n} recettes de dîner réalistes (~{target_kcal} kcal/portion), 3 portions chacune.
Format JSON strict: liste d'objets avec:
title, kcal_per_portion (int), portions (int), ingredients (liste de strings), steps (liste de strings).
Pas d'autres champs, pas de texte hors JSON."""
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role":"user","content":prompt}],
            temperature=0.6,
        )
        txt = resp.choices[0].message.content.strip()
        data = json.loads(txt)
        out = []
        for r in data:
            out.append({
                "title": r["title"],
                "kcal_per_portion": int(r["kcal_per_portion"]),
                "portions": int(r.get("portions", 3)),
                "ingredients": r.get("ingredients", []),
                "steps": r.get("steps", []),
                "source": "AI-OpenAI"
            })
        return out
    except Exception as e:
        print("⚠️ OpenAI indisponible, repli règles locales:", e)
        return [rule_based_recipe(target_kcal) for _ in range(n)]

def save_recipes(recipes: List[Dict[str, Any]]) -> List[Path]:
    paths = []
    for r in recipes:
        name = slugify(r["title"]) + ".json"
        p = OUT_DIR / name
        p.write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding="utf-8")
        paths.append(p)
    return paths

def main():
    ap = argparse.ArgumentParser(description="Génère des recettes AI ~500 kcal et (optionnel) upload vers Drive/Recettes.")
    ap.add_argument("--count", type=int, default=6, help="Nombre de recettes AI à créer")
    ap.add_argument("--upload", action="store_true", help="Uploader chaque recette dans Google Drive/Recettes")
    args = ap.parse_args()

    existing = load_index()
    print(f"📚 Recettes indexées existantes: {len(existing)}")
    ai_recipes = openai_generate_n(args.count, target_kcal=500)
    saved = save_recipes(ai_recipes)
    print(f"💾 Sauvegardé {len(saved)} nouvelles recettes AI dans: {OUT_DIR}")

    if args.upload:
        drive = connect_drive()
        folder_id = find_recettes_folder_id(drive, "Recettes")
        if not folder_id:
            raise SystemExit("❌ Dossier 'Recettes' introuvable sur Drive (partage ?).")
        for p in saved:
            fid = upload_json_to_drive(drive, folder_id, p)
            print(f"☁️ Uploadé: {p.name} → fileId={fid}")

    print("✅ Terminé.")

if __name__ == "__main__":
    main()
