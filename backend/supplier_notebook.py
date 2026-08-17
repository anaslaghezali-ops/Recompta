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
