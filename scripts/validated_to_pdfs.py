#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

from pathlib import Path
from datetime import datetime
import re

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.lib import utils

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = PROJECT_ROOT / "validated_recipes"
OUT_DIR = PROJECT_ROOT / "validated_pdfs"

def safe_filename(name: str) -> str:
    name = name.strip()
    name = re.sub(r"[^\w\s.-]", "", name, flags=re.UNICODE)
    name = re.sub(r"[\s]+", "_", name)
    return (name[:120] or "recette") + ".pdf"

def extract_title(md_text: str, fallback: str) -> str:
    # Try "### [VALIDEE] Title"
    m = re.search(r"^###\s*\[VALIDEE\]\s*(.+)\s*$", md_text, flags=re.M)
    if m:
        return m.group(1).strip()
    # Try first non-empty line
    for line in md_text.splitlines():
        line = line.strip()
        if line:
            return re.sub(r"^#+\s*", "", line).strip() or fallback
    return fallback

def md_to_flowables(md_text: str, title: str):
    styles = getSampleStyleSheet()

    style_title = ParagraphStyle(
        "TitleCustom",
        parent=styles["Title"],
        alignment=TA_LEFT,
        spaceAfter=12,
    )
    style_h = ParagraphStyle(
        "HeadingCustom",
        parent=styles["Heading2"],
        alignment=TA_LEFT,
        spaceBefore=10,
        spaceAfter=6,
    )
    style_body = ParagraphStyle(
        "BodyCustom",
        parent=styles["BodyText"],
        alignment=TA_LEFT,
        leading=14,
        spaceAfter=4,
    )
    style_mono = ParagraphStyle(
        "MonoCustom",
        parent=styles["BodyText"],
        fontName="Courier",
        leading=13,
        spaceAfter=2,
    )

    flow = []
    flow.append(Paragraph(utils.escape(title), style_title))
    flow.append(Paragraph(utils.escape(f"Genere le {datetime.now().strftime('%Y-%m-%d %H:%M')}"), styles["Normal"]))
    flow.append(Spacer(1, 12))

    lines = md_text.splitlines()

    # Very simple markdown-ish rendering:
    # - Lines like "Ingredients", "Preparation", etc. treated as headings if they match known section names
    section_like = re.compile(r"^(Titre|Description|Ingredients|Preparation|Cuisson|Finition|Service|Conseils|Variantes)\b", re.I)

    in_list = False
    for raw in lines:
        line = raw.rstrip()

        # Skip the header we already used as title
        if re.match(r"^###\s*\[VALIDEE\]\s*.+$", line):
            continue

        if not line.strip():
            flow.append(Spacer(1, 6))
            in_list = False
            continue

        # Markdown headings
        if line.lstrip().startswith("#"):
            txt = re.sub(r"^#+\s*", "", line).strip()
            flow.append(Paragraph(utils.escape(txt), style_h))
            in_list = False
            continue

        # Section-like labels (ASCII-safe style)
        if section_like.match(line.strip()):
            flow.append(Paragraph(utils.escape(line.strip()), style_h))
            in_list = False
            continue

        # Bullets
        if re.match(r"^\s*-\s+", line):
            txt = re.sub(r"^\s*-\s+", "• ", line).strip()
            flow.append(Paragraph(utils.escape(txt), style_body))
            in_list = True
            continue

        # Numbered steps (keep mono-ish for readability)
        if re.match(r"^\s*\d+\.\s+", line):
            flow.append(Paragraph(utils.escape(line.strip()), style_mono))
            in_list = False
            continue

        # Default paragraph
        flow.append(Paragraph(utils.escape(line.strip()), style_body))
        in_list = False

    return flow

def build_pdf(md_path: Path, pdf_path: Path) -> None:
    md_text = md_path.read_text(encoding="utf-8", errors="ignore")
    title = extract_title(md_text, md_path.stem)

    doc = SimpleDocTemplate(
        str(pdf_path),
        pagesize=A4,
        leftMargin=2*cm,
        rightMargin=2*cm,
        topMargin=2*cm,
        bottomMargin=2*cm,
        title=title,
        author="meal-planner",
    )
    flow = md_to_flowables(md_text, title)
    doc.build(flow)

def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    SRC_DIR.mkdir(parents=True, exist_ok=True)

    md_files = sorted([p for p in SRC_DIR.glob("*.md") if p.is_file()])
    if not md_files:
        print("INFO: No validated_recipes/*.md found. Nothing to render.")
        return 0

    created = 0
    skipped = 0

    for md in md_files:
        md_text = md.read_text(encoding="utf-8", errors="ignore")
        title = extract_title(md_text, md.stem)
        pdf_name = safe_filename(title)
        pdf = OUT_DIR / pdf_name

        # Skip if up-to-date
        if pdf.exists() and pdf.stat().st_mtime >= md.stat().st_mtime:
            print(f"INFO: Up-to-date, skip: {pdf.name}")
            skipped += 1
            continue

        build_pdf(md, pdf)
        print(f"OK: PDF generated: {pdf.name}")
        created += 1

    print(f"OK: Done. created={created}, skipped={skipped}, out={OUT_DIR}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
