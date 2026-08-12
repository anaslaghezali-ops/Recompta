from __future__ import annotations

import base64
import json
import os
import re
from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from typing import Iterable

import httpx
from pypdf import PdfReader

from models import Designation, ExtractionResult, InvoiceLine

MOROCCAN_DATE_PATTERNS = [
    r"(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})",
    r"(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})",
]

ICE_PATTERN = re.compile(r"\b(\d{15})\b")
IF_PATTERN = re.compile(r"\b(?:IF|I\.F\.|Identifiant\s+fiscal)\s*[:\s]*([0-9A-Za-z]+)", re.I)
AMOUNT_PATTERN = re.compile(r"(\d{1,3}(?:[ \u00a0.,]\d{3})*(?:[.,]\d{2})?)")
INVOICE_NUM_PATTERN = re.compile(
    r"FACTURE\s+N[°o\.]?\s*(.+?)(?:\n|$)",
    re.I,
)
SUPPLIER_SKIP = re.compile(r"^(ICE|IF|FACTURE|Date|Désignation|HT|TVA|TTC|TOTAL|Facture de test)", re.I)
AMOUNT_LINE = re.compile(r"^\d[\d., ]+$")


def _parse_amount(raw: str) -> float:
    cleaned = raw.replace("\u00a0", "").replace(" ", "")
    if "," in cleaned and "." in cleaned:
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    else:
        cleaned = cleaned.replace(",", ".")
    return float(cleaned)


def _parse_date(raw: str) -> date | None:
    raw = raw.strip()
    for pattern in MOROCCAN_DATE_PATTERNS:
        match = re.search(pattern, raw)
        if not match:
            continue
        parts = [int(p) for p in match.groups()]
        if parts[0] > 1900:
            year, month, day = parts
        else:
            day, month, year = parts
        try:
            return date(year, month, day)
        except ValueError:
            continue
    return None


def extract_text_from_pdf(content: bytes) -> str:
    reader = PdfReader(BytesIO(content))
    chunks: list[str] = []
    for page in reader.pages:
        text = page.extract_text() or ""
        if text.strip():
            chunks.append(text)
    return "\n".join(chunks)


def _guess_designation(text: str) -> Designation:
    lowered = text.lower()
    if any(word in lowered for word in ("orange", "inwi", "iam", "téléphon", "telephon")):
        return Designation.TELEPHONIE
    if any(word in lowered for word in ("banque", "bancaire", "relevé", "releve", "commission")):
        return Designation.FRAIS_BANCAIRE
    if any(word in lowered for word in ("prestation", "service", "honoraire", "glovo", "livraison")):
        return Designation.PRESTATIONS
    return Designation.MATIERES_CONSOMMABLES


def _extract_amounts(text: str) -> tuple[float | None, float | None, float | None]:
    labels = {
        "ht": re.compile(r"TOTAL\s+H\.?T\.?\s*[:\s]*([0-9 .,\u00a0]+)", re.I),
        "ttc": re.compile(r"TOTAL\s+T\.?T\.?C\.?\s*[:\s]*([0-9 .,\u00a0]+)", re.I),
        "tva": re.compile(r"TOTAL\s+T\.?V\.?A\.?\s*[:\s]*([0-9 .,\u00a0]+)", re.I),
    }
    found: dict[str, float] = {}
    for key, pattern in labels.items():
        match = pattern.search(text)
        if match:
            found[key] = _parse_amount(match.group(1))

    ht = found.get("ht")
    ttc = found.get("ttc")
    tva = found.get("tva")

    if ht is None and ttc is not None and tva is not None:
        ht = round(ttc - tva, 2)
    if tva is None and ht is not None and ttc is not None:
        tva = round(ttc - ht, 2)
    if ttc is None and ht is not None and tva is not None:
        ttc = round(ht + tva, 2)

    return ht, tva, ttc


def _guess_taux(ht: float | None, tva: float | None) -> float:
    if ht and tva and ht > 0:
        ratio = round(tva / ht, 2)
        if ratio in (0.1, 0.2):
            return ratio
        if 0.08 <= ratio <= 0.12:
            return 0.1
        if 0.18 <= ratio <= 0.22:
            return 0.2
    return 0.2


def _extract_supplier_name(text: str) -> str:
    for line in text.splitlines():
        candidate = line.strip()
        if not candidate or SUPPLIER_SKIP.match(candidate):
            continue
        if ICE_PATTERN.search(candidate) or IF_PATTERN.search(candidate):
            continue
        return candidate
    return ""


def _extract_invoice_number(text: str, filename: str) -> str:
    match = INVOICE_NUM_PATTERN.search(text)
    if match:
        return match.group(1).strip()
    return Path(filename).stem


def _extract_line_items(text: str) -> list[dict[str, float | str]]:
    total_idx = text.upper().find("TOTAL HT")
    section = text[:total_idx] if total_idx != -1 else text
    lines = [line.strip() for line in section.splitlines() if line.strip()]

    # Ignore table header block
    start = 0
    for idx, line in enumerate(lines):
        if line.upper() in {"HT", "TVA", "TTC"} or "désignation" in line.lower():
            start = idx + 1
    lines = lines[start:]

    items: list[dict[str, float | str]] = []
    i = 0
    while i < len(lines):
        if i + 3 < len(lines) and AMOUNT_LINE.match(lines[i + 1]) and AMOUNT_LINE.match(lines[i + 2]) and AMOUNT_LINE.match(lines[i + 3]):
            items.append(
                {
                    "label": lines[i],
                    "m_ht": _parse_amount(lines[i + 1]),
                    "tva": _parse_amount(lines[i + 2]),
                    "m_ttc": _parse_amount(lines[i + 3]),
                }
            )
            i += 4
            continue
        i += 1
    return items


def _heuristic_extract(filename: str, text: str) -> ExtractionResult:
    warnings: list[str] = []
    if not text.strip():
        warnings.append("Aucun texte extrait du document. Saisie manuelle requise.")

    ice_match = ICE_PATTERN.search(text)
    if_match = IF_PATTERN.search(text)
    fact_num = _extract_invoice_number(text, filename)
    supplier = _extract_supplier_name(text)

    date_candidates = []
    for pattern in MOROCCAN_DATE_PATTERNS:
        for match in re.finditer(pattern, text):
            parsed = _parse_date(match.group(0))
            if parsed:
                date_candidates.append(parsed)
    invoice_date = date_candidates[0] if date_candidates else None

    line_items = _extract_line_items(text)
    invoice_lines: list[InvoiceLine] = []

    if line_items:
        for item in line_items:
            ht = float(item["m_ht"])
            tva = float(item["tva"])
            ttc = float(item["m_ttc"])
            label = str(item["label"])
            taux = _guess_taux(ht, tva)
            invoice_lines.append(
                InvoiceLine(
                    fact_num=fact_num,
                    designation=_guess_designation(f"{text}\n{label}"),
                    m_ht=ht,
                    tva=tva,
                    m_ttc=ttc,
                    **{
                        "if": if_match.group(1).strip() if if_match else "",
                        "lib_frss": supplier,
                        "ice_frs": ice_match.group(1) if ice_match else "",
                        "taux": taux,
                        "id_paie": 4,
                        "date_paie": invoice_date,
                        "date_fac": invoice_date,
                    },
                )
            )
    else:
        ht, tva, ttc = _extract_amounts(text)
        if ht is None or ttc is None:
            warnings.append("Montants HT/TTC non détectés automatiquement.")

        taux = _guess_taux(ht, tva)
        if tva is None and ht is not None:
            tva = round(ht * taux, 2)
        if ttc is None and ht is not None and tva is not None:
            ttc = round(ht + tva, 2)

        invoice_lines.append(
            InvoiceLine(
                fact_num=fact_num,
                designation=_guess_designation(text),
                m_ht=ht or 0.0,
                tva=tva or 0.0,
                m_ttc=ttc or 0.0,
                **{
                    "if": if_match.group(1).strip() if if_match else "",
                    "lib_frss": supplier,
                    "ice_frs": ice_match.group(1) if ice_match else "",
                    "taux": taux,
                    "id_paie": 4,
                    "date_paie": invoice_date,
                    "date_fac": invoice_date,
                },
            )
        )

    return ExtractionResult(
        filename=filename,
        lines=invoice_lines,
        raw_text=text[:4000],
        confidence="low" if warnings else "medium",
        warnings=warnings,
    )


def _image_to_base64(content: bytes, mime_type: str) -> str:
    return f"data:{mime_type};base64,{base64.b64encode(content).decode()}"


async def _extract_with_openai(filename: str, content: bytes, mime_type: str) -> ExtractionResult:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY non configurée")

    prompt = """Tu es un assistant comptable marocain. Analyse cette facture fournisseur scannée.
Retourne UNIQUEMENT un JSON valide avec cette structure:
{
  "lines": [
    {
      "fact_num": "numéro facture",
      "designation": "MATIERES CONSOMMABLES | PRESTATIONS | TELEPHONIE | FRAIS BANCAIRE",
      "m_ht": 0.0,
      "tva": 0.0,
      "m_ttc": 0.0,
      "if": "identifiant fiscal fournisseur",
      "lib_frss": "nom fournisseur",
      "ice_frs": "ICE 15 chiffres",
      "taux": 0.1 ou 0.2,
      "id_paie": 1 ou 4,
      "date_paie": "YYYY-MM-DD",
      "date_fac": "YYYY-MM-DD"
    }
  ],
  "warnings": ["..."]
}
Si la facture contient plusieurs lignes avec des taux TVA différents, crée une entrée par ligne.
"""

    payload = {
        "model": os.getenv("OPENAI_VISION_MODEL", "gpt-4o-mini"),
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": _image_to_base64(content, mime_type)},
                    },
                ],
            }
        ],
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

    lines = [InvoiceLine.model_validate(item) for item in content_json.get("lines", [])]
    return ExtractionResult(
        filename=filename,
        lines=lines,
        confidence="high",
        warnings=content_json.get("warnings", []),
    )


async def extract_invoice(filename: str, content: bytes, mime_type: str) -> ExtractionResult:
    if mime_type == "application/pdf":
        text = extract_text_from_pdf(content)
        if text.strip():
            return _heuristic_extract(filename, text)

    if mime_type.startswith("image/") and os.getenv("OPENAI_API_KEY"):
        try:
            return await _extract_with_openai(filename, content, mime_type)
        except Exception as exc:  # noqa: BLE001
            return ExtractionResult(
                filename=filename,
                lines=[],
                confidence="low",
                warnings=[f"Extraction IA échouée: {exc}. Utilisez la saisie manuelle."],
            )

    if mime_type == "application/pdf":
        return _heuristic_extract(filename, text)

    return ExtractionResult(
        filename=filename,
        lines=[],
        confidence="low",
        warnings=[
            "Document image sans clé OpenAI: configurez OPENAI_API_KEY pour l'extraction automatique, "
            "ou saisissez les lignes manuellement."
        ],
    )


def merge_extractions(results: Iterable[ExtractionResult]) -> list[InvoiceLine]:
    lines: list[InvoiceLine] = []
    for result in results:
        lines.extend(result.lines)
    return lines
