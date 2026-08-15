#!/usr/bin/env python3
"""Compare le pipeline workspace (Python seul) pour un PDF donné.

production.html applique en plus normalizeExtractionResults() côté JS — cette
passe n'est pas reproduite ici. Utiliser ce script pour isoler extract_invoice
+ normalize_extraction_results avant merge worker.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from invoice_extractor import extract_invoice
from normalize_results import normalize_extraction_results


def _summarize(result) -> dict:
    return {
        "filename": result.filename,
        "engine": result.engine,
        "line_count": len(result.lines or []),
        "warnings": list(result.warnings or [])[:5],
        "lines": [
            {
                "fact_num": line.fact_num,
                "lib_frss": line.lib_frss,
                "taux": line.taux,
                "m_ht": line.m_ht,
                "tva": line.tva,
                "m_ttc": line.m_ttc,
            }
            for line in (result.lines or [])
        ],
    }


async def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python compare_extraction_paths.py <facture.pdf>")
        return 1

    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"Fichier introuvable: {path}")
        return 1

    content = path.read_bytes()
    raw = await extract_invoice(path.name, content, "application/pdf")
    normalized = normalize_extraction_results([raw])[0]

    report = {
        "note": "Workspace = after_normalize. production.html ajoute encore normalizeExtractionResults() JS.",
        "after_extract": _summarize(raw),
        "after_normalize": _summarize(normalized),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
