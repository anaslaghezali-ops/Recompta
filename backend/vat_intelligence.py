"""Intelligence TVA générique — aucune dépendance fournisseur."""

from __future__ import annotations

import re
from models import ALLOWED_TAUX, ExtractionResult, InvoiceLine

TTC_VENTILATION_PATTERN = re.compile(
    r"(\d+[,.]\d+)\s*TTC\s+(\d+[,.]\d+)\s*%?\s+([\d.,]+)",
    re.I,
)


def _parse_amount(value: str | None) -> float | None:
    from invoice_extractor import _parse_amount as parse

    return parse(value)


def parse_ttc_ventilation(text: str) -> list[dict[str, float]]:
    """Lignes type « 1905,00 TTC 20% 317,50 » — tous fournisseurs."""
    items: list[dict[str, float]] = []
    for match in TTC_VENTILATION_PATTERN.finditer(text):
        ttc = _parse_amount(match.group(1))
        taux = _parse_amount(match.group(2))
        tva = _parse_amount(match.group(3))
        if ttc is None or taux is None or tva is None:
            continue
        taux_norm = taux / 100 if taux > 1 else taux
        if taux_norm not in ALLOWED_TAUX:
            continue
        ht = round(ttc - tva, 2)
        items.append({"m_ht": ht, "tva": tva, "m_ttc": ttc, "taux": taux_norm})
    return items


def parse_rate_ht_tva_table(text: str) -> list[dict[str, float]]:
    """Tableau « Taux | Montant HT | TVA » — détecté par structure, pas par nom."""
    items: list[dict[str, float]] = []
    block = text
    lower = text.lower()
    for marker in ("taux", "montant ht", "ventilation"):
        idx = lower.find(marker)
        if idx != -1:
            block = text[idx:]
            break

    amount = r"(?:-?[\d]{1,3}(?:[.\s]\d{3})*(?:,\d{2})|-?[\d]+,\d{2})"
    row_pattern = re.compile(
        rf"^\s*(\d{{1,2}}[,.]\d{{2}})\s+({amount})\s+({amount})\s*$",
        re.M,
    )

    for match in row_pattern.finditer(block):
        taux = _parse_amount(match.group(1))
        ht = _parse_amount(match.group(2))
        tva = _parse_amount(match.group(3))
        if taux is None or ht is None or tva is None:
            continue
        if abs(ht) < 0.01 and abs(tva) < 0.01:
            continue
        taux_norm = taux / 100 if taux > 1 else taux
        if taux_norm not in ALLOWED_TAUX:
            continue
        if abs(ht) > 0:
            ratio = round(abs(tva) / abs(ht), 2)
            if (
                ratio not in (0.0, 0.1, 0.2)
                and not (0.08 <= ratio <= 0.12 or 0.18 <= ratio <= 0.22)
                and not (abs(tva) < 0.05 and abs(ratio) < 0.02)
            ):
                continue
        sign = -1 if ht < 0 or tva < 0 else 1
        ht_val = abs(ht) * sign
        tva_val = abs(tva) * sign
        items.append(
            {
                "m_ht": ht_val,
                "tva": tva_val,
                "m_ttc": round(ht_val + tva_val, 2),
                "taux": taux_norm,
            }
        )
    return items


def extract_footer_totals(text: str) -> tuple[float | None, float | None, float | None]:
    from invoice_extractor import _extract_amounts

    return _extract_amounts(text)


def extract_vat_lines_from_text(text: str) -> list[dict[str, float]]:
    """Meilleur jeu de lignes TVA trouvé dans le document (générique)."""
    candidates = [
        parse_ttc_ventilation(text),
        parse_rate_ht_tva_table(text),
    ]
    candidates = [c for c in candidates if c]
    if not candidates:
        return []
    return max(candidates, key=len)


def _is_ht_formula_on_ttc_amount(m_ht: float, tva: float, taux: float) -> bool:
    ht = abs(m_ht)
    tv = abs(tva)
    if ht < 0.01 or tv < 0.01 or taux not in (0.1, 0.2):
        return False
    if abs(tv - round(ht * taux, 2)) > 0.05:
        return False
    implied_ht = ht / (1 + taux)
    return abs(tv - round(implied_ht * taux, 2)) > 0.05


def _amount_labeled_ttc_in_text(text: str, amount: float) -> bool:
    if not text.strip() or abs(amount) < 0.01:
        return False
    value = abs(amount)
    whole = int(value)
    frac = round((value - whole) * 100)
    for variant in (f"{whole},{frac:02d}", f"{whole}.{frac:02d}", str(whole)):
        if re.search(rf"{re.escape(variant)}\s*TTC", text, re.I):
            return True
    return False


def _is_ttc_mislabeled_as_ht(m_ht: float, tva: float, taux: float) -> bool:
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


def _convert_ttc_amount_to_ht_line(line: InvoiceLine, ttc_value: float) -> InvoiceLine:
    sign = -1 if ttc_value < 0 else 1
    ttc_abs = abs(ttc_value)
    tva_abs = abs(line.tva)
    if _is_ht_formula_on_ttc_amount(line.m_ht, line.tva, line.taux):
        ht_abs = round(ttc_abs / (1 + line.taux), 2)
        tva_abs = round(ttc_abs - ht_abs, 2)
    elif tva_abs > 0.01:
        ht_abs = round(ttc_abs - tva_abs, 2)
    else:
        ht_abs = round(ttc_abs / (1 + line.taux), 2)
        tva_abs = round(ttc_abs - ht_abs, 2)
    line.m_ht = ht_abs * sign
    line.tva = tva_abs * sign
    line.m_ttc = round(ttc_abs, 2) * sign
    return line


def reconcile_line_amounts(
    line: InvoiceLine, text: str = "", footer_ht: float | None = None
) -> InvoiceLine:
    """Ne corrige que sur preuve, jamais sur la seule arithmétique.

    « HT=150, TVA=30 » (correct) et « TTC=150 pris pour du HT, TVA recalculée »
    donnent exactement les mêmes nombres : seul le document permet de trancher.
    Le ratio TVA/HT est en revanche une preuve suffisante quand il vaut
    taux/(1+taux), impossible sur une ligne correcte.
    """
    # Le document étiquette ce montant « Total HT » : ne pas le réinterpréter.
    # Sur une facture à plusieurs taux, le ratio global (17,5 % par exemple)
    # ressemble à tort à un montant TTC.
    if footer_ht is not None and abs(abs(line.m_ht) - footer_ht) <= max(0.05, footer_ht * 0.01):
        return line
    if _amount_labeled_ttc_in_text(text, line.m_ht):
        return _convert_ttc_amount_to_ht_line(line, line.m_ht)
    if _is_ttc_mislabeled_as_ht(line.m_ht, line.tva, line.taux):
        return _convert_ttc_amount_to_ht_line(line, line.m_ht)
    return line


def align_lines_with_footer_totals(lines: list[InvoiceLine], text: str) -> list[InvoiceLine]:
    footer_ht, footer_tva, footer_ttc = extract_footer_totals(text)
    if footer_ht is None or footer_ttc is None:
        return lines

    updated: list[InvoiceLine] = []
    for line in lines:
        if abs(abs(line.m_ht) - footer_ttc) <= 1.0 and abs(abs(line.m_ht) - footer_ht) > 1.0:
            updated.append(_convert_ttc_amount_to_ht_line(line, line.m_ht))
        elif (
            len(lines) == 1
            and abs(abs(line.m_ht) - footer_ttc) <= 1.0
            and abs(abs(line.m_ttc) - footer_ttc) <= 1.0
            and abs(abs(line.m_ht) - footer_ht) > 1.0
        ):
            sign = -1 if line.m_ht < 0 else 1
            line.m_ht = footer_ht * sign
            line.tva = (footer_tva if footer_tva is not None else line.tva) * sign
            line.m_ttc = footer_ttc * sign
            updated.append(line)
        else:
            updated.append(line)
    return updated


def line_is_coherent(line: InvoiceLine) -> bool:
    """HT + TVA = TTC et TVA/HT cohérent avec le taux."""
    ht = abs(line.m_ht)
    tva = abs(line.tva)
    ttc = abs(line.m_ttc)
    if ht < 0.01 and ttc < 0.01:
        return False
    if abs(ht + tva - ttc) > max(0.05, ttc * 0.01):
        return False
    if ht > 0.01 and line.taux in ALLOWED_TAUX:
        if line.taux == 0.0:
            return tva <= 0.05 and abs(ht - ttc) <= 0.05
        return abs(tva / ht - line.taux) <= 0.025
    return True


def result_needs_escalation(result: ExtractionResult) -> bool:
    """Vrai si l'extraction est douteuse et mérite un modèle plus capable."""
    if not result.lines:
        return True
    if any(not line_is_coherent(line) for line in result.lines):
        return True
    from vat_multi_rate import result_needs_multi_rate_escalation

    return result_needs_multi_rate_escalation(result)


def _signs_are_mixed(ht: float, tva: float, ttc: float) -> bool:
    vals = [v for v in (ht, tva, ttc) if abs(v) >= 0.01]
    if len(vals) < 2:
        return False
    return len({1 if v > 0 else -1 for v in vals}) > 1


def _magnitudes_coherent(ht: float, tva: float, ttc: float, taux: float) -> bool:
    abs_ht, abs_tva, abs_ttc = abs(ht), abs(tva), abs(ttc)
    if abs_ht < 0.01 and abs_ttc < 0.01:
        return False
    if abs(abs_ht + abs_tva - abs_ttc) > 0.05:
        return False
    if abs_ht > 0.01 and taux in ALLOWED_TAUX:
        if taux == 0.0:
            return abs_tva <= 0.05 and abs(abs_ht - abs_ttc) <= 0.05
        return abs(abs_tva / abs_ht - taux) <= 0.025
    return True


def _is_blended_multi_rate(ht: float, tva: float) -> bool:
    """Taux global entre 10 % et 20 % : facture multi-taux, ne pas « corriger »."""
    if abs(ht) < 0.01 or abs(tva) < 0.01:
        return False
    rate = abs(tva) / abs(ht)
    in_10 = 0.085 <= rate <= 0.115
    in_20 = 0.185 <= rate <= 0.215
    return 0.085 <= rate <= 0.215 and not in_10 and not in_20


def _ht_is_actually_the_rate(ht: float, tva: float, ttc: float) -> float | None:
    """OCR/IA a mis 10 ou 20 (le taux) dans le HT, et TTC × taux dans la TVA."""
    abs_ht, abs_tva, abs_ttc = abs(ht), abs(tva), abs(ttc)
    rate: float | None = None
    if abs(abs_ht - 20) <= 0.011 or abs(abs_ht - 0.2) <= 1e-6:
        rate = 0.2
    elif abs(abs_ht - 10) <= 0.011 or abs(abs_ht - 0.1) <= 1e-6:
        rate = 0.1
    if rate is None:
        return None
    # Une vraie petite ligne à 20 MAD HT a TVA/HT ≈ 10/20 %. Celle-ci non.
    if abs_ht > 0.01 and abs_tva / abs_ht <= 0.25:
        return None
    if abs_ttc < 50 and abs_tva < 50:
        return None
    return rate


def _is_zero_rate_line(ht: float, tva: float, ttc: float) -> bool:
    abs_ht, abs_tva, abs_ttc = abs(ht), abs(tva), abs(ttc)
    if abs_ht < 0.01:
        return False
    return abs_tva <= 0.05 and abs(abs_ht - abs_ttc) <= 0.05


def _rebuild_from_ttc(line: InvoiceLine, ttc_abs: float, taux: float, sign: int) -> InvoiceLine:
    ht_abs = round(ttc_abs / (1 + taux), 2)
    tva_abs = round(ttc_abs - ht_abs, 2)
    line.m_ht = ht_abs * sign
    line.tva = tva_abs * sign
    line.m_ttc = round(ttc_abs, 2) * sign
    line.taux = taux
    line.amounts_sanitized = True
    line.tva_calculated = True
    return line


def _finalize_sanitize(line: InvoiceLine, before: tuple[float, float, float, float]) -> InvoiceLine:
    after = (line.m_ht, line.tva, line.m_ttc, line.taux)
    if after != before and not line.amounts_sanitized:
        line.amounts_sanitized = True
    return line


def sanitize_impossible_amounts(line: InvoiceLine, is_avoir: bool = False) -> InvoiceLine:
    """Interdit HT/TVA de signes opposés, TVA > HT, et HT = 10 ou 20 (le taux).

    Ne touche pas une ligne déjà cohérente (ex. Carrefour 150/30/180) ni une
    facture multi-taux résumée (taux global entre 10 % et 20 %).
    """
    before = (line.m_ht, line.tva, line.m_ttc, line.taux)
    sign = -1 if is_avoir else 1
    ht, tva, ttc = abs(line.m_ht) * sign, abs(line.tva) * sign, abs(line.m_ttc) * sign
    taux = line.taux if line.taux in ALLOWED_TAUX else 0.2

    if _is_zero_rate_line(ht, tva, ttc):
        line.m_ht, line.tva, line.m_ttc = ht, tva, ttc
        line.taux = 0.0
        return _finalize_sanitize(line, before)

    rate_from_ht = _ht_is_actually_the_rate(ht, tva, ttc)
    if rate_from_ht is not None:
        ttc_abs = abs(ttc)
        if ttc_abs < 50 and abs(tva) > 50:
            ttc_abs = round(abs(tva) / rate_from_ht, 2)
        return _rebuild_from_ttc(line, ttc_abs, rate_from_ht, sign)

    line.m_ht, line.tva, line.m_ttc = ht, tva, ttc
    if _magnitudes_coherent(ht, tva, ttc, taux):
        return _finalize_sanitize(line, before)
    if _is_blended_multi_rate(ht, tva) and abs(abs(ht) + abs(tva) - abs(ttc)) <= 0.05:
        return _finalize_sanitize(line, before)

    abs_ht, abs_tva, abs_ttc = abs(ht), abs(tva), abs(ttc)
    ordered = sorted((abs_ht, abs_tva, abs_ttc), reverse=True)
    largest, mid, small = ordered
    if largest > 0.01 and abs(mid + small - largest) <= 0.05:
        cand_ht, cand_tva, cand_ttc = mid, small, largest
        if cand_ht > 0.01:
            ratio = cand_tva / cand_ht
            if abs(ratio - 0.1) <= 0.025:
                line.m_ht, line.tva, line.m_ttc = cand_ht * sign, cand_tva * sign, cand_ttc * sign
                line.taux = 0.1
                return _finalize_sanitize(line, before)
            if abs(ratio - 0.2) <= 0.025:
                line.m_ht, line.tva, line.m_ttc = cand_ht * sign, cand_tva * sign, cand_ttc * sign
                line.taux = 0.2
                return _finalize_sanitize(line, before)

    if largest > 0.01:
        result = _rebuild_from_ttc(line, largest, taux, sign)
    else:
        result = line
    return _finalize_sanitize(result, before)


def fill_missing_ttc(line: InvoiceLine) -> InvoiceLine:
    """Si le TTC n'est pas lisible, HT + TVA suffisent à le reconstituer."""
    ht, tva, ttc = line.m_ht, line.tva, line.m_ttc
    if abs(ttc) >= 0.01 or abs(ht) < 0.01:
        return line
    if _signs_are_mixed(ht, tva, ttc):
        return line
    if abs(tva) < 0.01:
        if line.taux == 0.0:
            line.m_ttc = round(ht, 2)
            line.ttc_reconstructed = True
        return line
    if abs(tva) > abs(ht) + 0.05:
        return line
    line.m_ttc = round(ht + tva, 2)
    line.ttc_reconstructed = True
    return line


def _result_is_avoir(result: ExtractionResult) -> bool:
    blob = f"{result.filename}\n{result.raw_text or ''}".lower()
    if "avoir" in blob:
        return True
    return any("avoir" in (line.fact_num or "").lower() for line in result.lines)


def apply_vat_reconciliation(result: ExtractionResult) -> ExtractionResult:
    """Réconciliation TVA générique post-extraction (IA ou OCR)."""
    text = result.raw_text or ""
    is_avoir = _result_is_avoir(result)
    ventilation = extract_vat_lines_from_text(text)
    distinct_invoices = {line.fact_num for line in result.lines if line.fact_num}

    # Document multi-factures : la ventilation globale n'appartient pas à une
    # seule facture, on ne réécrit donc pas les lignes à partir d'un modèle.
    if ventilation and result.lines and len(distinct_invoices) <= 1:
        from vat_multi_rate import expand_lines_from_ventilation, should_replace_with_ventilation

        if should_replace_with_ventilation(result, ventilation):
            template = result.lines[0]
            result.lines = expand_lines_from_ventilation(template, ventilation, is_avoir=is_avoir)
            return result

    # Corrections appuyées sur le document : pas de message, le tableau affiche
    # déjà les valeurs retenues.
    footer_ht, _footer_tva, _footer_ttc = extract_footer_totals(text)
    result.lines = align_lines_with_footer_totals(result.lines, text)
    result.lines = [reconcile_line_amounts(line, text, footer_ht) for line in result.lines]
    result.lines = [sanitize_impossible_amounts(line, is_avoir) for line in result.lines]

    from vat_multi_rate import append_blended_warnings

    result = append_blended_warnings(result)
    result.lines = [fill_missing_ttc(line) for line in result.lines]
    return result
