from __future__ import annotations

from collections import defaultdict
from contextvars import ContextVar
from pathlib import PurePosixPath
import re

from models import ExtractionResult, InvoiceLine
from vat_intelligence import apply_vat_reconciliation

# Rétrocompatibilité imports internes
from vat_intelligence import parse_ttc_ventilation  # noqa: F401

apply_ttc_ventilation_fixes = apply_vat_reconciliation

_excluded_client_ices: ContextVar[frozenset[str]] = ContextVar(
    "_excluded_client_ices",
    default=frozenset(),
)


def build_excluded_ices(client_ice: str) -> set[str]:
    normalized = normalize_ice_digits(client_ice)
    return {normalized} if normalized else set()


def activate_client_ice_exclusions(client_ice: str):
    return _excluded_client_ices.set(frozenset(build_excluded_ices(client_ice)))


def deactivate_client_ice_exclusions(token) -> None:
    _excluded_client_ices.reset(token)


def get_excluded_client_ices() -> frozenset[str]:
    return _excluded_client_ices.get()


def is_excluded_ice(ice: str) -> bool:
    normalized = normalize_ice_digits(ice)
    return bool(normalized and normalized in get_excluded_client_ices())


def folder_key(filename: str) -> str:
    parts = PurePosixPath(filename).as_posix().split("/")
    return parts[0].lower().strip() if len(parts) > 1 else ""


def supplier_hint_from_path(filename: str) -> dict[str, str] | None:
    """Indice organisationnel (nom de dossier ZIP) — pas de règle fournisseur codée."""
    key = folder_key(filename)
    if not key or key in {".", "..", "unknown", "factures", "invoices"}:
        return None
    label = " ".join(word.capitalize() for word in re.split(r"[\s_-]+", key) if word)
    return {"lib_frss": label} if label else None


def normalize_ice_digits(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    return digits if len(digits) == 15 else ""


def pick_best_ice(candidates: list[str], excluded: frozenset[str] | None = None) -> str:
    excluded = excluded if excluded is not None else get_excluded_client_ices()
    counts: dict[str, int] = {}
    for raw in candidates:
        ice = normalize_ice_digits(raw)
        if len(ice) != 15 or set(ice) == {"0"} or ice in excluded:
            continue
        counts[ice] = counts.get(ice, 0) + 1
    if not counts:
        return ""
    return max(counts.items(), key=lambda item: (item[1], item[0]))[0]


def pick_most_common(values: list[str]) -> str:
    counts: dict[str, int] = {}
    for raw in values:
        value = (raw or "").strip()
        if not value:
            continue
        counts[value] = counts.get(value, 0) + 1
    if not counts:
        return ""
    return max(counts.items(), key=lambda item: (item[1], item[0]))[0]


def is_avoir_document(filename: str, text: str = "", fact_num: str = "") -> bool:
    return "avoir" in f"{filename}\n{text}\n{fact_num}".lower()


def apply_avoir_signs(result: ExtractionResult) -> ExtractionResult:
    is_avoir = is_avoir_document(result.filename, result.raw_text)
    if not is_avoir and result.lines:
        is_avoir = any(is_avoir_document("", "", line.fact_num) for line in result.lines)
    if not is_avoir:
        return result

    for line in result.lines:
        if line.m_ht > 0:
            line.m_ht = -abs(line.m_ht)
        if line.tva > 0:
            line.tva = -abs(line.tva)
        if line.m_ttc > 0:
            line.m_ttc = -abs(line.m_ttc)
    return result


def _should_consolidate_group(group: list[InvoiceLine]) -> bool:
    if len(group) <= 1:
        return False
    has_zero_tva = any(abs(line.tva) < 1e-9 for line in group)
    has_non_zero_tva = any(abs(line.tva) >= 1e-9 for line in group)
    return has_zero_tva and has_non_zero_tva


def consolidate_lines(lines: list[InvoiceLine]) -> list[InvoiceLine]:
    if len(lines) <= 1:
        return lines

    groups: dict[tuple[str, float], list[InvoiceLine]] = defaultdict(list)
    for line in lines:
        groups[(line.fact_num or "", round(line.taux, 2))].append(line)

    merged: list[InvoiceLine] = []
    for (_fact_num, taux), group in groups.items():
        if len(group) == 1 or not _should_consolidate_group(group):
            merged.extend(group)
            continue

        total_ht = round(sum(line.m_ht for line in group), 2)
        total_tva = round(sum(line.tva for line in group), 2)
        total_ttc = round(sum(line.m_ttc for line in group), 2)
        sign = -1 if total_ht < 0 or any(line.m_ht < 0 for line in group) else 1
        abs_ht = abs(total_ht)

        if abs_ht > 0:
            expected_tva = round(abs_ht * taux, 2) * sign
            if abs(total_tva) < 1e-9 or any(line.tva == 0 for line in group):
                total_tva = expected_tva
            if abs(total_ttc) <= abs_ht or any(abs(line.m_ttc) <= abs(line.m_ht) for line in group):
                total_ttc = round(total_ht + total_tva, 2)

        base = group[0].model_copy(deep=True)
        base.m_ht = total_ht
        base.tva = total_tva
        base.m_ttc = total_ttc
        merged.append(base)

    return merged


def normalize_extraction_results(
    results: list[ExtractionResult],
    client_ice: str = "",
) -> list[ExtractionResult]:
    excluded = frozenset(build_excluded_ices(client_ice))
    normalized: list[ExtractionResult] = []
    for result in results:
        item = apply_avoir_signs(result.model_copy(deep=True))
        item = apply_vat_reconciliation(item)
        item.lines = consolidate_lines(item.lines)
        item.warnings = list(dict.fromkeys(item.warnings))
        normalized.append(item)

    groups: dict[str, dict] = defaultdict(lambda: {"filenames": [], "lines": [], "ices": [], "ifs": []})
    for result in normalized:
        group_key = folder_key(result.filename) or (
            (result.lines[0].lib_frss if result.lines else "") or "unknown"
        ).upper()
        bucket = groups[group_key]
        bucket["filenames"].append(result.filename)
        for line in result.lines:
            bucket["lines"].append(line)
            if line.ice_frs:
                bucket["ices"].append(line.ice_frs)
            if line.if_fournisseur:
                bucket["ifs"].append(line.if_fournisseur)

    for _group_key, bucket in groups.items():
        path_hint = supplier_hint_from_path(bucket["filenames"][0] if bucket["filenames"] else "")
        best_ice = pick_best_ice(bucket["ices"], excluded)
        best_if = pick_most_common(bucket["ifs"])
        best_name = pick_most_common([line.lib_frss for line in bucket["lines"]])
        if path_hint and not best_name:
            best_name = path_hint.get("lib_frss", "")

        for line in bucket["lines"]:
            if best_name and not line.lib_frss:
                line.lib_frss = best_name
            if best_ice and (not line.ice_frs or is_excluded_ice(line.ice_frs)):
                line.ice_frs = best_ice
            if best_if and not line.if_fournisseur:
                line.if_fournisseur = best_if

    return normalized
