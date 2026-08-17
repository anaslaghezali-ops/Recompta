"""Compteurs workspace — miroir de docs/workspace-summary.js et private.workspace_anomaly_count."""

from __future__ import annotations

from typing import Any

LINE_REVIEW_VERIFIED = "__line_review__"
SOFT_REVIEW_FIELDS = frozenset({"date_paie", "if"})


def is_line_review_verified(line: dict[str, Any] | None) -> bool:
    fields = (line or {}).get("user_verified_fields") or []
    return isinstance(fields, list) and LINE_REVIEW_VERIFIED in fields


def count_anomalies_from_stored_confidence(lines: list[dict[str, Any]] | None) -> int:
    count = 0
    for line in lines or []:
        if is_line_review_verified(line):
            continue
        conf = line.get("field_confidence") or {}
        if not isinstance(conf, dict):
            continue
        for field, entry in conf.items():
            if not isinstance(entry, dict):
                continue
            level = entry.get("level")
            if level == "error":
                count += 1
                break
            if level == "warn" and field not in SOFT_REVIEW_FIELDS:
                count += 1
                break
    return count


def workspace_summary_from_row(row: dict[str, Any] | None) -> dict[str, Any]:
    if not row:
        return {"line_count": 0, "bank_count": 0, "anomaly_count": 0, "updated_at": None}
    if row.get("line_count") is not None or row.get("lineCount") is not None:
        return {
            "line_count": int(row.get("lineCount", row.get("line_count")) or 0),
            "bank_count": int(row.get("bankCount", row.get("bank_count")) or 0),
            "anomaly_count": int(row.get("anomalyCount", row.get("anomaly_count")) or 0),
            "updated_at": row.get("updated_at"),
        }
    lines = row.get("lines") if isinstance(row.get("lines"), list) else []
    bank = row.get("bank_transactions") if isinstance(row.get("bank_transactions"), list) else []
    return {
        "line_count": len(lines),
        "bank_count": len(bank),
        "anomaly_count": count_anomalies_from_stored_confidence(lines),
        "updated_at": row.get("updated_at"),
    }


def build_fake_invoice_lines(count: int, *, anomaly_every: int = 10) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    for index in range(1, count + 1):
        is_anomaly = anomaly_every > 0 and index % anomaly_every == 0
        lines.append(
            {
                "fact_num": f"FAKE-{index:05d}",
                "lib_frss": f"FOURNISSEUR TEST {index}",
                "ice_frs": "" if is_anomaly else "000000000000001",
                "if": "",
                "designation": "MATIERES CONSOMMABLES",
                "m_ht": 100,
                "tva": 20,
                "m_ttc": 120,
                "taux": 0.2,
                "date_fac": "2026-08-01",
                "date_paie": "",
                "field_confidence": {
                    "fact_num": {"level": "ok", "reason": "Présent"},
                    "lib_frss": {"level": "ok", "reason": "Présent"},
                    "ice_frs": (
                        {"level": "error", "reason": "ICE manquant (jeu de test)"}
                        if is_anomaly
                        else {"level": "ok", "reason": "Présent"}
                    ),
                    "designation": {"level": "ok", "reason": "Présent"},
                    "m_ht": {"level": "ok", "reason": "Cohérent"},
                    "tva": {"level": "ok", "reason": "Cohérent"},
                    "m_ttc": {"level": "ok", "reason": "Cohérent"},
                    "taux": {"level": "ok", "reason": "20 %"},
                    "date_paie": {"level": "warn", "reason": "Date de paiement absente"},
                },
            }
        )
    return lines


def build_fake_bank_transactions(count: int) -> list[dict[str, Any]]:
    return [
        {"date": "2026-08-01", "label": f"Virement test {index}", "amount": -120}
        for index in range(1, count + 1)
    ]


def estimate_payload_bytes(lines: list[dict[str, Any]], bank: list[dict[str, Any]]) -> int:
    import json

    return len(json.dumps({"lines": lines, "bank_transactions": bank}, ensure_ascii=False).encode("utf-8"))
