from __future__ import annotations

import mimetypes
import stat
import zipfile
import zlib
from io import BytesIO
from pathlib import PurePosixPath

ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tiff", ".tif"}
SKIP_BASENAMES = {".ds_store", "thumbs.db", "desktop.ini"}
MIN_FILE_BYTES = 400
MAX_SINGLE_FILE_BYTES = 25 * 1024 * 1024
MAX_ZIP_ARCHIVE_BYTES = 100 * 1024 * 1024
MAX_ZIP_MEMBERS = 1000
MAX_ZIP_MEMBER_BYTES = 25 * 1024 * 1024
MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024
MAX_ZIP_COMPRESSION_RATIO = 200
MAX_IMPORT_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_IMPORT_DOCUMENTS = 1000
IMPORT_EXTRACTION_BATCH_SIZE = 2

EXTENSION_MIME = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
}


class ImportBudgetExceeded(ValueError):
    """Le lot dépasse le budget cumulé de décompression ou de documents."""


class InvoiceExtractionBudget:
    """Budget cumulatif partagé par une requête API ou un job d'import."""

    def __init__(
        self,
        *,
        max_uncompressed_bytes: int = MAX_IMPORT_UNCOMPRESSED_BYTES,
        max_documents: int = MAX_IMPORT_DOCUMENTS,
    ) -> None:
        self.max_uncompressed_bytes = max(1, int(max_uncompressed_bytes))
        self.max_documents = max(1, int(max_documents))
        self.total_uncompressed_bytes = 0
        self.document_count = 0

    def check_capacity(self, uncompressed_bytes: int, documents: int) -> None:
        if self.total_uncompressed_bytes + uncompressed_bytes > self.max_uncompressed_bytes:
            maximum_mib = self.max_uncompressed_bytes // (1024 * 1024)
            raise ImportBudgetExceeded(
                f"Lot refusé : plus de {maximum_mib} Mio de données décompressées "
                "(maximum cumulé par requête/job)."
            )
        if self.document_count + documents > self.max_documents:
            raise ImportBudgetExceeded(
                f"Lot refusé : plus de {self.max_documents} documents extraits "
                "(maximum cumulé par requête/job)."
            )

    def reserve(self, uncompressed_bytes: int, documents: int) -> None:
        self.check_capacity(uncompressed_bytes, documents)
        self.total_uncompressed_bytes += uncompressed_bytes
        self.document_count += documents


def mime_for_filename(filename: str) -> str:
    ext = PurePosixPath(filename).suffix.lower()
    return EXTENSION_MIME.get(ext) or mimetypes.guess_type(filename)[0] or "application/octet-stream"


def is_invoice_file(filename: str) -> bool:
    return PurePosixPath(filename).suffix.lower() in ALLOWED_EXTENSIONS


def is_zip_file(filename: str, mime_type: str) -> bool:
    ext = PurePosixPath(filename).suffix.lower()
    return ext == ".zip" or mime_type in {"application/zip", "application/x-zip-compressed"}


def iter_invoice_files(
    filename: str,
    content: bytes,
    mime_type: str,
    *,
    budget: InvoiceExtractionBudget | None = None,
) -> list[tuple[str, bytes, str]]:
    """Compatibilité : retourne une liste, avec budget cumulatif optionnel."""
    return list(iter_invoice_files_batched(filename, content, mime_type, budget=budget))


def iter_invoice_files_batched(
    filename: str,
    content: bytes,
    mime_type: str,
    *,
    budget: InvoiceExtractionBudget | None = None,
):
    """Produit les documents un par un après validation complète de l'archive.

    La première passe vérifie les tailles, limites cumulées et CRC sans conserver
    les contenus décompressés. La deuxième passe ne matérialise qu'un document à
    la fois, ce qui permet à l'appelant de traiter les documents par petits lots.
    """
    active_budget = budget or InvoiceExtractionBudget()
    if is_zip_file(filename, mime_type):
        yield from _iter_zip_entries(content, active_budget)
        return
    if is_invoice_file(filename):
        if len(content) > MAX_SINGLE_FILE_BYTES:
            raise ValueError("Fichier trop volumineux (maximum 25 Mio par document).")
        active_budget.reserve(len(content), 1)
        yield filename, content, mime_for_filename(filename)


def storage_path_for_zip_member(zip_filename: str, member_path: str) -> str:
    """Normalise le chemin d'un membre ZIP pour le stockage dossier_documents."""
    normalized = member_path.replace("\\", "/").strip()
    parts = [part for part in normalized.split("/") if part and part != "."]
    if not parts:
        return normalized
    zip_stem = PurePosixPath(zip_filename).stem
    if len(parts) == 1:
        return f"{zip_stem}/{parts[0]}"
    if parts[0].lower() != zip_stem.lower():
        return f"{zip_stem}/{'/'.join(parts)}"
    return "/".join(parts)


def _safe_member_name(raw_name: str) -> str:
    normalized = raw_name.replace("\\", "/")
    path = PurePosixPath(normalized)
    parts = normalized.split("/")
    if (
        not normalized
        or "\x00" in normalized
        or path.is_absolute()
        or any(part == ".." for part in parts)
        or (parts and ":" in parts[0])
    ):
        raise ValueError("Archive ZIP refusée : chemin de fichier invalide.")
    return path.as_posix()


def _iter_zip_entries(content: bytes, budget: InvoiceExtractionBudget):
    if len(content) > MAX_ZIP_ARCHIVE_BYTES:
        raise ValueError("Archive ZIP trop volumineuse (maximum 100 Mio).")

    try:
        with zipfile.ZipFile(BytesIO(content)) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ZIP_MEMBERS:
                raise ValueError(f"Archive ZIP refusée : plus de {MAX_ZIP_MEMBERS} entrées.")

            # Prévalidation complète : aucun document n'est transmis au worker
            # avant que tous les membres utiles de l'archive aient passé les contrôles.
            members: list[tuple[str, zipfile.ZipInfo]] = []
            archive_uncompressed = 0
            archive_documents = 0

            for info in sorted(infos, key=lambda item: item.filename.lower()):
                if info.is_dir():
                    continue

                name = _safe_member_name(info.filename)
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    raise ValueError("Archive ZIP refusée : les liens symboliques ne sont pas acceptés.")
                if info.flag_bits & 0x1:
                    raise ValueError("Archive ZIP refusée : les fichiers chiffrés ne sont pas acceptés.")
                if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                    raise ValueError("Archive ZIP refusée : méthode de compression non prise en charge.")

                base = PurePosixPath(name).name
                if not base or base.startswith(".") or base.startswith("._"):
                    continue
                if base.lower() in SKIP_BASENAMES:
                    continue
                if name.startswith("__MACOSX/") or "/." in name:
                    continue
                if not is_invoice_file(name):
                    continue

                if info.file_size > MAX_ZIP_MEMBER_BYTES:
                    raise ValueError(f"Archive ZIP refusée : « {base} » dépasse 25 Mio décompressés.")
                if info.file_size > 0 and info.compress_size == 0:
                    raise ValueError("Archive ZIP refusée : taille compressée incohérente.")
                if info.compress_size > 0 and info.file_size / info.compress_size > MAX_ZIP_COMPRESSION_RATIO:
                    raise ValueError(f"Archive ZIP refusée : ratio de compression anormal pour « {base} ».")

                member_size = 0
                with archive.open(info, "r") as member:
                    while True:
                        chunk = member.read(1024 * 1024)
                        if not chunk:
                            break
                        member_size += len(chunk)
                        if member_size > MAX_ZIP_MEMBER_BYTES:
                            raise ValueError(f"Archive ZIP refusée : « {base} » dépasse 25 Mio décompressés.")
                        if archive_uncompressed + member_size > MAX_ZIP_TOTAL_BYTES:
                            raise ValueError("Archive ZIP refusée : plus de 100 Mio de données décompressées.")
                        if budget.total_uncompressed_bytes + archive_uncompressed + member_size > budget.max_uncompressed_bytes:
                            budget.check_capacity(archive_uncompressed + member_size, 0)

                if member_size != info.file_size:
                    raise ValueError(f"Archive ZIP corrompue : taille inattendue pour « {base} ».")
                archive_uncompressed += member_size
                if member_size >= MIN_FILE_BYTES:
                    archive_documents += 1
                    budget.check_capacity(archive_uncompressed, archive_documents)
                    members.append((name, info))

            # Réserver le budget uniquement après la validation intégrale de l'archive.
            budget.reserve(archive_uncompressed, archive_documents)

            for name, info in members:
                payload_chunks: list[bytes] = []
                member_size = 0
                with archive.open(info, "r") as member:
                    while True:
                        chunk = member.read(1024 * 1024)
                        if not chunk:
                            break
                        member_size += len(chunk)
                        if member_size > MAX_ZIP_MEMBER_BYTES:
                            raise ValueError(f"Archive ZIP refusée : « {PurePosixPath(name).name} » dépasse 25 Mio décompressés.")
                        payload_chunks.append(chunk)
                if member_size != info.file_size:
                    raise ValueError(f"Archive ZIP corrompue : taille inattendue pour « {PurePosixPath(name).name} ».")
                yield name, b"".join(payload_chunks), mime_for_filename(name)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError, zlib.error) as exc:
        raise ValueError("Archive ZIP invalide ou endommagée.") from exc
