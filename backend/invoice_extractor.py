from __future__ import annotations

import asyncio
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
    negative = cleaned.startswith("-") or cleaned.startswith("(")
    cleaned = cleaned.lstrip("-(").rstrip(")")
    if "," in cleaned and "." in cleaned:
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    else:
        cleaned = cleaned.replace(",", ".")
    try:
        value = float(cleaned)
        return -abs(value) if negative else value
    except ValueError:
        return None


def _as_avoir_amount(value: float | None) -> float | None:
    if value is None:
        return None
    amount = abs(value)
    return -amount if amount else 0.0


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


KNOWN_ICE_SUPPLIERS: dict[str, tuple[str, str]] = {}


def pdf_to_png_pages(content: bytes, max_pages: int = 3, dpi: int = 200) -> list[bytes]:
    import pymupdf

    doc = pymupdf.open(stream=content, filetype="pdf")
    pages: list[bytes] = []
    for index in range(min(doc.page_count, max_pages)):
        pix = doc[index].get_pixmap(dpi=dpi)
        pages.append(pix.tobytes("png"))
    return pages


def pdf_first_page_to_png(content: bytes, dpi: int = 200) -> bytes:
    pages = pdf_to_png_pages(content, max_pages=1, dpi=dpi)
    return pages[0] if pages else b""


# Tesseract parallélise chaque page via OpenMP en utilisant tous les cœurs.
# Comme on traite déjà plusieurs factures en parallèle, cela sursouscrit le CPU
# (N pages × N cœurs de threads) et effondre le débit. Une page par thread est
# nettement plus rapide à l'échelle du lot — la qualité de l'OCR est identique.
os.environ.setdefault("OMP_THREAD_LIMIT", "1")


def ocr_image_bytes(content: bytes, lang: str = "fra+eng") -> str:
    import pytesseract
    from PIL import Image

    image = Image.open(BytesIO(content))
    return pytesseract.image_to_string(image, lang=lang)


# Le rendu PDF et l'OCR sont bloquants : sans thread, ils figent la boucle
# asyncio et les extractions « simultanées » redeviennent séquentielles.
async def extract_text_from_pdf_async(content: bytes) -> str:
    return await asyncio.to_thread(extract_text_from_pdf, content)


async def pdf_to_png_pages_async(
    content: bytes, max_pages: int = 3, dpi: int = 200
) -> list[bytes]:
    return await asyncio.to_thread(pdf_to_png_pages, content, max_pages, dpi)


async def pdf_first_page_to_png_async(content: bytes, dpi: int = 200) -> bytes:
    return await asyncio.to_thread(pdf_first_page_to_png, content, dpi)


async def ocr_image_bytes_async(content: bytes, lang: str = "fra+eng") -> str:
    return await asyncio.to_thread(ocr_image_bytes, content, lang)


async def ocr_pages_async(pages: list[bytes]) -> str:
    texts = await asyncio.gather(*(ocr_image_bytes_async(page) for page in pages))
    return "\n".join(texts)


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
            r"Total\s+(?:T\.?V\.?A\.?|Taxes)\s*[:\s]*\n?\s*([-\d .,\u00a0]+)\s*(?:DH)?",
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

    ht, tva, ttc = (v if v is None else abs(v) for v in (ht, tva, ttc))
    return ht, tva, ttc


def _extract_avoir_totals(text: str) -> tuple[float | None, float | None, float | None]:
    if not re.search(r"\bAVOIR\b", text, re.I):
        return None, None, None

    ventilation = re.search(
        r"Taux\s+Base\s+HT\s+Montant\s+TVA\s+.*?(-?[\d .,\u00a0]+)\s*(-?[\d .,\u00a0]+)\s+(\d+[,.]\d+)",
        text,
        re.I | re.S,
    )
    if ventilation:
        tva = _as_avoir_amount(_parse_amount(ventilation.group(1)))
        ht = _as_avoir_amount(_parse_amount(ventilation.group(2)))
        if ht and tva:
            return ht, tva, round(ht + tva, 2)

    block = re.search(r"Net\s+à\s+payer\s*(.*?)(?:ARRETEE|$)", text, re.I | re.S)
    if block:
        amounts: list[float] = []
        for match in re.finditer(r"(-?[\d]{1,3}(?:[.\s]\d{3})*(?:,\d{2})?)\s*(?:DH)?", block.group(1)):
            value = _parse_amount(match.group(1))
            if value is not None and value != 0:
                amounts.append(abs(value))
        unique = sorted(set(amounts))
        if len(unique) >= 3:
            tva, ht, ttc = unique[0], unique[1], unique[2]
            return _as_avoir_amount(ht), _as_avoir_amount(tva), _as_avoir_amount(ttc)

    return None, None, None


def _resolve_supplier_from_ice(text: str, supplier: str, ice: str) -> tuple[str, str]:
    return supplier, _extract_supplier_if(text)


def _needs_ai_upgrade(result: ExtractionResult) -> bool:
    if not result.lines:
        return True
    return all(abs(line.m_ht) < 1e-9 and abs(line.m_ttc) < 1e-9 for line in result.lines)


def _guess_taux(ht: float | None, tva: float | None) -> float:
    if ht and tva and abs(ht) > 0:
        ratio = round(abs(tva) / abs(ht), 2)
        if ratio in (0.1, 0.2):
            return ratio
        if 0.08 <= ratio <= 0.12:
            return 0.1
        if 0.18 <= ratio <= 0.22:
            return 0.2
    return 0.2


def _extract_supplier_name(text: str) -> str:
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
    from normalize_results import get_excluded_client_ices, normalize_ice_digits

    excluded = get_excluded_client_ices()

    footer_match = re.search(
        r"(?:SARL|Capital|RC\s*:).*?ICE\s*[:\s]*(\d{15})",
        text,
        re.I | re.S,
    )
    if footer_match:
        ice = normalize_ice_digits(footer_match.group(1))
        if ice and ice not in excluded:
            return ice

    for ice in reversed(ICE_PATTERN.findall(text)):
        normalized = normalize_ice_digits(ice)
        if normalized and normalized not in excluded:
            return normalized

    for ice in reversed(re.findall(r"\b(\d{15})\b", text)):
        normalized = normalize_ice_digits(ice)
        if normalized and normalized not in excluded:
            return normalized
    return ""


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
    block = text
    lower = text.lower()
    for marker in ("taux", "montant ht", "ventilation"):
        idx = lower.find(marker)
        if idx != -1:
            block = text[idx:]
            break

    amount = r"(?:-?[\d]{1,3}(?:[.\s]\d{3})*(?:,\d{2})|-?[\d]+,\d{2})"
    row_pattern = re.compile(
        rf"^\s*(\d{{1,2}}[,.]\d{{2}})\s+({amount})\s+({amount})\s*$",
        re.M,
    )

    for match in row_pattern.finditer(block):
        taux = _parse_amount(match.group(1))
        ht = _parse_amount(match.group(2))
        tva = _parse_amount(match.group(3))
        if taux is None or ht is None or tva is None:
            continue
        if abs(ht) < 0.01 and abs(tva) < 0.01:
            continue
        taux_norm = taux / 100 if taux > 1 else taux
        if taux_norm not in (0.1, 0.2):
            continue
        if abs(ht) > 0:
            ratio = round(abs(tva) / abs(ht), 2)
            if ratio not in (0.1, 0.2) and not (0.08 <= ratio <= 0.12 or 0.18 <= ratio <= 0.22):
                continue
        sign = -1 if ht < 0 or tva < 0 else 1
        ht_val = abs(ht) * sign
        tva_val = abs(tva) * sign
        items.append(
            {
                "m_ht": ht_val,
                "tva": tva_val,
                "m_ttc": round(ht_val + tva_val, 2),
                "taux": taux_norm,
            }
        )
    return items


def _extract_tva_ventilation(text: str) -> list[dict[str, float]]:
    """Parse les lignes de ventilation TVA (format MOSE Food, etc.)."""
    items: list[dict[str, float]] = []
    pattern = re.compile(
        r"(\d+[,.]\d+)\s*TTC\s+(\d+[,.]\d+)\s*%?\s+([\d.,]+)",
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
    supplier, if_fiscal = _resolve_supplier_from_ice(text, supplier, ice_match)

    date_candidates = []
    for pattern in MOROCCAN_DATE_PATTERNS:
        for match in re.finditer(pattern, text):
            parsed = _parse_date(match.group(0))
            if parsed:
                date_candidates.append(parsed)
    invoice_date = date_candidates[0] if date_candidates else None

    line_items = _extract_line_items(text)
    from vat_intelligence import extract_vat_lines_from_text

    ventilation = extract_vat_lines_from_text(text)
    invoice_lines: list[InvoiceLine] = []

    source = ventilation

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
            ht3, tva3, ttc3 = _extract_avoir_totals(text)
            ht = ht or ht3
            tva = tva or tva3
            ttc = ttc or ttc3
        if ht is None or ttc is None:
            warnings.append("Montants HT/TTC non détectés automatiquement.")
        elif re.search(r"\bAVOIR\b", text, re.I):
            warnings.append("Document AVOIR détecté — montants en négatif.")

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

## Méthode obligatoire (tous fournisseurs)

Pour CHAQUE ligne de TVA ou ventilation, suis ces étapes dans l'ordre :

1. **Lire les libellés visibles** sur le document : HT, TTC, TVA, « Montant HT », « Base HT », etc.
   Ne devine jamais : si un montant est étiqueté « TTC », c'est le TTC, pas le HT.

2. **Ventilation TVA marocaine** — formats fréquents (tous fournisseurs) :
   - « 1284,00 TTC  20%  214,00 » → m_ttc=1284, tva=214, m_ht=1070, taux=0.2
   - « Taux | Montant HT | TVA » → première colonne montant = HT
   - Totaux pied de page « Total HT / Total Taxes / Total TTC » → utiliser ces totaux

3. **Auto-vérification mathématique** avant de répondre, pour chaque ligne :
   - m_ht + tva ≈ m_ttc (±0,05 MAD)
   - tva / m_ht ≈ taux (±2 %)  OU  tva / m_ttc ≈ taux/(1+taux)
   - Si ça ne colle pas : tu as confondu HT et TTC → recalcule (HT = TTC − TVA)

4. **Plusieurs taux** (10 % et 20 %) : une entrée JSON par taux, avec les montants de la ventilation.

## Champs

- ICE fournisseur = 15 chiffres (pied de page légal, PAS l'ICE client en en-tête)
- IF = identifiant fiscal fournisseur
- designation : EXACTEMENT une de : "MATIERES CONSOMMABLES", "PRESTATIONS", "TELEPHONIE", "FRAIS BANCAIRE"
- id_paie : 1 (comptant) ou 4 (virement) — défaut 4
- AVOIR : montants HT, TVA et TTC négatifs
- Dates : YYYY-MM-DD

## Réponse JSON

Inclus un champ "verification" listant ton contrôle mathématique par ligne (ex. "20%: 1070+214=1284 OK").

{
  "verification": ["..."],
  "lines": [
    {
      "fact_num": "...",
      "designation": "MATIERES CONSOMMABLES",
      "m_ht": 1070.0,
      "tva": 214.0,
      "m_ttc": 1284.0,
      "if": "...",
      "lib_frss": "...",
      "ice_frs": "...",
      "taux": 0.2,
      "id_paie": 4,
      "date_paie": "2026-06-13",
      "date_fac": "2026-06-13"
    }
  ],
  "warnings": []
}
"""


def ai_available() -> bool:
    return bool(os.getenv("OPENAI_API_KEY", "").strip().startswith("sk-"))


async def verify_openai_key() -> tuple[bool, str]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key.startswith("sk-"):
        return False, "OPENAI_API_KEY manquante dans backend/.env"

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
        if response.status_code == 401:
            return False, "Clé OpenAI refusée (401) — créez une nouvelle clé sur platform.openai.com"
        if response.status_code >= 400:
            return False, f"OpenAI injoignable ({response.status_code})"
        return True, "Clé OpenAI valide"
    except Exception as exc:  # noqa: BLE001
        return False, f"Impossible de joindre OpenAI : {exc}"


def format_openai_error(exc: Exception) -> str:
    message = str(exc)
    if "401" in message or "Unauthorized" in message:
        return (
            "Clé OpenAI invalide (401). Éditez backend/.env avec une clé sk-... valide, "
            "puis redémarrez uvicorn (Ctrl+C puis relancez)."
        )
    if "502" in message or "Bad Gateway" in message:
        return "OpenAI temporairement indisponible (502). Réessayez dans quelques minutes."
    if "429" in message:
        return "Quota OpenAI dépassé (429). Vérifiez votre compte OpenAI."
    return message


def tesseract_available() -> bool:
    import shutil

    return shutil.which("tesseract") is not None


def preferred_engine() -> str:
    return "ai" if ai_available() else "tesseract"


DEFAULT_VISION_MODEL = "gpt-5.4-mini"
DEFAULT_VISION_MODEL_FALLBACK = "gpt-5.6-terra"


def vision_model() -> str:
    return os.getenv("OPENAI_VISION_MODEL", DEFAULT_VISION_MODEL).strip() or DEFAULT_VISION_MODEL


def vision_model_fallback() -> str:
    configured = os.getenv("OPENAI_VISION_MODEL_FALLBACK", DEFAULT_VISION_MODEL_FALLBACK).strip()
    return configured or DEFAULT_VISION_MODEL_FALLBACK


async def _post_chat_completion(api_key: str, payload: dict) -> dict:
    """Appelle l'API en retirant les paramètres refusés par certains modèles."""
    async with httpx.AsyncClient(timeout=180.0) as client:
        for _ in range(3):
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json=payload,
            )
            if response.status_code != 400:
                response.raise_for_status()
                return response.json()

            detail = response.text
            removed = False
            for param in ("temperature", "response_format"):
                if param in payload and param in detail:
                    payload.pop(param)
                    removed = True
                    break
            if not removed:
                response.raise_for_status()

        response.raise_for_status()
        return response.json()


async def _extract_with_openai_images(
    filename: str, images: list[tuple[bytes, str]], model: str | None = None
) -> ExtractionResult:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY non configurée")

    from normalize_results import get_excluded_client_ices

    prompt = AI_EXTRACTION_PROMPT
    excluded = get_excluded_client_ices()
    if excluded:
        prompt += (
            "\n- NE JAMAIS utiliser l'ICE client "
            + ", ".join(sorted(excluded))
            + " comme ICE fournisseur (c'est l'acheteur, pas le fournisseur)"
        )

    message_content: list[dict] = [{"type": "text", "text": prompt}]
    for image_bytes, image_mime in images:
        message_content.append(
            {
                "type": "image_url",
                "image_url": {"url": _image_to_base64(image_bytes, image_mime)},
            }
        )

    used_model = model or vision_model()
    payload = {
        "model": used_model,
        "messages": [{"role": "user", "content": message_content}],
        "response_format": {"type": "json_object"},
        "temperature": 0,
    }

    body = await _post_chat_completion(api_key, payload)
    content_json = json.loads(body["choices"][0]["message"]["content"])

    lines = [InvoiceLine.model_validate(item) for item in content_json.get("lines", [])]
    result = ExtractionResult(
        filename=filename,
        lines=lines,
        confidence="high",
        engine="ai",
        warnings=content_json.get("warnings", []),
    )

    from normalize_results import apply_vat_reconciliation

    result = apply_vat_reconciliation(result)
    verification = content_json.get("verification")
    if isinstance(verification, list) and verification:
        result.warnings.append(f"Vérification IA : {'; '.join(str(v) for v in verification[:3])}")

    return result


async def _supplement_ttc_ventilation(
    result: ExtractionResult, filename: str, content: bytes, mime_type: str
) -> ExtractionResult:
    from vat_intelligence import apply_vat_reconciliation, extract_vat_lines_from_text

    text = result.raw_text or ""
    if not text.strip() and mime_type == "application/pdf":
        text = await extract_text_from_pdf_async(content)
    if not text.strip() and tesseract_available() and mime_type == "application/pdf":
        try:
            pages = await pdf_to_png_pages_async(content, max_pages=2)
            if pages:
                text = await ocr_pages_async(pages)
        except Exception:  # noqa: BLE001
            pass
    if not text.strip() and mime_type.startswith("image/") and tesseract_available():
        try:
            text = await ocr_image_bytes_async(content)
        except Exception:  # noqa: BLE001
            pass

    if text.strip():
        result.raw_text = text[:4000]

    ventilation = extract_vat_lines_from_text(text)
    if ventilation and result.lines:
        template = result.lines[0]
        result.lines = [
            InvoiceLine(
                fact_num=template.fact_num,
                designation=template.designation,
                m_ht=row["m_ht"],
                tva=row["tva"],
                m_ttc=row["m_ttc"],
                **{
                    "if": template.if_fournisseur,
                    "lib_frss": template.lib_frss,
                    "ice_frs": template.ice_frs,
                    "taux": row["taux"],
                    "id_paie": template.id_paie,
                    "date_paie": template.date_paie,
                    "date_fac": template.date_fac,
                },
            )
            for row in ventilation
        ]
        result.warnings.append(
            f"Ventilation relue depuis le document ({len(result.lines)} ligne(s))."
        )
        return result

    return apply_vat_reconciliation(result)


async def _extract_with_ai_cascade(
    filename: str, images: list[tuple[bytes, str]]
) -> ExtractionResult:
    """Modèle économique par défaut, escalade vers un modèle plus capable si incohérent."""
    from vat_intelligence import result_needs_escalation

    result = await _extract_with_openai_images(filename, images)

    fallback = vision_model_fallback()
    if not result_needs_escalation(result) or fallback == vision_model():
        return result

    try:
        upgraded = await _extract_with_openai_images(filename, images, model=fallback)
    except Exception:  # noqa: BLE001
        return result

    if result_needs_escalation(upgraded) and result.lines:
        return result

    upgraded.warnings.append(f"Scan difficile : relu avec {fallback}.")
    return upgraded


async def _extract_pdf_with_ai(filename: str, content: bytes) -> ExtractionResult:
    pages = await pdf_to_png_pages_async(content, max_pages=3)
    if not pages:
        raise RuntimeError("Impossible de convertir le PDF en image pour l'IA.")
    result = await _extract_with_ai_cascade(filename, [(page, "image/png") for page in pages])
    return await _supplement_ttc_ventilation(result, filename, content, "application/pdf")


async def _extract_with_ocr(filename: str, image_bytes: bytes) -> ExtractionResult:
    text = await ocr_image_bytes_async(image_bytes)
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
        text = await extract_text_from_pdf_async(content)
        if text.strip():
            result = _heuristic_extract(filename, text)
            if ai_available() and _needs_ai_upgrade(result):
                try:
                    return await _extract_pdf_with_ai(filename, content)
                except Exception as exc:  # noqa: BLE001
                    result.warnings.append(f"Extraction IA échouée ({format_openai_error(exc)}) — résultat texte conservé.")
            return result

        if ai_available():
            try:
                return await _extract_pdf_with_ai(filename, content)
            except Exception as exc:  # noqa: BLE001
                return ExtractionResult(
                    filename=filename,
                    lines=[],
                    confidence="low",
                    engine="ai",
                    warnings=[f"Extraction IA échouée: {format_openai_error(exc)}"],
                )

        if not tesseract_available():
            return ExtractionResult(
                filename=filename,
                lines=[],
                confidence="low",
                engine="manual",
                warnings=[
                    "PDF scanné : configurez OPENAI_API_KEY dans backend/.env et redémarrez uvicorn."
                ],
            )

        try:
            png_bytes = await pdf_first_page_to_png_async(content)
            if png_bytes:
                return await _extract_with_ocr(filename, png_bytes)
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
                result = await _extract_with_ai_cascade(filename, [(content, mime_type)])
                return await _supplement_ttc_ventilation(result, filename, content, mime_type)
            except Exception as exc:  # noqa: BLE001
                return ExtractionResult(
                    filename=filename,
                    lines=[],
                    confidence="low",
                    engine="ai",
                    warnings=[f"Extraction IA échouée: {format_openai_error(exc)}"],
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
