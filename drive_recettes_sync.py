import os, sys, csv, json, io, re, time, unicodedata
from typing import List, Dict, Optional, Tuple
from pathlib import Path

# --- pdfminer noisy stderr filter (keeps real errors) ---
_PDFMINER_NOISE_SUBSTRINGS = (
    "Cannot set gray non-stroke color because",
    "Cannot set gray stroke color because",
    "Could get FontBBox from font descriptor because",
)

class _StderrFilter:
    def __init__(self, underlying):
        self._underlying = underlying

    def write(self, msg):
        if not msg:
            return
        for s in _PDFMINER_NOISE_SUBSTRINGS:
            if s in msg:
                return
        self._underlying.write(msg)

    def flush(self):
        try:
            self._underlying.flush()
        except Exception:
            pass

# Install filter early
sys.stderr = _StderrFilter(sys.__stderr__)

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

# === CONFIG / PATHS ===
REPO_ROOT = Path(__file__).resolve().parent  # this file sits at repo root (same level as /credentials and /backend)

# Candidate locations for the service-account key (outside repo)
_env_key = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
_secrets_dir = os.environ.get("MEAL_PLANNER_SECRETS_DIR", "").strip()
CANDIDATE_KEYS = [
    Path(_env_key) if _env_key else None,  # env var, if set
    Path(_secrets_dir) / "service_accounts" / "chatgpt-recettes-access.json" if _secrets_dir else None,
]

# Pick the first existing path
CANDIDATE_KEYS = [p for p in CANDIDATE_KEYS if p]
SERVICE_ACCOUNT_FILE = next((str(p) for p in CANDIDATE_KEYS if Path(p).exists()), None)

if not SERVICE_ACCOUNT_FILE:
    print("❌ Clé de service introuvable. Cherché aux emplacements suivants :")
    for p in CANDIDATE_KEYS:
        print(" -", p, "→", "OK" if Path(p).exists() else "absent")
    sys.exit(1)

SCOPES = ['https://www.googleapis.com/auth/drive.readonly']

# Outputs are written at repo root (same folder as this script)
ID_FILE   = str(REPO_ROOT / "recettes_id.txt")
OUT_JSON  = str(REPO_ROOT / "recettes_index.json")
OUT_CSV   = str(REPO_ROOT / "recipes_list.csv")
OUT_NUTR  = str(REPO_ROOT / "recipes_nutrition.csv")
TMP_DIR   = str(REPO_ROOT / ".cache_recettes")
NUTRION_CSV = str(REPO_ROOT / "nutrition_table.csv")

print("🔑 Utilisation de la clé :", SERVICE_ACCOUNT_FILE)
creds = service_account.Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE, scopes=SCOPES)
drive = build('drive', 'v3', credentials=creds)

# === UTILS ===
def deaccent(s: str) -> str:
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')

def get_or_save_folder_id(folder_name: str = "Recettes") -> str:
    if os.path.exists(ID_FILE):
        return Path(ID_FILE).read_text(encoding="utf-8").strip()
    resp = drive.files().list(
        q=f"name = '{folder_name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields="files(id, name)", pageSize=10
    ).execute()
    files = resp.get('files', [])
    if not files:
        raise SystemExit(f"❌ Dossier '{folder_name}' non trouvé ou non partagé.")
    folder_id = files[0]['id']
    Path(ID_FILE).write_text(folder_id, encoding="utf-8")
    print(f"💾 ID dossier '{folder_name}' :", folder_id)
    return folder_id

def list_all_files_in_folder(folder_id: str) -> List[Dict]:
    items, token = [], None
    while True:
        res = drive.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields="nextPageToken, files(id, name, mimeType)",
            pageSize=1000, pageToken=token, orderBy="name"
        ).execute()
        items.extend(res.get("files", []))
        token = res.get("nextPageToken")
        if not token: break
    return items

# === EXTRACTION ===
def export_google_doc_text(file_id: str) -> str:
    resp = drive.files().export(fileId=file_id, mimeType="text/plain").execute()
    return resp.decode("utf-8", errors="ignore")

def download_file(file_id: str, filename: str):
    request = drive.files().get_media(fileId=file_id)
    fh = io.FileIO(filename, "wb")
    downloader = MediaIoBaseDownload(fh, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()

def extract_text_from_pdf(local_path: str) -> str:
    try:
        from pdfminer.high_level import extract_text
        return extract_text(local_path) or ""
    except Exception:
        return ""

def extract_text_from_docx(local_path: str) -> str:
    try:
        from docx import Document
        doc = Document(local_path)
        return "\n".join(p.text for p in doc.paragraphs)
    except Exception:
        return ""

def extract_text_from_plain(local_path: str) -> str:
    for enc in ("utf-8","latin-1","cp1252"):
        try:
            with open(local_path, "r", encoding=enc) as f:
                return f.read()
        except Exception:
            continue
    return ""

def extract_recipe_text(item: Dict) -> str:
    os.makedirs(TMP_DIR, exist_ok=True)
    fid, name, mt = item["id"], item["name"], item["mimeType"]
    if mt == "application/vnd.google-apps.document":
        return export_google_doc_text(fid)
    if mt.startswith("application/vnd.google-apps."):
        return ""

    ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    local_path = os.path.join(TMP_DIR, f"{fid}.{ext or 'bin'}")
    download_file(fid, local_path)

    if ext == "pdf":         return extract_text_from_pdf(local_path)
    if ext == "docx":        return extract_text_from_docx(local_path)
    if ext in ("txt","md"):  return extract_text_from_plain(local_path)
    return extract_text_from_plain(local_path)

# === PARSING RECETTE ===
INGR_HEADERS = [r"ingr[ée]dients?", r"courses", r"liste d[ei]s? ingr"]
STEP_HEADERS = [
    r"pr[ée]paration",
    r"[ée]tapes?",
    r"method(e)?",
    r"instructions?",
    r"directions?",
    r"proc[ée]dure"
]

FRACTIONS_MAP = {
    "¼": "1/4",
    "½": "1/2",
    "¾": "3/4",
    "⅓": "1/3",
    "⅔": "2/3",
    "⅛": "1/8",
    "⅜": "3/8",
    "⅝": "5/8",
    "⅞": "7/8",
}

ING_LINE_RE = re.compile(
    r"^\s*(?P<qty>("
    r"\d+([.,]\d+)?|\d+/\d+|"
    r"\d+\s?x\s?\d+([.,]\d+)?|"
    r"\d+\s?[-–]\s?\d+([.,]\d+)?|"
    r"[¼½¾⅓⅔⅛⅜⅝⅞]"
    r"))\s*"
    r"(?P<unit>g|gr|kg|ml|l|cl|dl|"
    r"cs|càs|càc|cc|"
    r"c\.?\s?à\s?s\.?|c\.?\s?à\s?c\.?|"
    r"cuil(?:l[èe]re)?s?\s?(?:soupe|cafe|café)?|"
    r"pinc(?:e|ée)?s?|tranches?|gousses?|boites?|boîtes?|sachets?|verres?|"
    r"unit(?:és)?|cups?|tbsp|tsp|tablespoons?|teaspoons?|oz|lb|lbs)?\s+"
    r"(?P<item>.+)$",
    re.I,
)

VERB_RE = re.compile(
    r"\b(ajout(e|er)|m[ée]lang(e|er)|cuir(e|e)|po[êe]l(er|e)|r[ôo]tir|"
    r"fai(re|tes)|met(te|tre)|incorpor(er|e)|r[ée]server|chauffer|"
    r"saisir|dorer|bouillir|sauter|verser|add|mix|cook|bake|fry)\b",
    re.I,
)

def split_sections(text: str) -> Dict[str, str]:
    lines = [l.strip() for l in text.splitlines()]

    def find_header(patterns: List[str], start: int = 0) -> Optional[int]:
        for i in range(start, len(lines)):
            if any(re.search(p, lines[i], re.I) for p in patterns):
                return i
        return None

    i_ing = find_header(INGR_HEADERS, 0)
    i_prep = find_header(STEP_HEADERS, (i_ing + 1) if i_ing is not None else 0)

    notes = []
    if i_ing is None:
        notes.append("missing_ingredients_header")
    if i_prep is None:
        notes.append("missing_steps_header")
    if i_ing is None or i_prep is None or i_prep <= i_ing:
        return {"ingredients": "", "steps": "", "status": "INCOMPLETE", "notes": notes}

    ingredients_txt = "\n".join(lines[i_ing + 1 : i_prep]).strip()
    steps_txt = "\n".join(lines[i_prep + 1 :]).strip()
    status = "CONFIDENT" if ingredients_txt and steps_txt else "INCOMPLETE"
    if not ingredients_txt:
        notes.append("empty_ingredients_block")
    if not steps_txt:
        notes.append("empty_steps_block")
    return {"ingredients": ingredients_txt, "steps": steps_txt, "status": status, "notes": notes}

def lines_to_list(block: str) -> List[str]:
    arr = []
    for l in block.splitlines():
        l = re.sub(r"^[\-•*\d.\)\s]+", "", l).strip()
        if l: arr.append(l)
    return arr

def normalize_qty_line(line: str) -> str:
    line = line.replace("–", "-").replace("—", "-")
    line = re.sub(r"(\d)\s*[xX]\s*(\d)", r"\1 x \2", line)
    line = re.sub(r"(\d)([¼½¾⅓⅔⅛⅜⅝⅞])", r"\1 \2", line)
    for k, v in FRACTIONS_MAP.items():
        line = line.replace(k, v)
    m = re.match(r"^\s*(\d+)\s*\(([^)]+)\)\s*(.+)$", line)
    if m:
        line = f"{m.group(1)} {m.group(2)} {m.group(3)}"
    return line

def parse_ingredients_lines(block: str) -> Dict[str, List[str]]:
    valid, invalid = [], []
    for raw in block.splitlines():
        line = re.sub(r"^[\-•*\d.\)\s]+", "", raw).strip()
        if not line:
            continue
        line = normalize_qty_line(line)
        if VERB_RE.search(line):
            invalid.append(line); continue
        m = ING_LINE_RE.match(line)
        if not m or not m.group("item"):
            invalid.append(line); continue
        valid.append(line)
    return {"valid": valid, "invalid": invalid}

# === NUTRITION ===
def load_nutrition_table() -> List[Dict]:
    builtin = [
        {"food":"poulet","aliases":"blanc de poulet|poulet","unit":"g","grams_per_unit":"","kcal_per_100g":"165","protein_g_per_100g":"31","fat_g_per_100g":"3.6","carb_g_per_100g":"0"},
        {"food":"courge butternut","aliases":"butternut|courge","unit":"g","grams_per_unit":"","kcal_per_100g":"45","protein_g_per_100g":"1","fat_g_per_100g":"0.1","carb_g_per_100g":"10"},
        {"food":"pomme de terre","aliases":"pdt|pommes de terre|patate","unit":"g","grams_per_unit":"","kcal_per_100g":"77","protein_g_per_100g":"2","fat_g_per_100g":"0.1","carb_g_per_100g":"17"},
        {"food":"riz basmati","aliases":"riz","unit":"g","grams_per_unit":"","kcal_per_100g":"360","protein_g_per_100g":"7","fat_g_per_100g":"0.6","carb_g_per_100g":"79"},
        {"food":"pâtes","aliases":"pates|spaghetti|tagliatelles","unit":"g","grams_per_unit":"","kcal_per_100g":"350","protein_g_per_100g":"12","fat_g_per_100g":"1.5","carb_g_per_100g":"73"},
        {"food":"oignon","aliases":"oignons","unit":"unit","grams_per_unit":"110","kcal_per_100g":"40","protein_g_per_100g":"1.1","fat_g_per_100g":"0.1","carb_g_per_100g":"9"},
        {"food":"ail","aliases":"gousse d’ail|gousse ail|ail","unit":"unit","grams_per_unit":"5","kcal_per_100g":"149","protein_g_per_100g":"6.4","fat_g_per_100g":"0.5","carb_g_per_100g":"33"},
        {"food":"carotte","aliases":"carottes","unit":"g","grams_per_unit":"","kcal_per_100g":"41","protein_g_per_100g":"0.9","fat_g_per_100g":"0.2","carb_g_per_100g":"10"},
        {"food":"brocoli","aliases":"brocolis","unit":"g","grams_per_unit":"","kcal_per_100g":"34","protein_g_per_100g":"2.8","fat_g_per_100g":"0.4","carb_g_per_100g":"7"},
        {"food":"épinards","aliases":"epinards","unit":"g","grams_per_unit":"","kcal_per_100g":"23","protein_g_per_100g":"2.9","fat_g_per_100g":"0.4","carb_g_per_100g":"3.6"},
        {"food":"crème entière","aliases":"creme","unit":"ml","grams_per_unit":"","kcal_per_100g":"300","protein_g_per_100g":"2","fat_g_per_100g":"30","carb_g_per_100g":"3"},
        {"food":"yaourt nature","aliases":"yaourt","unit":"g","grams_per_unit":"","kcal_per_100g":"61","protein_g_per_100g":"3.5","fat_g_per_100g":"3.3","carb_g_per_100g":"4.7"},
        {"food":"fromage râpé","aliases":"emmental|comté|gruyère|parmesan","unit":"g","grams_per_unit":"","kcal_per_100g":"390","protein_g_per_100g":"28","fat_g_per_100g":"28","carb_g_per_100g":"3.5"},
        {"food":"huile d’olive","aliases":"huile","unit":"ml","grams_per_unit":"","kcal_per_100g":"884","protein_g_per_100g":"0","fat_g_per_100g":"100","carb_g_per_100g":"0"},
        {"food":"beurre","aliases":"","unit":"g","grams_per_unit":"","kcal_per_100g":"717","protein_g_per_100g":"0.9","fat_g_per_100g":"81","carb_g_per_100g":"0.1"},
        {"food":"sucre","aliases":"sucre en poudre","unit":"g","grams_per_unit":"","kcal_per_100g":"400","protein_g_per_100g":"0","fat_g_per_100g":"0","carb_g_per_100g":"100"},
        {"food":"tomates concassées","aliases":"tomate","unit":"g","grams_per_unit":"","kcal_per_100g":"21","protein_g_per_100g":"1","fat_g_per_100g":"0.2","carb_g_per_100g":"3.5"},
        {"food":"lait demi-écrémé","aliases":"lait","unit":"ml","grams_per_unit":"","kcal_per_100g":"46","protein_g_per_100g":"3.4","fat_g_per_100g":"1.6","carb_g_per_100g":"4.8"},
    ]
    if os.path.exists(NUTRION_CSV):
        out = []
        with open(NUTRION_CSV, "r", encoding="utf-8") as f:
            rdr = csv.DictReader(f, delimiter=";")
            for r in rdr:
                out.append({k: (r[k] if r.get(k) is not None else "") for k in rdr.fieldnames})
        return out + [x for x in builtin if x["food"] not in {r["food"] for r in out}]
    return builtin

NUTRI = load_nutrition_table()

def match_food(line: str) -> Optional[Dict]:
    base = deaccent(line.lower())
    for row in NUTRI:
        aliases = deaccent((row.get("aliases") or "")).split("|") if row.get("aliases") else []
        names = [deaccent(row["food"].lower())] + aliases
        if any(n and n in base for n in names):
            return row
    return None

QTY_RE = re.compile(r"(?P<num>\d+[.,]?\d*)\s*(?P<unit>g|grammes?|ml|cl|l|cs|càs|càc|cc|cuill(?:ere|ère)s?\s?(?:soupe|cafe|café)?|pinc(ée)?s?|tranches?|gousses?|boites?|boîtes?|sachets?|verres?|units?)", re.I)

def parse_quantity(line: str, row: Dict) -> float:
    m = QTY_RE.search(line)
    if not m:
        if (row.get("unit") or "") == "unit":
            gper = float(row.get("grams_per_unit") or 0) or 100.0
            return gper
        return 100.0

    num = m.group("num").replace(",", ".")
    try: val = float(num)
    except: val = 1.0
    unit = m.group("unit").lower()
    unit = unit.replace("grammes", "g").replace("càs", "cs").replace("càc", "cc").replace("cuillere", "cuillère")

    if unit in ("g","gramme","grammes"): return val
    if unit in ("ml",):  return val
    if unit in ("cl",):  return val * 10.0
    if unit == "l":      return val * 1000.0
    if unit in ("cs","cuillère soupe","cuillere soupe"):
        if "huile" in deaccent(row["food"]): return 15.0
        if "crème" in row["food"] or "creme" in row.get("aliases",""): return 15.0
        return 12.0
    if unit in ("cc","cuillère cafe","cuillere cafe","café"): return 5.0
    if "gousse" in unit:
        gper = float(row.get("grams_per_unit") or 0) or 5.0
        return val * gper
    if unit in ("tranche","tranches"): return 30.0 * val
    if (row.get("unit") or "") == "unit":
        gper = float(row.get("grams_per_unit") or 0) or 100.0
        return val * gper
    return val * 100.0

def parse_portions(title: str, ingredients_raw: str, steps_raw: str) -> int:
    text = " ".join([title or "", ingredients_raw or "", steps_raw or ""]).lower()
    m = re.search(r"pour\s+(\d+)\s*(pers|personnes?)", text)
    if m:
        try: return int(m.group(1))
        except: pass
    return 3  # défaut

def compute_nutrition_for_recipe(ingredients: List[str], portions: int) -> Tuple[Dict, List[Dict]]:
    total = {"kcal":0.0,"prot":0.0,"fat":0.0,"carb":0.0}
    details = []
    for line in ingredients:
        row = match_food(line)
        if not row:
            details.append({"ingredient": line, "match":"", "qty_g":0, "kcal":0})
            continue
        qty_g = parse_quantity(line, row)
        kcal100 = float(row.get("kcal_per_100g") or 0)
        p100   = float(row.get("protein_g_per_100g") or 0)
        f100   = float(row.get("fat_g_per_100g") or 0)
        c100   = float(row.get("carb_g_per_100g") or 0)

        kcal = kcal100 * qty_g / 100.0
        prot = p100   * qty_g / 100.0
        fat  = f100   * qty_g / 100.0
        carb = c100   * qty_g / 100.0

        total["kcal"] += kcal; total["prot"] += prot; total["fat"] += fat; total["carb"] += carb
        details.append({"ingredient": line, "match": row["food"], "qty_g": round(qty_g,1), "kcal": round(kcal,1)})
    per_portion = {k: (v/max(portions,1)) for k,v in total.items()}
    return {
        "total_kcal": round(total["kcal"]),
        "kcal_per_portion": round(per_portion["kcal"]),
        "proteins_g": round(total["prot"],1),
        "lipids_g": round(total["fat"],1),
        "carbs_g": round(total["carb"],1),
        "proteins_g_per_portion": round(per_portion["prot"],1),
        "lipids_g_per_portion": round(per_portion["fat"],1),
        "carbs_g_per_portion": round(per_portion["carb"],1),
        "portions": portions
    }, details

# === PIPELINE ===
def main():
    folder_id = get_or_save_folder_id("Recettes")
    files = list_all_files_in_folder(folder_id)
    print(f"📂 {len(files)} fichier(s) dans 'Recettes'.")

    os.makedirs(TMP_DIR, exist_ok=True)
    index = []

    for k, it in enumerate(files, 1):
        name, fid, mt = it["name"], it["id"], it["mimeType"]
        print(f"[{k}/{len(files)}] ↪ {name}  ({mt})")
        try:
            text = extract_recipe_text(it)
            if not text:
                print("   (vide ou non supporté)"); continue
            sections = split_sections(text)
            parsed_ing = parse_ingredients_lines(sections["ingredients"])
            ingredients_list = parsed_ing["valid"][:120]
            steps_list = lines_to_list(sections["steps"])[:120]
            portions = parse_portions(name, sections["ingredients"], sections["steps"])

            status = sections.get("status", "INCOMPLETE")
            notes = list(sections.get("notes", []))

            if parsed_ing["invalid"]:
                notes.append("ingredients_invalid_lines")
            if not ingredients_list:
                notes.append("no_valid_ingredients")
                status = "INCOMPLETE"
            if not steps_list:
                notes.append("no_steps")
                status = "INCOMPLETE"

            if status == "CONFIDENT":
                nutr, details = compute_nutrition_for_recipe(ingredients_list, portions)
            else:
                nutr = {
                    "total_kcal": 0,
                    "kcal_per_portion": 0,
                    "proteins_g": 0,
                    "lipids_g": 0,
                    "carbs_g": 0,
                    "proteins_g_per_portion": 0,
                    "lipids_g_per_portion": 0,
                    "carbs_g_per_portion": 0,
                    "portions": portions
                }
                details = []

            entry = {
                "title": name,
                "file_id": fid,
                "mimeType": mt,
                "ingredients_raw": sections["ingredients"],
                "steps_raw": sections["steps"],
                "ingredients": ingredients_list,
                "steps": steps_list,
                "ingredients_invalid": parsed_ing["invalid"],
                "parse_status": status,
                "parse_notes": notes,
                **nutr
            }
            index.append(entry)
        except Exception as e:
            print(f"   ⚠️ Extraction échouée: {e}")
        time.sleep(0.03)

    # Saves
    Path(OUT_JSON).write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    with open(OUT_CSV, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["title","file_id","mimeType","ingredients_count","steps_count"])
        for e in index:
            w.writerow([e["title"], e["file_id"], e["mimeType"], len(e["ingredients"]), len(e["steps"])])

    with open(OUT_NUTR, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["title","portions","total_kcal","kcal_per_portion","proteins_g","lipids_g","carbs_g"])
        for e in index:
            w.writerow([e["title"], e["portions"], e["total_kcal"], e["kcal_per_portion"], e["proteins_g"], e["lipids_g"], e["carbs_g"]])

    print(f"✅ Index JSON enrichi : {OUT_JSON}")
    print(f"✅ Résumé fichiers     : {OUT_CSV}")
    print(f"✅ Nutrition (CSV)     : {OUT_NUTR}")

if __name__ == "__main__":
    main()
