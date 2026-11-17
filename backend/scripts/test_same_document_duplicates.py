#!/usr/bin/env python3
"""Doublons d'un même document et regroupement par dossier (cas réels juillet 2026)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from models import ExtractionResult, InvoiceLine  # noqa: E402
from normalize_results import normalize_extraction_results  # noqa: E402


def L(**kw) -> InvoiceLine:
    base = {"fact_num": "F1", "m_ht": 0, "tva": 0, "m_ttc": 0, "taux": 0.2}
    base.update(kw)
    return InvoiceLine.model_validate(base)


def run(*results: ExtractionResult) -> list[ExtractionResult]:
    return normalize_extraction_results(list(results))


def main() -> int:
    # Date de facture lue comme une 2e facture : TVA comptée deux fois.
    out = run(ExtractionResult(filename="heberjahiz.pdf", lines=[
        L(fact_num="337929-26-DJ", m_ht=139, tva=27.8, m_ttc=166.8, lib_frss="heberjahiz"),
        L(fact_num="07-04-2026", m_ht=139, tva=27.8, m_ttc=166.8, lib_frss="heberjahiz"),
    ]))[0]
    assert [l.fact_num for l in out.lines] == ["337929-26-DJ"], out.lines
    assert any("en double" in w for w in out.warnings), out.warnings

    # Taux imprimé (10) lu comme une ligne de TVA à HT 0.
    out = run(ExtractionResult(filename="achibest.pdf", lines=[
        L(fact_num="FV26-032025", m_ht=0, tva=10, m_ttc=0, taux=0.1, lib_frss="ACHIBEST"),
        L(fact_num="FV26-032025", m_ht=2755, tva=551, m_ttc=3306, lib_frss="ACHIBEST"),
    ]))[0]
    assert len(out.lines) == 1 and out.lines[0].m_ht == 2755, out.lines

    # Deux livraisons identiques avec deux vrais numéros : on garde les deux.
    out = run(ExtractionResult(filename="probun.pdf", lines=[
        L(fact_num="FAC0111", m_ht=500, tva=0, m_ttc=500, taux=0, lib_frss="Probun"),
        L(fact_num="FAC0112", m_ht=500, tva=0, m_ttc=500, taux=0, lib_frss="Probun"),
    ]))[0]
    assert len(out.lines) == 2

    # Montants identiques sans aucun numéro lisible : rien ne prouve un doublon.
    out = run(ExtractionResult(filename="lot.pdf", lines=[
        L(fact_num="", m_ht=50, tva=10, m_ttc=60), L(fact_num="", m_ht=50, tva=10, m_ttc=60),
    ]))[0]
    assert len(out.lines) == 2

    # Dossier « Autres » : l'ICE de Glovo ne doit pas être collé sur PROXY.
    a, b = run(
        ExtractionResult(filename="Autres/a.pdf", lines=[L(fact_num="X1", m_ht=100, tva=20, m_ttc=120, lib_frss="GLOVO", ice_frs="002086928000050")]),
        ExtractionResult(filename="Autres/b.pdf", lines=[L(fact_num="X2", m_ht=100, tva=20, m_ttc=120, lib_frss="PROXY")]),
    )
    assert b.lines[0].ice_frs == "", b.lines[0]

    # Dossier d'un seul fournisseur : l'ICE manquant est bien complété.
    a, b = run(
        ExtractionResult(filename="Achibest/a.pdf", lines=[L(fact_num="Y1", m_ht=100, tva=20, m_ttc=120, lib_frss="ACHIBEST", ice_frs="000229475000050", if_fournisseur="1102277")]),
        ExtractionResult(filename="Achibest/b.pdf", lines=[L(fact_num="Y2", m_ht=100, tva=20, m_ttc=120, lib_frss="")]),
    )
    assert b.lines[0].ice_frs == "000229475000050" and b.lines[0].if_fournisseur == "1102277", b.lines[0]

    print("OK test_same_document_duplicates")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
