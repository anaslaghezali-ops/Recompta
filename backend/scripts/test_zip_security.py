from __future__ import annotations

from io import BytesIO
from pathlib import Path
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from zip_utils import (
    MAX_SINGLE_FILE_BYTES,
    ImportBudgetExceeded,
    InvoiceExtractionBudget,
    iter_invoice_files,
    iter_invoice_files_batched,
)


def make_zip(name: str, payload: bytes, *, compression: int = zipfile.ZIP_STORED) -> bytes:
    stream = BytesIO()
    with zipfile.ZipFile(stream, "w", compression=compression) as archive:
        archive.writestr(name, payload)
    return stream.getvalue()


def expect_rejected(content: bytes, expected: str) -> None:
    try:
        iter_invoice_files("archive.zip", content, "application/zip")
    except ValueError as exc:
        assert expected in str(exc), str(exc)
    else:
        raise AssertionError(f"Archive acceptée alors qu'elle devait être refusée : {expected}")


def test_reject_path_traversal() -> None:
    expect_rejected(make_zip("../outside.pdf", b"x" * 1000), "chemin de fichier invalide")


def test_reject_absolute_and_windows_paths() -> None:
    expect_rejected(make_zip("/tmp/outside.pdf", b"x" * 1000), "chemin de fichier invalide")
    expect_rejected(make_zip("C:\\temp\\outside.pdf", b"x" * 1000), "chemin de fichier invalide")


def test_reject_zip_bomb_ratio() -> None:
    expect_rejected(
        make_zip("facture.pdf", b"0" * 500_000, compression=zipfile.ZIP_DEFLATED),
        "ratio de compression anormal",
    )


def test_reject_oversized_single_document() -> None:
    try:
        iter_invoice_files("facture.pdf", b"x" * (MAX_SINGLE_FILE_BYTES + 1), "application/pdf")
    except ValueError as exc:
        assert "maximum 25 Mio" in str(exc)
    else:
        raise AssertionError("Document individuel trop volumineux accepté")


def test_accept_normal_zip() -> None:
    payload = b"%PDF-" + (b"sample invoice content " * 40)
    result = iter_invoice_files(
        "factures.zip",
        make_zip("Fournisseur/facture.pdf", payload),
        "application/zip",
    )
    assert len(result) == 1
    assert result[0][0] == "Fournisseur/facture.pdf"
    assert result[0][1] == payload


def test_batched_iterator_yields_incrementally_after_validation() -> None:
    budget = InvoiceExtractionBudget(max_uncompressed_bytes=2000, max_documents=10)
    archive = BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as bundle:
        bundle.writestr("b.pdf", b"b" * 500)
        bundle.writestr("a.pdf", b"a" * 500)
    stream = iter_invoice_files_batched(
        "batch.zip", archive.getvalue(), "application/zip", budget=budget
    )
    first = next(stream)
    assert first[0] == "a.pdf"
    assert first[1] == b"a" * 500
    assert budget.document_count == 2
    second = next(stream)
    assert second[0] == "b.pdf"
    stream.close()


def test_cumulative_uncompressed_budget_across_archives() -> None:
    budget = InvoiceExtractionBudget(max_uncompressed_bytes=800, max_documents=10)
    first = iter_invoice_files(
        "first.zip", make_zip("one.pdf", b"a" * 500), "application/zip", budget=budget
    )
    assert len(first) == 1
    assert budget.total_uncompressed_bytes == 500
    try:
        iter_invoice_files(
            "second.zip", make_zip("two.pdf", b"b" * 500), "application/zip", budget=budget
        )
    except ImportBudgetExceeded as exc:
        assert "données décompressées" in str(exc)
    else:
        raise AssertionError("Le budget décompressé cumulé aurait dû refuser le second ZIP")
    assert budget.total_uncompressed_bytes == 500
    assert budget.document_count == 1


def test_cumulative_document_limit_across_archives() -> None:
    budget = InvoiceExtractionBudget(max_uncompressed_bytes=5000, max_documents=1)
    iter_invoice_files(
        "first.zip", make_zip("one.pdf", b"a" * 500), "application/zip", budget=budget
    )
    try:
        iter_invoice_files(
            "second.zip", make_zip("two.pdf", b"b" * 500), "application/zip", budget=budget
        )
    except ImportBudgetExceeded as exc:
        assert "documents extraits" in str(exc)
    else:
        raise AssertionError("Le plafond documentaire cumulé aurait dû refuser le second ZIP")
    assert budget.document_count == 1


def test_failed_archive_does_not_consume_shared_budget() -> None:
    budget = InvoiceExtractionBudget(max_uncompressed_bytes=800, max_documents=10)
    stream = BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("one.pdf", b"a" * 500)
        archive.writestr("two.pdf", b"b" * 500)
    try:
        iter_invoice_files("bad-lot.zip", stream.getvalue(), "application/zip", budget=budget)
    except ImportBudgetExceeded:
        pass
    else:
        raise AssertionError("Une archive dépassant le budget a été acceptée")
    assert budget.total_uncompressed_bytes == 0
    assert budget.document_count == 0


def main() -> None:
    test_cumulative_uncompressed_budget_across_archives()
    test_cumulative_document_limit_across_archives()
    test_failed_archive_does_not_consume_shared_budget()
    test_reject_path_traversal()
    test_reject_absolute_and_windows_paths()
    test_reject_zip_bomb_ratio()
    test_reject_oversized_single_document()
    test_accept_normal_zip()
    print("OK test_zip_security")


if __name__ == "__main__":
    main()
