from __future__ import annotations

import re
from collections import defaultdict
from contextvars import ContextVar
from pathlib import PurePosixPath

from models import ExtractionResult, InvoiceLine

_excluded_client_ices: ContextVar[frozenset[str]] = ContextVar(
    "_excluded_client_ices",
    default=frozenset(),
)

FOLDER_SUPPLIERS: dict[str, dict[str, str]] = {
    "achibest": {
        "lib_frss": "ACHIBEST",
        "ice_frs": "000229475000050",
        "if_fournisseur": "1102277",
    },
    "eatmeat": {
        "lib_frss": "EATMEAT",
        "ice_frs": "002540001000040",
        "if_fournisseur": "45978904",
    },
    "mose": {
        "lib_frss": "MOSE Food",
        "ice_frs": "000161664000072",
        "if_fournisseur": "14427958",
    },
    "mose food": {
        "lib_frss": "MOSE Food",
        "ice_frs": "000161664000072",
        "if_fournisseur": "14427958",
    },
}


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
    key = folder_key(filename)
    if not key:
        return None
    if key in FOLDER_SUPPLIERS:
        return FOLDER_SUPPLIERS[key]
    for pattern, hint in FOLDER_SUPPLIERS.items():
        if pattern in key:
            return hint
    return None


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


def _is_ttc_mislabeled_as_ht(m_ht: float, tva: float, taux: float) -> bool:
    """Détecte quand un montant TTC a été saisi dans m_ht (ex. ventilation MOSE Food)."""
    ht = abs(m_ht)
    tv = abs(tva)
    if ht < 0.01 or tv < 0.01 or taux not in (0.1, 0.2):
        return False
    ratio = tv / ht
    as_ht_rate = abs(ratio - taux) <= 0.025
    as_ttc_rate = abs(ratio - taux / (1 + taux)) <= 0.025
    if not as_ttc_rate or as_ht_rate:
        return False
    recomputed_ht = ht - tv
    if recomputed_ht <= 0:
        return False
    return abs(tv / recomputed_ht - taux) <= 0.025


def fix_ttc_mislabeled_line(line: InvoiceLine) -> InvoiceLine:
    if not _is_ttc_mislabeled_as_ht(line.m_ht, line.tva, line.taux):
        return line
    sign = -1 if line.m_ht < 0 else 1
    ttc_abs = abs(line.m_ht)
    tva_abs = abs(line.tva)
    ht_abs = round(ttc_abs - tva_abs, 2)
    line.m_ht = ht_abs * sign
    line.tva = tva_abs * sign
    line.m_ttc = round(ttc_abs, 2) * sign
    return line


TTC_VENTILATION_PATTERN = re.compile(
    r"(\d+[,.]\d+)\s*TTC\s+(\d+[,.]\d+)\s*%?\s+([\d.,]+)",
    re.I,
)


def parse_ttc_ventilation(text: str) -> list[dict[str, float]]:
    from invoice_extractor import _parse_amount

    items: list[dict[str, float]] = []
    for match in TTC_VENTILATION_PATTERN.finditer(text):
        ttc = _parse_amount(match.group(1))
        taux = _parse_amount(match.group(2))
        tva = _parse_amount(match.group(3))
        if ttc is None or taux is None or tva is None:
            continue
        taux_norm = taux / 100 if taux > 1 else taux
        if taux_norm not in (0.1, 0.2):
            continue
        ht = round(ttc - tva, 2)
        items.append({"m_ht": ht, "tva": tva, "m_ttc": ttc, "taux": taux_norm})
    return items


def reconcile_line_amounts(line: InvoiceLine) -> InvoiceLine:
    """Corrige toute incohérence HT/TVA/TTC (générique, tous fournisseurs)."""
    return fix_ttc_mislabeled_line(line)


def apply_ttc_ventilation_fixes(result: ExtractionResult) -> ExtractionResult:
    text = result.raw_text or ""
    ventilation = parse_ttc_ventilation(text)

    if ventilation:
        template = result.lines[0] if result.lines else None
        if template:
            new_lines: list[InvoiceLine] = []
            for item in ventilation:
                new_lines.append(
                    template.model_copy(
                        update={
                            "m_ht": item["m_ht"],
                            "tva": item["tva"],
                            "m_ttc": item["m_ttc"],
                            "taux": item["taux"],
                        }
                    )
                )
            result.lines = new_lines
            result.warnings.append(
                f"Ventilation TTC corrigée ({len(new_lines)} ligne(s) — montants TTC convertis en HT)."
            )
            return result

    fixed: list[InvoiceLine] = []
    changed = False
    for line in result.lines:
        before = (line.m_ht, line.tva, line.m_ttc)
        fixed.append(reconcile_line_amounts(line))
        after = (fixed[-1].m_ht, fixed[-1].tva, fixed[-1].m_ttc)
        if before != after:
            changed = True
    result.lines = fixed
    if changed:
        result.warnings.append("Montants TTC de la ventilation convertis en HT.")
    return result


def _should_consolidate_group(group: list[InvoiceLine]) -> bool:
    """Fusionne seulement les éclats produit (ex. EatMeat) où la TVA est sur une seule ligne."""
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
    for (fact_num, taux), group in groups.items():
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
        item = apply_ttc_ventilation_fixes(item)
        item.lines = consolidate_lines(item.lines)
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

    for group_key, bucket in groups.items():
        path_hint = supplier_hint_from_path(bucket["filenames"][0] if bucket["filenames"] else "")
        best_ice = (path_hint or {}).get("ice_frs") or pick_best_ice(bucket["ices"], excluded)
        best_if = (path_hint or {}).get("if_fournisseur") or pick_most_common(bucket["ifs"])
        best_name = (path_hint or {}).get("lib_frss") or pick_most_common(
            [line.lib_frss for line in bucket["lines"]]
        )

        for line in bucket["lines"]:
            if best_name:
                line.lib_frss = best_name
            if best_ice and (not line.ice_frs or is_excluded_ice(line.ice_frs)):
                line.ice_frs = best_ice
            if best_if:
                line.if_fournisseur = best_if

    return normalized
