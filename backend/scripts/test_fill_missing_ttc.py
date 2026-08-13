#!/usr/bin/env python3
"""TTC reconstitué depuis HT + TVA, et ICE/IF marqués comme inférés."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from models import InvoiceLine
from normalize_results import complete_supplier_identifiers
from vat_intelligence import fill_missing_ttc


def line(**kwargs) -> InvoiceLine:
    defaults = {
        "fact_num": "F1",
        "designation": "MATIERES CONSOMMABLES",
        "m_ht": 100.0,
        "tva": 20.0,
        "m_ttc": 0.0,
        "taux": 0.2,
        "lib_frss": "FOURNISSEUR",
    }
    defaults.update(kwargs)
    return InvoiceLine(**defaults)


def main() -> int:
    filled = fill_missing_ttc(line(m_ht=1905.0, tva=381.0, m_ttc=0.0))
    assert filled.m_ttc == 2286.0, filled.m_ttc

    avoir = fill_missing_ttc(line(m_ht=-1905.0, tva=-381.0, m_ttc=0.0))
    assert avoir.m_ttc == -2286.0, avoir.m_ttc

    visible = fill_missing_ttc(line(m_ht=100.0, tva=20.0, m_ttc=119.5))
    assert visible.m_ttc == 119.5, visible.m_ttc

    incomplete = fill_missing_ttc(line(m_ht=100.0, tva=0.0, m_ttc=0.0))
    assert incomplete.m_ttc == 0.0, incomplete.m_ttc

    known = line(
        fact_num="A",
        lib_frss="EAT MEAT",
        ice_frs="123456789012345",
        if_fournisseur="998877",
        m_ttc=120.0,
    )
    unknown = line(
        fact_num="B",
        lib_frss="EATMEAT SARL",
        ice_frs="",
        if_fournisseur="",
        m_ttc=120.0,
    )
    complete_supplier_identifiers([known, unknown])
    assert unknown.ice_frs == "123456789012345", unknown.ice_frs
    assert unknown.ice_inferred
    assert unknown.if_fournisseur == "998877"
    assert unknown.if_inferred
    assert not known.ice_inferred
    assert not known.if_inferred

    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
