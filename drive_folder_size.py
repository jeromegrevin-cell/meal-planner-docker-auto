#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Compute total size (quota bytes) of a Google Drive folder.
- Uses a service account (same env keys as other scripts in this repo).
- Recursively traverses subfolders.
- Uses quotaBytesUsed when available (covers Google Docs).
"""

import argparse
import os
import re
import sys
import time
import random
from pathlib import Path
from typing import Dict, Iterable, Tuple

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

BASE_DIR = Path(__file__).resolve().parent
SECRETS_DIR = os.environ.get("MEAL_PLANNER_SECRETS_DIR", "").strip()
SERVICE_ACCOUNT_CANDIDATES = [
    os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip(),
    str(Path(SECRETS_DIR) / "service_accounts" / "chatgpt-recettes-access.json") if SECRETS_DIR else "",
]

FOLDER_MIME = "application/vnd.google-apps.folder"
SHORTCUT_MIME = "application/vnd.google-apps.shortcut"


def parse_folder_id(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        raise ValueError("Empty folder id/url")
    if raw.startswith("http://") or raw.startswith("https://"):
        m = re.search(r"/folders/([a-zA-Z0-9_-]+)", raw)
        if m:
            return m.group(1)
        m = re.search(r"id=([a-zA-Z0-9_-]+)", raw)
        if m:
            return m.group(1)
        raise ValueError("Could not extract folder id from URL")
    return raw


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


def with_retries(fn, *args, **kwargs):
    for attempt in range(5):
        try:
            return fn(*args, **kwargs)
        except HttpError as e:
            status = getattr(e, "resp", None).status if getattr(e, "resp", None) else None
            if status in (403, 429, 500, 502, 503, 504):
                time.sleep((2 ** attempt) + random.random())
                continue
            raise
        except Exception:
            time.sleep((2 ** attempt) + random.random())
    return fn(*args, **kwargs)


def iter_children(service, folder_id: str) -> Iterable[Dict]:
    page_token = None
    while True:
        resp = with_retries(
            service.files().list,
            q=f"'{folder_id}' in parents and trashed = false",
            fields=(
                "nextPageToken, "
                "files(id,name,mimeType,size,quotaBytesUsed,shortcutDetails(targetId,targetMimeType))"
            ),
            pageSize=1000,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
            pageToken=page_token,
        ).execute()
        for f in resp.get("files", []):
            yield f
        page_token = resp.get("nextPageToken")
        if not page_token:
            break


def human_bytes(n: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB", "PB"]
    size = float(n)
    for u in units:
        if size < 1024.0 or u == units[-1]:
            return f"{size:.2f} {u}"
        size /= 1024.0
    return f"{n} B"


def compute_folder_size(service, folder_id: str, follow_shortcuts: bool) -> Tuple[int, Dict[str, int]]:
    total = 0
    stats = {
        "files": 0,
        "folders": 0,
        "shortcuts": 0,
        "skipped_no_size": 0,
    }

    stack = [folder_id]
    visited_folders = set()

    while stack:
        fid = stack.pop()
        if fid in visited_folders:
            continue
        visited_folders.add(fid)
        stats["folders"] += 1

        for f in iter_children(service, fid):
            mime = f.get("mimeType", "")
            if mime == FOLDER_MIME:
                stack.append(f["id"])
                continue

            if mime == SHORTCUT_MIME:
                stats["shortcuts"] += 1
                if not follow_shortcuts:
                    continue
                target_id = (f.get("shortcutDetails") or {}).get("targetId")
                target_mime = (f.get("shortcutDetails") or {}).get("targetMimeType")
                if target_id and target_mime == FOLDER_MIME:
                    stack.append(target_id)
                # If it's a file shortcut, skip to avoid double counting.
                continue

            stats["files"] += 1
            size = f.get("quotaBytesUsed") or f.get("size")
            if size is None:
                stats["skipped_no_size"] += 1
                continue
            try:
                total += int(size)
            except (TypeError, ValueError):
                stats["skipped_no_size"] += 1

    return total, stats


def main() -> int:
    ap = argparse.ArgumentParser(description="Compute size of a Google Drive folder (recursive).")
    ap.add_argument("folder", help="Folder ID or URL")
    ap.add_argument("--follow-shortcuts", action="store_true", help="Follow folder shortcuts")
    ap.add_argument("--bytes", action="store_true", help="Print only total bytes")
    args = ap.parse_args()

    try:
        folder_id = parse_folder_id(args.folder)
    except ValueError as e:
        print(f"❌ {e}")
        return 2

    service = build_drive_service()
    total, stats = compute_folder_size(service, folder_id, args.follow_shortcuts)

    if args.bytes:
        print(total)
        return 0

    print("✅ Folder scan complete")
    print(f"Total: {total} bytes ({human_bytes(total)})")
    print(
        f"Items: folders={stats['folders']}, files={stats['files']}, "
        f"shortcuts={stats['shortcuts']}, skipped_no_size={stats['skipped_no_size']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
