"""Tests chemins ZIP → documents extraits."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dossier_analysis import _should_skip_zip_for_analysis, _zip_child_documents
from zip_utils import storage_path_for_zip_member
from normalize_results import normalize_extraction_results, supplier_hint_from_path
from models import ExtractionResult, InvoiceLine, Designation


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


def test_drive_zip_uses_inner_folder() -> None:
    path = "Probun-20260816T102702Z-1-001/Probun/FACTURE AICHOUM 10072026.pdf"
    assert supplier_hint_from_path(path) == {"lib_frss": "Probun"}
    flat = "Probun-20260816T102702Z-1-001/FACTURE.pdf"
    assert supplier_hint_from_path(flat) == {"lib_frss": "Probun"}
    assert supplier_hint_from_path("Mose food/a.pdf") == {"lib_frss": "Mose Food"}
    assert supplier_hint_from_path("factures/Mose food/a.pdf") == {"lib_frss": "Mose Food"}
    assert supplier_hint_from_path("2026-06/a.pdf") is None


def test_keep_invoice_supplier_name() -> None:
    path = "Probun-20260816T102702Z-1-001/Probun/a.pdf"
    named = ExtractionResult(
        filename=path,
        lines=[
            InvoiceLine(
                fact_num="FAC0111/2026",
                designation=Designation.MATIERES_CONSOMMABLES,
                m_ht=10368.0,
                tva=0.0,
                m_ttc=10368.0,
                lib_frss="PROBUNS SARL",
            )
        ],
        engine="text",
    )
    kept = normalize_extraction_results([named])[0].lines[0]
    assert kept.lib_frss == "PROBUNS SARL"
    assert kept.supplier_from_folder is False

    empty = ExtractionResult(
        filename=path,
        lines=[
            InvoiceLine(
                fact_num="FAC0111/2026",
                designation=Designation.MATIERES_CONSOMMABLES,
                m_ht=10368.0,
                tva=0.0,
                m_ttc=10368.0,
                lib_frss="",
            )
        ],
        engine="text",
    )
    filled = normalize_extraction_results([empty])[0].lines[0]
    assert filled.lib_frss == "Probun"
    assert filled.supplier_from_folder is True


def main() -> None:
    test_storage_path_for_zip_member()
    test_zip_child_fallback()
    test_drive_zip_uses_inner_folder()
    test_keep_invoice_supplier_name()
    print("OK test_zip_paths")


if __name__ == "__main__":
    main()
