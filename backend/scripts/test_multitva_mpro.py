#!/usr/bin/env python3
"""Facture MPRO : 1284 TTC 20% + 450 TTC 10%."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import ExtractionResult, InvoiceLine
from vat_intelligence import extract_vat_lines_from_text, ventilation_marker_count
from vat_multi_rate import should_replace_with_ventilation, try_apply_ventilation_from_text

SAMPLE = """
Ventilation de la TVA
11) 1284,00TTC 20,00% 214,00 DH
13) 450,00TTC 10,00% 40,91 DH
Total HT 1479,09 DH
Total Taxes 254,91 DH
Total TTC 1734,00 DH
"""


def test_parse_two_rates() -> None:
    lines = extract_vat_lines_from_text(SAMPLE)
    assert len(lines) == 2, lines
    rates = sorted(row["taux"] for row in lines)
    assert rates == [0.1, 0.2]


def test_replace_single_ai_line() -> None:
    result = ExtractionResult(
        filename="scan.pdf",
        raw_text=SAMPLE,
        lines=[
            InvoiceLine(
                fact_num="F1",
                m_ht=1070.0,
                tva=214.0,
                m_ttc=1284.0,
                taux=0.2,
                lib_frss="MPRO",
            )
        ],
    )
    assert ventilation_marker_count(SAMPLE) >= 2
    updated, applied = try_apply_ventilation_from_text(result, SAMPLE)
    assert applied, updated.warnings
    assert len(updated.lines) == 2
    assert sorted(line.taux for line in updated.lines) == [0.1, 0.2]


def main() -> None:
    test_parse_two_rates()
    test_replace_single_ai_line()
    print("OK test_multitva_mpro")


if __name__ == "__main__":
    main()
