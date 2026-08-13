"""Ventilation multi-taux DED — une ligne par taux (0 / 10 / 20 %).

Module générique : aucune règle par fournisseur. Réutilisable par l'IA,
la réconciliation texte et l'escalade de modèle.
"""

from __future__ import annotations

from models import ExtractionResult, InvoiceLine
from vat_intelligence import (
    _is_blended_multi_rate,
    extract_vat_lines_from_text,
    fill_missing_ttc,
    sanitize_impossible_amounts,
)

MULTI_RATE_WARNING = (
    "Taux TVA global de {rate:.1f} % sur {label} : facture à plusieurs taux — "
    "ventiler en lignes 0 / 10 / 20 % (tableau de ventilation du document)."
)

AI_MULTI_RATE_ESCALATION_SUFFIX = """

## Rappel critique — facture multi-taux

La facture contient très probablement **plusieurs taux TVA** (0 %, 10 % et/ou 20 %).

Tu DOIS renvoyer **une entrée JSON par taux distinct**, avec les montants HT/TVA/TTC
de la ventilation imprimée sur le document.

INTERDIT :
- une seule ligne dont TVA÷HT est entre 11 % et 19 % (taux « moyen » ~17,5 %) ;
- choisir un taux unique (ex. 0.2) pour masquer un mix 10 %+20 %.

Exemple valide (même fact_num, deux taux) :
{"fact_num": "123", "m_ht": 400.0, "tva": 40.0, "m_ttc": 440.0, "taux": 0.1, ...}
{"fact_num": "123", "m_ht": 600.0, "tva": 120.0, "m_ttc": 720.0, "taux": 0.2, ...}
"""


def line_has_blended_rate(line: InvoiceLine) -> bool:
    """Taux global entre 10 % et 20 % — mix non déclarable en une ligne DED."""
    return _is_blended_multi_rate(line.m_ht, line.tva)


def result_has_blended_summary(result: ExtractionResult) -> bool:
    return any(line_has_blended_rate(line) for line in result.lines)


def distinct_invoice_count(result: ExtractionResult) -> int:
    return len({line.fact_num for line in result.lines if line.fact_num})


def can_apply_document_ventilation(result: ExtractionResult) -> bool:
    """Ventilation globale du texte : une seule facture ou fact_num unique."""
    if not result.lines:
        return False
    return distinct_invoice_count(result) <= 1


def expand_lines_from_ventilation(
    template: InvoiceLine,
    ventilation: list[dict[str, float]],
    *,
    is_avoir: bool = False,
) -> list[InvoiceLine]:
    """Clone le modèle de ligne pour chaque taux de ventilation."""
    expanded: list[InvoiceLine] = []
    for row in ventilation:
        line = template.model_copy(
            update={
                "m_ht": row["m_ht"],
                "tva": row["tva"],
                "m_ttc": row["m_ttc"],
                "taux": row["taux"],
            }
        )
        line = sanitize_impossible_amounts(line, is_avoir)
        line = fill_missing_ttc(line)
        expanded.append(line)
    return expanded


def _is_avoir_result(result: ExtractionResult) -> bool:
    blob = f"{result.filename}\n{result.raw_text or ''}".lower()
    if "avoir" in blob:
        return True
    return any("avoir" in (line.fact_num or "").lower() for line in result.lines)


def should_replace_with_ventilation(
    result: ExtractionResult,
    ventilation: list[dict[str, float]],
) -> bool:
    if len(ventilation) >= 2:
        return True
    if len(ventilation) == 1 and result_has_blended_summary(result):
        return True
    if len(ventilation) == 1 and len(result.lines) == 1:
        only = result.lines[0]
        row = ventilation[0]
        if line_has_blended_rate(only) and row["taux"] in (0.0, 0.1, 0.2):
            return True
    return False


def try_apply_ventilation_from_text(
    result: ExtractionResult,
    text: str,
) -> tuple[ExtractionResult, bool]:
    """Remplace les lignes résumées par la ventilation lue dans le document."""
    if not text.strip() or not result.lines or not can_apply_document_ventilation(result):
        return result, False

    ventilation = extract_vat_lines_from_text(text)
    if not ventilation or not should_replace_with_ventilation(result, ventilation):
        return result, False

    template = result.lines[0]
    is_avoir = _is_avoir_result(result)
    result.lines = expand_lines_from_ventilation(template, ventilation, is_avoir=is_avoir)

    distinct_rates = sorted({row["taux"] for row in ventilation})
    rates_label = ", ".join(f"{int(r * 100)} %" for r in distinct_rates)
    result.warnings.append(
        f"Ventilation multi-taux appliquée depuis le document ({rates_label}) — "
        f"{len(result.lines)} ligne(s) DED."
    )
    return result, True


def append_blended_warnings(result: ExtractionResult) -> ExtractionResult:
    """Avertit seulement si une ligne reste à taux moyen après ventilation."""
    for line in result.lines:
        if not line_has_blended_rate(line):
            continue
        ht, tva = abs(line.m_ht), abs(line.tva)
        rate = (tva / ht * 100) if ht > 0.01 else 0.0
        label = line.fact_num or "cette pièce"
        result.warnings.append(MULTI_RATE_WARNING.format(rate=rate, label=label))
        break
    return result


def apply_multi_rate_postprocess(result: ExtractionResult) -> ExtractionResult:
    """Post-traitement générique : ventilation texte puis alertes résiduelles."""
    text = result.raw_text or ""
    result, _applied = try_apply_ventilation_from_text(result, text)
    return append_blended_warnings(result)


def result_needs_multi_rate_escalation(result: ExtractionResult) -> bool:
    """Escalade IA si une ligne résumée à taux moyen subsiste."""
    return result_has_blended_summary(result)
