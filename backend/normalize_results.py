from __future__ import annotations

from collections import defaultdict
from contextvars import ContextVar
from pathlib import PurePosixPath
import re
import unicodedata

from models import ExtractionResult, InvoiceLine
from vat_intelligence import apply_vat_reconciliation, fill_missing_ttc, sanitize_impossible_amounts

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


GENERIC_FOLDERS = {".", "..", "unknown", "factures", "invoices", "scans", "documents", "pdf"}
# Google Drive / Takeout : « Probun-20260816T102702Z-1-001 »
DRIVE_EXPORT_STEM = re.compile(
    r"^(?P<name>.+)-(?P<ts>\d{8}T\d{6}Z)(?P<seq>(?:-\d+)+)(?:_[a-z0-9]+)?$",
    re.I,
)
_PERIOD_FOLDER = re.compile(
    r"\b(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|"
    r"novembre|d[ée]cembre|trimestre|semestre)\b",
    re.I,
)


def strip_drive_export_stem(segment: str) -> str | None:
    """« Probun-20260816T102702Z-1-001 » → « Probun ». None si ce n'est pas un export Drive."""
    match = DRIVE_EXPORT_STEM.fullmatch((segment or "").strip())
    if not match:
        return None
    name = (match.group("name") or "").strip()
    return name or None


def _is_period_folder(key: str) -> bool:
    text = (key or "").strip()
    if not text:
        return True
    return bool(re.fullmatch(r"[\d\s._/-]+", text) or _PERIOD_FOLDER.search(text))


def _folder_label(key: str) -> str:
    return " ".join(word.capitalize() for word in re.split(r"[\s_-]+", key) if word)


def _is_noisy_folder_label(label: str) -> bool:
    """Rejette un libellé trop numérique (horodatage Drive resté collé)."""
    text = (label or "").strip()
    if not text:
        return True
    return sum(ch.isdigit() for ch in text) > max(3, len(text) / 4)


def supplier_folder_segment(filename: str) -> str:
    """Dossier interne utile, pas le nom du fichier ZIP Drive.

    « Probun-20260816T102702Z-1-001/Probun/facture.pdf » → « Probun »
    """
    parts = [part for part in PurePosixPath(filename).as_posix().split("/") if part and part != "."]
    if len(parts) <= 1:
        return ""
    fallback = ""
    for part in parts[:-1]:
        stripped = strip_drive_export_stem(part)
        lowered = part.lower().strip()
        if lowered in GENERIC_FOLDERS or (stripped and stripped.lower() in GENERIC_FOLDERS):
            continue
        if stripped is not None:
            if not fallback and not _is_period_folder(stripped.lower()):
                fallback = stripped
            continue
        if _is_period_folder(lowered):
            continue
        return part
    return fallback


def supplier_hint_from_path(filename: str) -> dict[str, str] | None:
    """Indice organisationnel (dossier interne) — pas le stem Drive, pas de règle fournisseur."""
    key = supplier_folder_segment(filename)
    if not key:
        return None
    label = _folder_label(key)
    if not label or _is_noisy_folder_label(label):
        return None
    return {"lib_frss": label}


def looks_like_supplier_name(name: str) -> bool:
    """Écarte les restes d'OCR : codes produit, fragments, suites sans voyelle."""
    text = (name or "").strip()
    if len(text) < 4 or len(text) > 60:
        return False
    letters = [ch for ch in text if ch.isalpha()]
    if len(letters) < 4:
        return False
    if sum(ch.isdigit() for ch in text) > len(text) / 4:
        return False
    if not any(ch.lower() in "aeiouyàâéèêîôûü" for ch in letters):
        return False
    # Un nom de société tient en quelques mots.
    return len(text.split()) <= 6


LEGAL_FORM_TOKENS = {
    "SARL", "SARLAU", "SA", "SAS", "SASU", "SNC", "SCS", "STE", "SOCIETE", "AU", "EURL",
}


def supplier_name_key(name: str) -> str:
    """« EAT MEAT », « EATMEAT SARL » et « EATMEAT » désignent la même société."""
    text = unicodedata.normalize("NFD", str(name or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = re.sub(r"[.'’]", "", text).upper()
    tokens = [t for t in re.split(r"[^A-Z0-9]+", text) if t and t not in LEGAL_FORM_TOKENS]
    return "".join(tokens)


def complete_supplier_identifiers(lines: list[InvoiceLine]) -> int:
    """Complète ICE et IF manquants depuis les autres factures du fournisseur."""
    by_supplier: dict[str, dict[str, list[str]]] = defaultdict(lambda: {"ices": [], "ifs": []})
    if_by_ice: dict[str, list[str]] = defaultdict(list)

    for line in lines:
        key = supplier_name_key(line.lib_frss)
        ice = normalize_ice_digits(line.ice_frs)
        fiscal = re.sub(r"\D", "", line.if_fournisseur or "")
        if key:
            if ice and not is_excluded_ice(ice):
                by_supplier[key]["ices"].append(ice)
            if fiscal:
                by_supplier[key]["ifs"].append(fiscal)
        if ice and fiscal:
            if_by_ice[ice].append(fiscal)

    completed = 0
    for line in lines:
        group = by_supplier.get(supplier_name_key(line.lib_frss))

        if not normalize_ice_digits(line.ice_frs) and group and group["ices"]:
            line.ice_frs = pick_most_common(group["ices"])
            line.ice_inferred = True
            completed += 1

        if not (line.if_fournisseur or "").strip():
            ice = normalize_ice_digits(line.ice_frs)
            candidates = if_by_ice.get(ice) or (group["ifs"] if group else [])
            if candidates:
                line.if_fournisseur = pick_most_common(candidates)
                line.if_inferred = True
                completed += 1

    return completed


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


_DATE_LIKE_NUMBER = re.compile(
    r"^(?:\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})$"
)
_RATE_AS_AMOUNT = {7.0, 10.0, 14.0, 20.0}


def _invoice_number_key(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper()).lstrip("0")


def _is_real_invoice_number(value: str) -> bool:
    text = str(value or "").strip()
    return bool(_invoice_number_key(text)) and not _DATE_LIKE_NUMBER.match(text)


def _amount_key(line: InvoiceLine) -> tuple:
    return (
        round(abs(line.m_ht), 2),
        round(abs(line.tva), 2),
        round(abs(line.m_ttc), 2),
        round(float(line.taux or 0), 3),
    )


def drop_same_document_duplicates(result: ExtractionResult) -> int:
    """Lignes en double produites par la lecture d'un même document.

    Supprimé seulement sur preuve :
    - même montants, même taux, et un « numéro » qui est en fait une date
      (ou vide) alors qu'une jumelle porte un vrai numéro : la date de la
      facture a été lue comme une 2e facture (TVA comptée deux fois) ;
    - ligne fantôme HT 0 dont la « TVA » vaut 7, 10, 14 ou 20 : c'est le taux
      imprimé lu comme un montant, à côté de la vraie ligne de la même facture.

    Deux lignes aux mêmes montants mais avec deux vrais numéros différents
    sont conservées (deux livraisons identiques, par exemple).
    """
    lines = list(result.lines or [])
    if len(lines) < 2:
        return 0
    drop: set[int] = set()

    by_amounts: dict[tuple, list[int]] = defaultdict(list)
    for index, line in enumerate(lines):
        by_amounts[_amount_key(line)].append(index)
    for indexes in by_amounts.values():
        if len(indexes) < 2:
            continue
        real = [i for i in indexes if _is_real_invoice_number(lines[i].fact_num)]
        if not real:
            continue
        drop.update(i for i in indexes if i not in real)

    for index, line in enumerate(lines):
        if index in drop:
            continue
        tva = round(abs(line.tva), 2)
        if abs(line.m_ht) >= 0.01 or tva not in _RATE_AS_AMOUNT:
            continue
        if abs(line.m_ttc) >= 0.01 and round(abs(line.m_ttc), 2) != tva:
            continue
        key = _invoice_number_key(line.fact_num)
        twins = [
            other for j, other in enumerate(lines)
            if j != index and j not in drop and abs(other.m_ht) >= 0.01
            and (not key or _invoice_number_key(other.fact_num) == key)
        ]
        if twins:
            drop.add(index)

    if not drop:
        return 0
    result.lines = [line for i, line in enumerate(lines) if i not in drop]
    result.warnings.append(
        f"{len(drop)} ligne(s) en double retirée(s) (date lue comme n° de facture, "
        "ou taux lu comme montant) — vérifiez les montants de cette pièce."
    )
    return len(drop)


def _bucket_identity(bucket: dict, excluded: frozenset[str]) -> tuple[str, set[str]]:
    """ICE du groupe s'il est unique, et noms (clés) des lignes qui le portent.

    Un dossier importé (« Autres », « Août 2026 ») mélange des fournisseurs :
    l'ICE majoritaire ne doit jamais être collé sur la facture d'un autre.
    """
    ices = {
        ice for ice in (normalize_ice_digits(raw) for raw in bucket["ices"])
        if ice and not re.fullmatch(r"0+", ice) and ice not in excluded
    }
    if len(ices) != 1:
        return "", set()
    ice = next(iter(ices))
    keys = {
        supplier_name_key(line.lib_frss)
        for line in bucket["lines"]
        if normalize_ice_digits(line.ice_frs) == ice
    } - {""}
    return ice, keys


def normalize_extraction_results(
    results: list[ExtractionResult],
    client_ice: str = "",
) -> list[ExtractionResult]:
    excluded = frozenset(build_excluded_ices(client_ice))
    normalized: list[ExtractionResult] = []
    for result in results:
        item = apply_avoir_signs(result.model_copy(deep=True))
        is_avoir = is_avoir_document(item.filename, item.raw_text)
        if not is_avoir and item.lines:
            is_avoir = any(is_avoir_document("", "", line.fact_num) for line in item.lines)
        # Doublons retirés sur les montants tels que lus, avant toute correction
        # (une correction transformerait la ligne fantôme en ligne plausible).
        drop_same_document_duplicates(item)
        item = apply_vat_reconciliation(item)
        item.lines = [
            fill_missing_ttc(sanitize_impossible_amounts(line, is_avoir))
            for line in consolidate_lines(item.lines)
        ]
        # La date de paiement ne vient que du relevé bancaire : une facture ne
        # prouve pas son règlement, même si l'IA propose une date.
        for line in item.lines:
            line.date_paie = None
        item.warnings = list(dict.fromkeys(item.warnings))
        normalized.append(item)

    groups: dict[str, dict] = defaultdict(lambda: {"filenames": [], "lines": [], "ices": [], "ifs": []})
    for result in normalized:
        group_key = (
            folder_key(result.filename)
            or supplier_name_key(result.lines[0].lib_frss if result.lines else "")
            or "unknown"
        )
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
        best_ice, ice_names = _bucket_identity(bucket, excluded)
        best_if = pick_most_common([
            line.if_fournisseur for line in bucket["lines"]
            if best_ice and normalize_ice_digits(line.ice_frs) == best_ice and line.if_fournisseur
        ])
        best_name = pick_most_common([line.lib_frss for line in bucket["lines"]])
        if path_hint and not best_name:
            best_name = path_hint.get("lib_frss", "")

        # Dossier interne seulement si la facture n'a pas déjà un nom.
        folder_name = (path_hint or {}).get("lib_frss", "")

        for line in bucket["lines"]:
            if not (line.lib_frss or "").strip() and folder_name:
                line.lib_frss = folder_name
                line.supplier_from_folder = True
            elif best_name and not line.lib_frss:
                line.lib_frss = best_name
            elif not looks_like_supplier_name(line.lib_frss):
                line.lib_frss = line.lib_frss.strip()
            # Même fournisseur seulement : nom absent, ou nom d'une ligne qui
            # porte cet ICE.
            name_key = supplier_name_key(line.lib_frss)
            same_supplier = bool(best_ice) and (not name_key or name_key in ice_names)
            if same_supplier and (not line.ice_frs or is_excluded_ice(line.ice_frs)):
                line.ice_frs = best_ice
                line.ice_inferred = True
            if (
                same_supplier and best_if and not line.if_fournisseur
                and normalize_ice_digits(line.ice_frs) == best_ice
            ):
                line.if_fournisseur = best_if
                line.if_inferred = True

    complete_supplier_identifiers([line for item in normalized for line in item.lines])

    from field_confidence import attach_field_confidence

    for result in normalized:
        for line in result.lines:
            line.extraction_engine = result.engine
        attach_field_confidence(
            result.lines,
            client_ice=client_ice,
            engine=result.engine,
            document_warnings=result.warnings,
        )

    return normalized
