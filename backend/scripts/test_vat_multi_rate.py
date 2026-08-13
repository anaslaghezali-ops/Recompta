#!/usr/bin/env python3
"""Tests ventilation multi-taux."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from models import ExtractionResult, InvoiceLine
from vat_intelligence import result_needs_escalation
from vat_multi_rate import (
    apply_multi_rate_postprocess,
    expand_lines_from_ventilation,
    line_has_blended_rate,
    result_has_blended_summary,
    try_apply_ventilation_from_text,
)


def line(**kwargs) -> InvoiceLine:
    defaults = {
        "fact_num": "F-100",
        "designation": "MATIERES CONSOMMABLES",
        "m_ht": 1000.0,
        "tva": 175.0,
        "m_ttc": 1175.0,
        "taux": 0.2,
        "lib_frss": "FOURNISSEUR",
        "ice_frs": "002345678000012",
    }
    defaults.update(kwargs)
    return InvoiceLine(**defaults)


def main() -> int:
    blended = line()
    assert line_has_blended_rate(blended)
    assert result_has_blended_summary(
        ExtractionResult(filename="x.pdf", lines=[blended], engine="ai")
    )
    assert result_needs_escalation(ExtractionResult(filename="x.pdf", lines=[blended], engine="ai"))

    ok = line(m_ht=1000.0, tva=200.0, m_ttc=1200.0, taux=0.2)
    assert not line_has_blended_rate(ok)

    ventilation = [
        {"m_ht": 400.0, "tva": 40.0, "m_ttc": 440.0, "taux": 0.1},
        {"m_ht": 600.0, "tva": 120.0, "m_ttc": 720.0, "taux": 0.2},
    ]
    expanded = expand_lines_from_ventilation(blended, ventilation)
    assert len(expanded) == 2
    assert expanded[0].taux == 0.1 and expanded[1].taux == 0.2

    text = """
    Taux Montant HT TVA
    10,00 400,00 40,00
    20,00 600,00 120,00
    Total TTC 1160,00
    """
    result = ExtractionResult(filename="f.pdf", lines=[blended], engine="ai")
    updated, applied = try_apply_ventilation_from_text(result, text)
    assert applied
    assert len(updated.lines) == 2
    assert not result_has_blended_summary(updated)

    still_blended = apply_multi_rate_postprocess(
        ExtractionResult(filename="f.pdf", lines=[blended], engine="ai")
    )
    assert result_has_blended_summary(still_blended)
    assert any("17,5" in w or "plusieurs taux" in w for w in still_blended.warnings)

    print("OK test_vat_multi_rate")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
