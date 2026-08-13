"""Identifiant stable fichier ↔ résultat d'extraction (tag __RC__src-N)."""

from __future__ import annotations

import re
from pathlib import PurePosixPath

TAG_RE = re.compile(r"^(.+)__RC__(src-\d+)(\.[^.]+)$")
LEGACY_TAG_RE = re.compile(r"^(.+)__RC__(src-\d+)$")


def split_source_tag(filename: str) -> tuple[str, str]:
    """Retourne (nom original, source_id).

    Format actuel : facture__RC__src-1.pdf (tag avant l'extension).
    Ancien format : facture.pdf__RC__src-1.
    """
    posix = (filename or "").replace("\\", "/")
    path = PurePosixPath(posix)
    base = path.name
    match = TAG_RE.match(base)
    if match:
        original_base = f"{match.group(1)}{match.group(3)}"
        original = str(path.with_name(original_base))
        if original.startswith("./"):
            original = original[2:]
        return original, match.group(2)
    legacy = LEGACY_TAG_RE.match(base)
    if legacy:
        original_base = legacy.group(1)
        original = str(path.with_name(original_base))
        if original.startswith("./"):
            original = original[2:]
        return original, legacy.group(2)
    return filename, ""
