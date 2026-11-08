#!/usr/bin/env python3
"""Tests de la sortie structurée IA et des métadonnées de preuve."""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ai_structured
from invoice_extractor import _parse_ai_lines


def test_response_format_is_strict_json_schema() -> None:
    os.environ.pop("AI_STRUCTURED_OUTPUT", None)
    response_format = ai_structured.build_response_format()
    assert response_format["type"] == "json_schema"
    schema = response_format["json_schema"]
    assert schema["strict"] is True
    params = schema["schema"]
    assert params["additionalProperties"] is False
    assert "lines" in params["required"]
    line_schema = params["properties"]["lines"]["items"]
    assert "evidence" in line_schema["required"]
    assert "field_confidence" in line_schema["required"]
    evidence = line_schema["properties"]["evidence"]
    assert evidence["additionalProperties"] is False
    assert "ice_frs" in evidence["required"]


def test_response_format_can_fall_back_to_json_object() -> None:
    os.environ["AI_STRUCTURED_OUTPUT"] = "0"
    try:
        assert ai_structured.build_response_format() == {"type": "json_object"}
        assert ai_structured.json_object_response_format() == {"type": "json_object"}
    finally:
        os.environ.pop("AI_STRUCTURED_OUTPUT", None)


def test_normalize_evidence_maps_prompt_names() -> None:
    evidence = ai_structured.normalize_evidence(
        {
            "if": "I.F : 1102277",
            "ice_frs": "ICE : 000229475000050",
            "m_ht": "  932,98  ",
            "unknown": "x",
            "tva": "",
        }
    )
    assert evidence == {
        "if_fournisseur": "I.F : 1102277",
        "ice_frs": "ICE : 000229475000050",
        "m_ht": "932,98",
    }


def test_normalize_confidence_maps_levels() -> None:
    confidence = ai_structured.normalize_confidence(
        {"fact_num": "ok", "ice_frs": "warning", "m_ht": "ko", "date_fac": "inconnu"}
    )
    assert confidence == {
        "fact_num": "ok",
        "ice_frs": "warn",
        "m_ht": "error",
        "date_fac": "warn",
    }


def test_usage_totals() -> None:
    assert ai_structured.usage_totals(
        {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150, "other": "x"}
    ) == {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}
    assert ai_structured.usage_totals(None) == {}


def test_parse_ai_lines_attaches_evidence_and_confidence() -> None:
    raw_lines = [
        {
            "fact_num": "FV26-023806",
            "designation": "MATIERES CONSOMMABLES",
            "m_ht": 932.98,
            "tva": 93.3,
            "m_ttc": 1026.28,
            "if": "1102277",
            "lib_frss": "ACHIBEST",
            "ice_frs": "000229475000050",
            "taux": 0.1,
            "id_paie": 4,
            "date_paie": None,
            "date_fac": "2026-06-13",
            "evidence": {"m_ht": "932,98", "ice_frs": "000229475000050"},
            "field_confidence": {"fact_num": "ok", "lib_frss": "warning"},
        }
    ]
    lines, warnings = _parse_ai_lines(raw_lines)
    assert not warnings
    assert len(lines) == 1
    line = lines[0]
    assert line.evidence["m_ht"] == "932,98"
    assert line.evidence["ice_frs"] == "000229475000050"
    assert line.ai_confidence == {"fact_num": "ok", "lib_frss": "warn"}


def test_parse_ai_lines_tolerates_missing_metadata() -> None:
    lines, warnings = _parse_ai_lines(
        [
            {
                "fact_num": "A-1",
                "m_ht": 100,
                "tva": 20,
                "m_ttc": 120,
                "taux": 0.2,
            }
        ]
    )
    assert not warnings
    assert lines[0].evidence == {}
    assert lines[0].ai_confidence == {}


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
