"""Chargement du corpus d'évaluation (``manifest.json``)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class EvalCase:
    id: str
    document: Path
    mime: str
    expected: dict[str, Any]
    notes: str = ""
    client_ice: str = ""


def load_corpus(corpus_dir: Path) -> list[EvalCase]:
    """Charge le manifeste et vérifie que chaque document existe.

    Les chemins du manifeste sont résolus d'abord relativement au dossier du
    corpus (pour un corpus privé déplacable), puis relativement à ``backend/``
    (pour les documents déjà versionnés, comme les PDF de démonstration).
    """
    corpus_dir = Path(corpus_dir).resolve()
    manifest_path = corpus_dir / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Manifeste de corpus introuvable : {manifest_path}")
    raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = raw.get("cases") or []
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"Manifeste vide ou invalide : {manifest_path}")

    cases: list[EvalCase] = []
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError(f"Cas invalide dans {manifest_path}: {entry!r}")
        case_id = str(entry.get("id") or "").strip()
        if not case_id:
            raise ValueError(f"Cas sans 'id' dans {manifest_path}")
        if case_id in seen:
            raise ValueError(f"Identifiant de cas dupliqué : {case_id}")
        seen.add(case_id)
        document = Path(str(entry.get("document") or ""))
        if not document.is_absolute():
            candidates = (corpus_dir / document, BACKEND_DIR / document)
            document = next((candidate for candidate in candidates if candidate.exists()), candidates[0])
        if not document.exists():
            raise FileNotFoundError(
                f"Document du corpus introuvable pour {case_id}: {document}. "
                "Lancez 'python scripts/generate_sample_invoices.py' si les PDF de démonstration manquent."
            )
        expected = entry.get("expected") or {}
        if not isinstance(expected, dict) or not expected.get("lines"):
            raise ValueError(f"Cas {case_id} sans vérité terrain ('expected.lines').")
        cases.append(
            EvalCase(
                id=case_id,
                document=document,
                mime=str(entry.get("mime") or "application/pdf"),
                expected=expected,
                notes=str(entry.get("notes") or ""),
                client_ice="".join(ch for ch in str(entry.get("client_ice") or "") if ch.isdigit()),
            )
        )
    return cases
