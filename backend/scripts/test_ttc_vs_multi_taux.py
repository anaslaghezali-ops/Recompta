#!/usr/bin/env python3
"""TTC lu comme HT vs facture multi-taux : ne corriger que sur preuve."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from models import ExtractionResult, InvoiceLine  # noqa: E402
from normalize_results import normalize_extraction_results  # noqa: E402


def run(m_ht: float, tva: float, m_ttc: float, text: str = "", taux: float = 0.2) -> tuple[InvoiceLine, list[str]]:
    result = ExtractionResult(
        filename="f.pdf",
        engine="ai",
        raw_text=text,
        lines=[InvoiceLine(fact_num="F1", m_ht=m_ht, tva=tva, m_ttc=m_ttc, taux=taux, lib_frss="FOURNISSEUR")],
    )
    out = normalize_extraction_results([result])[0]
    assert len(out.lines) == 1, out.lines
    return out.lines[0], out.warnings


def amounts(line: InvoiceLine) -> tuple[float, float, float]:
    return (round(line.m_ht, 2), round(line.tva, 2), round(line.m_ttc, 2))


def main() -> int:
    # Vraie erreur : l'IA a mis le TTC dans HT et répété le même montant en TTC.
    line, _ = run(1800, 300, 1800)
    assert amounts(line) == (1500, 300, 1800), amounts(line)

    # Vraie erreur, TTC non lu.
    line, _ = run(1800, 300, 0)
    assert amounts(line) == (1500, 300, 1800), amounts(line)

    # Facture 10 % + 20 % (600 + 1 200 HT) : rien ne prouve une erreur.
    line, warnings = run(1800, 300, 2100)
    assert amounts(line) == (1800, 300, 2100), amounts(line)
    assert any("600.00 HT à 10 %" in w and "1200.00 HT à 20 %" in w for w in warnings), warnings

    # Le document affiche bien 2 100 : multi-taux confirmé.
    line, _ = run(1800, 300, 2100, text="Total TTC 2 100,00 DH")
    assert amounts(line) == (1800, 300, 2100), amounts(line)

    # Le document affiche 1 500 HT et pas 2 100 : c'était bien un TTC.
    line, _ = run(1800, 300, 2100, text="Total HT 1.500,00\nTVA 20% 300,00\nNet à payer 1 800,00")
    assert amounts(line) == (1500, 300, 1800), amounts(line)

    # Taux moyen 15 % : l'ancienne tolérance (±2,5 points) le prenait pour un TTC.
    line, _ = run(2000, 300, 2300)
    assert amounts(line) == (2000, 300, 2300), amounts(line)

    # 10 % : TTC 1 100 lu comme HT, TVA 100.
    line, _ = run(1100, 100, 1100, taux=0.1)
    assert amounts(line) == (1000, 100, 1100), amounts(line)

    # Ligne correcte : intacte.
    line, _ = run(150, 30, 180)
    assert amounts(line) == (150, 30, 180), amounts(line)

    print("OK test_ttc_vs_multi_taux")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
