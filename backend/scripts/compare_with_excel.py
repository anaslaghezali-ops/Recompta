#!/usr/bin/env python3
"""Compare les extractions avec les valeurs attendues du fichier Excel Aichoum."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).parent.parent))

REPORT = Path(__file__).parent / "extraction_report.json"
EXCEL_REF = Path("/home/ubuntu/.cursor/projects/workspace/uploads/Aichoum_DED_TVA_062026_2227.xlsx")

# Correspondance facture scannée → numéro attendu (déduite du contenu OCR / Excel)
INVOICE_MAP = {
    "V081505": "Scanned 15_07_2026 at 15_15_11.pdf",
    "V081351": "Scanned 15_07_2026 at 15_15_20.pdf",
    "V081784": "Scanned 15_07_2026 at 15_15_29.pdf",
    "V082263": "Scanned 15_07_2026 at 15_15_39.pdf",
    "FV26-027494": "Scanned 15_07_2026 at 15_14_58.pdf",
    "FV26-025163": "Scanned 15_07_2026 at 15_14_39.pdf",
    "FV26-023806": "Scanned 15_07_2026 at 15_14_48.pdf",
}


def load_excel_refs() -> dict[str, list[dict]]:
    wb = openpyxl.load_workbook(EXCEL_REF, data_only=True)
    ws = wb["EDI0626"]
    refs: dict[str, list[dict]] = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row[1]:
            continue
        fact = str(row[1]).strip()
        refs.setdefault(fact, []).append(
            {"ht": float(row[3]), "tva": float(row[4]), "taux": float(row[9]), "frss": row[7]}
        )
    return refs


def main() -> None:
    if not REPORT.exists():
        print("Lancez d'abord: python scripts/extract_all_uploads.py")
        return

    refs = load_excel_refs()
    data = json.loads(REPORT.read_text(encoding="utf-8"))

    print("COMPARAISON AVEC EXCEL AICHOUM\n")
    matches = 0
    checks = 0

    for result in data:
        for line in result["lines"]:
            fact = line["fact_num"]
            if fact not in refs:
                continue
            expected_list = refs[fact]
            ht = line["m_ht"]
            taux = line["taux"]
            for exp in expected_list:
                if abs(exp["ht"] - ht) < 1.0 and exp["taux"] == taux:
                    matches += 1
                    checks += 1
                    print(f"✓ {fact} | {line['lib_frss']} | HT {ht} @ {taux*100:.0f}% — conforme Excel")
                    break
            else:
                checks += 1
                exp_hts = [f"HT {e['ht']} @ {e['taux']*100:.0f}%" for e in expected_list]
                print(f"? {fact} | HT {ht} @ {taux*100:.0f}% — attendu: {', '.join(exp_hts)}")

    print(f"\n{matches}/{checks} lignes conformes à l'Excel de référence")


if __name__ == "__main__":
    main()
