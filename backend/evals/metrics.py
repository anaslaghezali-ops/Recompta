"""Métriques d'évaluation de l'extraction, sans réseau ni dépendance externe.

Le harnais compare la sortie du pipeline (``ExtractionResult``) à une vérité
terrain partielle : chaque ligne attendue ne déclare que les champs que l'on
sait vérifier (un montant, un taux, un ICE…). Les métriques produites :

- ``field_accuracy`` : champs vérifiés corrects / champs vérifiés ;
- ``line_recall`` : lignes attendues retrouvées / lignes attendues ;
- ``document_pass_rate`` : documents dont toutes les lignes attendues sont
  retrouvées (et dont le nombre de lignes correspond quand il est déclaré) ;
- ``missed_documents`` : documents sans aucune ligne extraite alors qu'on en
  attendait ;
- latence (moyenne / p95) et répartition des moteurs.

Module pur : utilisable par ``run_eval.py`` et par les tests.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field
from statistics import mean
from typing import Any

from models import ExtractionResult, InvoiceLine

AMOUNT_TOLERANCE = 0.5
TAUX_TOLERANCE = 1e-6

FIELD_LABELS = {
    "fact_num": "N° facture",
    "designation": "Désignation",
    "m_ht": "Montant HT",
    "tva": "TVA",
    "m_ttc": "Montant TTC",
    "taux": "Taux",
    "if": "IF fournisseur",
    "lib_frss": "Fournisseur",
    "ice_frs": "ICE fournisseur",
    "date_fac": "Date facture",
    "line_count": "Nombre de lignes",
}


def _normalize_text(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return " ".join(" ".join(text.lower().split()).split())


def _normalize_digits(value: object) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _amount(value: object) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


def _actual_value(line: InvoiceLine, field_name: str) -> Any:
    if field_name == "if":
        return line.if_fournisseur
    if field_name == "lib_frss":
        return line.lib_frss
    if field_name == "lib_frss_contains":
        return line.lib_frss
    if field_name == "designation":
        return line.designation.value
    if field_name == "code_tva":
        return line.resolved_code_tva()
    return getattr(line, field_name, None)


def _field_matches(field_name: str, expected: Any, actual: Any) -> bool:
    if field_name == "lib_frss_contains":
        return _normalize_text(expected) in _normalize_text(actual)
    if field_name in {"m_ht", "tva", "m_ttc"}:
        return abs(_amount(expected) - _amount(actual)) <= AMOUNT_TOLERANCE
    if field_name == "taux":
        return abs(_amount(expected) - _amount(actual)) <= TAUX_TOLERANCE
    if field_name == "ice_frs":
        return _normalize_digits(expected) == _normalize_digits(actual)
    if field_name == "line_count":
        return int(expected) == int(_amount(actual))
    return _normalize_text(expected) == _normalize_text(actual)


def _scored_field_name(field_name: str) -> str:
    return "lib_frss" if field_name == "lib_frss_contains" else field_name


def _line_matches(expected_line: dict[str, Any], line: InvoiceLine) -> bool:
    for field_name, expected in expected_line.items():
        if not _field_matches(field_name, expected, _actual_value(line, field_name)):
            return False
    return True


@dataclass
class FieldCheck:
    field: str
    expected: Any
    actual: Any
    ok: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "field": self.field,
            "expected": self.expected,
            "actual": self.actual,
            "ok": self.ok,
        }


@dataclass
class CaseOutcome:
    case_id: str
    document: str
    ok: bool
    missed_document: bool
    missed_lines: int
    extra_lines: int
    expected_lines: int
    matched_lines: int
    field_checks: list[FieldCheck] = field(default_factory=list)
    latency_ms: float = 0.0
    engine: str = ""
    error: str = ""
    warnings: list[str] = field(default_factory=list)

    @property
    def fields_total(self) -> int:
        return len(self.field_checks)

    @property
    def fields_ok(self) -> int:
        return sum(1 for check in self.field_checks if check.ok)

    def as_dict(self) -> dict[str, Any]:
        return {
            "case_id": self.case_id,
            "document": self.document,
            "ok": self.ok,
            "missed_document": self.missed_document,
            "missed_lines": self.missed_lines,
            "extra_lines": self.extra_lines,
            "expected_lines": self.expected_lines,
            "matched_lines": self.matched_lines,
            "fields_total": self.fields_total,
            "fields_ok": self.fields_ok,
            "field_checks": [check.as_dict() for check in self.field_checks],
            "latency_ms": round(self.latency_ms, 1),
            "engine": self.engine,
            "error": self.error,
            "warnings": self.warnings[:10],
        }


def evaluate_case(
    case_id: str,
    document: str,
    expected: dict[str, Any],
    result: ExtractionResult | None,
    latency_ms: float = 0.0,
    error: str = "",
) -> CaseOutcome:
    """Évalue un document contre sa vérité terrain partielle."""
    expected_lines: list[dict[str, Any]] = list(expected.get("lines") or [])
    expected_line_count = expected.get("line_count")
    lines = result.lines if result is not None else []

    used: set[int] = set()
    checks: list[FieldCheck] = []
    matched = 0
    missed = 0

    for expected_line in expected_lines:
        match_index = -1
        for index, line in enumerate(lines):
            if index in used:
                continue
            if _line_matches(expected_line, line):
                match_index = index
                break
        if match_index >= 0:
            used.add(match_index)
            matched += 1
            line = lines[match_index]
            for field_name, expected_value in expected_line.items():
                actual = _actual_value(line, field_name)
                checks.append(
                    FieldCheck(
                        field=_scored_field_name(field_name),
                        expected=expected_value,
                        actual=actual,
                        ok=True,
                    )
                )
        else:
            missed += 1
            for field_name, expected_value in expected_line.items():
                checks.append(
                    FieldCheck(
                        field=_scored_field_name(field_name),
                        expected=expected_value,
                        actual=None,
                        ok=False,
                    )
                )

    line_count_ok = True
    if expected_line_count is not None:
        line_count_ok = len(lines) == int(expected_line_count)
        checks.append(
            FieldCheck(
                field="line_count",
                expected=int(expected_line_count),
                actual=len(lines),
                ok=line_count_ok,
            )
        )

    extra_lines = len(lines) - matched
    missed_document = bool(expected_lines) and not lines
    ok = missed == 0 and line_count_ok and missed_document is False and not error
    return CaseOutcome(
        case_id=case_id,
        document=document,
        ok=ok,
        missed_document=missed_document,
        missed_lines=missed,
        extra_lines=max(0, extra_lines),
        expected_lines=len(expected_lines),
        matched_lines=matched,
        field_checks=checks,
        latency_ms=latency_ms,
        engine=(result.engine if result is not None else ""),
        error=error,
        warnings=list(result.warnings if result is not None else []),
    )


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * ratio)))
    return ordered[index]


def summarize(outcomes: list[CaseOutcome]) -> dict[str, Any]:
    """Agrège les résultats en un rapport unique."""
    fields_total = sum(outcome.fields_total for outcome in outcomes)
    fields_ok = sum(outcome.fields_ok for outcome in outcomes)
    expected_lines = sum(outcome.expected_lines for outcome in outcomes)
    matched_lines = sum(outcome.matched_lines for outcome in outcomes)
    latencies = [outcome.latency_ms for outcome in outcomes if outcome.latency_ms > 0]
    engines: dict[str, int] = {}
    for outcome in outcomes:
        engines[outcome.engine or "inconnu"] = engines.get(outcome.engine or "inconnu", 0) + 1

    documents = len(outcomes)
    documents_passed = sum(1 for outcome in outcomes if outcome.ok)
    return {
        "documents": documents,
        "documents_passed": documents_passed,
        "document_pass_rate": round(documents_passed / documents, 4) if documents else 0.0,
        "missed_documents": sum(1 for outcome in outcomes if outcome.missed_document),
        "expected_lines": expected_lines,
        "matched_lines": matched_lines,
        "line_recall": round(matched_lines / expected_lines, 4) if expected_lines else 0.0,
        "fields_total": fields_total,
        "fields_ok": fields_ok,
        "field_accuracy": round(fields_ok / fields_total, 4) if fields_total else 0.0,
        "extra_lines": sum(outcome.extra_lines for outcome in outcomes),
        "latency_avg_ms": round(mean(latencies), 1) if latencies else 0.0,
        "latency_p95_ms": round(percentile(latencies, 0.95), 1) if latencies else 0.0,
        "engines": engines,
    }


def build_report(
    outcomes: list[CaseOutcome],
    *,
    corpus: str,
    mode: str,
    generated_at: str,
) -> dict[str, Any]:
    return {
        "generated_at": generated_at,
        "corpus": corpus,
        "mode": mode,
        "summary": summarize(outcomes),
        "documents": [outcome.as_dict() for outcome in outcomes],
    }


def _format_value(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:g}"
    return str(value)


def render_markdown(report: dict[str, Any]) -> str:
    """Rapport lisible (CI, revue, baseline)."""
    summary = report["summary"]
    lines = [
        "# Rapport d'évaluation Recompta",
        "",
        f"- Généré : {report['generated_at']}",
        f"- Corpus : `{report['corpus']}`",
        f"- Mode : {report['mode']}",
        "",
        "## Synthèse",
        "",
        "| Métrique | Valeur |",
        "|---|---|",
        f"| Documents | {summary['documents']} |",
        f"| Documents réussis | {summary['documents_passed']} ({summary['document_pass_rate'] * 100:.1f} %) |",
        f"| Documents manqués (aucune ligne) | {summary['missed_documents']} |",
        f"| Lignes attendues retrouvées | {summary['matched_lines']}/{summary['expected_lines']} ({summary['line_recall'] * 100:.1f} %) |",
        f"| Champs corrects | {summary['fields_ok']}/{summary['fields_total']} ({summary['field_accuracy'] * 100:.1f} %) |",
        f"| Lignes en trop | {summary['extra_lines']} |",
        f"| Latence moyenne | {summary['latency_avg_ms']} ms |",
        f"| Latence p95 | {summary['latency_p95_ms']} ms |",
        "",
        "## Documents",
        "",
        "| Document | Résultat | Lignes | Champs | Moteur | Latence |",
        "|---|---|---|---|---|---|",
    ]
    for document in report["documents"]:
        status = "✅" if document["ok"] else "❌"
        fields = f"{document['fields_ok']}/{document['fields_total']}"
        lines.append(
            f"| {document['document']} | {status} | {document['matched_lines']}/{document['expected_lines']} | "
            f"{fields} | {document['engine'] or '—'} | {document['latency_ms']} ms |"
        )

    failures = [document for document in report["documents"] if not document["ok"]]
    if failures:
        lines.extend(["", "## Échecs", ""])
        for document in failures:
            lines.append(f"### {document['document']}")
            if document["error"]:
                lines.append(f"- Erreur : {document['error']}")
            for check in document["field_checks"]:
                if check["ok"]:
                    continue
                lines.append(
                    f"- {FIELD_LABELS.get(check['field'], check['field'])} : "
                    f"attendu {_format_value(check['expected'])}, obtenu {_format_value(check['actual'])}"
                )
    return "\n".join(lines) + "\n"


def check_thresholds(summary: dict[str, Any], thresholds: dict[str, Any]) -> list[str]:
    """Liste des seuils non respectés (vide = succès)."""
    failures: list[str] = []
    checks = (
        ("field_accuracy_min", summary.get("field_accuracy", 0.0), ">="),
        ("line_recall_min", summary.get("line_recall", 0.0), ">="),
        ("document_pass_rate_min", summary.get("document_pass_rate", 0.0), ">="),
        ("max_missed_documents", summary.get("missed_documents", 0), "<="),
        ("max_extra_lines", summary.get("extra_lines", 0), "<="),
    )
    for key, actual, direction in checks:
        if key not in thresholds:
            continue
        expected = thresholds[key]
        failed = actual < expected if direction == ">=" else actual > expected
        if failed:
            failures.append(f"{key} : {actual} (seuil {direction} {expected})")
    return failures
