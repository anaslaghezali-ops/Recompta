#!/usr/bin/env python3
"""Tests de la fusion des deux lectures IA (ai_fusion.py)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ai_fusion import merge_ai_results
from models import ExtractionResult, InvoiceLine


def make_line(**overrides: object) -> InvoiceLine:
    data = {
        "fact_num": "FV-001",
        "designation": "MATIERES CONSOMMABLES",
        "m_ht": 100.0,
        "tva": 20.0,
        "m_ttc": 120.0,
        "taux": 0.2,
        "id_paie": 4,
        "date_paie": None,
        "date_fac": None,
        "lib_frss": "FOURNISSEUR",
        "ice_frs": "000000000000001",
        "if_fournisseur": "123456",
    }
    data.update(overrides)
    return InvoiceLine.model_validate(data)


def make_result(*lines: InvoiceLine, raw_text: str = "", warnings: list[str] | None = None) -> ExtractionResult:
    return ExtractionResult(
        filename="facture.pdf",
        lines=list(lines),
        raw_text=raw_text,
        confidence="high" if lines else "low",
        engine="ai",
        warnings=list(warnings or []),
    )


def test_fills_missing_fields_from_primary_reading() -> None:
    primary = make_line(ice_frs="000229475000050", if_fournisseur="1102277")
    secondary = make_line(ice_frs="", if_fournisseur="")
    merged = merge_ai_results(
        make_result(primary),
        make_result(secondary),
    )
    assert len(merged.lines) == 1
    assert merged.lines[0].ice_frs == "000229475000050"
    assert merged.lines[0].if_fournisseur == "1102277"
    assert merged.fusion["fields_filled"] == 2
    assert any("Fusion IA" in warning for warning in merged.warnings)


def test_evidence_wins_over_secondary_amounts() -> None:
    primary = make_line(m_ht=100.0, tva=20.0, m_ttc=120.0, evidence={"m_ht": "100,00"})
    secondary = make_line(m_ht=90.0, tva=18.0, m_ttc=108.0)
    merged = merge_ai_results(
        make_result(primary, raw_text="Total HT 100,00 TVA 20,00 TTC 120,00"),
        make_result(secondary, raw_text="Total HT 100,00 TVA 20,00 TTC 120,00"),
    )
    assert merged.lines[0].m_ht == 100.0
    assert merged.lines[0].tva == 20.0
    assert merged.fusion["evidence_wins"] >= 1


def test_coherent_primary_rescues_incoherent_secondary() -> None:
    primary = make_line(m_ht=100.0, tva=20.0, m_ttc=120.0)
    secondary = make_line(m_ht=100.0, tva=20.0, m_ttc=130.0)
    merged = merge_ai_results(make_result(primary), make_result(secondary))
    assert merged.lines[0].m_ttc == 120.0
    assert merged.fusion["coherence_rescues"] == 1


def test_unmatched_lines_are_kept_on_both_sides() -> None:
    primary = make_line(fact_num="A-1")
    extra_primary = make_line(fact_num="A-2", m_ht=50.0, tva=10.0, m_ttc=60.0)
    secondary = make_line(fact_num="A-1")
    extra_secondary = make_line(fact_num="A-3", m_ht=70.0, tva=14.0, m_ttc=84.0)
    merged = merge_ai_results(
        make_result(primary, extra_primary),
        make_result(secondary, extra_secondary),
    )
    facts = sorted(line.fact_num for line in merged.lines)
    assert facts == ["A-1", "A-2", "A-3"]
    assert merged.fusion["lines_only_primary"] == 1
    assert merged.fusion["lines_only_secondary"] == 1


def test_usage_is_summed() -> None:
    primary = make_result(make_line())
    primary.usage = {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}
    secondary = make_result(make_line())
    secondary.usage = {"prompt_tokens": 150, "completion_tokens": 30, "total_tokens": 180}
    merged = merge_ai_results(primary, secondary)
    assert merged.usage == {"prompt_tokens": 250, "completion_tokens": 50, "total_tokens": 300}


def test_empty_secondary_keeps_primary() -> None:
    primary = make_result(make_line())
    primary.warnings = ["avertissement principal"]
    merged = merge_ai_results(primary, make_result())
    assert len(merged.lines) == 1
    assert merged is primary
    assert any("lecture de secours vide" in warning for warning in merged.warnings)


def test_multi_rate_lines_are_aligned_by_fact_and_taux() -> None:
    primary_10 = make_line(m_ht=100.0, tva=10.0, m_ttc=110.0, taux=0.1)
    primary_20 = make_line(m_ht=200.0, tva=40.0, m_ttc=240.0, taux=0.2)
    secondary_20 = make_line(m_ht=200.0, tva=40.0, m_ttc=240.0, taux=0.2)
    secondary_10 = make_line(m_ht=100.0, tva=10.0, m_ttc=110.0, taux=0.1)
    merged = merge_ai_results(
        make_result(primary_10, primary_20),
        make_result(secondary_20, secondary_10),
    )
    assert len(merged.lines) == 2
    assert merged.fusion["lines_matched"] == 2
    by_taux = {round(line.taux, 2): line for line in merged.lines}
    assert by_taux[0.1].m_ht == 100.0
    assert by_taux[0.2].m_ht == 200.0


def test_result_is_marked_ai_with_fusion_trace() -> None:
    merged = merge_ai_results(make_result(make_line()), make_result(make_line()))
    assert merged.engine == "ai"
    assert merged.confidence == "high"
    assert isinstance(merged.fusion, dict)
    assert merged.fusion["lines_matched"] == 1


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failures = 0
    for test in tests:
        try:
            test()
            print(f"OK   {test.__name__}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {test.__name__}: {exc}")
    print(f"\n{len(tests) - failures}/{len(tests)} tests réussis")
    raise SystemExit(0 if failures == 0 else 1)
