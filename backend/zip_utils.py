from __future__ import annotations

import mimetypes
import zipfile
from io import BytesIO
from pathlib import PurePosixPath

ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tiff", ".tif"}
SKIP_BASENAMES = {".ds_store", "thumbs.db", "desktop.ini"}
MIN_FILE_BYTES = 400
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
    """Retourne une liste de (nom_relatif, contenu, mime_type)."""
    if is_zip_file(filename, mime_type):
        return _extract_zip(content)
    if is_invoice_file(filename):
        return [(filename, content, mime_for_filename(filename))]
    return []


def _extract_zip(content: bytes) -> list[tuple[str, bytes, str]]:
    files: list[tuple[str, bytes, str]] = []
    with zipfile.ZipFile(BytesIO(content)) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = PurePosixPath(info.filename).as_posix()
            base = PurePosixPath(name).name
            if not base or base.startswith(".") or base.startswith("._"):
                continue
            if base.lower() in SKIP_BASENAMES:
                continue
            if name.startswith("__MACOSX/") or "/." in name:
                continue
            if not is_invoice_file(name):
                continue
            payload = archive.read(info)
            if len(payload) < MIN_FILE_BYTES:
                continue
            files.append((name, payload, mime_for_filename(name)))
    files.sort(key=lambda item: item[0].lower())
    return files
