#!/usr/bin/env python3
"""Teste l'extraction sur les factures déposées dans invoices/upload/."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from invoice_extractor import extract_invoice

UPLOAD_DIR = Path(__file__).parent.parent / "invoices" / "upload"
ALLOWED = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tiff"}
MIME = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".tiff": "image/tiff",
}


async def main() -> int:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    files = [f for f in sorted(UPLOAD_DIR.iterdir()) if f.suffix.lower() in ALLOWED]

    if not files:
        print(f"Aucune facture dans {UPLOAD_DIR}")
        print("Déposez vos PDF ou images scannées dans ce dossier, puis relancez.")
        return 1

    for path in files:
        print(f"\n{'='*60}")
        print(path.name)
        result = await extract_invoice(path.name, path.read_bytes(), MIME[path.suffix.lower()])
        print(f"Confiance: {result.confidence}")
        if result.warnings:
            print("Alertes:", result.warnings)
        for i, line in enumerate(result.lines, 1):
            data = line.model_dump(by_alias=True)
            data["designation"] = line.designation.value
            print(f"  L{i}:", data)

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
