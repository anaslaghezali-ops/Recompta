#!/usr/bin/env python3
"""Tests des métriques du harnais d'évaluation (evals/metrics.py)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from evals.metrics import (
    build_report,
    check_thresholds,
    evaluate_case,
    render_markdown,
    summarize,
)
from models import ExtractionResult, InvoiceLine


def make_line(**overrides: object) -> InvoiceLine:
    data = {
        "fact_num": "F-1",
        "designation": "MATIERES CONSOMMABLES",
        "m_ht": 100.0,
        "tva": 20.0,
        "m_ttc": 120.0,
        "taux": 0.2,
        "id_paie": 4,
        "date_paie": None,
        "date_fac": None,
        "lib_frss": "FOURNISSEUR TEST",
        "ice_frs": "000000000000001",
        "if_fournisseur": "123456",
    }
    data.update(overrides)
    return InvoiceLine.model_validate(data)


def make_result(*lines: InvoiceLine) -> ExtractionResult:
    return ExtractionResult(filename="test.pdf", lines=list(lines), engine="text")


EXPECTED = {
    "line_count": 1,
    "lines": [
        {
            "fact_num": "F-1",
            "lib_frss_contains": "FOURNISSEUR",
            "ice_frs": "000000000000001",
            "if": "123456",
            "m_ht": 100.0,
            "taux": 0.2,
        }
    ],
}


def test_case_passes_with_partial_truth() -> None:
    outcome = evaluate_case("case_ok", "test.pdf", EXPECTED, make_result(make_line()))
    assert outcome.ok
    assert outcome.missed_lines == 0
    assert outcome.fields_total == len(EXPECTED["lines"][0]) + 1  # + line_count
    assert outcome.fields_ok == outcome.fields_total


def test_amount_tolerance() -> None:
    outcome = evaluate_case("case_tol", "test.pdf", EXPECTED, make_result(make_line(m_ht=100.4)))
    assert outcome.ok
    outcome = evaluate_case("case_tol2", "test.pdf", EXPECTED, make_result(make_line(m_ht=101.0)))
    assert not outcome.ok


def test_missing_line_fails_case() -> None:
    expected = {"lines": [{"m_ht": 999.0}]}
    outcome = evaluate_case("case_missing", "test.pdf", expected, make_result(make_line()))
    assert not outcome.ok
    assert outcome.missed_lines == 1
    assert outcome.fields_ok == 0


def test_line_count_mismatch_fails_case() -> None:
    expected = {"line_count": 2, "lines": [{"m_ht": 100.0}]}
    outcome = evaluate_case("case_count", "test.pdf", expected, make_result(make_line()))
    assert not outcome.ok
    line_count_check = next(check for check in outcome.field_checks if check.field == "line_count")
    assert not line_count_check.ok


def test_missed_document() -> None:
    outcome = evaluate_case("case_empty", "test.pdf", EXPECTED, make_result())
    assert outcome.missed_document
    assert not outcome.ok


def test_extra_lines_counted() -> None:
    expected = {"lines": [{"m_ht": 100.0}]}
    result = make_result(make_line(), make_line(fact_num="F-2", m_ht=50.0, tva=10.0, m_ttc=60.0))
    outcome = evaluate_case("case_extra", "test.pdf", expected, result)
    assert outcome.ok  # ligne attendue retrouvée, l'extra est du bruit mesuré
    assert outcome.extra_lines == 1


def test_summarize_and_thresholds() -> None:
    good = evaluate_case("good", "a.pdf", EXPECTED, make_result(make_line()))
    bad = evaluate_case("bad", "b.pdf", EXPECTED, make_result())
    summary = summarize([good, bad])
    assert summary["documents"] == 2
    assert summary["documents_passed"] == 1
    assert summary["document_pass_rate"] == 0.5
    assert summary["missed_documents"] == 1
    assert summary["field_accuracy"] == 0.5
    assert summary["line_recall"] == 0.5

    failures = check_thresholds(summary, {"document_pass_rate_min": 0.9})
    assert len(failures) == 1
    assert check_thresholds(summary, {"document_pass_rate_min": 0.5}) == []


def test_render_markdown_and_report() -> None:
    outcome = evaluate_case("doc_ok", "facture.pdf", EXPECTED, make_result(make_line()))
    report = build_report([outcome], corpus="corpus", mode="test", generated_at="2026-01-01T00:00:00Z")
    markdown = render_markdown(report)
    assert "# Rapport d'évaluation Recompta" in markdown
    assert "facture.pdf" in markdown
    assert report["summary"]["document_pass_rate"] == 1.0


def test_latency_percentile_is_robust() -> None:
    from evals.metrics import percentile

    assert percentile([], 0.95) == 0.0
    assert percentile([10.0], 0.95) == 10.0
    assert percentile([1.0, 2.0, 3.0, 4.0], 0.5) == 3.0


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
