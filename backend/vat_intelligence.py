"""Intelligence TVA générique — aucune dépendance fournisseur."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from models import ExtractionResult, InvoiceLine

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
        if taux_norm not in (0.1, 0.2):
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
        if taux_norm not in (0.1, 0.2):
            continue
        if abs(ht) > 0:
            ratio = round(abs(tva) / abs(ht), 2)
            if ratio not in (0.1, 0.2) and not (0.08 <= ratio <= 0.12 or 0.18 <= ratio <= 0.22):
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


def reconcile_line_amounts(line: InvoiceLine, text: str = "") -> InvoiceLine:
    """Ne corrige que sur preuve, jamais sur la seule arithmétique.

    « HT=150, TVA=30 » (correct) et « TTC=150 pris pour du HT, TVA recalculée »
    donnent exactement les mêmes nombres : seul le document permet de trancher.
    Le ratio TVA/HT est en revanche une preuve suffisante quand il vaut
    taux/(1+taux), impossible sur une ligne correcte.
    """
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
    if ht > 0.01 and line.taux in (0.1, 0.2):
        return abs(tva / ht - line.taux) <= 0.025
    return True


def result_needs_escalation(result: ExtractionResult) -> bool:
    """Vrai si l'extraction est douteuse et mérite un modèle plus capable."""
    if not result.lines:
        return True
    return any(not line_is_coherent(line) for line in result.lines)


def apply_vat_reconciliation(result: ExtractionResult) -> ExtractionResult:
    """Réconciliation TVA générique post-extraction (IA ou OCR)."""
    from models import InvoiceLine

    text = result.raw_text or ""
    ventilation = extract_vat_lines_from_text(text)
    distinct_invoices = {line.fact_num for line in result.lines if line.fact_num}

    # Document multi-factures : la ventilation globale n'appartient pas à une
    # seule facture, on ne réécrit donc pas les lignes à partir d'un modèle.
    if ventilation and result.lines and len(distinct_invoices) <= 1:
        template = result.lines[0]
        result.lines = [
            template.model_copy(
                update={
                    "m_ht": item["m_ht"],
                    "tva": item["tva"],
                    "m_ttc": item["m_ttc"],
                    "taux": item["taux"],
                }
            )
            for item in ventilation
        ]
        result.warnings.append(
            f"Ventilation relue depuis le document ({len(result.lines)} ligne(s))."
        )
        return result

    result.lines = align_lines_with_footer_totals(result.lines, text)
    changed = False
    fixed: list[InvoiceLine] = []
    for line in result.lines:
        before = (line.m_ht, line.tva, line.m_ttc)
        fixed.append(reconcile_line_amounts(line, text))
        if (fixed[-1].m_ht, fixed[-1].tva, fixed[-1].m_ttc) != before:
            changed = True
    result.lines = fixed
    if changed:
        result.warnings.append("Montants TVA réconciliés (contrôle mathématique).")
    return result
