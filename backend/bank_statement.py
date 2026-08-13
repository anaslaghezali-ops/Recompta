"""Extraction des mouvements bancaires depuis un relevé PDF/image via IA."""

from __future__ import annotations

import json
import os
import re
from typing import Optional

import httpx
from pydantic import BaseModel, Field

from invoice_extractor import (
    ai_available,
    format_openai_error,
    ocr_image_bytes_async,
    pdf_to_png_pages_async,
    tesseract_available,
    verify_openai_key,
    vision_model,
    _image_to_base64,
    _post_chat_completion,
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
    bank_ice: str = ""
    bank_if: str = ""
    transactions: list[BankTransaction] = Field(default_factory=list)
    engine: str = "manual"
    warnings: list[str] = Field(default_factory=list)


def _bank_identity(text: str) -> tuple[str, str, str]:
    """Nom, ICE et IF de la banque, lus dans l'en-tête légal du relevé."""
    from invoice_extractor import ICE_PATTERN, _extract_supplier_if, other_legal_ids

    ice_candidates = [ice for ice in ICE_PATTERN.findall(text) if len(ice) == 15]
    ice = max(set(ice_candidates), key=ice_candidates.count) if ice_candidates else ""

    fiscal_id = _extract_supplier_if(text)
    if fiscal_id and re.sub(r"\D", "", fiscal_id) in other_legal_ids(text):
        fiscal_id = ""

    name = ""
    for line in text.splitlines():
        candidate = line.strip()
        if 3 <= len(candidate) <= 60 and re.match(r"^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .&'-]+$", candidate):
            name = candidate
            break

    return name or "BANQUE", ice, fiscal_id


async def _document_text(content: bytes, mime_type: str) -> str:
    from invoice_extractor import (
        extract_text_from_pdf_async,
        ocr_image_bytes_async,
        tesseract_available,
    )

    if mime_type == "application/pdf":
        text = await extract_text_from_pdf_async(content)
        if text.strip():
            return text
    if mime_type.startswith("image/") and tesseract_available():
        try:
            return await ocr_image_bytes_async(content)
        except Exception:  # noqa: BLE001
            return ""
    return ""


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
        "model": vision_model(),
        "messages": [{"role": "user", "content": message_content}],
        "response_format": {"type": "json_object"},
        "temperature": 0,
    }

    body = await _post_chat_completion(api_key, payload)
    content_json = json.loads(body["choices"][0]["message"]["content"])

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

    result = await _extract_bank_statement_inner(filename, content, mime_type)

    # L'ICE de la banque figure dans l'en-tête légal du relevé : il alimente
    # les lignes FRAIS BANCAIRE, qui sinon partiraient sans ICE fournisseur.
    text = await _document_text(content, mime_type)
    if text.strip():
        name, ice, fiscal_id = _bank_identity(text)
        if ice:
            result.bank_ice = ice
        if fiscal_id:
            result.bank_if = fiscal_id
        if name != "BANQUE" and result.bank_name in ("", "BANQUE"):
            result.bank_name = name

    if not result.bank_ice and result.transactions:
        result.warnings.append("ICE de la banque introuvable — à saisir manuellement.")

    return result


async def _extract_bank_statement_inner(
    filename: str, content: bytes, mime_type: str
) -> BankStatementResult:

    if mime_type == "application/pdf":
        if ai_available():
            try:
                pages = await pdf_to_png_pages_async(content, max_pages=5)
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
            pages = await pdf_to_png_pages_async(content, max_pages=1)
            if pages:
                text = await ocr_image_bytes_async(pages[0])
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
            text = await ocr_image_bytes_async(content)
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
