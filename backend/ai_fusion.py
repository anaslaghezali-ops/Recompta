"""Fusion champ par champ de deux lectures IA d'une même facture.

Le pipeline IA dispose de deux lectures : le modèle principal (économique) et
le modèle de secours (escalade sur les documents difficiles). Jusqu'ici, la
lecture de secours était jetée dès qu'elle restait incohérente, et la première
lecture gagnait sinon. Ce module aligne les lignes des deux lectures et choisit
champ par champ la valeur la plus fiable, en s'appuyant sur :

1. la cohérence mathématique (HT + TVA = TTC, TVA/HT = taux) ;
2. les preuves fournies par les modèles (extrait verbatim retrouvé dans le
   texte) ;
3. la préférence pour la lecture de secours (modèle plus capable) en dernier
   ressort.

Aucune I/O, aucun appel réseau : logique testable sur des ``ExtractionResult``.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

from models import ExtractionResult, InvoiceLine
from vat_intelligence import line_is_coherent

AMOUNT_FIELDS = ("m_ht", "tva", "m_ttc")
IDENTITY_FIELDS = ("fact_num", "designation", "if_fournisseur", "lib_frss", "ice_frs", "taux", "date_fac")
AMOUNT_TOLERANCE = 0.05

_AUTO_FLAGS = (
    "ice_inferred",
    "if_inferred",
    "ttc_reconstructed",
    "tva_calculated",
    "amounts_sanitized",
    "supplier_from_folder",
)


@dataclass
class FusionStats:
    """Compteurs exposés dans ``ExtractionResult.fusion`` pour la revue/tests."""

    lines_matched: int = 0
    lines_only_primary: int = 0
    lines_only_secondary: int = 0
    fields_filled: int = 0
    conflicts_resolved: int = 0
    evidence_wins: int = 0
    coherence_rescues: int = 0
    unresolved: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "lines_matched": self.lines_matched,
            "lines_only_primary": self.lines_only_primary,
            "lines_only_secondary": self.lines_only_secondary,
            "fields_filled": self.fields_filled,
            "conflicts_resolved": self.conflicts_resolved,
            "evidence_wins": self.evidence_wins,
            "coherence_rescues": self.coherence_rescues,
            "unresolved": self.unresolved,
        }


def _normalize_text(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text.lower()).split())


def _normalize_identifier(value: object) -> str:
    return "".join(ch for ch in str(value or "").upper() if ch.isalnum())


def _normalize_digits(value: object) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _as_amount(value: object) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


def _is_empty(field_name: str, value: object) -> bool:
    if field_name in AMOUNT_FIELDS:
        return abs(_as_amount(value)) < 0.01
    if field_name == "taux":
        return value is None
    if field_name == "date_fac":
        return value is None or not str(value).strip()
    return not str(value or "").strip()


def _values_equal(field_name: str, left: object, right: object) -> bool:
    if field_name in AMOUNT_FIELDS:
        return abs(_as_amount(left) - _as_amount(right)) <= AMOUNT_TOLERANCE
    if field_name == "taux":
        return abs(_as_amount(left) - _as_amount(right)) <= 1e-9
    if field_name in {"ice_frs"}:
        return _normalize_digits(left) == _normalize_digits(right)
    if field_name == "date_fac":
        return str(left or "")[:10] == str(right or "")[:10]
    return _normalize_text(left) == _normalize_text(right)


def _evidence_supported(line: InvoiceLine, raw_text: str) -> set[str]:
    """Champs dont la preuve verbatim est réellement retrouvée dans le texte."""
    if not raw_text.strip():
        return set()
    haystack = _normalize_text(raw_text)
    supported: set[str] = set()
    for field_name, snippet in (line.evidence or {}).items():
        needle = _normalize_text(snippet)
        if len(needle) >= 2 and needle in haystack:
            supported.add(field_name)
    return supported


def _amount_evidence_count(line: InvoiceLine, supported: set[str]) -> int:
    return sum(1 for name in AMOUNT_FIELDS if name in supported)


def _taux(line: InvoiceLine) -> float:
    return _as_amount(line.taux)


def _line_match_score(left: InvoiceLine, right: InvoiceLine) -> int:
    """Score d'alignement entre deux lignes (0 = non appariées)."""
    left_fact = _normalize_identifier(left.fact_num)
    right_fact = _normalize_identifier(right.fact_num)
    same_taux = abs(_taux(left) - _taux(right)) <= 1e-9
    if left_fact and left_fact == right_fact and same_taux:
        return 100
    if left_fact and left_fact == right_fact:
        return 60
    if same_taux and abs(_as_amount(left.m_ttc) - _as_amount(right.m_ttc)) <= AMOUNT_TOLERANCE:
        return 50
    if same_taux and abs(_as_amount(left.m_ht) - _as_amount(right.m_ht)) <= AMOUNT_TOLERANCE:
        return 40
    return 0


def _align_lines(
    primary_lines: list[InvoiceLine], secondary_lines: list[InvoiceLine]
) -> tuple[list[tuple[InvoiceLine, InvoiceLine]], list[InvoiceLine], list[InvoiceLine]]:
    """Apparie les lignes par identité, puis par montants/taux, sans réutilisation."""
    available = list(range(len(secondary_lines)))
    pairs: list[tuple[InvoiceLine, InvoiceLine]] = []
    only_primary: list[InvoiceLine] = []
    for primary_line in primary_lines:
        best_index = -1
        best_score = 0
        for index in available:
            score = _line_match_score(primary_line, secondary_lines[index])
            if score > best_score:
                best_score = score
                best_index = index
        if best_index >= 0 and best_score >= 40:
            pairs.append((primary_line, secondary_lines[best_index]))
            available.remove(best_index)
        else:
            only_primary.append(primary_line)
    only_secondary = [secondary_lines[index] for index in available]

    # Dernier recours : une seule ligne restante de chaque côté, même fournisseur
    # (ICE ou nom), et un numéro de facture manifestement mal lu d'un côté
    # (texte libre type « FACTURE AVRIL - ABDESSALAM LABRARDI »). On ne rapproche
    # pas deux vraies factures distinctes d'un même fournisseur.
    if len(only_primary) == 1 and len(only_secondary) == 1:
        primary_line = only_primary[0]
        secondary_line = only_secondary[0]
        if (
            _supplier_key(primary_line) == _supplier_key(secondary_line)
            and (
                _fact_num_is_suspicious(primary_line.fact_num)
                or _fact_num_is_suspicious(secondary_line.fact_num)
            )
        ):
            pairs.append((primary_line, secondary_line))
            only_primary = []
            only_secondary = []

    return pairs, only_primary, only_secondary


def _fact_num_is_suspicious(value: object) -> bool:
    text = str(value or "").strip()
    return bool(text) and (" " in text or len(text) > 20)


def _supplier_key(line: InvoiceLine) -> tuple[str, str]:
    ice = _normalize_digits(line.ice_frs)
    if len(ice) == 15:
        return ("ice", ice)
    return ("name", _normalize_identifier(line.lib_frss))


def _choose_text_value(
    field_name: str,
    primary_value: Any,
    secondary_value: Any,
    primary_supported: set[str],
    secondary_supported: set[str],
    stats: FusionStats,
) -> Any:
    """Choisit une valeur non monétaire entre les deux lectures."""
    if _values_equal(field_name, primary_value, secondary_value):
        return secondary_value
    primary_empty = _is_empty(field_name, primary_value)
    secondary_empty = _is_empty(field_name, secondary_value)

    if primary_empty and not secondary_empty:
        return secondary_value
    if secondary_empty and not primary_empty:
        stats.fields_filled += 1
        return primary_value
    if primary_empty and secondary_empty:
        return secondary_value

    primary_evidence = field_name in primary_supported
    secondary_evidence = field_name in secondary_supported
    if primary_evidence and not secondary_evidence:
        stats.evidence_wins += 1
        return primary_value
    if secondary_evidence and not primary_evidence:
        stats.evidence_wins += 1
        return secondary_value

    stats.conflicts_resolved += 1
    return secondary_value


def _choose_amounts(
    primary: InvoiceLine,
    secondary: InvoiceLine,
    primary_supported: set[str],
    secondary_supported: set[str],
    stats: FusionStats,
) -> tuple[float, float, float]:
    """Choisit le triplet HT/TVA/TTC de façon atomique."""
    primary_coherent = line_is_coherent(primary)
    secondary_coherent = line_is_coherent(secondary)
    if secondary_coherent and not primary_coherent:
        return secondary.m_ht, secondary.tva, secondary.m_ttc
    if primary_coherent and not secondary_coherent:
        stats.coherence_rescues += 1
        return primary.m_ht, primary.tva, primary.m_ttc

    primary_score = _amount_evidence_count(primary, primary_supported)
    secondary_score = _amount_evidence_count(secondary, secondary_supported)
    if primary_score != secondary_score:
        stats.evidence_wins += 1
        winner = primary if primary_score > secondary_score else secondary
        return winner.m_ht, winner.tva, winner.m_ttc

    stats.conflicts_resolved += 1
    return secondary.m_ht, secondary.tva, secondary.m_ttc


def _fuse_line(
    primary: InvoiceLine,
    secondary: InvoiceLine,
    raw_text: str,
    stats: FusionStats,
) -> InvoiceLine:
    primary_supported = _evidence_supported(primary, raw_text)
    secondary_supported = _evidence_supported(secondary, raw_text)
    fused = secondary.model_copy(deep=True)

    for field_name in IDENTITY_FIELDS:
        value = _choose_text_value(
            field_name,
            getattr(primary, field_name),
            getattr(secondary, field_name),
            primary_supported,
            secondary_supported,
            stats,
        )
        setattr(fused, field_name, value)

    m_ht, tva, m_ttc = _choose_amounts(
        primary, secondary, primary_supported, secondary_supported, stats
    )
    fused.m_ht = m_ht
    fused.tva = tva
    fused.m_ttc = m_ttc

    for flag in _AUTO_FLAGS:
        setattr(fused, flag, bool(getattr(primary, flag, False) or getattr(secondary, flag, False)))

    merged_confidence: dict[str, str] = dict(secondary.ai_confidence or {})
    for key, level in (primary.ai_confidence or {}).items():
        merged_confidence.setdefault(key, level)
    fused.ai_confidence = merged_confidence

    merged_evidence: dict[str, str] = dict(secondary.evidence or {})
    for key, snippet in (primary.evidence or {}).items():
        merged_evidence.setdefault(key, snippet)
    fused.evidence = merged_evidence
    fused.field_confidence = dict(secondary.field_confidence or primary.field_confidence or {})
    return fused


def _fused_signature(line: InvoiceLine) -> tuple[Any, ...]:
    return (
        _normalize_identifier(line.fact_num),
        round(_taux(line), 4),
        round(_as_amount(line.m_ht), 2),
        round(_as_amount(line.m_ttc), 2),
    )


def _weak_signature(line: InvoiceLine) -> tuple[Any, ...]:
    return (
        round(_taux(line), 4),
        round(_as_amount(line.m_ht), 2),
        round(_as_amount(line.tva), 2),
        round(_as_amount(line.m_ttc), 2),
        str(line.date_fac or ""),
    )


def _line_is_artifact(line: InvoiceLine) -> bool:
    """Ligne issue d'un mauvais découpage : numéro date ou nom = description."""
    fact = str(line.fact_num or "").strip()
    if re.fullmatch(r"\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}", fact):
        return True
    name = str(line.lib_frss or "")
    words = [word for word in name.split() if word]
    return len(name) > 60 or sum(ch.isdigit() for ch in name) > 3 or len(words) > 6


def _dedupe_same_amounts(lines: list[InvoiceLine]) -> list[InvoiceLine]:
    """Garde une seule ligne pour un même montant/taux/date.

    Cible les artefacts de découpage texte qui dupliquent la facture avec un
    numéro mal lu (ex. une date à la place du numéro) ou un nom qui est une
    description de produit. La ligne crédible (numéro et nom lisibles) gagne.
    """
    out: list[InvoiceLine] = []
    for line in lines:
        signature = _weak_signature(line)
        match = next((index for index, kept in enumerate(out) if _weak_signature(kept) == signature), None)
        if match is None:
            out.append(line)
            continue
        kept = out[match]
        if _line_is_artifact(line) and not _line_is_artifact(kept):
            continue
        if _line_is_artifact(kept) and not _line_is_artifact(line):
            out[match] = line
    return out


def _dedupe(lines: list[InvoiceLine]) -> list[InvoiceLine]:
    seen: set[tuple[Any, ...]] = set()
    out: list[InvoiceLine] = []
    for line in lines:
        signature = _fused_signature(line)
        if signature in seen:
            continue
        seen.add(signature)
        out.append(line)
    return out


def _merge_usage(first: dict[str, int], second: dict[str, int]) -> dict[str, int]:
    merged: dict[str, int] = {}
    for source in (first or {}, second or {}):
        for key, value in source.items():
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                merged[key] = merged.get(key, 0) + int(value)
    return merged


def merge_ai_results(primary: ExtractionResult, secondary: ExtractionResult) -> ExtractionResult:
    """Fusionne la lecture principale et la lecture de secours.

    Renvoie ``ExtractionResult`` avec ``engine="ai"``, ``fusion`` renseigné et
    une alerte lisible expliquant ce que la fusion a changé.
    """
    if not secondary.lines:
        primary.warnings = list(primary.warnings) + [
            "Fusion IA : lecture de secours vide — résultat principal conservé."
        ]
        primary.fusion = {"lines_matched": 0, "lines_only_primary": len(primary.lines), "lines_only_secondary": 0}
        return primary
    if not primary.lines:
        secondary.warnings = list(secondary.warnings) + [
            "Fusion IA : lecture principale vide — résultat de secours conservé."
        ]
        secondary.fusion = {"lines_matched": 0, "lines_only_primary": 0, "lines_only_secondary": len(secondary.lines)}
        return secondary

    raw_text = primary.raw_text if len(primary.raw_text or "") >= len(secondary.raw_text or "") else secondary.raw_text
    stats = FusionStats()
    pairs, only_primary, only_secondary = _align_lines(primary.lines, secondary.lines)
    stats.lines_matched = len(pairs)
    stats.lines_only_primary = len(only_primary)
    stats.lines_only_secondary = len(only_secondary)

    fused_lines = [_fuse_line(first, second, raw_text, stats) for first, second in pairs]
    fused_lines.extend(line.model_copy(deep=True) for line in only_primary)
    fused_lines.extend(line.model_copy(deep=True) for line in only_secondary)

    # Une ligne sans aucun montant est un artefact de découpage (en-tête/adresse
    # pris pour une facture) ; on la retire dès qu'une vraie ligne existe.
    has_amounts = any(
        abs(line.m_ht) + abs(line.tva) + abs(line.m_ttc) >= 0.01 for line in fused_lines
    )
    if has_amounts:
        kept: list[InvoiceLine] = []
        dropped = 0
        for line in fused_lines:
            if abs(line.m_ht) + abs(line.tva) + abs(line.m_ttc) < 0.01:
                dropped += 1
                continue
            kept.append(line)
        if dropped:
            stats.unresolved += dropped
            fused_lines = kept
    # Un artefact peut aussi porter des montants (ligne « 07-04-2026 ») en
    # doublon de la vraie ligne fusionnée : même fournisseur, mêmes montants.
    fused_lines = _dedupe_same_amounts(fused_lines)
    fused_lines = _dedupe(fused_lines)

    warnings = list(primary.warnings)
    for warning in secondary.warnings:
        if warning not in warnings:
            warnings.append(warning)

    all_coherent = bool(fused_lines) and all(line_is_coherent(line) for line in fused_lines)
    confidence = "high" if all_coherent else (primary.confidence if primary.lines else secondary.confidence)

    changes = stats.fields_filled + stats.conflicts_resolved + stats.coherence_rescues + stats.evidence_wins
    if changes or only_primary or only_secondary:
        warnings.append(
            "Fusion IA : "
            f"{stats.lines_matched} ligne(s) rapprochée(s), "
            f"{stats.fields_filled} champ(s) complété(s), "
            f"{stats.conflicts_resolved} conflit(s) arbitré(s), "
            f"{stats.evidence_wins} arbitrage(s) sur preuve, "
            f"{stats.coherence_rescues} sauvetage(s) par cohérence"
            + (f", {only_primary} ligne(s) absente(s) de la lecture de secours" if only_primary else "")
            + (f", {only_secondary} ligne(s) supplémentaire(s) en secours" if only_secondary else "")
            + "."
        )

    return ExtractionResult(
        filename=primary.filename or secondary.filename,
        lines=fused_lines,
        raw_text=raw_text,
        confidence=confidence,
        engine="ai",
        warnings=warnings[:20],
        source_id=primary.source_id or secondary.source_id,
        usage=_merge_usage(primary.usage, secondary.usage),
        fusion=stats.as_dict(),
    )
