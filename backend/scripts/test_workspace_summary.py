#!/usr/bin/env python3
"""Tests compteurs portefeuille — aucun appel IA / réseau."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from workspace_summary import (
    build_fake_bank_transactions,
    build_fake_invoice_lines,
    count_anomalies_from_stored_confidence,
    estimate_payload_bytes,
    workspace_summary_from_row,
)


def test_counts_fake_volume() -> None:
    lines = build_fake_invoice_lines(200, anomaly_every=10)
    bank = build_fake_bank_transactions(80)
    assert len(lines) == 200
    assert count_anomalies_from_stored_confidence(lines) == 20

    summary = workspace_summary_from_row(
        {"line_count": 200, "bank_count": 80, "anomaly_count": 20, "updated_at": "2026-08-01"}
    )
    assert summary["line_count"] == 200
    assert summary["bank_count"] == 80
    assert summary["anomaly_count"] == 20

    from_json = workspace_summary_from_row({"lines": lines, "bank_transactions": bank})
    assert from_json["line_count"] == 200
    assert from_json["bank_count"] == 80
    assert from_json["anomaly_count"] == 20

    full = estimate_payload_bytes(lines, bank)
    summary_json = json.dumps(
        {"line_count": 200, "bank_count": 80, "anomaly_count": 20},
        ensure_ascii=False,
    ).encode("utf-8")
    assert full > 20_000
    assert len(summary_json) < 120
    assert full > len(summary_json) * 50


def test_verified_line_ignored() -> None:
    lines = build_fake_invoice_lines(10, anomaly_every=10)
    assert count_anomalies_from_stored_confidence(lines) == 1
    lines[-1]["user_verified_fields"] = ["__line_review__"]
    assert count_anomalies_from_stored_confidence(lines) == 0


def test_soft_date_paie_not_counted() -> None:
    line = {
        "field_confidence": {
            "date_paie": {"level": "warn", "reason": "absente"},
            "if": {"level": "warn", "reason": "absent"},
        }
    }
    assert count_anomalies_from_stored_confidence([line]) == 0


def test_empty_workspace() -> None:
    summary = workspace_summary_from_row(None)
    assert summary == {"line_count": 0, "bank_count": 0, "anomaly_count": 0, "updated_at": None}


def main() -> int:
    test_counts_fake_volume()
    test_verified_line_ignored()
    test_soft_date_paie_not_counted()
    test_empty_workspace()
    print("test_workspace_summary: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
