"""Sortie structurée et métadonnées de preuve pour l'extraction IA.

Trois responsabilités, sans accès réseau :

- ``AI_EVIDENCE_INSTRUCTIONS`` : consignes ajoutées au prompt pour exiger, par
  ligne, un extrait verbatim par champ et un niveau de confiance ;
- ``build_response_format()`` : schéma JSON strict (structured outputs) avec
  repli sur ``json_object`` quand le modèle ou l'endpoint ne le supporte pas ;
- ``normalize_evidence()`` / ``normalize_confidence()`` : normalisation des
  métadonnées avant de les poser sur les ``InvoiceLine``.

L'objectif métier : rendre chaque champ extractible *prouvable* et *notable*,
pour que la revue humaine et la fusion des lectures IA puissent arbitrer sur
des preuves plutôt que sur une confiance globale opaque.
"""

from __future__ import annotations

import os
from typing import Any

# Champs suivis par les preuves et la confiance (noms du prompt JSON).
EVIDENCE_FIELDS = (
    "fact_num",
    "designation",
    "m_ht",
    "tva",
    "m_ttc",
    "if",
    "lib_frss",
    "ice_frs",
    "taux",
    "date_fac",
)

CONFIDENCE_LEVELS = ("ok", "warn", "error")

AI_EVIDENCE_INSTRUCTIONS = """
## Preuves et confiance (obligatoire)

Pour CHAQUE ligne, ajoute deux objets :

- "evidence" : pour chaque champ ci-dessous, l'extrait **verbatim** du document
  qui justifie la valeur (copie exacte, sans reformulation). Si le champ n'est
  pas lisible, mets "".
  Champs : fact_num, designation, m_ht, tva, m_ttc, if, lib_frss, ice_frs, taux, date_fac.
- "field_confidence" : pour chaque champ ci-dessous, "ok", "warn" ou "error"
  (ok = lu et vérifié, warn = lu mais douteux, error = absent ou incohérent).
  Champs : les mêmes.

N'invente jamais une preuve : si tu ne peux pas citer le document, laisse ""
et marque "warn". Une preuve copiée doit apparaître telle quelle dans le texte
ou l'image fournie.
"""


def _string_or_null() -> dict[str, Any]:
    return {"type": ["string", "null"]}


def _evidence_schema() -> dict[str, Any]:
    properties = {name: {"type": "string"} for name in EVIDENCE_FIELDS}
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(EVIDENCE_FIELDS),
        "properties": properties,
    }


def _confidence_schema() -> dict[str, Any]:
    properties = {name: {"type": "string", "enum": list(CONFIDENCE_LEVELS)} for name in EVIDENCE_FIELDS}
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(EVIDENCE_FIELDS),
        "properties": properties,
    }


def _line_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "fact_num",
            "designation",
            "m_ht",
            "tva",
            "m_ttc",
            "if",
            "lib_frss",
            "ice_frs",
            "taux",
            "id_paie",
            "date_paie",
            "date_fac",
            "evidence",
            "field_confidence",
        ],
        "properties": {
            "fact_num": {"type": "string"},
            "designation": {
                "type": "string",
                "enum": [
                    "MATIERES CONSOMMABLES",
                    "PRESTATIONS",
                    "TELEPHONIE",
                    "FRAIS BANCAIRE",
                ],
            },
            "m_ht": {"type": "number"},
            "tva": {"type": "number"},
            "m_ttc": {"type": "number"},
            "if": {"type": "string"},
            "lib_frss": {"type": "string"},
            "ice_frs": {"type": "string"},
            "taux": {"type": "number"},
            "id_paie": {"type": "integer"},
            "date_paie": _string_or_null(),
            "date_fac": _string_or_null(),
            "evidence": _evidence_schema(),
            "field_confidence": _confidence_schema(),
        },
    }


RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["verification", "lines", "warnings"],
    "properties": {
        "verification": {"type": "array", "items": {"type": "string"}},
        "warnings": {"type": "array", "items": {"type": "string"}},
        "lines": {"type": "array", "items": _line_schema()},
    },
}


def structured_output_enabled() -> bool:
    """Permet de couper le schéma strict par configuration (repli json_object)."""
    return os.getenv("AI_STRUCTURED_OUTPUT", "1").strip().lower() not in {"0", "false", "no", "off"}


def build_response_format() -> dict[str, Any]:
    """``response_format`` demandé à l'API : schéma strict si autorisé."""
    if not structured_output_enabled():
        return {"type": "json_object"}
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "invoice_extraction",
            "strict": True,
            "schema": RESPONSE_SCHEMA,
        },
    }


def json_object_response_format() -> dict[str, Any]:
    """Repli universel quand le modèle refuse les structured outputs."""
    return {"type": "json_object"}


def _canonical_field(name: object) -> str | None:
    key = str(name or "").strip().lower().replace("-", "_")
    if key in {"if", "if_fournisseur"}:
        return "if_fournisseur"
    if key in {"ice", "ice_frs"}:
        return "ice_frs"
    if key in {"tva", "montant_tva"}:
        return "tva"
    if key in {"ht", "m_ht", "montant_ht"}:
        return "m_ht"
    if key in {"ttc", "m_ttc", "montant_ttc"}:
        return "m_ttc"
    if key in {"fact_num", "numero", "num_facture"}:
        return "fact_num"
    if key in {"date_fac", "date_facture"}:
        return "date_fac"
    if key in EVIDENCE_FIELDS:
        return key
    return None


def normalize_evidence(value: object) -> dict[str, str]:
    """Preuves valides uniquement : chaînes non vides, champs connus, bornées."""
    if not isinstance(value, dict):
        return {}
    out: dict[str, str] = {}
    for raw_key, raw_value in value.items():
        key = _canonical_field(raw_key)
        if key is None or not isinstance(raw_value, str):
            continue
        snippet = " ".join(raw_value.split()).strip()
        if not snippet:
            continue
        out[key] = snippet[:300]
    return out


def normalize_confidence(value: object) -> dict[str, str]:
    """Niveaux de confiance normalisés ; les valeurs inconnues deviennent warn."""
    if not isinstance(value, dict):
        return {}
    out: dict[str, str] = {}
    for raw_key, raw_value in value.items():
        key = _canonical_field(raw_key)
        if key is None:
            continue
        level = str(raw_value or "").strip().lower()
        if level in {"warning", "warn", "medium", "moyen"}:
            level = "warn"
        elif level in {"error", "err", "ko", "bad"}:
            level = "error"
        elif level in {"ok", "good", "high", "haut"}:
            level = "ok"
        else:
            level = "warn"
        out[key] = level
    return out


def usage_totals(usage: object) -> dict[str, int]:
    """Extrait les compteurs de tokens d'une réponse OpenAI."""
    if not isinstance(usage, dict):
        return {}
    out: dict[str, int] = {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        value = usage.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            out[key] = int(value)
    return out
