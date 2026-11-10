"""Harnais d'évaluation de l'extraction Recompta.

Usage (depuis ``backend/``) :

    python evals/run_eval.py                        # corpus par défaut, sans IA
    python evals/run_eval.py --no-ai --markdown eval.md
    python evals/run_eval.py --thresholds evals/thresholds.json --json eval.json

Le mode ``--no-ai`` force le pipeline heuristique/texte (aucune clé OpenAI,
aucun appel réseau) : c'est le mode de référence de la CI. Sans ce drapeau, la
clé ``OPENAI_API_KEY`` de l'environnement est utilisée si elle existe.

Code de sortie : 0 si les seuils sont respectés, 1 sinon.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from evals.corpus import EvalCase, load_corpus  # noqa: E402
from evals.metrics import build_report, check_thresholds, evaluate_case, render_markdown  # noqa: E402


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Évalue le pipeline d'extraction sur un corpus annoté.")
    parser.add_argument(
        "--corpus",
        type=Path,
        default=Path(__file__).resolve().parent / "corpus",
        help="Dossier contenant manifest.json (défaut : evals/corpus).",
    )
    parser.add_argument("--json", type=Path, help="Écrit le rapport JSON détaillé à ce chemin.")
    parser.add_argument("--markdown", type=Path, help="Écrit le rapport Markdown à ce chemin.")
    parser.add_argument(
        "--thresholds",
        type=Path,
        default=None,
        help="Seuils JSON (défaut : evals/thresholds.json s'il existe).",
    )
    parser.add_argument(
        "--no-ai",
        action="store_true",
        help="Force le pipeline texte/heuristique (pas d'appel OpenAI) — mode CI.",
    )
    parser.add_argument("--show-failures", action="store_true", help="Affiche le détail des échecs.")
    parser.add_argument("--verbose", action="store_true", help="Affiche chaque document évalué.")
    parser.add_argument(
        "--no-thresholds",
        action="store_true",
        help="Ne pas appliquer de seuils (utile pour un corpus privé non calibré).",
    )
    parser.add_argument(
        "--no-normalize",
        action="store_true",
        help="Évaluer la sortie brute de extract_invoice, sans la normalisation du pipeline (API/worker).",
    )
    return parser.parse_args(argv)


async def _run_case(case: EvalCase, *, normalize: bool) -> tuple[object | None, float, str]:
    from invoice_extractor import extract_invoice
    from normalize_results import (
        activate_client_ice_exclusions,
        deactivate_client_ice_exclusions,
        normalize_extraction_results,
    )

    content = case.document.read_bytes()
    # Nom passé au pipeline : dossier parent + fichier, comme un ZIP organisé
    # par fournisseur (permet l'indice dossier de la normalisation). Un cas peut
    # forcer `document_label` quand le dossier n'est pas un fournisseur.
    label = case.document_label or f"{case.document.parent.name}/{case.document.name}"
    started = time.perf_counter()
    try:
        token = activate_client_ice_exclusions(case.client_ice)
        try:
            result = await extract_invoice(label, content, case.mime)
        finally:
            deactivate_client_ice_exclusions(token)
        if normalize:
            # Même pipeline que l'API/worker : consolidation multi-taux, avoirs,
            # réconciliation TVA, complétion ICE/IF.
            result = normalize_extraction_results([result], client_ice=case.client_ice)[0]
        error = ""
    except Exception as exc:  # noqa: BLE001 - un document ne doit pas arrêter le corpus
        result = None
        error = f"{type(exc).__name__}: {exc}"
    return result, round((time.perf_counter() - started) * 1000, 1), error


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    if args.no_ai:
        os.environ["OPENAI_API_KEY"] = ""

    cases = load_corpus(args.corpus)

    outcomes = []
    for case in cases:
        result, latency_ms, error = asyncio.run(_run_case(case, normalize=not args.no_normalize))
        outcome = evaluate_case(
            case_id=case.id,
            document=case.document.name,
            expected=case.expected,
            result=result,  # type: ignore[arg-type]
            latency_ms=latency_ms,
            error=error,
        )
        outcomes.append(outcome)
        status = "OK " if outcome.ok else "ECHEC"
        print(
            f"[{status}] {case.id:<28} {outcome.matched_lines}/{outcome.expected_lines} lignes, "
            f"{outcome.fields_ok}/{outcome.fields_total} champs, {outcome.engine or '—'}, {latency_ms:.0f} ms"
        )
        if args.verbose or not outcome.ok:
            for check in outcome.field_checks:
                if not check.ok:
                    print(f"        - {check.field}: attendu {check.expected!r}, obtenu {check.actual!r}")
            if outcome.error:
                print(f"        - erreur: {outcome.error}")

    mode = "sans IA (heuristique/texte)" if args.no_ai else "avec IA si configurée"
    try:
        corpus_label = str(Path(args.corpus).resolve().relative_to(BACKEND_DIR))
    except ValueError:
        corpus_label = str(args.corpus)
    report = build_report(
        outcomes,
        corpus=corpus_label,
        mode=mode,
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )
    markdown = render_markdown(report)
    print()
    summary = report["summary"]
    print(
        f"Synthèse : {summary['documents_passed']}/{summary['documents']} documents, "
        f"lignes {summary['matched_lines']}/{summary['expected_lines']} "
        f"({summary['line_recall'] * 100:.1f} %), "
        f"champs {summary['fields_ok']}/{summary['fields_total']} "
        f"({summary['field_accuracy'] * 100:.1f} %), "
        f"manqués {summary['missed_documents']}, "
        f"latence moyenne {summary['latency_avg_ms']} ms"
    )

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Rapport JSON : {args.json}")
    if args.markdown:
        args.markdown.parent.mkdir(parents=True, exist_ok=True)
        args.markdown.write_text(markdown, encoding="utf-8")
        print(f"Rapport Markdown : {args.markdown}")

    thresholds_path = args.thresholds
    if args.no_thresholds:
        thresholds_path = None
    elif thresholds_path is None:
        candidate = Path(__file__).resolve().parent / "thresholds.json"
        thresholds_path = candidate if candidate.exists() else None
    if thresholds_path is not None:
        thresholds = json.loads(Path(thresholds_path).read_text(encoding="utf-8"))
        failures = check_thresholds(summary, thresholds)
        if failures:
            print(f"\nSeuils non respectés ({thresholds_path}) :")
            for failure in failures:
                print(f"  - {failure}")
            return 1
        print(f"\nSeuils respectés ({thresholds_path}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
