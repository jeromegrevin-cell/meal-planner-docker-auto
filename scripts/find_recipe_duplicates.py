#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Find duplicate recipe titles in recettes_index.json.

Detects:
- exact duplicates: same normalized_title
- near duplicates: same title_key but different normalized_title

Exit codes:
  0 = no duplicates found
  1 = duplicates found
  2 = error (missing index)
"""

import json
import sys
from pathlib import Path
from collections import defaultdict


BASE_DIR = Path(__file__).resolve().parent.parent
INDEX_PATH = BASE_DIR / "recettes_index.json"


def load_index():
    if not INDEX_PATH.exists():
        print(f"ERROR: {INDEX_PATH} not found. Run recettes_rescan.py first.")
        sys.exit(2)
    with INDEX_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def main():
    data = load_index()
    if not isinstance(data, list):
        print("ERROR: recettes_index.json is not a list.")
        sys.exit(2)

    by_norm = defaultdict(list)
    by_key = defaultdict(list)

    for item in data:
        title = item.get("title", "")
        norm = item.get("normalized_title", "")
        key = item.get("title_key", "")
        fid = item.get("file_id", "")
        path = item.get("fullPath", "")

        entry = {"title": title, "file_id": fid, "fullPath": path, "normalized_title": norm, "title_key": key}
        if norm:
            by_norm[norm].append(entry)
        if key:
            by_key[key].append(entry)

    exact_dups = {k: v for k, v in by_norm.items() if len(v) > 1}
    near_dups = {}
    for k, v in by_key.items():
        if len(v) <= 1:
            continue
        norms = {e["normalized_title"] for e in v}
        if len(norms) > 1:
            near_dups[k] = v

    if exact_dups:
        print("=== Exact duplicates (normalized_title) ===")
        for k, v in exact_dups.items():
            print(f"- {k}")
            for e in v:
                print(f"  * {e['title']}  [{e['file_id']}]  {e['fullPath']}")

    if near_dups:
        print("\n=== Near duplicates (title_key) ===")
        for k, v in near_dups.items():
            print(f"- {k}")
            for e in v:
                print(f"  * {e['title']}  [{e['file_id']}]  {e['fullPath']}")

    if exact_dups or near_dups:
        sys.exit(1)

    print("OK: no duplicates found.")
    sys.exit(0)


if __name__ == "__main__":
    main()
