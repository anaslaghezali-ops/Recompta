#!/usr/bin/env python3
"""Tests déduplication worker : source_id unique vs basename identique."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from import_job_worker import (  # noqa: E402
    _merge_workspace_lines,
    _processed_invoice_keys,
    _work_item_already_processed,
    persist_source_document,
)


def test_same_basename_different_source_ids() -> None:
    processed = _processed_invoice_keys(
        [{"source_file": "Scanned.pdf", "source_id": "src-aaa"}],
    )
    assert _work_item_already_processed(
        {"filename": "Scanned.pdf", "source_id": "src-bbb"},
        processed,
    ) is False
    assert _work_item_already_processed(
        {"filename": "Scanned.pdf", "source_id": "src-aaa"},
        processed,
    ) is True


def test_merge_preserves_distinct_lines() -> None:
    existing = [{"source_file": "a.pdf", "source_id": "src-1", "m_ht": 100}]
    new_lines = [
        {"source_file": "b.pdf", "source_id": "src-2", "m_ht": 200},
        {"source_file": "c.pdf", "source_id": "src-3", "m_ht": 300},
    ]
    merged = _merge_workspace_lines(existing, new_lines)
    assert len(merged) == 3
    ids = {line["source_id"] for line in merged}
    assert ids == {"src-1", "src-2", "src-3"}


def test_merge_keeps_multi_vat_same_source_id() -> None:
    """Facture MPRO : 2 taux (10 % + 20 %) sur le même PDF / source_id."""
    new_lines = [
        {
            "source_file": "MPRO/scan.pdf",
            "source_id": "src-mpro",
            "fact_num": "F1",
            "taux": 0.2,
            "m_ht": 1070.0,
            "tva": 214.0,
            "m_ttc": 1284.0,
        },
        {
            "source_file": "MPRO/scan.pdf",
            "source_id": "src-mpro",
            "fact_num": "F1",
            "taux": 0.1,
            "m_ht": 409.09,
            "tva": 40.91,
            "m_ttc": 450.0,
        },
    ]
    merged = _merge_workspace_lines([], new_lines)
    assert len(merged) == 2, merged
    rates = sorted(line["taux"] for line in merged)
    assert rates == [0.1, 0.2]


def test_analysis_jobs_do_not_rewrite_source_documents() -> None:
    assert persist_source_document({"options": {"analysis_from_documents": True}}) is False
    assert persist_source_document({"options": {}}) is True
    assert persist_source_document({}) is True


def test_merge_skips_exact_duplicate_line() -> None:
    line = {
        "source_file": "scan.pdf",
        "source_id": "src-1",
        "fact_num": "F1",
        "taux": 0.2,
        "m_ht": 100.0,
    }
    merged = _merge_workspace_lines([line], [line.copy()])
    assert len(merged) == 1


def main() -> int:
    test_same_basename_different_source_ids()
    test_merge_preserves_distinct_lines()
    test_merge_keeps_multi_vat_same_source_id()
    test_merge_skips_exact_duplicate_line()
    test_analysis_jobs_do_not_rewrite_source_documents()
    print("OK test_worker_dedup")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
