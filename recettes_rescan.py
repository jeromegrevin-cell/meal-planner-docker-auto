#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Recettes rescan + nutrition index

- Uses Google Service Account (Drive API v3, read-only)
- Recursively scans the "Recettes" folder on Google Drive
- Extracts text from:
    * Google Docs (export as text/plain)
    * PDF (pdfminer.six)
    * DOCX (python-docx)
    * TXT / MD (plain text)
- Parses:
    * Ingredients block
    * Steps block
- Estimates nutrition per recipe based on nutrition_table.csv
- Outputs in the project root:
    * recettes_index.json      (full enriched index)
    * recipes_list.csv         (summary list of files)
    * recipes_nutrition.csv    (nutrition summary per recipe)
"""

import os
import sys
import io
import csv
import json
import re
import time
import random
import unicodedata
from pathlib import Path
from typing import List, Dict, Optional, Tuple

# =========================================================
# B2: Filter specific noisy pdfminer stderr warnings only
# =========================================================
_PDFMINER_NOISE_SUBSTRINGS = (
    "Cannot set gray non-stroke color because",
    # keep room for other ultra-common pdfminer noise lines if needed later
)

class _StderrFilter:
    """
    Filters only known pdfminer noise lines while preserving everything else.
    This is intentionally narrow to avoid hiding real errors.
    """
    def __init__(self, underlying):
        self._underlying = underlying

    def write(self, msg):
        if not msg:
            return
        # Drop only the exact noisy messages
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
from googleapiclient.errors import HttpError


# ========== CONFIG ==========

BASE_DIR = Path(__file__).resolve().parent

# Where to look for the service-account key
SERVICE_ACCOUNT_CANDIDATES = [
    os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip(),
    str(BASE_DIR / "credentials" / "chatgpt-recettes-access.json"),
]

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

ID_FILE = BASE_DIR / "recettes_id.txt"
OUT_JSON = BASE_DIR / "recettes_index.json"
OUT_CSV = BASE_DIR / "recipes_list.csv"
OUT_NUTR = BASE_DIR / "recipes_nutrition.csv"
TMP_DIR = BASE_DIR / ".cache_recettes"
NUTRION_CSV = BASE_DIR / "nutrition_table.csv"   # your custom table

ENV_FOLDER_ID = os.environ.get("RECETTES_FOLDER_ID", "").strip()


# ========== LOW-LEVEL HELPERS ==========

def deaccent(s: str) -> str:
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')

def normalize_title(s: str) -> str:
    # Lowercase + remove accents + keep alphanumerics/spaces.
    s = deaccent(s or "").lower()
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return re.sub(r"\s+", " ", s)

_TITLE_STOP_WORDS = {
    "de", "du", "des", "la", "le", "les", "au", "aux", "a", "et", "en",
    "d", "l", "un", "une", "aux", "avec", "sans"
}

def title_key(s: str) -> str:
    base = normalize_title(s)
    if not base:
        return ""
    tokens = [t for t in base.split(" ") if t and t not in _TITLE_STOP_WORDS]
    tokens.sort()
    return " ".join(tokens)

def with_retries(fn, *args, **kwargs):
    for attempt in range(5):
        try:
            return fn(*args, **kwargs)
        except HttpError as e:
            status = getattr(e, "resp", None).status if getattr(e, "resp", None) else None
            if status in (403, 429, 500, 502, 503, 504):
                # backoff
                time.sleep((2 ** attempt) + random.random())
                continue
            raise
        except Exception:
            time.sleep((2 ** attempt) + random.random())
    return fn(*args, **kwargs)


def find_service_account_file() -> Path:
    for cand in SERVICE_ACCOUNT_CANDIDATES:
        if cand:
            p = Path(cand)
            if p.exists():
                print(f"🔑 Using key: {p}")
                return p

    print("❌ Service account key not found. Checked:")
    for cand in SERVICE_ACCOUNT_CANDIDATES:
        if cand:
            p = Path(cand)
            print(f" - {p} → {'OK' if p.exists() else 'absent'}")
    sys.exit(1)


def build_drive_service():
    key_path = find_service_account_file()
    creds = service_account.Credentials.from_service_account_file(
        str(key_path), scopes=SCOPES
    )
    return build("drive", "v3", credentials=creds)


def get_or_save_folder_id(service, folder_name: str = "Recettes") -> str:
    # 1) ENV
    if ENV_FOLDER_ID:
        print(f"📂 Using RECETTES_FOLDER_ID from environment: {ENV_FOLDER_ID}")
        return ENV_FOLDER_ID

    # 2) cached file
    if ID_FILE.exists():
        fid = ID_FILE.read_text(encoding="utf-8").strip()
        if fid:
            print(f"📂 Using cached folder ID from {ID_FILE}: {fid}")
            return fid

    # 3) lookup by name
    print(f"🔍 Searching Drive for folder named '{folder_name}'...")
    resp = with_retries(
        service.files().list,
        q=f"name = '{folder_name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields="files(id, name)",
        pageSize=10,
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
        corpora="allDrives",
    )
    data = resp.execute()
    files = data.get("files", [])
    if not files:
        print(f"❌ Folder '{folder_name}' not found or not shared with the service account.")
        sys.exit(1)

    folder_id = files[0]["id"]
    ID_FILE.write_text(folder_id, encoding="utf-8")
    print(f"💾 Folder ID cached to {ID_FILE}: {folder_id}")
    return folder_id


def list_tree(service, folder_id: str) -> List[Dict]:
    """Depth-first traversal of 'Recettes' folder tree with fullPath assembly."""
    items: List[Dict] = []
    stack = [(folder_id, [])]  # (id, path_segments)

    while stack:
        cur_id, cur_path = stack.pop()

        # subfolders
        res_sub = with_retries(
            service.files().list,
            q=f"'{cur_id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            fields="files(id, name)",
            pageSize=1000,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        )
        subs = res_sub.execute().get("files", [])
        for sf in subs:
            stack.append((sf["id"], cur_path + [sf["name"]]))

        # files
        res_files = with_retries(
            service.files().list,
            q=f"'{cur_id}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false",
            fields="files(id, name, mimeType, createdTime, modifiedTime)",
            pageSize=1000,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        )
        files = res_files.execute().get("files", [])
        for f in files:
            items.append(
                {
                    **f,
                    "fullPath": "Recettes/" + "/".join(cur_path + [f["name"]]),
                }
            )

    return items


# ========== TEXT EXTRACTION ==========

def export_google_doc_text(service, file_id: str) -> str:
    data = with_retries(
        service.files().export(fileId=file_id, mimeType="text/plain").execute
    )
    return data.decode("utf-8", errors="ignore")


def download_file(service, file_id: str, filename: Path):
    request = service.files().get_media(fileId=file_id, supportsAllDrives=True)
    fh = io.FileIO(str(filename), "wb")
    downloader = MediaIoBaseDownload(fh, request)
    done = False
    while not done:
        status, done = with_retries(downloader.next_chunk)


def extract_text_from_pdf(local_path: Path) -> str:
    try:
        from pdfminer.high_level import extract_text
    except Exception:
        print("⚠️ pdfminer.six not installed, cannot parse PDF:", local_path)
        return ""
    try:
        return extract_text(str(local_path)) or ""
    except Exception:
        return ""


def extract_text_from_docx(local_path: Path) -> str:
    try:
        from docx import Document
    except Exception:
        print("⚠️ python-docx not installed, cannot parse DOCX:", local_path)
        return ""
    try:
        doc = Document(str(local_path))
        return "\n".join(p.text for p in doc.paragraphs)
    except Exception:
        return ""


def extract_text_from_plain(local_path: Path) -> str:
    for enc in ("utf-8", "latin-1", "cp1252"):
        try:
            with open(local_path, "r", encoding=enc) as f:
                return f.read()
        except Exception:
            continue
    return ""


def extract_recipe_text(service, item: Dict) -> str:
    TMP_DIR.mkdir(exist_ok=True)
    fid = item["id"]
    name = item["name"]
    mt = item["mimeType"]

    # Google Docs
    if mt == "application/vnd.google-apps.document":
        return export_google_doc_text(service, fid)

    # Ignore other Google internal types
    if mt.startswith("application/vnd.google-apps."):
        return ""

    ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    local_path = TMP_DIR / f"{fid}.{ext or 'bin'}"
    download_file(service, fid, local_path)

    if ext == "pdf":
        return extract_text_from_pdf(local_path)
    if ext == "docx":
        return extract_text_from_docx(local_path)
    if ext in ("txt", "md"):
        return extract_text_from_plain(local_path)
    # fallback: try plain
    return extract_text_from_plain(local_path)


# ========== PARSING RECETTES ==========

INGR_HEADERS = [r"ingr[ée]dients?", r"courses", r"liste d[ei]s? ingr", r"pour .* personnes"]
STEP_HEADERS = [r"pr[ée]paration", r"étapes?", r"recette", r"method(e)?", r"instructions?"]


def split_sections(text: str) -> Dict[str, str]:
    lines = [l.strip() for l in text.splitlines()]
    if not lines:
        return {"ingredients": "", "steps": ""}

    def find_header(patterns: List[str]) -> Optional[int]:
        for i, line in enumerate(lines):
            for p in patterns:
                if re.search(p, line, re.I):
                    return i
        return None

    i_ing = find_header(INGR_HEADERS)
    i_step = find_header(STEP_HEADERS)

    if i_ing is not None:
        if i_step is not None and i_step > i_ing:
            ingredients_txt = "\n".join(lines[i_ing + 1 : i_step])
        else:
            ingredients_txt = "\n".join(lines[i_ing + 1 :])
    else:
        # fallback: lines with bullets or quantities
        bullets = [
            l
            for l in lines
            if re.match(r"^[-•*]\s", l)
            or re.search(r"\d+\s?(g|ml|c[. ]?à|cs|cc)\b", l, re.I)
        ]
        ingredients_txt = "\n".join(bullets[:20])

    if i_step is not None:
        steps_txt = "\n".join(lines[i_step + 1 :])
    else:
        steps_txt = "\n".join(lines)

    return {"ingredients": ingredients_txt.strip(), "steps": steps_txt.strip()}


def lines_to_list(block: str) -> List[str]:
    out: List[str] = []
    for l in block.splitlines():
        l = re.sub(r"^[\-•*\d.\)\s]+", "", l).strip()
        if l:
            out.append(l)
    return out


def parse_portions(title: str, ingredients_raw: str, steps_raw: str) -> int:
    text = " ".join([title or "", ingredients_raw or "", steps_raw or ""]).lower()
    m = re.search(r"pour\s+(\d+)\s*(pers|personnes?)", text)
    if m:
        try:
            return int(m.group(1))
        except Exception:
            pass
    return 3  # default: 2 adults + 1 child


# ========== NUTRITION ==========

def load_nutrition_table() -> List[Dict]:
    builtin = [
        {"food": "poulet", "aliases": "blanc de poulet|poulet", "unit": "g", "grams_per_unit": "",
         "kcal_per_100g": "165", "protein_g_per_100g": "31", "fat_g_per_100g": "3.6", "carb_g_per_100g": "0"},
        {"food": "pomme de terre", "aliases": "pdt|pommes de terre|patate", "unit": "g", "grams_per_unit": "",
         "kcal_per_100g": "77", "protein_g_per_100g": "2", "fat_g_per_100g": "0.1", "carb_g_per_100g": "17"},
        {"food": "riz basmati", "aliases": "riz", "unit": "g", "grams_per_unit": "",
         "kcal_per_100g": "360", "protein_g_per_100g": "7", "fat_g_per_100g": "0.6", "carb_g_per_100g": "79"},
        {"food": "pâtes", "aliases": "pates|spaghetti|tagliatelles", "unit": "g", "grams_per_unit": "",
         "kcal_per_100g": "350", "protein_g_per_100g": "12", "fat_g_per_100g": "1.5", "carb_g_per_100g": "73"},
        {"food": "carotte", "aliases": "carottes", "unit": "g", "grams_per_unit": "",
         "kcal_per_100g": "41", "protein_g_per_100g": "0.9", "fat_g_per_100g": "0.2", "carb_g_per_100g": "10"},
        {"food": "oignon", "aliases": "oignons", "unit": "unit", "grams_per_unit": "110",
         "kcal_per_100g": "40", "protein_g_per_100g": "1.1", "fat_g_per_100g": "0.1", "carb_g_per_100g": "9"},
        {"food": "huile d’olive", "aliases": "huile olive|huile", "unit": "ml", "grams_per_unit": "",
         "kcal_per_100g": "884", "protein_g_per_100g": "0", "fat_g_per_100g": "100", "carb_g_per_100g": "0"},
    ]

    if NUTRION_CSV.exists():
        try:
            with NUTRION_CSV.open("r", encoding="utf-8") as f:
                rdr = csv.DictReader(f, delimiter=";")
                rows = [dict(r) for r in rdr]
            # merge: external rows override builtin for same food
            existing = {deaccent(r["food"].lower()): r for r in rows if r.get("food")}
            for b in builtin:
                key = deaccent(b["food"].lower())
                if key not in existing:
                    rows.append(b)
            return rows
        except Exception as e:
            print(f"⚠️ Failed to read {NUTRION_CSV}: {e}. Using builtin table only.")
    return builtin


NUTRI = load_nutrition_table()

QTY_RE = re.compile(
    r"(?P<num>(\d+[.,]?\d*|\d+\s*/\s*\d+|[½¼¾⅓⅔]))\s*"
    r"(?P<unit>g|grammes?|ml|cl|l|cs|càs|càc|cc|cuill(?:ere|ère)s?\s?(?:soupe|cafe|café)?|"
    r"pinc(?:e|ée)s?|tranches?|gousses?|boi(?:te|îte)s?|sachets?|verres?|tasses?|cups?|pi[eè]ces?)",
    re.I,
)


def _to_float(num_str: str) -> float:
    num_str = num_str.strip().replace(",", ".")
    map_unicode = {"½": "1/2", "¼": "1/4", "¾": "3/4", "⅓": "1/3", "⅔": "2/3"}
    num_str = map_unicode.get(num_str, num_str)
    if "/" in num_str:
        a, b = num_str.split("/")
        return float(a) / float(b)
    return float(num_str)


def match_food(line: str) -> Optional[Dict]:
    base = " " + re.sub(r"[^a-z0-9]+", " ", deaccent(line.lower())) + " "
    for row in NUTRI:
        tokens = [deaccent(row["food"].lower())]
        if row.get("aliases"):
            tokens += [deaccent(a.lower()) for a in row["aliases"].split("|")]
        for t in tokens:
            if t and re.search(rf"\b{re.escape(t)}\b", base):
                return row
    return None


def parse_quantity(line: str, row: Dict) -> float:
    m = QTY_RE.search(line)
    if not m:
        if (row.get("unit") or "") == "unit":
            return float(row.get("grams_per_unit") or 100.0)
        return 100.0

    val = _to_float(m.group("num"))
    unit = m.group("unit").lower()
    unit = unit.replace("grammes", "g").replace("càs", "cs").replace("càc", "cc")

    alias_all = deaccent((row.get("food", "") + "|" + row.get("aliases", "")).lower())

    if unit in ("cs", "cuillère soupe", "cuillere soupe"):
        return val * (15.0 if "huile" in alias_all else 12.0)
    if unit in ("cc", "cuillère cafe", "cuillere cafe", "café"):
        return val * 5.0
    if unit == "ml":
        return val
    if unit == "cl":
        return val * 10.0
    if unit == "l":
        return val * 1000.0
    if re.search(r"pi[eè]ces?|gousses?|tranches?", unit):
        grams = float(row.get("grams_per_unit") or 0) or (30.0 if "tranche" in unit else 5.0)
        return val * grams
    if unit in ("cups", "cup", "tasse", "tasses", "verre", "verres"):
        base_ml = 220.0 if "huile" in alias_all else 240.0
        return val * base_ml
    if unit in ("g", "gramme"):
        return val
    return val * 100.0


def compute_nutrition(ingredients: List[str], portions: int) -> Dict:
    totals = {"kcal": 0.0, "prot": 0.0, "fat": 0.0, "carb": 0.0}

    for line in ingredients:
        row = match_food(line)
        if not row:
            continue
        qty_g = parse_quantity(line, row)
        kcal100 = float(row.get("kcal_per_100g") or 0)
        p100 = float(row.get("protein_g_per_100g") or 0)
        f100 = float(row.get("fat_g_per_100g") or 0)
        c100 = float(row.get("carb_g_per_100g") or 0)

        totals["kcal"] += kcal100 * qty_g / 100.0
        totals["prot"] += p100 * qty_g / 100.0
        totals["fat"] += f100 * qty_g / 100.0
        totals["carb"] += c100 * qty_g / 100.0

    portions = max(portions, 1)
    per = {k: v / portions for k, v in totals.items()}

    return {
        "total_kcal": round(totals["kcal"]),
        "kcal_per_portion": round(per["kcal"]),
        "proteins_g": round(totals["prot"], 1),
        "lipids_g": round(totals["fat"], 1),
        "carbs_g": round(totals["carb"], 1),
        "proteins_g_per_portion": round(per["prot"], 1),
        "lipids_g_per_portion": round(per["fat"], 1),
        "carbs_g_per_portion": round(per["carb"], 1),
        "portions": portions,
    }


# ========== MAIN PIPELINE ==========

def main():
    service = build_drive_service()
    folder_id = get_or_save_folder_id(service, "Recettes")

    print("🔁 Scanning 'Recettes' folder tree...")
    files = list_tree(service, folder_id)
    print(f"📂 {len(files)} file(s) found in 'Recettes'.")

    index: List[Dict] = []
    nutrition_rows: List[List] = []

    for k, it in enumerate(files, 1):
        name = it["name"]
        fid = it["id"]
        mt = it["mimeType"]
        print(f"[{k}/{len(files)}] ↪ {name} ({mt})")

        try:
            text = extract_recipe_text(service, it)
            if not text:
                print("   (empty or unsupported format)")
                continue

            sections = split_sections(text)
            ingredients_list = lines_to_list(sections["ingredients"])[:120]
            steps_list = lines_to_list(sections["steps"])[:200]
            portions = parse_portions(name, sections["ingredients"], sections["steps"])
            nutr = compute_nutrition(ingredients_list, portions)

            created = it.get("createdTime", "")
            modified = it.get("modifiedTime", "")
            web = f"https://drive.google.com/file/d/{fid}/view"
            full_path = it.get("fullPath", name)

            entry = {
                "title": name,
                "normalized_title": normalize_title(name),
                "title_key": title_key(name),
                "file_id": fid,
                "mimeType": mt,
                "webViewLink": web,
                "fullPath": full_path,
                "createdTime": created,
                "modifiedTime": modified,
                "ingredients_raw": sections["ingredients"],
                "steps_raw": sections["steps"],
                "ingredients": ingredients_list,
                "steps": steps_list,
                **nutr,
            }
            index.append(entry)

            nutrition_rows.append(
                [
                    name,
                    portions,
                    nutr["total_kcal"],
                    nutr["kcal_per_portion"],
                    nutr["proteins_g"],
                    nutr["lipids_g"],
                    nutr["carbs_g"],
                ]
            )

        except Exception as e:
            print(f"   ⚠️ Extraction failed for {name}: {e}")

    # ----- Save JSON index -----
    with OUT_JSON.open("w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f"✅ Enriched JSON index : {OUT_JSON}")

    # ----- Save recipes_list.csv -----
    with OUT_CSV.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, delimiter=";")
        writer.writerow(
            ["title", "file_id", "mimeType", "webViewLink", "fullPath", "createdTime", "modifiedTime",
             "ingredients_count", "steps_count"]
        )
        for e in index:
            writer.writerow(
                [
                    e["title"],
                    e["file_id"],
                    e["mimeType"],
                    e["webViewLink"],
                    e["fullPath"],
                    e["createdTime"],
                    e["modifiedTime"],
                    len(e["ingredients"]),
                    len(e["steps"]),
                ]
            )
    print(f"✅ Files summary       : {OUT_CSV}")

    # ----- Save recipes_nutrition.csv -----
    with OUT_NUTR.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, delimiter=";")
        writer.writerow(
            ["title", "portions", "total_kcal", "kcal_per_portion", "proteins_g", "lipids_g", "carbs_g"]
        )
        for row in nutrition_rows:
            writer.writerow(row)
    print(f"✅ Nutrition summary   : {OUT_NUTR}")


if __name__ == "__main__":
    main()
