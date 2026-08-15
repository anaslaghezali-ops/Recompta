"""Tests chemins ZIP → documents extraits."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dossier_analysis import _should_skip_zip_for_analysis, _zip_child_documents
from zip_utils import storage_path_for_zip_member


def test_storage_path_for_zip_member() -> None:
    assert storage_path_for_zip_member("factures.zip", "scan.pdf") == "factures/scan.pdf"
    assert storage_path_for_zip_member("factures.zip", "Mose food/scan.pdf") == "factures/Mose food/scan.pdf"
    assert storage_path_for_zip_member("factures.zip", "factures/a.pdf") == "factures/a.pdf"


def test_zip_child_fallback() -> None:
    zip_doc = {"id": 1, "original_filename": "factures.zip", "doc_type": "invoice"}
    children = [
        {"id": 2, "original_filename": "Mose food/a.pdf", "doc_type": "invoice"},
        {"id": 3, "original_filename": "Mose food/b.pdf", "doc_type": "invoice"},
    ]
    docs = [zip_doc, *children]
    found = _zip_child_documents(zip_doc, docs)
    assert len(found) == 2
    assert _should_skip_zip_for_analysis(zip_doc, docs, set(), set())


def main() -> None:
    test_storage_path_for_zip_member()
    test_zip_child_fallback()
    print("OK test_zip_paths")


if __name__ == "__main__":
    main()
