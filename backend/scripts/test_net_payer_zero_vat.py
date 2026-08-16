#!/usr/bin/env python3
"""Net à payer = TTC, TVA 0 % légale, n° de facture alphanumérique."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from invoice_extractor import (
    _extract_amounts,
    _extract_invoice_number,
    _extract_supplier_if,
    _heuristic_extract,
    _needs_ai_upgrade,
)

PROBUN_10_07 = """
FACTURE
NUMERO : FAC0111/2026
DATE        : 10/07/2026
   CLIENT     : Sté.AICHOUM SARL
   ICE             : 003641228000030

Désignation Qté Prix uni TTC Total TTC Total HT Val TVA Tx de TVA
PAIN BUN 29/06/2026 912 6,00 5 472,00 5 472,00 0,00 0%
PAIN BUN 07/07/2026 816 6,00 4 896,00 4 896,00 0,00 0%
TOTAL 10368,00 10368,00 0,00 0,00

 NET A PAYER 10 368,00

Arrêter le présent facture à la somme de :
Dix mille trois cent soixante-huit dhs.

17, Rue ZAIZAFOUNE Lot DAKHLA- Agadir
R.C. :20295-Patente : 48758418-I.F : 40240688-ICE : 000055344000094
"""

PROBUN_25_07 = """
FACTURE
NUMERO : FAC0131/2026
DATE        : 25/07/2026
   CLIENT     : Sté.AICHOUM SARL
   ICE             : 003641228000030

Désignation Qté Prix uni TTC Total TTC Total HT Val TVA Tx de TVA
PAIN BUN 13/07/2026 864 6,00 5 184,00 5 184,00 0,00 0%
PAIN BUN 20/07/2026 1056 6,00 6 336,00 6 336,00 0,00 0%
TOTAL 11520,00 11520,00 0,00 0,00

 NET A PAYER 11 520,00

Arrêter le présent facture à la somme de :
Onze mille cinq cent vingt dhs.
"""


def test_net_a_payer_is_ttc() -> None:
    ht, tva, ttc = _extract_amounts(PROBUN_10_07)
    assert ttc == 10368.0
    assert ht == 10368.0
    assert tva == 0.0


def test_zero_vat_is_not_an_upgrade() -> None:
    result = _heuristic_extract("FACTURE AICHOUM 10072026.pdf", PROBUN_10_07)
    assert result.lines
    line = result.lines[0]
    assert line.taux == 0.0
    assert line.m_ttc == 10368.0
    assert line.m_ht == 10368.0
    assert line.tva == 0.0
    assert not _needs_ai_upgrade(result)
    assert "Montants HT/TTC non détectés" not in " ".join(result.warnings)


def test_alphanumeric_invoice_number() -> None:
    assert _extract_invoice_number(PROBUN_10_07, "x.pdf") == "FAC0111/2026"
    assert _extract_invoice_number(PROBUN_25_07, "x.pdf") == "FAC0131/2026"
    classic = "FACTURE N° FV26-023806\nTotal HT 100,00\nTotal TVA 20,00\nTotal TTC 120,00"
    assert _extract_invoice_number(classic, "x.pdf") == "FV26-023806"
    labeled = "FACTURE N° RELEVE BANCAIRE\nTotal HT 114.58"
    assert _extract_invoice_number(labeled, "saham.pdf") == "RELEVE BANCAIRE"


def test_second_probun_invoice() -> None:
    result = _heuristic_extract("FACTURE AICHOUM 25072026.pdf", PROBUN_25_07)
    line = result.lines[0]
    assert line.fact_num == "FAC0131/2026"
    assert line.m_ttc == 11520.0
    assert line.taux == 0.0
    assert not _needs_ai_upgrade(result)


def test_if_accepts_optional_dot_after_f() -> None:
    assert _extract_supplier_if("I.F : 40240688") == "40240688"
    assert _extract_supplier_if("I.F. : 40240688") == "40240688"
    assert _extract_supplier_if("IF : 40240688") == "40240688"
    assert _extract_supplier_if("I.F:40240688") == "40240688"
    assert _extract_supplier_if(PROBUN_10_07) == "40240688"
    result = _heuristic_extract("FACTURE AICHOUM 10072026.pdf", PROBUN_10_07)
    assert result.lines[0].if_fournisseur == "40240688"


def main() -> int:
    test_net_a_payer_is_ttc()
    test_zero_vat_is_not_an_upgrade()
    test_alphanumeric_invoice_number()
    test_second_probun_invoice()
    test_if_accepts_optional_dot_after_f()
    print("OK test_net_payer_zero_vat")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
