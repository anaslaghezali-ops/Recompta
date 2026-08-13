#!/usr/bin/env python3
"""Tests identifiant source (tag __RC__src-N)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from source_id import split_source_tag


def main() -> int:
    original, source_id = split_source_tag("facture__RC__src-2.pdf")
    assert original == "facture.pdf", original
    assert source_id == "src-2"

    original, source_id = split_source_tag("ACHIBEST/FV26-023806__RC__src-0.pdf")
    assert original == "ACHIBEST/FV26-023806.pdf", original
    assert source_id == "src-0"

    original, source_id = split_source_tag("facture.pdf__RC__src-1")
    assert original == "facture.pdf", original
    assert source_id == "src-1"

    original, source_id = split_source_tag("orange.pdf")
    assert original == "orange.pdf"
    assert source_id == ""

    print("OK test_source_id")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
