#!/usr/bin/env python3
"""PDF texte vs scan : le scan ne doit jamais passer par Tesseract."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from invoice_extractor import (
    SCAN_REQUIRES_AI_WARNING,
    extract_invoice,
    is_meaningful_pdf_text,
    pdf_is_scanned,
)

SAMPLE_TEXT = Path(__file__).parent / "invoices" / "carrefour_303-22-06-2026.pdf"
SAMPLE_SCAN = Path(__file__).parent.parent / "invoices" / "upload" / "achibest" / "Scanned 15_07_2026 at 15_14_39.pdf"


async def main() -> int:
    text_pdf = SAMPLE_TEXT.read_bytes()
    assert not pdf_is_scanned(text_pdf), "Carrefour doit être un PDF texte"

    scan_pdf = SAMPLE_SCAN.read_bytes()
    assert pdf_is_scanned(scan_pdf), "Achibest scan doit être détecté comme scan"

    assert is_meaningful_pdf_text(
        "Facture FV26-023806\nICE 000229475000050\nTotal HT 1500,00\nTotal TVA 300,00\nTotal TTC 1800,00"
    )

    text_result = await extract_invoice("carrefour.pdf", text_pdf, "application/pdf")
    assert text_result.engine == "text", text_result.engine
    assert text_result.lines, "PDF texte doit produire des lignes"

    scan_result = await extract_invoice("scan.pdf", scan_pdf, "application/pdf")
    assert scan_result.engine == "scan", scan_result.engine
    assert scan_result.lines == []
    assert any(SCAN_REQUIRES_AI_WARNING in w for w in scan_result.warnings)

    img_result = await extract_invoice("photo.jpg", b"\xff\xd8\xff", "image/jpeg")
    assert img_result.engine == "scan"
    assert img_result.lines == []

    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
