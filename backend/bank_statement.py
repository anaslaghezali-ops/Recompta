"""Extraction des mouvements bancaires depuis un relevé PDF/image via IA."""

from __future__ import annotations

import json
import os
from typing import Optional

import httpx
from pydantic import BaseModel, Field

from invoice_extractor import (
    ai_available,
    format_openai_error,
    pdf_to_png_pages,
    tesseract_available,
    verify_openai_key,
    _image_to_base64,
    ocr_image_bytes,
)

BANK_STATEMENT_PROMPT = """Tu analyses un relevé bancaire marocain (PDF ou scan).
Extrais UNIQUEMENT les mouvements (opérations) sous forme JSON :

{
  "bank_name": "nom de la banque si visible",
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "label": "libellé complet de l'opération",
      "amount": -1234.56,
      "type": "payment"
    }
  ],
  "warnings": []
}

Règles :
- amount NÉGATIF pour les débits (paiements sortants, frais, commissions)
- amount POSITIF pour les crédits (encaissements)
- type = "fee" si commission, frais bancaires, agios, tenue de compte, cotisation carte
- type = "payment" si virement/paiement/chèque/prélèvement fournisseur (débit hors frais)
- type = "credit" si encaissement entrant
- Ignore les lignes de solde initial/final
- Date au format ISO YYYY-MM-DD
- Montants en MAD avec décimales
- Ne pas inventer de mouvements absents du document
"""


class BankTransaction(BaseModel):
    date: str
    label: str = ""
    amount: float
    type: str = "other"


class BankStatementResult(BaseModel):
    filename: str
    bank_name: str = "BANQUE"
    transactions: list[BankTransaction] = Field(default_factory=list)
    engine: str = "manual"
    warnings: list[str] = Field(default_factory=list)


def _heuristic_from_text(text: str) -> list[BankTransaction]:
    """Parse basique depuis texte OCR (secours)."""
    import re

    transactions: list[BankTransaction] = []
    for line in text.splitlines():
        lowered = line.lower()
        if any(w in lowered for w in ("solde", "total", "report")):
            continue
        date_match = re.search(r"(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})", line)
        amount_match = re.search(r"(-?\d[\d\s]*[,.]\d{2})\s*$", line)
        if not date_match or not amount_match:
            continue
        day, month, year = date_match.groups()
        if len(year) == 2:
            year = f"20{year}"
        date_str = f"{year}-{month.zfill(2)}-{day.zfill(2)}"
        amount = float(amount_match.group(1).replace(" ", "").replace(",", "."))
        label = line[: date_match.start()].strip() or line
        txn_type = "fee" if any(w in lowered for w in ("commission", "frais", "agios")) else (
            "payment" if amount < 0 else "credit"
        )
        transactions.append(
            BankTransaction(date=date_str, label=label, amount=amount, type=txn_type)
        )
    return transactions


async def _extract_with_ai(filename: str, images: list[tuple[bytes, str]]) -> BankStatementResult:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY non configurée")

    message_content: list[dict] = [{"type": "text", "text": BANK_STATEMENT_PROMPT}]
    for image_bytes, image_mime in images:
        message_content.append(
            {
                "type": "image_url",
                "image_url": {"url": _image_to_base64(image_bytes, image_mime)},
            }
        )

    payload = {
        "model": os.getenv("OPENAI_VISION_MODEL", "gpt-4o-mini"),
        "messages": [{"role": "user", "content": message_content}],
        "response_format": {"type": "json_object"},
        "temperature": 0,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json=payload,
        )
        response.raise_for_status()
        content_json = json.loads(response.json()["choices"][0]["message"]["content"])

    txns = [BankTransaction.model_validate(item) for item in content_json.get("transactions", [])]
    return BankStatementResult(
        filename=filename,
        bank_name=content_json.get("bank_name") or "BANQUE",
        transactions=txns,
        engine="ai",
        warnings=content_json.get("warnings", []),
    )


async def extract_bank_statement(filename: str, content: bytes, mime_type: str) -> BankStatementResult:
    if not content:
        return BankStatementResult(
            filename=filename,
            warnings=["Fichier vide."],
        )

    if mime_type == "application/pdf":
        if ai_available():
            try:
                pages = pdf_to_png_pages(content, max_pages=5)
                if pages:
                    return await _extract_with_ai(
                        filename, [(page, "image/png") for page in pages]
                    )
            except Exception as exc:  # noqa: BLE001
                return BankStatementResult(
                    filename=filename,
                    warnings=[f"Extraction IA échouée ({format_openai_error(exc)})."],
                )

        if tesseract_available():
            pages = pdf_to_png_pages(content, max_pages=1)
            if pages:
                text = ocr_image_bytes(pages[0])
                txns = _heuristic_from_text(text)
                return BankStatementResult(
                    filename=filename,
                    transactions=txns,
                    engine="tesseract",
                    warnings=["Extraction OCR basique — préférez CSV/Excel ou activez l'IA."],
                )

        return BankStatementResult(
            filename=filename,
            warnings=["PDF non lisible sans IA. Configurez OPENAI_API_KEY ou exportez en CSV."],
        )

    if mime_type.startswith("image/"):
        if ai_available():
            try:
                return await _extract_with_ai(filename, [(content, mime_type)])
            except Exception as exc:  # noqa: BLE001
                return BankStatementResult(
                    filename=filename,
                    warnings=[f"Extraction IA échouée ({format_openai_error(exc)})."],
                )
        if tesseract_available():
            text = ocr_image_bytes(content)
            return BankStatementResult(
                filename=filename,
                transactions=_heuristic_from_text(text),
                engine="tesseract",
                warnings=["Extraction OCR basique."],
            )

    return BankStatementResult(
        filename=filename,
        warnings=["Type de fichier non supporté pour le relevé bancaire."],
    )


async def bank_ai_ready() -> tuple[bool, str]:
    if not ai_available():
        return False, "OPENAI_API_KEY manquante"
    return await verify_openai_key()
