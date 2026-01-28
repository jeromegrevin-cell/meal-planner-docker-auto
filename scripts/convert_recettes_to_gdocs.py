#!/usr/bin/env python3
import argparse
import csv
import hashlib
import json
import os
import re
import sys
from pathlib import Path

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload


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


def sanitize_doc_name(name: str) -> str:
    base = name.strip()
    base = re.sub(r"\.pdf$", "", base, flags=re.IGNORECASE)
    base = re.sub(r"\s+", " ", base).strip()
    return base


def file_md5(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def get_drive_client():
    oauth_client = resolve_oauth_client_file()
    if not oauth_client:
        print("Missing OAuth client. Set DRIVE_OAUTH_CLIENT or MEAL_PLANNER_SECRETS_DIR.")
        sys.exit(3)

    token_path = resolve_oauth_token_file()
    scopes = ["https://www.googleapis.com/auth/drive.file"]
    creds = None
    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, scopes=scopes)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(oauth_client, scopes=scopes)
            creds = flow.run_local_server(port=0, prompt="consent")
        Path(token_path).write_text(creds.to_json(), encoding="utf-8")
    return build("drive", "v3", credentials=creds)


def ensure_folder(drive, folder_name: str) -> str:
    resp = drive.files().list(
        q=(
            f"name = '{folder_name}' and mimeType = 'application/vnd.google-apps.folder' "
            "and trashed = false"
        ),
        fields="files(id, name)",
        pageSize=10,
    ).execute()
    files = resp.get("files", [])
    if files:
        return files[0]["id"]

    folder_meta = {
        "name": folder_name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": ["root"],
    }
    created = drive.files().create(body=folder_meta, fields="id").execute()
    return created["id"]


def find_existing_doc(drive, folder_id: str, doc_name: str):
    resp = drive.files().list(
        q=(
            f"'{folder_id}' in parents and name = '{doc_name}' "
            "and mimeType = 'application/vnd.google-apps.document' and trashed = false"
        ),
        fields="files(id, name, webViewLink)",
        pageSize=1,
    ).execute()
    files = resp.get("files", [])
    return files[0] if files else None


def convert_pdf_to_doc(drive, pdf_path: Path, folder_id: str, doc_name: str):
    media = MediaFileUpload(str(pdf_path), mimetype="application/pdf", resumable=True)
    meta = {
        "name": doc_name,
        "mimeType": "application/vnd.google-apps.document",
        "parents": [folder_id],
    }
    created = drive.files().create(body=meta, media_body=media, fields="id,name,webViewLink").execute()
    return created


def main():
    parser = argparse.ArgumentParser(description="Convert Recettes PDFs to Google Docs")
    parser.add_argument("--src", default="/Users/Jerome/Recettes", help="Source folder of PDFs")
    parser.add_argument("--dest-folder", default="Recettes_Converties", help="Drive folder name")
    parser.add_argument("--out", default="/Users/Jerome/meal-planner-docker-auto", help="Report output dir")
    parser.add_argument("--limit", type=int, default=0, help="Max files to convert (0=all)")
    parser.add_argument("--dry-run", action="store_true", help="List what would be converted")
    args = parser.parse_args()

    src_dir = Path(args.src).expanduser().resolve()
    if not src_dir.exists():
        print(f"Source not found: {src_dir}")
        return 2

    pdfs = sorted([p for p in src_dir.iterdir() if p.suffix.lower() == ".pdf"])
    if args.limit and args.limit > 0:
        pdfs = pdfs[: args.limit]

    report = {
        "source": str(src_dir),
        "dest_folder": args.dest_folder,
        "total": len(pdfs),
        "converted": 0,
        "skipped": 0,
        "failed": 0,
        "items": [],
    }

    if args.dry_run:
        for p in pdfs:
            report["items"].append({"file": p.name, "status": "planned"})
        write_reports(report, args.out)
        print(json.dumps({"ok": True, "dry_run": True, "total": len(pdfs)}))
        return 0

    drive = get_drive_client()
    folder_id = ensure_folder(drive, args.dest_folder)

    seen_hashes = {}
    for idx, pdf in enumerate(pdfs, start=1):
        doc_name = sanitize_doc_name(pdf.name)
        entry = {
            "file": pdf.name,
            "doc_name": doc_name,
            "status": "",
        }
        try:
            md5 = file_md5(pdf)
            if md5 in seen_hashes:
                entry.update({
                    "status": "duplicate_hash",
                    "duplicate_of": seen_hashes[md5],
                })
                report["skipped"] += 1
                report["items"].append(entry)
                continue
            seen_hashes[md5] = pdf.name

            existing = find_existing_doc(drive, folder_id, doc_name)
            if existing:
                entry.update({
                    "status": "already_exists",
                    "doc_id": existing.get("id"),
                    "webViewLink": existing.get("webViewLink"),
                })
                report["skipped"] += 1
                report["items"].append(entry)
                continue

            created = convert_pdf_to_doc(drive, pdf, folder_id, doc_name)
            entry.update({
                "status": "converted",
                "doc_id": created.get("id"),
                "webViewLink": created.get("webViewLink"),
            })
            report["converted"] += 1
            report["items"].append(entry)
        except Exception as e:
            entry.update({"status": "failed", "error": str(e)})
            report["failed"] += 1
            report["items"].append(entry)
        if idx % 25 == 0:
            print(f"[{idx}/{len(pdfs)}] processed")

    write_reports(report, args.out)
    print(json.dumps({"ok": True, "converted": report["converted"], "failed": report["failed"]}))
    return 0


def write_reports(report, out_dir):
    out = Path(out_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    json_path = out / "recettes_convert_report.json"
    csv_path = out / "recettes_convert_report.csv"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["file", "doc_name", "status", "doc_id", "webViewLink", "error", "duplicate_of"])
        for it in report.get("items", []):
            writer.writerow([
                it.get("file", ""),
                it.get("doc_name", ""),
                it.get("status", ""),
                it.get("doc_id", ""),
                it.get("webViewLink", ""),
                it.get("error", ""),
                it.get("duplicate_of", ""),
            ])


if __name__ == "__main__":
    sys.exit(main())
