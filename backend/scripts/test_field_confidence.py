#!/usr/bin/env python3
"""Tests confiance par champ."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from field_confidence import compute_field_confidence
from models import InvoiceLine
from vat_intelligence import fill_missing_ttc


def line(**kwargs) -> InvoiceLine:
    defaults = {
        "fact_num": "F1",
        "designation": "MATIERES CONSOMMABLES",
        "m_ht": 100.0,
        "tva": 20.0,
        "m_ttc": 120.0,
        "taux": 0.2,
        "lib_frss": "EAT MEAT SARL",
        "ice_frs": "002345678000012",
    }
    defaults.update(kwargs)
    return InvoiceLine(**defaults)


def main() -> int:
    ok = compute_field_confidence(line())
    assert ok["m_ht"].level == "ok"
    assert ok["ice_frs"].level == "ok"

    inferred = compute_field_confidence(line(ice_inferred=True))
    assert inferred["ice_frs"].level == "warn"
    assert "repris" in inferred["ice_frs"].reason

    filled = fill_missing_ttc(line(m_ht=100.0, tva=20.0, m_ttc=0.0))
    assert filled.ttc_reconstructed
    ttc_conf = compute_field_confidence(filled)
    assert ttc_conf["m_ttc"].level == "warn"
    assert "reconstitué" in ttc_conf["m_ttc"].reason.lower()

    blended = compute_field_confidence(line(m_ht=1000.0, tva=175.0, m_ttc=1175.0, taux=0.2))
    assert blended["taux"].level == "warn"
    assert "ventiler" in blended["taux"].reason.lower()

    bad_math = compute_field_confidence(line(m_ht=100.0, tva=20.0, m_ttc=150.0))
    assert bad_math["m_ht"].level == "error"
    assert bad_math["m_ttc"].level == "error"

    client_ice = compute_field_confidence(
        line(ice_frs="003641228000030"),
        client_ice="003641228000030",
    )
    assert client_ice["ice_frs"].level == "error"

    scan = compute_field_confidence(
        line(),
        engine="ai",
        document_warnings=["Scan difficile : relu avec gpt-5.6-terra."],
    )
    assert scan["m_ht"].level == "warn"

    verified = compute_field_confidence(line(ice_inferred=True), user_verified=frozenset({"ice_frs"}))
    assert verified["ice_frs"].level == "ok"
    assert verified["ice_frs"].reason == "Validé manuellement"

    zero_vat = compute_field_confidence(
        line(m_ht=1058.0, tva=0.0, m_ttc=1058.0, taux=0.0, tva_calculated=True),
        engine="ai",
    )
    assert zero_vat["tva"].level == "ok"
    assert zero_vat["taux"].level == "ok"
    assert zero_vat["designation"].level == "ok"

    uncertain_zero_vat = compute_field_confidence(
        line(m_ht=1058.0, tva=0.0, m_ttc=1058.0, taux=0.0, tva_calculated=True),
        engine="ai",
        document_warnings=["Scan difficile : relu avec gpt-5.6-terra."],
    )
    assert uncertain_zero_vat["tva"].level == "warn"
    assert "scan difficile" in uncertain_zero_vat["tva"].reason.lower()

    print("OK test_field_confidence")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
