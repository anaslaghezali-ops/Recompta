#!/usr/bin/env python3
"""Carnet ICE/IF → nom officiel à l'extraction."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from supplier_notebook import apply_official_supplier_names, official_name_for_line  # noqa: E402


def test_lookup_prefers_ice() -> None:
    entries = [
        {"ice": "000000000000001", "if_number": "111", "official_name": "Achibest"},
        {"ice": None, "if_number": "111", "official_name": "Autre"},
    ]
    line = {"ice_frs": "000000000000001", "if": "111", "lib_frss": "Achibest ERT"}
    assert official_name_for_line(line, entries) == "Achibest"


def test_lookup_falls_back_to_if() -> None:
    entries = [{"ice": None, "if_number": "40240688", "official_name": "Achibest"}]
    line = {"ice_frs": "", "if": "40240688", "lib_frss": "Achibest ERT"}
    assert official_name_for_line(line, entries) == "Achibest"


def test_apply_replaces_ai_name() -> None:
    entries = [{"ice": "123456789000001", "official_name": "Achibest"}]
    lines = [
        {"ice_frs": "123456789000001", "lib_frss": "Achibest ERT"},
        {"ice_frs": "999999999000001", "lib_frss": "Orange"},
    ]
    changed = apply_official_supplier_names(lines, entries)
    assert changed == 1
    assert lines[0]["lib_frss"] == "Achibest"
    assert lines[0]["supplier_from_folder"] is False
    assert lines[1]["lib_frss"] == "Orange"


def test_no_identity_is_unchanged() -> None:
    entries = [{"ice": "123456789000001", "official_name": "Achibest"}]
    lines = [{"ice_frs": "", "if": "", "lib_frss": "Achibest ERT"}]
    assert apply_official_supplier_names(lines, entries) == 0
    assert lines[0]["lib_frss"] == "Achibest ERT"


def main() -> int:
    test_lookup_prefers_ice()
    test_lookup_falls_back_to_if()
    test_apply_replaces_ai_name()
    test_no_identity_is_unchanged()
    print("OK test_supplier_notebook")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
