#!/usr/bin/env python3
"""Parité des deux pipelines : production.html (Python puis 2e passe JS
normalizeExtractionResults) vs workspace (Python seul).

Échoue si la 2e passe JS change quoi que ce soit au résultat Python, ou si les
implémentations JS et Python divergent sur les mêmes données brutes.

    python scripts/test_normalize_parity.py      (Node requis)
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
RUNNER = Path(__file__).resolve().parent / "normalize_js_runner.mjs"
sys.path.insert(0, str(BACKEND))

from invoice_extractor import extract_invoice  # noqa: E402
from models import ExtractionResult, InvoiceLine  # noqa: E402
from normalize_results import normalize_extraction_results  # noqa: E402

CLIENT_ICE = "001234567000089"
COMPARE_FIELDS = [
    "fact_num", "designation", "m_ht", "tva", "m_ttc", "taux", "lib_frss", "ice_frs", "if",
    "ice_inferred", "if_inferred", "ttc_reconstructed", "amounts_sanitized", "supplier_from_folder",
]


def L(**kw) -> InvoiceLine:
    base = {"fact_num": "F1", "m_ht": 0, "tva": 0, "m_ttc": 0}
    base.update(kw)
    return InvoiceLine.model_validate(base)


def synthetic() -> list[ExtractionResult]:
    R = ExtractionResult
    return [
        # TTC lu comme HT, prouvé par libellé
        R(filename="fournA/f1.pdf", engine="ai", raw_text="Net à payer 1200,00 TTC",
          lines=[L(fact_num="A1", m_ht=1200, tva=240, m_ttc=1440, taux=0.2, lib_frss="ALPHA SARL", ice_frs="002000000000011")]),
        # Même fournisseur, ICE manquant -> hérité
        R(filename="fournA/f2.pdf", engine="ai", raw_text="",
          lines=[L(fact_num="A2", m_ht=100, tva=20, m_ttc=120, taux=0.2, lib_frss="ALPHA SARL")]),
        # Avoir
        R(filename="avoir_beta.pdf", engine="ai", raw_text="AVOIR n° AV9",
          lines=[L(fact_num="AV9", m_ht=50, tva=10, m_ttc=60, taux=0.2, lib_frss="BETA")]),
        # TTC manquant
        R(filename="gamma.pdf", engine="text", raw_text="",
          lines=[L(fact_num="G1", m_ht=300, tva=30, m_ttc=0, taux=0.1, lib_frss="GAMMA")]),
        # HT = le taux
        R(filename="delta.pdf", engine="ai", raw_text="",
          lines=[L(fact_num="D1", m_ht=20, tva=200, m_ttc=1200, taux=0.2, lib_frss="DELTA")]),
        # Ratio impossible (TTC confondu)
        R(filename="eps.pdf", engine="ai", raw_text="",
          lines=[L(fact_num="E1", m_ht=1800, tva=300, m_ttc=2100, taux=0.2, lib_frss="EPSILON")]),
        # Éclats produit même taux dont un sans TVA -> consolidation
        R(filename="zeta.pdf", engine="ai", raw_text="",
          lines=[L(fact_num="Z1", m_ht=100, tva=20, m_ttc=120, taux=0.2, lib_frss="ZETA"),
                 L(fact_num="Z1", m_ht=50, tva=0, m_ttc=50, taux=0.2, lib_frss="ZETA")]),
        # Plusieurs lignes même facture même taux, toutes avec TVA (pas de consolidation)
        R(filename="eta.pdf", engine="ai", raw_text="",
          lines=[L(fact_num="H1", m_ht=100, tva=20, m_ttc=120, taux=0.2, lib_frss="ETA"),
                 L(fact_num="H1", m_ht=200, tva=40, m_ttc=240, taux=0.2, lib_frss="ETA")]),
        # Lot scanné : plusieurs factures sans numéro lisible dans un PDF
        R(filename="lot_scan.pdf", engine="ai", raw_text="",
          lines=[L(fact_num="", m_ht=10, tva=2, m_ttc=12, taux=0.2, lib_frss="THETA"),
                 L(fact_num="", m_ht=30, tva=6, m_ttc=36, taux=0.2, lib_frss="IOTA")]),
        # Multi-taux sur une facture
        R(filename="mpro/scan.pdf", engine="ai", raw_text="",
          lines=[L(fact_num="M1", m_ht=1070, tva=214, m_ttc=1284, taux=0.2, lib_frss="MPRO"),
                 L(fact_num="M1", m_ht=409.09, tva=40.91, m_ttc=450, taux=0.1, lib_frss="MPRO")]),
        # ICE client lu à la place du fournisseur
        R(filename="kappa.pdf", engine="ai", raw_text="",
          lines=[L(fact_num="K1", m_ht=100, tva=20, m_ttc=120, taux=0.2, lib_frss="KAPPA", ice_frs=CLIENT_ICE)]),
        # Nom absent -> dossier
        R(filename="Probun-20260816T102702Z-1-001/Probun/x.pdf", engine="ai", raw_text="",
          lines=[L(fact_num="P1", m_ht=100, tva=20, m_ttc=120, taux=0.2, lib_frss="")]),
        # Pied de page : HT = Total TTC
        R(filename="lambda.pdf", engine="text",
          raw_text="Total HT 1000,00\nTotal TVA 200,00\nTotal TTC 1200,00",
          lines=[L(fact_num="LA1", m_ht=1200, tva=200, m_ttc=1200, taux=0.2, lib_frss="LAMBDA")]),
        # Ventilation multi-taux dans le texte, ligne mélangée
        R(filename="mu.pdf", engine="text",
          raw_text="1100,00 TTC 10% 100,00\n1200,00 TTC 20% 200,00\nTotal TTC 2300,00",
          lines=[L(fact_num="MU1", m_ht=2000, tva=300, m_ttc=2300, taux=0.2, lib_frss="MU")]),
        # Taux 0
        R(filename="nu.pdf", engine="ai", raw_text="",
          lines=[L(fact_num="N1", m_ht=500, tva=0, m_ttc=500, taux=0, lib_frss="NU")]),
    ]


async def real_pdfs() -> list[ExtractionResult]:
    out = []
    for pdf in sorted((BACKEND / "scripts" / "invoices").glob("*.pdf")):
        if "releve" in pdf.name:
            continue
        r = await extract_invoice(pdf.name, pdf.read_bytes(), "application/pdf")
        r.filename = pdf.name
        out.append(r)
    return out


def dump(results: list[ExtractionResult]) -> list[dict]:
    return [r.model_dump(mode="json", by_alias=True) for r in results]


def run_js(payload: list[dict]) -> list[dict]:
    proc = subprocess.run(
        ["node", str(RUNNER), CLIENT_ICE],
        input=json.dumps(payload), capture_output=True, text=True, check=True,
    )
    return json.loads(proc.stdout)


def norm(v):
    if isinstance(v, float):
        return round(v, 2)
    if v is None:
        return ""
    return v


def compare(label: str, a: list[dict], b: list[dict]) -> int:
    diffs = 0
    for ra, rb in zip(a, b):
        la, lb = ra["lines"], rb["lines"]
        if len(la) != len(lb):
            print(f"[{label}] {ra['filename']}: {len(la)} ligne(s) vs {len(lb)}")
            diffs += 1
            continue
        for i, (x, y) in enumerate(zip(la, lb)):
            for f in COMPARE_FIELDS:
                if norm(x.get(f)) != norm(y.get(f)):
                    print(f"[{label}] {ra['filename']} #{i} {f}: {x.get(f)!r} vs {y.get(f)!r}")
                    diffs += 1
    return diffs


async def main() -> int:
    raw = await real_pdfs() + synthetic()
    py = normalize_extraction_results([r.model_copy(deep=True) for r in raw], client_ice=CLIENT_ICE)
    workspace = dump(py)
    production = run_js(dump(py))
    js_only = run_js(dump(raw))
    d1 = compare("workspace vs production", workspace, production)
    d2 = compare("python seul vs js seul", workspace, js_only)
    assert d1 == 0 and d2 == 0, f"{d1 + d2} écart(s) entre pipelines"
    print(f"OK test_normalize_parity ({len(raw)} documents)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
