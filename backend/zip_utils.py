from __future__ import annotations

import mimetypes
import stat
import zipfile
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
EXTENSION_MIME = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
}


def mime_for_filename(filename: str) -> str:
    ext = PurePosixPath(filename).suffix.lower()
    return EXTENSION_MIME.get(ext) or mimetypes.guess_type(filename)[0] or "application/octet-stream"


def is_invoice_file(filename: str) -> bool:
    return PurePosixPath(filename).suffix.lower() in ALLOWED_EXTENSIONS


def is_zip_file(filename: str, mime_type: str) -> bool:
    ext = PurePosixPath(filename).suffix.lower()
    return ext == ".zip" or mime_type in {"application/zip", "application/x-zip-compressed"}


def iter_invoice_files(filename: str, content: bytes, mime_type: str) -> list[tuple[str, bytes, str]]:
    """Retourne une liste de (nom_relatif, contenu, mime_type), avec limites mémoire."""
    if is_zip_file(filename, mime_type):
        return _extract_zip(content)
    if is_invoice_file(filename):
        if len(content) > MAX_SINGLE_FILE_BYTES:
            raise ValueError("Fichier trop volumineux (maximum 25 Mio par document).")
        return [(filename, content, mime_for_filename(filename))]
    return []


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


def _extract_zip(content: bytes) -> list[tuple[str, bytes, str]]:
    if len(content) > MAX_ZIP_ARCHIVE_BYTES:
        raise ValueError("Archive ZIP trop volumineuse (maximum 100 Mio).")

    files: list[tuple[str, bytes, str]] = []
    total_uncompressed = 0
    try:
        with zipfile.ZipFile(BytesIO(content)) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ZIP_MEMBERS:
                raise ValueError(f"Archive ZIP refusée : plus de {MAX_ZIP_MEMBERS} entrées.")

            for info in infos:
                if info.is_dir():
                    continue

                name = _safe_member_name(info.filename)
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    raise ValueError("Archive ZIP refusée : les liens symboliques ne sont pas acceptés.")
                if info.flag_bits & 0x1:
                    raise ValueError("Archive ZIP refusée : les fichiers chiffrés ne sont pas acceptés.")

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

                total_uncompressed += info.file_size
                if total_uncompressed > MAX_ZIP_TOTAL_BYTES:
                    raise ValueError("Archive ZIP refusée : plus de 100 Mio de données décompressées.")

                payload = archive.read(info)
                if len(payload) != info.file_size:
                    raise ValueError(f"Archive ZIP corrompue : taille inattendue pour « {base} ».")
                if len(payload) < MIN_FILE_BYTES:
                    continue
                files.append((name, payload, mime_for_filename(name)))
    except zipfile.BadZipFile as exc:
        raise ValueError("Archive ZIP invalide ou endommagée.") from exc

    files.sort(key=lambda item: item[0].lower())
    return files
