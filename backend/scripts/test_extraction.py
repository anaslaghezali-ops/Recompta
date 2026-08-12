#!/usr/bin/env python3
"""Test d'extraction sur les factures PDF de test."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from invoice_extractor import extract_invoice

INVOICES_DIR = Path(__file__).parent / "invoices"

# Valeurs attendues (première ligne ou totaux selon le cas)
EXPECTED = {
    "achibest_FV26-023806.pdf": {
        "fact_num": "FV26-023806",
        "lib_frss_contains": "ACHIBEST",
        "ice_frs": "000229475000050",
        "if": "1102277",
        "line_count": 2,
        "lines": [
            {"m_ht": 932.98, "taux": 0.1},
            {"m_ht": 4380.68, "taux": 0.2},
        ],
    },
    "orange_F-0626-0465400.pdf": {
        "fact_num": "F-0626-0465400",
        "lib_frss_contains": "ORANGE",
        "ice_frs": "001524628000001",
        "designation": "TELEPHONIE",
        "m_ht": 249.17,
        "taux": 0.2,
    },
    "glovo_MA-FVR260000608.pdf": {
        "fact_num": "MA-FVR260000608",
        "lib_frss_contains": "GLOVO",
        "ice_frs": "002086928000050",
        "designation": "PRESTATIONS",
        "m_ht": 2895.50,
        "taux": 0.2,
    },
    "carrefour_303-22-06-2026.pdf": {
        "fact_num": "303/22-06-2026/001/78561",
        "ice_frs": "000078523000008",
        "m_ht": 150.0,
        "taux": 0.2,
    },
    "saham_releve_bancaire.pdf": {
        "fact_num": "RELEVE BANCAIRE",
        "designation": "FRAIS BANCAIRE",
        "m_ht": 114.58,
        "taux": 0.1,
    },
}


async def run() -> int:
    if not INVOICES_DIR.exists():
        print(f"Dossier introuvable: {INVOICES_DIR}")
        print("Lancez d'abord: python scripts/generate_sample_invoices.py")
        return 1

    pdfs = sorted(INVOICES_DIR.glob("*.pdf"))
    if not pdfs:
        print("Aucun PDF dans", INVOICES_DIR)
        return 1

    passed = 0
    failed = 0

    for pdf in pdfs:
        print(f"\n{'='*60}")
        print(f"Fichier: {pdf.name}")
        content = pdf.read_bytes()
        result = await extract_invoice(pdf.name, content, "application/pdf")

        print(f"Confiance: {result.confidence}")
        if result.warnings:
            print(f"Alertes: {result.warnings}")
        print(f"Lignes extraites: {len(result.lines)}")
        for i, line in enumerate(result.lines, 1):
            print(f"  L{i}: {line.model_dump(by_alias=True)}")

        exp = EXPECTED.get(pdf.name, {})
        errors = []
        if not result.lines:
            errors.append("Aucune ligne extraite")
        else:
            if "line_count" in exp and len(result.lines) != exp["line_count"]:
                errors.append(f"line_count: got {len(result.lines)}, expected {exp['line_count']}")

            if "lines" in exp:
                for idx, expected_line in enumerate(exp["lines"]):
                    if idx >= len(result.lines):
                        errors.append(f"ligne {idx+1} manquante")
                        continue
                    line = result.lines[idx]
                    if "m_ht" in expected_line and abs(line.m_ht - expected_line["m_ht"]) > 0.5:
                        errors.append(f"L{idx+1} m_ht: got {line.m_ht}, expected {expected_line['m_ht']}")
                    if "taux" in expected_line and line.taux != expected_line["taux"]:
                        errors.append(f"L{idx+1} taux: got {line.taux}, expected {expected_line['taux']}")
            else:
                line = result.lines[0]
                if "fact_num" in exp and line.fact_num != exp["fact_num"]:
                    errors.append(f"fact_num: got {line.fact_num!r}, expected {exp['fact_num']!r}")
                if "ice_frs" in exp and line.ice_frs != exp["ice_frs"]:
                    errors.append(f"ice_frs: got {line.ice_frs!r}, expected {exp['ice_frs']!r}")
                if "if" in exp and str(line.if_fournisseur) != str(exp["if"]):
                    errors.append(f"if: got {line.if_fournisseur!r}, expected {exp['if']!r}")
                if "designation" in exp and line.designation.value != exp["designation"]:
                    errors.append(f"designation: got {line.designation.value}, expected {exp['designation']}")
                if "m_ht" in exp and abs(line.m_ht - exp["m_ht"]) > 0.5:
                    errors.append(f"m_ht: got {line.m_ht}, expected {exp['m_ht']}")
                if "taux" in exp and line.taux != exp["taux"]:
                    errors.append(f"taux: got {line.taux}, expected {exp['taux']}")

            first = result.lines[0]
            if "fact_num" in exp and first.fact_num != exp["fact_num"]:
                errors.append(f"fact_num: got {first.fact_num!r}, expected {exp['fact_num']!r}")
            if "ice_frs" in exp and first.ice_frs != exp["ice_frs"]:
                errors.append(f"ice_frs: got {first.ice_frs!r}, expected {exp['ice_frs']!r}")
            if "if" in exp and str(first.if_fournisseur) != str(exp["if"]):
                errors.append(f"if: got {first.if_fournisseur!r}, expected {exp['if']!r}")
            if "lib_frss_contains" in exp and exp["lib_frss_contains"].upper() not in (first.lib_frss or "").upper():
                if exp["lib_frss_contains"].upper() not in result.raw_text.upper():
                    errors.append(f"fournisseur {exp['lib_frss_contains']} non trouvé")

        if errors:
            print("ECHEC:", "; ".join(errors))
            failed += 1
        else:
            print("OK")
            passed += 1

    print(f"\n{'='*60}")
    print(f"Résultat: {passed} OK, {failed} échec(s) sur {len(pdfs)} factures")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
