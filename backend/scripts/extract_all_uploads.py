#!/usr/bin/env python3
"""Extrait toutes les factures du dossier upload (récursif) et génère un rapport."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from excel_export import export_filename, export_to_bytes
from invoice_extractor import extract_invoice, merge_extractions
from models import ExportRequest

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
    files = sorted(
        f for f in UPLOAD_DIR.rglob("*") if f.is_file() and f.suffix.lower() in ALLOWED
    )
    if not files:
        print(f"Aucune facture dans {UPLOAD_DIR}")
        return 1

    print(f"Traitement de {len(files)} fichier(s)...\n")
    results = []
    for path in files:
        rel = path.relative_to(UPLOAD_DIR)
        print(f"{'='*60}\n{rel}")
        result = await extract_invoice(path.name, path.read_bytes(), MIME[path.suffix.lower()])
        results.append(result)
        print(f"  Confiance: {result.confidence} | Lignes: {len(result.lines)}")
        if result.warnings:
            print(f"  Alertes: {result.warnings}")
        for i, line in enumerate(result.lines, 1):
            print(
                f"  L{i}: {line.fact_num} | {line.lib_frss} | ICE {line.ice_frs} | "
                f"HT {line.m_ht} | TVA {line.tva} @ {line.taux*100:.0f}% | "
                f"{line.date_fac}"
            )

    lines = merge_extractions(results)
    print(f"\n{'='*60}")
    print(f"TOTAL: {len(lines)} ligne(s) extraites sur {len(files)} fichier(s)")

    if lines:
        request = ExportRequest(client_name="Aichoum", period="062026", lines=lines)
        out = Path(__file__).parent / "output_real_invoices.xlsx"
        out.write_bytes(export_to_bytes(request))
        print(f"Excel généré: {out} ({export_filename('Aichoum', '062026')})")

        report = Path(__file__).parent / "extraction_report.json"
        report.write_text(
            json.dumps(
                [r.model_dump() for r in results],
                indent=2,
                ensure_ascii=False,
                default=str,
            ),
            encoding="utf-8",
        )
        print(f"Rapport JSON: {report}")

    empty = sum(1 for r in results if not r.lines)
    if empty:
        print(f"\n⚠ {empty} fichier(s) sans extraction — vérification manuelle requise")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
