#!/usr/bin/env python3
"""Les pièces de vente ne partent jamais en lecture des achats (TVA déductible)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dossier_analysis import select_pending_invoice_documents  # noqa: E402


def doc(i: int, name: str, doc_type: str, **extra):
    return {"id": i, "doc_type": doc_type, "original_filename": name, "source_id": f"s{i}",
            "size_bytes": 1000 + i, "created_at": f"2026-11-18T10:00:{i:02d}Z", **extra}


documents = [
    doc(1, "achat.pdf", "invoice"),
    doc(2, "vente-F-2026-101.pdf", "sale"),
    doc(3, "releve.pdf", "bank"),
    doc(4, "lot.zip", "archive"),
    doc(5, "deja-lue.pdf", "invoice"),
]
lines = [{"source_id": "s5", "source_file": "deja-lue.pdf"}]
pending = [d["original_filename"] for d in select_pending_invoice_documents(documents, lines)]
assert pending == ["achat.pdf"], pending
print("OK test_sales_documents_excluded")
