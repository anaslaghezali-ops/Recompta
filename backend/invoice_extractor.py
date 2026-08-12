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

ICE_PATTERN = re.compile(r"\bI\.?C\.?E\.?\s*[:\s]*(\d{15})\b", re.I)
IF_PATTERN = re.compile(r"\b(?:IF|I\.F\.|1F|Identifiant\s+fiscal)\s*[:\s-]*([0-9A-Za-z]+)", re.I)
IF_FOOTER_PATTERN = re.compile(r"\bF\s+(\d{6,9})\b")
AMOUNT_PATTERN = re.compile(r"(\d{1,3}(?:[ \u00a0.,]\d{3})*(?:[.,]\d{2})?)")
INVOICE_NUM_PATTERN = re.compile(
    r"(?:FACTURE|AVOIR|N[°o]\s*Pi[eè]ce)\s*(?:N[°o\.]?|:)?\s*([A-Za-z0-9][A-Za-z0-9/_.-]{2,})",
    re.I,
)
SUPPLIER_SKIP = re.compile(r"^(ICE|IF|FACTURE|Date|Désignation|HT|TVA|TTC|TOTAL|Facture de test)", re.I)
AMOUNT_LINE = re.compile(r"^\d[\d., ]+$")


def _parse_amount(raw: str) -> float | None:
    cleaned = raw.replace("\u00a0", "").replace(" ", "").strip()
    if not cleaned or cleaned in {"-", "--"}:
        return None
    if "," in cleaned and "." in cleaned:
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    else:
        cleaned = cleaned.replace(",", ".")
    try:
        return float(cleaned)
    except ValueError:
        return None


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


def pdf_first_page_to_png(content: bytes, dpi: int = 200) -> bytes:
    import pymupdf

    doc = pymupdf.open(stream=content, filetype="pdf")
    if doc.page_count == 0:
        return b""
    page = doc[0]
    pix = page.get_pixmap(dpi=dpi)
    return pix.tobytes("png")


def ocr_image_bytes(content: bytes, lang: str = "fra+eng") -> str:
    import pytesseract
    from PIL import Image

    image = Image.open(BytesIO(content))
    return pytesseract.image_to_string(image, lang=lang)


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
        "ht": re.compile(
            r"Total\s+H\.?T\.?\s*(?:Net)?\s*[;:\s]*\n?\s*([-\d .,\u00a0]+)\s*(?:DH)?",
            re.I,
        ),
        "ttc": re.compile(
            r"Total\s+T\.?T\.?C\.?\s*[:\s]*\n?\s*([-\d .,\u00a0]+)\s*(?:DH)?",
            re.I,
        ),
        "tva": re.compile(
            r"Total\s+T\.?V\.?A\.?\s*[:\s]*\n?\s*([-\d .,\u00a0]+)\s*(?:DH)?",
            re.I,
        ),
    }
    found: dict[str, float] = {}
    for key, pattern in labels.items():
        match = pattern.search(text)
        if match:
            amount = _parse_amount(match.group(1))
            if amount is not None:
                found[key] = amount

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
    branded = re.search(
        r"\b(ACHIBEST|EATMEAT|MOSE\s*Food|ORANGE|GLOVO|CARREFOUR)\b",
        text,
        re.I,
    )
    if branded:
        name = branded.group(1).upper().replace("  ", " ")
        if "MOSE" in name:
            return "MOSE Food"
        if "EATMEAT" in name:
            return "EATMEAT"
        return name.title() if name != "ACHIBEST" else "ACHIBEST"

    if "partenaire des tables gourmandes" in text.lower():
        return "ACHIBEST"

    company_pattern = re.compile(r"\b(SARL|SA|STE|S\.A\.R\.L|S\.A\.R\.L\.A\.U)\b", re.I)
    for line in text.splitlines():
        candidate = line.strip()
        if not candidate or len(candidate) < 3 or SUPPLIER_SKIP.match(candidate):
            continue
        if "AICHOUM" in candidate.upper():
            continue
        if ICE_PATTERN.search(candidate) or IF_PATTERN.search(candidate):
            continue
        if company_pattern.search(candidate) or re.match(r"^[A-Z][A-Za-z0-9 .&'-]{2,}$", candidate):
            return candidate
    return ""


def _extract_supplier_ice(text: str) -> str:
    matches = ICE_PATTERN.findall(text)
    if matches:
        return matches[-1]
    plain = re.findall(r"\b(\d{15})\b", text)
    return plain[-1] if plain else ""


def _extract_supplier_if(text: str) -> str:
    if_match = IF_PATTERN.search(text)
    if if_match:
        return if_match.group(1).strip()
    footer = IF_FOOTER_PATTERN.search(text)
    if footer:
        return footer.group(1).strip()
    return ""


def _extract_invoice_number(text: str, filename: str) -> str:
    for pattern in (
        INVOICE_NUM_PATTERN,
        re.compile(r"(?:Facture|FACTURE)\s*:\s*([A-Za-z0-9][A-Za-z0-9/_.-]{2,})", re.I),
        re.compile(r"AVOIR\s*:\s*([A-Za-z0-9][A-Za-z0-9/_.-]{2,})", re.I),
        re.compile(r"FACTURE\s+N[°o\.]?\s*(.+?)(?:\n|$)", re.I),
    ):
        match = pattern.search(text)
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
            ht = _parse_amount(lines[i + 1])
            tva = _parse_amount(lines[i + 2])
            ttc = _parse_amount(lines[i + 3])
            if ht is None or tva is None or ttc is None:
                i += 1
                continue
            items.append(
                {
                    "label": lines[i],
                    "m_ht": ht,
                    "tva": tva,
                    "m_ttc": ttc,
                }
            )
            i += 4
            continue
        i += 1
    return items


def _extract_achibest_tva_table(text: str) -> list[dict[str, float]]:
    """Parse le tableau Taux / Montant HT / TVA des factures ACHIBEST."""
    items: list[dict[str, float]] = []
    pattern = re.compile(
        r"(\d+[,.]\d+)\s*[.\s]+([\d .,\u00a0]+)\s+([\d .,\u00a0]+)",
    )
    for match in pattern.finditer(text):
        taux = _parse_amount(match.group(1))
        ht = _parse_amount(match.group(2))
        tva = _parse_amount(match.group(3))
        if taux is None or ht is None or tva is None or ht <= 0:
            continue
        taux_norm = taux / 100 if taux > 1 else taux
        if taux_norm not in (0.1, 0.2):
            continue
        items.append(
            {
                "m_ht": ht,
                "tva": tva,
                "m_ttc": round(ht + tva, 2),
                "taux": taux_norm,
            }
        )
    return items


def _extract_tva_ventilation(text: str) -> list[dict[str, float]]:
    """Parse les lignes de ventilation TVA (format MOSE Food, etc.)."""
    items: list[dict[str, float]] = []
    pattern = re.compile(
        r"(\d+[,.]\d+)\s*TTC\s+(\d+[,.]\d+)\s*%\s+([\d.,]+)",
        re.I,
    )
    for match in pattern.finditer(text):
        ttc = _parse_amount(match.group(1))
        taux = _parse_amount(match.group(2))
        tva = _parse_amount(match.group(3))
        if ttc is None or taux is None or tva is None:
            continue
        taux_norm = taux / 100 if taux > 1 else taux
        ht = round(ttc - tva, 2)
        items.append({"m_ht": ht, "tva": tva, "m_ttc": ttc, "taux": taux_norm})
    return items


def _extract_mad_amounts(text: str) -> tuple[float | None, float | None, float | None]:
    """Extrait HT/TVA/TTC depuis des lignes type 1870.00MAD (factures EatMeat)."""
    amounts = [_parse_amount(m.group(1)) for m in re.finditer(r"([\d .,\u00a0]+)\s*MAD", text, re.I)]
    amounts = [a for a in amounts if a is not None and a > 0]
    if len(amounts) >= 3:
        # Heuristique: TTC est le plus grand, TVA le plus petit des 3
        amounts.sort()
        tva, ht, ttc = amounts[0], amounts[1], amounts[2]
        if ttc < ht:
            ht, ttc = ttc, ht
        return ht, tva, ttc
    return None, None, None


def _heuristic_extract(filename: str, text: str) -> ExtractionResult:
    warnings: list[str] = []
    if not text.strip():
        warnings.append("Aucun texte extrait du document. Saisie manuelle requise.")

    ice_match = _extract_supplier_ice(text)
    if_fiscal = _extract_supplier_if(text)
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
    achibest_lines = _extract_achibest_tva_table(text) if "ACHIBEST" in supplier.upper() or "partenaire des tables gourmandes" in text.lower() else []
    ventilation = _extract_tva_ventilation(text)
    invoice_lines: list[InvoiceLine] = []

    if achibest_lines:
        source = achibest_lines
    elif ventilation:
        source = ventilation
    else:
        source = []

    if source:
        for item in source:
            invoice_lines.append(
                InvoiceLine(
                    fact_num=fact_num,
                    designation=_guess_designation(text),
                    m_ht=item["m_ht"],
                    tva=item["tva"],
                    m_ttc=item["m_ttc"],
                    **{
                        "if": if_fiscal,
                        "lib_frss": supplier,
                        "ice_frs": ice_match,
                        "taux": item["taux"],
                        "id_paie": 4,
                        "date_paie": invoice_date,
                        "date_fac": invoice_date,
                    },
                )
            )
    elif line_items:
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
                        "if": if_fiscal,
                        "lib_frss": supplier,
                        "ice_frs": ice_match,
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
            ht2, tva2, ttc2 = _extract_mad_amounts(text)
            ht = ht or ht2
            tva = tva or tva2
            ttc = ttc or ttc2
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
                    "if": if_fiscal,
                    "lib_frss": supplier,
                    "ice_frs": ice_match,
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
        engine="text",
        warnings=warnings,
    )


def _image_to_base64(content: bytes, mime_type: str) -> str:
    return f"data:{mime_type};base64,{base64.b64encode(content).decode()}"


AI_EXTRACTION_PROMPT = """Tu es un expert comptable marocain. Analyse cette facture fournisseur (scan ou photo).

Extrais les informations pour la déclaration TVA (format DED TVA marocain).

Règles importantes :
- ICE fournisseur = 15 chiffres (en pied de page, PAS l'ICE du client)
- IF = identifiant fiscal du fournisseur
- Si plusieurs taux TVA (10% et 20%), crée UNE entrée par taux avec les montants HT/TVA/TTC correspondants
- designation : MATIERES CONSOMMABLES (achats), PRESTATIONS (services), TELEPHONIE, FRAIS BANCAIRE
- id_paie : 1 (paiement comptant) ou 4 (virement/crédit) — utilise 4 par défaut
- Pour un AVOIR (montants négatifs), utilise des montants positifs et ajoute un warning
- Dates au format YYYY-MM-DD

Retourne UNIQUEMENT un JSON valide :
{
  "lines": [
    {
      "fact_num": "FV26-023806",
      "designation": "MATIERES CONSOMMABLES",
      "m_ht": 0.0,
      "tva": 0.0,
      "m_ttc": 0.0,
      "if": "1102277",
      "lib_frss": "ACHIBEST",
      "ice_frs": "000229475000050",
      "taux": 0.2,
      "id_paie": 4,
      "date_paie": "2026-06-04",
      "date_fac": "2026-06-04"
    }
  ],
  "warnings": []
}
"""


def ai_available() -> bool:
    return bool(os.getenv("OPENAI_API_KEY", "").strip().startswith("sk-"))


def tesseract_available() -> bool:
    import shutil

    return shutil.which("tesseract") is not None


def preferred_engine() -> str:
    return "ai" if ai_available() else "tesseract"


async def _extract_with_openai(filename: str, content: bytes, mime_type: str) -> ExtractionResult:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY non configurée")

    payload = {
        "model": os.getenv("OPENAI_VISION_MODEL", "gpt-4o-mini"),
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": AI_EXTRACTION_PROMPT},
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
        engine="ai",
        warnings=content_json.get("warnings", []),
    )


async def _extract_with_ocr(filename: str, image_bytes: bytes) -> ExtractionResult:
    text = ocr_image_bytes(image_bytes)
    if not text.strip():
        return ExtractionResult(
            filename=filename,
            lines=[],
            confidence="low",
            warnings=["OCR n'a extrait aucun texte de l'image."],
        )
    result = _heuristic_extract(filename, text)
    result.confidence = "medium"
    result.engine = "tesseract"
    result.warnings.append("Extraction Tesseract (OCR local) — vérifiez les montants.")
    return result


async def extract_invoice(filename: str, content: bytes, mime_type: str) -> ExtractionResult:
    if mime_type == "application/pdf":
        text = extract_text_from_pdf(content)
        if text.strip():
            return _heuristic_extract(filename, text)

        # PDF scanné : IA en priorité, Tesseract en secours
        warnings_ai = ""
        if ai_available():
            try:
                png_bytes = pdf_first_page_to_png(content)
                if png_bytes:
                    return await _extract_with_openai(filename, png_bytes, "image/png")
            except Exception as exc:  # noqa: BLE001
                warnings_ai = f"IA indisponible ({exc}), repli sur Tesseract."
        else:
            return ExtractionResult(
                filename=filename,
                lines=[],
                confidence="low",
                engine="manual",
                warnings=[
                    "OPENAI_API_KEY manquante dans backend/.env — créez le fichier et redémarrez uvicorn."
                ],
            )

        if not tesseract_available():
            return ExtractionResult(
                filename=filename,
                lines=[],
                confidence="low",
                engine="manual",
                warnings=[warnings_ai or "Tesseract non installé.", "Configurez OPENAI_API_KEY dans backend/.env."],
            )

        try:
            png_bytes = pdf_first_page_to_png(content)
            if png_bytes:
                result = await _extract_with_ocr(filename, png_bytes)
                if warnings_ai:
                    result.warnings.insert(0, warnings_ai)
                return result
        except Exception as exc:  # noqa: BLE001
            return ExtractionResult(
                filename=filename,
                lines=[],
                confidence="low",
                engine="tesseract",
                warnings=[f"OCR échoué: {exc}"],
            )

        return ExtractionResult(
            filename=filename,
            lines=[],
            confidence="low",
            warnings=["PDF scanné : impossible d'extraire le texte."],
        )

    if mime_type.startswith("image/"):
        if ai_available():
            try:
                return await _extract_with_openai(filename, content, mime_type)
            except Exception as exc:  # noqa: BLE001
                if not tesseract_available():
                    return ExtractionResult(
                        filename=filename,
                        lines=[],
                        confidence="low",
                        engine="manual",
                        warnings=[f"IA échouée: {exc}", "Vérifiez OPENAI_API_KEY dans backend/.env."],
                    )
                try:
                    result = await _extract_with_ocr(filename, content)
                    result.warnings.insert(0, f"IA indisponible ({exc}), repli sur Tesseract.")
                    return result
                except Exception as ocr_exc:  # noqa: BLE001
                    return ExtractionResult(
                        filename=filename,
                        lines=[],
                        confidence="low",
                        engine="tesseract",
                        warnings=[f"Extraction échouée: {ocr_exc}"],
                    )
        return ExtractionResult(
            filename=filename,
            lines=[],
            confidence="low",
            engine="manual",
            warnings=["OPENAI_API_KEY manquante dans backend/.env — créez le fichier et redémarrez uvicorn."],
        )

    return ExtractionResult(
        filename=filename,
        lines=[],
        confidence="low",
        warnings=[f"Type de fichier non supporté: {mime_type}"],
    )


def merge_extractions(results: Iterable[ExtractionResult]) -> list[InvoiceLine]:
    lines: list[InvoiceLine] = []
    for result in results:
        lines.extend(result.lines)
    return lines
