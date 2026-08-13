"""Score de confiance par champ — règles explicites, auditables."""

from __future__ import annotations

from typing import Literal

from models import ALLOWED_TAUX, FieldConfidenceEntry, InvoiceLine, infer_code_tva
from normalize_results import looks_like_supplier_name, normalize_ice_digits
from vat_intelligence import _is_blended_multi_rate, _signs_are_mixed

ConfidenceLevel = Literal["ok", "warn", "error"]

TRACKED_FIELDS = (
    "fact_num",
    "lib_frss",
    "ice_frs",
    "if",
    "designation",
    "m_ht",
    "tva",
    "m_ttc",
    "taux",
    "date_fac",
    "date_paie",
)

LEVEL_RANK = {"error": 0, "warn": 1, "ok": 2}


def _entry(level: ConfidenceLevel, reason: str) -> FieldConfidenceEntry:
    return FieldConfidenceEntry(level=level, reason=reason)


def _verified(field: str, user_verified: frozenset[str] | None) -> bool:
    return bool(user_verified and field in user_verified)


def _scan_like_engine(engine: str) -> bool:
    return engine in {"ai", "scan", "tesseract"}


def _difficult_document(warnings: list[str] | None) -> bool:
    if not warnings:
        return False
    blob = " ".join(warnings).lower()
    needles = (
        "scan difficile",
        "relu avec",
        "contrôle ia",
        "ocr",
        "non détectés",
        "saisie manuelle",
        "illisible",
    )
    return any(needle in blob for needle in needles)


def _implied_taux(ht: float, tva: float) -> float | None:
    if abs(ht) < 0.01:
        return None
    if abs(tva) < 0.05:
        return 0.0
    ratio = abs(tva) / abs(ht)
    for allowed in (0.1, 0.2):
        if abs(ratio - allowed) <= 0.025:
            return allowed
    return None


def _amount_issues(ht: float, tva: float, ttc: float) -> list[tuple[ConfidenceLevel, str]]:
    issues: list[tuple[ConfidenceLevel, str]] = []
    if abs(ht) < 0.01 and abs(ttc) < 0.01:
        issues.append(("error", "Montants HT et TTC absents ou nuls"))
        return issues
    if _signs_are_mixed(ht, tva, ttc):
        issues.append(("error", "Signes HT / TVA / TTC incohérents"))
    if abs(ht) >= 0.01 and abs(tva) > abs(ht) + 0.05:
        issues.append(("error", "TVA supérieure au HT (impossible à 10/20 %)"))
    if abs(abs(ht) + abs(tva) - abs(ttc)) > 0.05:
        issues.append(("error", "HT + TVA ≠ TTC"))
    return issues


def compute_field_confidence(
    line: InvoiceLine,
    *,
    client_ice: str = "",
    engine: str = "",
    document_warnings: list[str] | None = None,
    duplicate: bool = False,
    user_verified: frozenset[str] | None = None,
) -> dict[str, FieldConfidenceEntry]:
    """Calcule le feu tricolore pour chaque champ suivi."""
    client = normalize_ice_digits(client_ice)
    difficult = _difficult_document(document_warnings)
    scan_like = _scan_like_engine(engine)

    ht = float(line.m_ht)
    tva = float(line.tva)
    ttc = float(line.m_ttc)
    taux = float(line.taux)
    amount_issues = _amount_issues(ht, tva, ttc)
    worst_amount = amount_issues[0] if amount_issues else None
    blended = _is_blended_multi_rate(ht, tva)
    implied = _implied_taux(ht, tva)

    out: dict[str, FieldConfidenceEntry] = {}

    # --- fact_num ---
    if _verified("fact_num", user_verified):
        out["fact_num"] = _entry("ok", "Validé manuellement")
    elif not (line.fact_num or "").strip():
        out["fact_num"] = _entry("error", "Numéro de facture vide")
    elif duplicate:
        out["fact_num"] = _entry("warn", "Doublon probable — confirmez le numéro de facture")
    elif scan_like and difficult:
        out["fact_num"] = _entry("warn", "Extraction IA sur scan difficile — confirmez le numéro")
    else:
        out["fact_num"] = _entry("ok", "Numéro de facture présent")

    # --- lib_frss ---
    name = (line.lib_frss or "").strip()
    if _verified("lib_frss", user_verified):
        out["lib_frss"] = _entry("ok", "Validé manuellement")
    elif not name:
        out["lib_frss"] = _entry("error", "Nom fournisseur manquant")
    elif line.supplier_from_folder:
        out["lib_frss"] = _entry("warn", "Nom issu du dossier ZIP — confirmez le fournisseur")
    elif not looks_like_supplier_name(name):
        out["lib_frss"] = _entry("warn", "Nom fournisseur suspect (OCR / IA)")
    elif scan_like and difficult:
        out["lib_frss"] = _entry("warn", "Fournisseur extrait d'un scan difficile — confirmez")
    else:
        out["lib_frss"] = _entry("ok", "Nom fournisseur présent")

    # --- ice_frs ---
    ice = normalize_ice_digits(line.ice_frs)
    if _verified("ice_frs", user_verified):
        out["ice_frs"] = _entry("ok", "Validé manuellement")
    elif not ice:
        out["ice_frs"] = _entry("error", "ICE fournisseur manquant")
    elif client and ice == client:
        out["ice_frs"] = _entry("error", "ICE fournisseur identique à l'ICE client")
    elif line.ice_inferred:
        out["ice_frs"] = _entry("warn", "ICE repris d'une autre facture du même fournisseur")
    elif scan_like and difficult:
        out["ice_frs"] = _entry("warn", "ICE extrait d'un scan difficile — confirmez les 15 chiffres")
    else:
        out["ice_frs"] = _entry("ok", "ICE fournisseur valide (15 chiffres)")

    # --- if ---
    fiscal = (line.if_fournisseur or "").strip()
    if _verified("if", user_verified):
        out["if"] = _entry("ok", "Validé manuellement")
    elif not fiscal:
        out["if"] = _entry("warn", "IF absent — à compléter si disponible sur la facture")
    elif line.if_inferred:
        out["if"] = _entry("warn", "IF repris d'une autre facture du même fournisseur")
    else:
        out["if"] = _entry("ok", "IF présent")

    # --- designation / CODE TVA ---
    code = line.resolved_code_tva()
    if _verified("designation", user_verified):
        out["designation"] = _entry("ok", "Validé manuellement")
    elif code is None and taux == 0.0:
        out["designation"] = _entry("warn", "TVA 0 % — CODE TVA à renseigner si votre DED l'exige")
    elif code is None:
        out["designation"] = _entry(
            "warn",
            f"CODE TVA non déduit pour {line.designation.value} à {int(taux * 100)} %",
        )
    else:
        out["designation"] = _entry("ok", f"CODE TVA {code} déduit")

    # --- montants HT / TVA / TTC ---
    for key, label in (("m_ht", "HT"), ("tva", "TVA"), ("m_ttc", "TTC")):
        if _verified(key, user_verified):
            out[key] = _entry("ok", "Validé manuellement")
            continue
        if worst_amount:
            out[key] = _entry(worst_amount[0], worst_amount[1])
            continue
        if line.amounts_sanitized:
            out[key] = _entry("warn", "Montants corrigés automatiquement — vérifiez")
            continue
        if key == "m_ttc" and line.ttc_reconstructed:
            out[key] = _entry("warn", "TTC reconstitué à partir de HT + TVA")
            continue
        if key == "tva" and line.tva_calculated:
            out[key] = _entry("warn", "TVA recalculée à partir de HT × taux")
            continue
        if scan_like and difficult:
            out[key] = _entry("warn", f"{label} extrait d'un scan difficile — confirmez")
            continue
        if duplicate and key == "m_ttc":
            out[key] = _entry("warn", "Doublon probable — confirmez le montant TTC")
            continue
        out[key] = _entry("ok", f"{label} cohérent")

    # --- taux ---
    if _verified("taux", user_verified):
        out["taux"] = _entry("ok", "Validé manuellement")
    elif taux not in ALLOWED_TAUX:
        pct = f"{taux * 100:g} %" if taux else "?"
        out["taux"] = _entry("error", f"Taux {pct} hors 0 / 10 / 20 %")
    elif taux == 0.0 and abs(tva) > 0.05:
        out["taux"] = _entry("error", "Taux 0 % mais TVA non nulle")
    elif blended and abs(abs(ht) + abs(tva) - abs(ttc)) <= 0.05:
        pct = round(abs(tva) / abs(ht) * 100, 1) if abs(ht) >= 0.01 else 0
        out["taux"] = _entry(
            "warn",
            f"Taux moyen ~{pct} % — ventiler en lignes 10 % et 20 % si nécessaire pour la DED",
        )
    elif implied is not None and taux != implied and abs(ht) >= 0.01 and abs(tva) >= 0.05:
        out["taux"] = _entry(
            "warn",
            f"Taux déclaré {int(taux * 100)} % incohérent avec HT/TVA (~{int(implied * 100)} %)",
        )
    elif scan_like and difficult:
        out["taux"] = _entry("warn", "Taux extrait d'un scan difficile — confirmez 0 / 10 / 20 %")
    else:
        out["taux"] = _entry("ok", f"Taux {int(taux * 100)} % cohérent")

    # --- date_fac ---
    if _verified("date_fac", user_verified):
        out["date_fac"] = _entry("ok", "Validé manuellement")
    elif line.date_fac is None:
        out["date_fac"] = _entry("warn", "Date de facture absente")
    elif scan_like and difficult:
        out["date_fac"] = _entry("warn", "Date extraite d'un scan difficile — confirmez")
    else:
        out["date_fac"] = _entry("ok", "Date de facture présente")

    # --- date_paie ---
    if _verified("date_paie", user_verified):
        out["date_paie"] = _entry("ok", "Validé manuellement")
    elif line.date_paie is None:
        out["date_paie"] = _entry("warn", "Date de paiement absente — relevé bancaire ou saisie manuelle")
    elif line.date_paie_from_bank:
        out["date_paie"] = _entry("ok", "Date de paiement issue du rapprochement bancaire")
    else:
        out["date_paie"] = _entry("ok", "Date de paiement renseignée")

    return out


def attach_field_confidence(
    lines: list[InvoiceLine],
    *,
    client_ice: str = "",
    engine: str = "",
    document_warnings: list[str] | None = None,
    duplicate_indexes: set[int] | None = None,
    user_verified_by_index: dict[int, frozenset[str]] | None = None,
) -> None:
    dupes = duplicate_indexes or set()
    verified_map = user_verified_by_index or {}
    for index, line in enumerate(lines):
        line.field_confidence = compute_field_confidence(
            line,
            client_ice=client_ice,
            engine=engine or line.extraction_engine,
            document_warnings=document_warnings,
            duplicate=index in dupes,
            user_verified=verified_map.get(index),
        )


def confidence_issues_from_lines(
    lines: list[InvoiceLine],
    *,
    client_ice: str = "",
    duplicate_indexes: set[int] | None = None,
) -> list[dict[str, str]]:
    """Points à relire pour l'export, triés par gravité."""
    dupes = duplicate_indexes or set()
    issues: list[tuple[int, str, str, str]] = []

    for index, line in enumerate(lines):
        label_parts = []
        if (line.fact_num or "").strip():
            label_parts.append(f"Facture {line.fact_num.strip()}")
        if (line.lib_frss or "").strip():
            label_parts.append(f"({line.lib_frss.strip()})")
        label = " ".join(label_parts) if label_parts else f"Ligne {index + 1}"

        if index in dupes:
            issues.append((0, "warn", label, "Doublon probable — même fournisseur, facture, taux et TTC"))

        for field, conf in (line.field_confidence or {}).items():
            if conf.level == "ok":
                continue
            field_label = {
                "fact_num": "N° facture",
                "lib_frss": "Fournisseur",
                "ice_frs": "ICE",
                "if": "IF",
                "designation": "Désignation / CODE TVA",
                "m_ht": "HT",
                "tva": "TVA",
                "m_ttc": "TTC",
                "taux": "Taux",
                "date_fac": "Date facture",
                "date_paie": "Date paiement",
            }.get(field, field)
            rank = 0 if conf.level == "error" else 1
            modal_level = "error" if conf.level == "error" else conf.level
            issues.append((rank, modal_level, label, f"{field_label} — {conf.reason}"))

    issues.sort(key=lambda item: (item[0], item[2]))
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for _rank, level, label, detail in issues:
        text = f"{label} — {detail}"
        if text in seen:
            continue
        seen.add(text)
        out.append({"level": level, "text": text})
    return out
