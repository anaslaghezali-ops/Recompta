from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class Designation(str, Enum):
    MATIERES_CONSOMMABLES = "MATIERES CONSOMMABLES"
    PRESTATIONS = "PRESTATIONS"
    TELEPHONIE = "TELEPHONIE"
    FRAIS_BANCAIRE = "FRAIS BANCAIRE"


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
    taux: float = Field(0.2, description="Taux TVA (0.1 ou 0.2)")
    id_paie: int = Field(4, description="Mode de paiement (1 ou 4)")
    date_paie: Optional[date] = None
    date_fac: Optional[date] = None
    code_tva: Optional[int] = None
    or_value: Optional[str] = Field(None, alias="or")

    model_config = {"populate_by_name": True}

    @field_validator("taux")
    @classmethod
    def validate_taux(cls, value: float) -> float:
        if value not in (0.1, 0.2):
            raise ValueError("Le taux TVA doit être 0.1 (10%) ou 0.2 (20%)")
        return value

    @field_validator("ice_frs")
    @classmethod
    def normalize_ice(cls, value: str) -> str:
        digits = "".join(ch for ch in value if ch.isdigit())
        if not digits:
            return ""
        if len(digits) != 15:
            return ""
        return digits

    def resolved_code_tva(self) -> int:
        if self.code_tva is not None:
            return self.code_tva
        inferred = infer_code_tva(self.designation, self.taux)
        if inferred is None:
            raise ValueError(
                f"Impossible de déduire le CODE TVA pour {self.designation.value} à {self.taux * 100}%"
            )
        return inferred


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
