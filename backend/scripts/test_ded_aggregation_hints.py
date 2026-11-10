#!/usr/bin/env python3
"""Tests des correctifs d'efficacité DED : agrégation par taux, nom fournisseur
depuis le dossier, relecture du pied de page, escalade IA des PDF texte douteux."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from invoice_extractor import _parse_footer_identifiers, _text_result_needs_ai_upgrade
from models import ExtractionResult, InvoiceLine
from normalize_results import aggregate_lines_by_rate, normalize_extraction_results


def make_line(**overrides: object) -> InvoiceLine:
    data = {
        "fact_num": "FV-001",
        "designation": "MATIERES CONSOMMABLES",
        "m_ht": 100.0,
        "tva": 20.0,
        "m_ttc": 120.0,
        "taux": 0.2,
        "id_paie": 4,
        "date_paie": None,
        "date_fac": None,
        "lib_frss": "FOURNISSEUR",
        "ice_frs": "000000000000001",
        "if_fournisseur": "123456",
    }
    data.update(overrides)
    return InvoiceLine.model_validate(data)


def test_aggregate_same_rate_and_designation() -> None:
    lines = [
        make_line(fact_num="FV-1", m_ht=88.18, tva=8.82, m_ttc=97.0, taux=0.1),
        make_line(fact_num="FV-1", m_ht=844.80, tva=84.48, m_ttc=929.28, taux=0.1),
    ]
    aggregated = aggregate_lines_by_rate(lines)
    assert len(aggregated) == 1
    assert aggregated[0].m_ht == 932.98
    assert aggregated[0].tva == 93.3
    assert aggregated[0].m_ttc == 1026.28


def test_aggregate_keeps_distinct_rates_and_factures() -> None:
    lines = [
        make_line(fact_num="FV-1", taux=0.1, m_ht=100, tva=10, m_ttc=110),
        make_line(fact_num="FV-1", taux=0.2, m_ht=200, tva=40, m_ttc=240),
        make_line(fact_num="FV-2", taux=0.1, m_ht=50, tva=5, m_ttc=55),
    ]
    aggregated = aggregate_lines_by_rate(lines)
    assert len(aggregated) == 3


def test_aggregate_keeps_distinct_designations() -> None:
    lines = [
        make_line(taux=0.2, designation="MATIERES CONSOMMABLES", m_ht=100, tva=20, m_ttc=120),
        make_line(taux=0.2, designation="PRESTATIONS", m_ht=200, tva=40, m_ttc=240),
    ]
    assert len(aggregate_lines_by_rate(lines)) == 2


def test_folder_name_corrects_ocr_supplier_variant() -> None:
    result = ExtractionResult(
        filename="achibest/Scanned 15_07_2026.pdf",
        engine="ai",
        lines=[
            make_line(
                lib_frss="Aichibes",
                ice_frs="000229475000050",
                if_fournisseur="1102277",
            )
        ],
    )
    normalized = normalize_extraction_results([result], client_ice="003641228000030")
    line = normalized[0].lines[0]
    assert line.lib_frss == "Achibest"
    assert line.supplier_from_folder is True


def test_folder_without_hint_keeps_line_supplier() -> None:
    result = ExtractionResult(
        filename="invoices/scan.pdf",
        engine="ai",
        lines=[make_line(lib_frss="VRAI FOURNISSEUR")],
    )
    normalized = normalize_extraction_results([result])
    assert normalized[0].lines[0].lib_frss == "VRAI FOURNISSEUR"


def test_footer_identifier_parsing() -> None:
    assert _parse_footer_identifiers(
        {"ice": "ICE : 000161664000072", "if": "F 14427958"}
    ) == {"ice": "000161664000072", "if": "14427958"}
    assert _parse_footer_identifiers({"ice": "12345", "if": "12"}) == {}
    assert _parse_footer_identifiers("pas un objet") == {}


def test_text_upgrade_on_address_like_supplier_or_avoir() -> None:
    address_result = ExtractionResult(
        filename="Avoirs AICHOUM.pdf",
        raw_text="I.C.E : 003641228000030",
        engine="text",
        lines=[make_line(lib_frss="CASABLANCA-EL MAARIF", taux=0.0, tva=-1134, m_ht=-5670, m_ttc=-6804)],
    )
    assert _text_result_needs_ai_upgrade(address_result)

    avoir_result = ExtractionResult(
        filename="Avoirs AICHOUM.pdf",
        raw_text="AVOIR : FR26-003076",
        engine="text",
        lines=[make_line(fact_num="FR26-003076")],
    )
    assert _text_result_needs_ai_upgrade(avoir_result)

    clean_result = ExtractionResult(
        filename="facture.pdf",
        raw_text="Total HT 100,00 TVA 20,00 TTC 120,00",
        engine="text",
        lines=[make_line(lib_frss="ACHIBEST")],
    )
    assert not _text_result_needs_ai_upgrade(clean_result)


def test_text_upgrade_on_broken_heuristic_layout() -> None:
    # Numéro de facture qui est une date.
    date_number = ExtractionResult(
        filename="facture.pdf",
        raw_text="Facture N° 337929-26-DJ",
        engine="text",
        lines=[make_line(fact_num="07-04-2026", lib_frss="HEBERJAHIZ")],
    )
    assert _text_result_needs_ai_upgrade(date_number)

    # Nom fournisseur = numéro de facture (FA2026057).
    code_name = ExtractionResult(
        filename="facture.pdf",
        raw_text="Facture FA2026057",
        engine="text",
        lines=[make_line(fact_num="FA2026057", lib_frss="FA2026057")],
    )
    assert _text_result_needs_ai_upgrade(code_name)

    # TVA 0 % annoncée sur le document mais 20 % inventée par l'heuristique.
    zero_vat = ExtractionResult(
        filename="facture.pdf",
        raw_text="Sous-total: 230,00 MAD\nTVA (0%): 0,00 MAD",
        engine="text",
        lines=[make_line(fact_num="4", lib_frss="ABDESSALAM LABRARDI", m_ht=191.67, tva=38.33, m_ttc=230, taux=0.2)],
    )
    assert _text_result_needs_ai_upgrade(zero_vat)


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failures = 0
    for test in tests:
        try:
            test()
            print(f"OK   {test.__name__}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {test.__name__}: {exc}")
    print(f"\n{len(tests) - failures}/{len(tests)} tests réussis")
    raise SystemExit(0 if failures == 0 else 1)
