"""Carnet fournisseurs : ICE / IF → nom officiel."""

from __future__ import annotations

import re
from typing import Any


def normalize_ice_digits(value: str | None) -> str:
    digits = re.sub(r"\D", "", value or "")
    return digits if len(digits) == 15 else ""


def normalize_if_digits(value: str | None) -> str:
    return re.sub(r"\D", "", value or "")


def line_if_value(line: dict[str, Any]) -> str:
    return normalize_if_digits(str(line.get("if") or line.get("if_fournisseur") or ""))


def official_name_for_line(line: dict[str, Any], entries: list[dict[str, Any]]) -> str:
    ice = normalize_ice_digits(str(line.get("ice_frs") or ""))
    fiscal = line_if_value(line)
    by_ice = {
        normalize_ice_digits(str(entry.get("ice") or "")): str(entry.get("official_name") or "").strip()
        for entry in entries
    }
    by_if = {
        normalize_if_digits(str(entry.get("if_number") or entry.get("if") or "")): str(
            entry.get("official_name") or ""
        ).strip()
        for entry in entries
    }
    if ice and by_ice.get(ice):
        return by_ice[ice]
    if fiscal and by_if.get(fiscal):
        return by_if[fiscal]
    return ""


def apply_official_supplier_names(lines: list[dict[str, Any]], entries: list[dict[str, Any]]) -> int:
    """Remplace le nom IA par le nom du carnet. Retourne le nombre de lignes modifiées."""
    if not lines or not entries:
        return 0
    changed = 0
    for line in lines:
        official = official_name_for_line(line, entries)
        if not official:
            continue
        current = str(line.get("lib_frss") or "").strip()
        if current == official:
            continue
        line["lib_frss"] = official
        line["supplier_from_folder"] = False
        changed += 1
    return changed


# ── Identités fournisseurs à l'échelle du dossier ─────────────────────────
#
# Mesure juillet 2026 : sur 42 lignes déclarées, 15 avaient les bons montants
# mais un IF ou un ICE manquant, alors que l'information existait ailleurs
# (autre facture du même fournisseur, carnet du client). Et 18 noms ont dû
# être corrigés à la main (AICHIBEST / ACHIBEST / Aichbest).
#
# Règles (déterministes, sans IA) :
# - on ne remplit que des champs vides ; jamais un champ validé par
#   l'utilisateur (user_verified_fields) ;
# - ICE retrouvé par l'IF, puis par le nom (exact, puis approché), seulement
#   s'il n'y a qu'un candidat ;
# - IF retrouvé par l'ICE (carnet d'abord, puis autres lignes) ;
# - nom aligné sur le carnet, sinon sur un nom déjà validé à la main pour
#   cet ICE. Le nom lu est gardé dans lib_frss_read.

_LEGAL_FORMS = {"SARL", "SA", "SAS", "AU", "SARLAU", "STE", "SOCIETE", "STÉ", "SNC", "EURL", "LTD", "PBC", "INC"}


def supplier_key(name: str | None) -> str:
    import unicodedata

    text = unicodedata.normalize("NFD", str(name or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = re.sub(r"[.'’]", "", text).upper()
    tokens = [t for t in re.split(r"[^A-Z0-9]+", text) if t and t not in _LEGAL_FORMS]
    return "".join(tokens)


def _similar(a: str, b: str) -> bool:
    from difflib import SequenceMatcher

    if len(a) < 6 or len(b) < 6:
        return False
    return SequenceMatcher(None, a, b).ratio() >= 0.88


def _verified(line: dict[str, Any], field: str) -> bool:
    return field in (line.get("user_verified_fields") or [])


def _unique(values: set[str]) -> str:
    values = {v for v in values if v}
    return next(iter(values)) if len(values) == 1 else ""


def enrich_supplier_identities(
    lines: list[dict[str, Any]],
    notebook: list[dict[str, Any]] | None = None,
    *,
    client_ice: str = "",
) -> dict[str, int]:
    """Complète ICE / IF et harmonise les noms, sur place. Retourne les compteurs."""
    stats = {"ice": 0, "if": 0, "name": 0}
    if not lines:
        return stats
    notebook = notebook or []
    excluded = {normalize_ice_digits(client_ice)} - {""}

    def ice_of(line: dict[str, Any]) -> str:
        ice = normalize_ice_digits(str(line.get("ice_frs") or ""))
        return "" if ice in excluded or re.fullmatch(r"0+", ice or "x") else ice

    official_by_ice: dict[str, str] = {}
    notebook_if_by_ice: dict[str, str] = {}
    if_by_ice: dict[str, set[str]] = {}
    ice_by_if: dict[str, set[str]] = {}
    ice_by_name: dict[str, set[str]] = {}

    def remember(ice: str, fiscal: str, name: str) -> None:
        if ice and fiscal:
            if_by_ice.setdefault(ice, set()).add(fiscal)
            ice_by_if.setdefault(fiscal, set()).add(ice)
        key = supplier_key(name)
        if ice and key:
            ice_by_name.setdefault(key, set()).add(ice)

    for entry in notebook:
        ice = normalize_ice_digits(str(entry.get("ice") or ""))
        if not ice or ice in excluded:
            continue
        name = str(entry.get("official_name") or "").strip()
        fiscal = normalize_if_digits(str(entry.get("if_number") or entry.get("if") or ""))
        if name:
            official_by_ice[ice] = name
        if fiscal:
            notebook_if_by_ice[ice] = fiscal
        remember(ice, fiscal, name)

    verified_name_by_ice: dict[str, str] = {}
    for line in lines:
        ice = ice_of(line)
        remember(ice, line_if_value(line), str(line.get("lib_frss") or ""))
        if ice and _verified(line, "lib_frss") and line.get("lib_frss"):
            verified_name_by_ice.setdefault(ice, str(line["lib_frss"]).strip())

    def find_ice(line: dict[str, Any]) -> str:
        fiscal = line_if_value(line)
        if fiscal:
            found = _unique(ice_by_if.get(fiscal, set()))
            if found:
                return found
        key = supplier_key(line.get("lib_frss"))
        if not key:
            return ""
        found = _unique(ice_by_name.get(key, set()))
        if found:
            return found
        close = {ice for name, ices in ice_by_name.items() if _similar(key, name) for ice in ices}
        return _unique(close)

    for line in lines:
        ice = ice_of(line)
        if not ice and not _verified(line, "ice_frs"):
            ice = find_ice(line)
            if ice:
                line["ice_frs"] = ice
                line["ice_inferred"] = True
                stats["ice"] += 1
        if not ice:
            continue

        current_if = line_if_value(line)
        if not _verified(line, "if"):
            notebook_if = notebook_if_by_ice.get(ice, "")
            if not current_if:
                fiscal = notebook_if or _unique(if_by_ice.get(ice, set()))
                if not fiscal:
                    # Même IF à un zéro de tête près : prendre le plus fréquent.
                    variants = if_by_ice.get(ice, set())
                    if variants and len({v.lstrip("0") for v in variants}) == 1:
                        fiscal = sorted(variants, key=len)[-1]
                if fiscal:
                    line["if"] = fiscal
                    line["if_inferred"] = True
                    stats["if"] += 1
            elif notebook_if and current_if.lstrip("0") != notebook_if.lstrip("0"):
                # L'ICE (15 chiffres) est sûr et le carnet a été validé par le
                # cabinet : un IF différent est une erreur de lecture
                # (ex. 110277 lu pour 1102277).
                line["if_read"] = current_if
                line["if"] = notebook_if
                line["if_inferred"] = True
                stats["if"] += 1

        name = official_by_ice.get(ice) or verified_name_by_ice.get(ice)
        current = str(line.get("lib_frss") or "").strip()
        if name and current != name and not _verified(line, "lib_frss"):
            if current and not line.get("lib_frss_read"):
                line["lib_frss_read"] = current
            line["lib_frss"] = name
            line["supplier_from_folder"] = False
            stats["name"] += 1
    return stats
