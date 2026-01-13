#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations
from pathlib import Path
from datetime import date, timedelta

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DRAFT_DIR = PROJECT_ROOT / "draft_recipes"
TEMPLATE_PATH = DRAFT_DIR / "_TEMPLATE_Brouillons_menus.md"

def next_sunday(today: date) -> date:
    # weekday(): Monday=0 ... Sunday=6
    days_until_sun = (6 - today.weekday()) % 7
    if days_until_sun == 0:
        # If today is Sunday, generate for NEXT Sunday (avoid collisions)
        days_until_sun = 7
    return today + timedelta(days=days_until_sun)

def build_week_dates(start_sun: date) -> dict:
    # Your week definition: Sunday -> Friday
    d0 = start_sun
    return {
        "start": d0,
        "end": d0 + timedelta(days=5),  # Friday
        "dimanche": d0,
        "lundi": d0 + timedelta(days=1),
        "mardi": d0 + timedelta(days=2),
        "mercredi": d0 + timedelta(days=3),
        "jeudi": d0 + timedelta(days=4),
        "vendredi": d0 + timedelta(days=5),
    }

def ddmm(d: date) -> str:
    return d.strftime("%d/%m")

def iso(d: date) -> str:
    return d.strftime("%Y-%m-%d")

def render_template(tpl: str, dates: dict) -> str:
    periode = f"Du {ddmm(dates['start'])} au {ddmm(dates['end'])}"
    out = tpl
    out = out.replace("{PERIODE_TEXTE}", periode)
    out = out.replace("{DATE_START_ISO}", iso(dates["start"]))
    out = out.replace("{DATE_END_ISO}", iso(dates["end"]))
    out = out.replace("{DIMANCHE_DDMM}", ddmm(dates["dimanche"]))
    out = out.replace("{LUNDI_DDMM}", ddmm(dates["lundi"]))
    out = out.replace("{MARDI_DDMM}", ddmm(dates["mardi"]))
    out = out.replace("{MERCREDI_DDMM}", ddmm(dates["mercredi"]))
    out = out.replace("{JEUDI_DDMM}", ddmm(dates["jeudi"]))
    out = out.replace("{VENDREDI_DDMM}", ddmm(dates["vendredi"]))
    return out

def main() -> int:
    DRAFT_DIR.mkdir(parents=True, exist_ok=True)

    if not TEMPLATE_PATH.exists():
        print(f"ERROR: Template missing: {TEMPLATE_PATH}")
        return 2

    start = next_sunday(date.today())
    dates = build_week_dates(start)

    filename = f"{iso(dates['start'])}_to_{iso(dates['end'])}_Brouillons_menus.md"
    out_path = DRAFT_DIR / filename

    if out_path.exists():
        print(f"INFO: Draft already exists: {out_path}")
        return 0

    tpl = TEMPLATE_PATH.read_text(encoding="utf-8")
    content = render_template(tpl, dates)
    out_path.write_text(content, encoding="utf-8")

    print(f"OK: Created weekly draft: {out_path}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
