from __future__ import annotations

from io import BytesIO
import zipfile

from zip_utils import (
    MAX_SINGLE_FILE_BYTES,
    iter_invoice_files,
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


def main() -> None:
    test_reject_path_traversal()
    test_reject_absolute_and_windows_paths()
    test_reject_zip_bomb_ratio()
    test_reject_oversized_single_document()
    test_accept_normal_zip()
    print("OK test_zip_security")


if __name__ == "__main__":
    main()
