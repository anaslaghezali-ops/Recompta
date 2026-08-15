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


def main() -> int:
    test_same_basename_different_source_ids()
    test_merge_preserves_distinct_lines()
    print("OK test_worker_dedup")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
