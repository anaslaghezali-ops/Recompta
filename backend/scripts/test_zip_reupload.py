#!/usr/bin/env python3
"""Ré-upload du même ZIP : les enfants de l'ancienne version ne bloquent pas la nouvelle."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dossier_analysis import (
    _should_skip_zip_for_analysis,
    _zip_child_documents,
)


def test_reuploaded_zip_not_blocked_by_old_children() -> None:
    old_zip = {
        "id": 1,
        "original_filename": "1.zip",
        "created_at": "2026-08-15T10:00:00Z",
        "doc_type": "invoice",
    }
    new_zip = {
        "id": 2,
        "original_filename": "1.zip",
        "created_at": "2026-08-15T12:00:00Z",
        "doc_type": "invoice",
    }
    old_child = {
        "id": 10,
        "original_filename": "1/facture-a.pdf",
        "created_at": "2026-08-15T10:05:00Z",
        "doc_type": "invoice",
        "source_id": "src-old",
    }
    docs = [old_zip, new_zip, old_child]

    assert _zip_child_documents(old_zip, docs) == [old_child]
    assert _zip_child_documents(new_zip, docs) == []
    assert not _should_skip_zip_for_analysis(new_zip, docs, set(), set())


def test_expanded_new_zip_skipped_but_child_pending() -> None:
    zip_doc = {
        "id": 2,
        "original_filename": "1.zip",
        "created_at": "2026-08-15T12:00:00Z",
        "doc_type": "invoice",
    }
    new_child = {
        "id": 11,
        "original_filename": "1/facture-b.pdf",
        "created_at": "2026-08-15T12:05:00Z",
        "doc_type": "invoice",
        "source_id": "src-new",
    }
    docs = [zip_doc, new_child]

    assert _zip_child_documents(zip_doc, docs) == [new_child]
    assert _should_skip_zip_for_analysis(zip_doc, docs, set(), set())


def main() -> None:
    test_reuploaded_zip_not_blocked_by_old_children()
    test_expanded_new_zip_skipped_but_child_pending()
    print("OK test_zip_reupload")


if __name__ == "__main__":
    main()
