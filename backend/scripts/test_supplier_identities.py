#!/usr/bin/env python3
"""Complétion IF / ICE / nom à l'échelle du dossier (cas réels juillet 2026)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from supplier_notebook import enrich_supplier_identities  # noqa: E402

CARNET = [
    {"ice": "000229475000050", "if_number": "1102277", "official_name": "ACHIBEST FOOD SARL"},
    {"ice": "001530596000079", "if_number": "01660911", "official_name": "SCBG"},
]
CLIENT_ICE = "003641228000030"


def main() -> int:
    lines = [
        # IF mal lu (un chiffre perdu) : le carnet l'emporte.
        {"lib_frss": "AICHIBEST FOOD SARL", "ice_frs": "000229475000050", "if": "110277"},
        # IF absent, nom mal orthographié : nom et IF du carnet.
        {"lib_frss": "Aichbest Food", "ice_frs": "000229475000050", "if": ""},
        # ICE absent, nom proche d'un fournisseur connu : ICE retrouvé.
        {"lib_frss": "ACHIBEST FOOD", "ice_frs": "", "if": ""},
        # IF validé à la main : jamais touché.
        {"lib_frss": "SCBG", "ice_frs": "001530596000079", "if": "999", "user_verified_fields": ["if"]},
        # Fournisseur hors carnet : IF repris d'une autre ligne du même ICE.
        {"lib_frss": "Bilad FOOD", "ice_frs": "000070808000054", "if": "06508414"},
        {"lib_frss": "Bilad Food SARL", "ice_frs": "000070808000054", "if": ""},
        # Nom inconnu, aucun indice : rien n'est inventé.
        {"lib_frss": "PROXY", "ice_frs": "", "if": ""},
        # ICE du client lu à la place du fournisseur : traité comme absent.
        {"lib_frss": "SCBG", "ice_frs": CLIENT_ICE, "if": ""},
    ]
    stats = enrich_supplier_identities(lines, CARNET, client_ice=CLIENT_ICE)

    assert lines[0]["if"] == "1102277" and lines[0]["if_read"] == "110277"
    assert lines[0]["lib_frss"] == "ACHIBEST FOOD SARL" and lines[0]["lib_frss_read"] == "AICHIBEST FOOD SARL"
    assert lines[1]["lib_frss"] == "ACHIBEST FOOD SARL" and lines[1]["if"] == "1102277" and lines[1]["if_inferred"]
    assert lines[2]["ice_frs"] == "000229475000050" and lines[2]["ice_inferred"] and lines[2]["if"] == "1102277"
    assert lines[3]["if"] == "999", "champ validé à la main respecté"
    assert lines[5]["if"] == "06508414" and lines[5]["if_inferred"]
    assert lines[6]["ice_frs"] == "" and lines[6]["if"] == "", lines[6]
    assert lines[7]["ice_frs"] == "001530596000079" and lines[7]["if"] == "01660911", lines[7]
    assert stats["if"] >= 4 and stats["name"] >= 2, stats

    # Deux fournisseurs différents avec le même nom approché : pas de choix au hasard.
    ambiguous = [
        {"lib_frss": "SOCIETE ALPHA", "ice_frs": "001111111000011"},
        {"lib_frss": "SOCIETE ALPHAS", "ice_frs": "002222222000022"},
        {"lib_frss": "SOCIETE ALPHAA", "ice_frs": ""},
    ]
    enrich_supplier_identities(ambiguous, [])
    assert ambiguous[2]["ice_frs"] == "", ambiguous[2]

    print("OK test_supplier_identities")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
