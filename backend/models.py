from __future__ import annotations

import re
from datetime import date
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class FieldConfidenceEntry(BaseModel):
    level: str = Field("ok", description="ok | warn | error")
    reason: str = Field("", description="Explication affichée au comptable")


class Designation(str, Enum):
    MATIERES_CONSOMMABLES = "MATIERES CONSOMMABLES"
    PRESTATIONS = "PRESTATIONS"
    TELEPHONIE = "TELEPHONIE"
    FRAIS_BANCAIRE = "FRAIS BANCAIRE"


def normalize_designation_label(value: object) -> Designation:
    if isinstance(value, Designation):
        return value

    text = re.sub(r"\s+", " ", str(value or "").upper().strip())
    if not text:
        return Designation.MATIERES_CONSOMMABLES

    for designation in Designation:
        if text == designation.value:
            return designation

    compact = text.replace("MATIERE ", "MATIERES ").replace("CONSOMABLE", "CONSOMMABLES")
    compact = compact.replace("CONSOMABLES", "CONSOMMABLES")
    compact = re.sub(r"\s+", " ", compact).strip()
    for designation in Designation:
        if compact == designation.value:
            return designation

    if any(word in text for word in ("TELEPHON", "ORANGE", "INWI", "IAM")):
        return Designation.TELEPHONIE
    if any(word in text for word in ("BANCAIRE", "BANQUE", "COMMISSION")):
        return Designation.FRAIS_BANCAIRE
    if any(word in text for word in ("PRESTATION", "SERVICE", "HONORAIRE")):
        return Designation.PRESTATIONS
    if any(word in text for word in ("MATIERE", "CONSOM", "ACHAT", "FOURNITURE")):
        return Designation.MATIERES_CONSOMMABLES

    return Designation.MATIERES_CONSOMMABLES


# 0 % = exonéré (viande, lait, pain, etc.), 10 %, 20 %
ALLOWED_TAUX = (0.0, 0.1, 0.2)


def normalize_taux(value: object) -> float:
    """Accepte 0 / 0.1 / 0.2, ou 0 / 10 / 20 écrits en pourcentage."""
    if value is None or value == "":
        raise ValueError("Taux TVA manquant")
    try:
        rate = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Taux TVA invalide") from exc
    if abs(rate) > 1:
        rate = rate / 100.0
    for allowed in ALLOWED_TAUX:
        if abs(rate - allowed) <= 0.015:
            return allowed
    raise ValueError("Le taux TVA doit être 0 % (exonéré), 10 % ou 20 %")


def taux_from_amounts(ht: float | None, tva: float | None) -> float:
    """Déduit 0 / 10 / 20 % à partir de HT et TVA."""
    if ht is None or abs(ht) < 0.01:
        return 0.2
    if tva is None or abs(tva) < 0.05:
        return 0.0
    ratio = abs(tva) / abs(ht)
    for allowed in (0.1, 0.2):
        if abs(ratio - allowed) <= 0.025:
            return allowed
    return 0.2


# Mapping observé dans les fichiers DED TVA marocains
CODE_TVA_BY_DESIGNATION_TAUX: dict[tuple[Designation, float], int] = {
    (Designation.MATIERES_CONSOMMABLES, 0.2): 146,
    (Designation.MATIERES_CONSOMMABLES, 0.1): 150,
    (Designation.PRESTATIONS, 0.2): 140,
    (Designation.TELEPHONIE, 0.2): 140,
    (Designation.FRAIS_BANCAIRE, 0.1): 142,
}


def infer_code_tva(designation: Designation, taux: float) -> Optional[int]:
    return CODE_TVA_BY_DESIGNATION_TAUX.get((designation, taux))


class InvoiceLine(BaseModel):
    fact_num: str = Field(..., description="Numéro de facture")
    designation: Designation = Designation.MATIERES_CONSOMMABLES
    m_ht: float = Field(..., description="Montant HT (négatif pour un avoir)")
    tva: float = Field(..., description="Montant TVA (négatif pour un avoir)")
    m_ttc: float = Field(..., description="Montant TTC (négatif pour un avoir)")
    if_fournisseur: str = Field("", alias="if", description="Identifiant fiscal fournisseur")
    lib_frss: str = Field("", description="Nom du fournisseur")
    ice_frs: str = Field("", description="ICE fournisseur (15 chiffres)")
    ice_inferred: bool = Field(
        False,
        description="ICE repris d'une autre facture du même fournisseur, pas lu sur cette pièce",
    )
    if_inferred: bool = Field(
        False,
        description="IF repris d'une autre facture du même fournisseur, pas lu sur cette pièce",
    )
    ttc_reconstructed: bool = Field(
        False,
        description="TTC calculé à partir de HT + TVA faute de total lisible sur la facture",
    )
    tva_calculated: bool = Field(
        False,
        description="TVA recalculée à partir de HT × taux (saisie ou correction)",
    )
    amounts_sanitized: bool = Field(
        False,
        description="Montants corrigés par la sanitization générique",
    )
    supplier_from_folder: bool = Field(
        False,
        description="Nom fournisseur issu du dossier ZIP, pas lu sur la facture",
    )
    date_paie_from_bank: bool = Field(
        False,
        description="Date de paiement issue du rapprochement bancaire",
    )
    extraction_engine: str = Field(
        "",
        description="Moteur d'extraction ayant produit la ligne (ai, text, scan, …)",
    )
    field_confidence: dict[str, FieldConfidenceEntry] = Field(
        default_factory=dict,
        description="Confiance par champ pour la revue comptable",
    )
    taux: float = Field(0.2, description="Taux TVA (0 exonéré, 0.1 ou 0.2)")
    id_paie: int = Field(4, description="Mode de paiement (1 ou 4)")
    date_paie: Optional[date] = None
    date_fac: Optional[date] = None
    code_tva: Optional[int] = None
    or_value: Optional[str] = Field(None, alias="or")

    model_config = {"populate_by_name": True}

    @field_validator("designation", mode="before")
    @classmethod
    def normalize_designation(cls, value: object) -> Designation:
        return normalize_designation_label(value)

    @field_validator("taux", mode="before")
    @classmethod
    def validate_taux(cls, value: object) -> float:
        return normalize_taux(value)

    @field_validator("ice_frs")
    @classmethod
    def normalize_ice(cls, value: str) -> str:
        digits = "".join(ch for ch in value if ch.isdigit())
        if not digits:
            return ""
        if len(digits) != 15:
            return ""
        return digits

    def resolved_code_tva(self) -> Optional[int]:
        if self.code_tva is not None:
            return self.code_tva
        return infer_code_tva(self.designation, self.taux)


class ExportRequest(BaseModel):
    client_name: str = Field("CLIENT", description="Nom du client (pour le nom de fichier)")
    period: str = Field(..., pattern=r"^\d{6}$", description="Période MMAAAA, ex: 062026")
    sheet_name: Optional[str] = None
    lines: list[InvoiceLine]


class ExtractionResult(BaseModel):
    filename: str
    lines: list[InvoiceLine]
    raw_text: str = ""
    confidence: str = "manual"
    engine: str = "manual"  # ai | text | tesseract
    warnings: list[str] = Field(default_factory=list)
    source_id: str = ""
