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
from pydantic import ValidationError
from pypdf import PdfReader

from models import Designation, ExtractionResult, InvoiceLine, normalize_taux, taux_from_amounts

MOROCCAN_DATE_PATTERNS = [
    r"(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})",
    r"(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})",
]

# « N° », « No », « Numéro » s'intercalent souvent entre le libellé et le numéro.
_LABEL_NUM = r"(?:N\s*[°ºo]?\.?|Num[ée]ro)?"
ICE_PATTERN = re.compile(rf"\bI\.?C\.?E\.?\s*{_LABEL_NUM}\s*[:\s]*(\d{{15}})\b", re.I)
IF_PATTERN = re.compile(
    rf"\b(?:IF|I\.F\.|1F|Identifiant\s+fiscal)\s*{_LABEL_NUM}\s*[:\s-]*([0-9A-Za-z]+)",
    re.I,
)
IF_FOOTER_PATTERN = re.compile(r"\bF\s+(\d{6,9})\b")
# Identifiants légaux marocains à ne jamais confondre avec l'IF.
OTHER_LEGAL_IDS_PATTERNS = (
    re.compile(r"\b(?:R\.?\s?C\.?|Registre\s+de\s+commerce)\s*[:\s.]*(\d{3,10})\b", re.I),
    re.compile(r"\bPATENTE\s*[:\s.]*(\d{5,12})", re.I),
    re.compile(r"\bCNSS\s*[:\s.]*(\d{5,12})", re.I),
    re.compile(r"\bCAPITAL[^\n]*?(\d[\d .,]{4,})", re.I),
)
AMOUNT_PATTERN = re.compile(r"(\d{1,3}(?:[ \u00a0.,]\d{3})*(?:[.,]\d{2})?)")
# N° / Numéro = libellé, pas le début du numéro. « N » seul avalait « NUMERO ».
_DOC_NUM_LABEL = r"(?:N\s*[°ºo]\.?|Num[ée]ro)"
INVOICE_NUM_PATTERN = re.compile(
    rf"(?:FACTURE|AVOIR|N[°o]\s*Pi[eè]ce)\s*(?:{_DOC_NUM_LABEL})?\s*[:\s]*"
    rf"([A-Za-z0-9][A-Za-z0-9/_.-]{{2,}})",
    re.I,
)
NET_A_PAYER_PATTERN = re.compile(
    r"(?:Montant\s+)?Net\s+[àa]\s+payer\s*[:\s]*([-\d .,\u00a0]+)",
    re.I,
)
VAT_PERCENT_PATTERN = re.compile(r"(?<![\d])(0|10|20)\s*%", re.I)
_FACT_NUM_STOPWORDS = {
    "numero",
    "numéro",
    "date",
    "client",
    "facture",
    "avoir",
    "total",
    "designation",
    "désignation",
}
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


def _pdf_pages_via_pymupdf(content: bytes) -> list[str]:
    import pymupdf

    doc = pymupdf.open(stream=content, filetype="pdf")
    try:
        return [page.get_text() or "" for page in doc]
    finally:
        doc.close()


def extract_text_from_pdf_pages(content: bytes) -> list[str]:
    """pypdf échoue sur certaines polices : PyMuPDF prend alors le relais."""
    try:
        reader = PdfReader(BytesIO(content))
        pages = [(page.extract_text() or "") for page in reader.pages]
        if any(page.strip() for page in pages):
            return pages
    except Exception:  # noqa: BLE001
        pass

    try:
        return _pdf_pages_via_pymupdf(content)
    except Exception:  # noqa: BLE001
        return []


def extract_text_from_pdf(content: bytes) -> str:
    return "\n".join(page for page in extract_text_from_pdf_pages(content) if page.strip())


def is_meaningful_pdf_text(text: str, min_chars: int = 60) -> bool:
    """Vrai si le PDF a une vraie couche texte (facture native, pas un scan)."""
    compact = re.sub(r"\s+", "", text or "")
    if len(compact) < min_chars:
        return False
    return bool(
        re.search(r"\d{15}", text)
        or re.search(r"total\s+(?:ht|ttc|tva)", text, re.I)
        or re.search(r"facture", text, re.I)
        or re.search(r"\bICE\b", text, re.I)
    )


def pdf_is_scanned(content: bytes) -> bool:
    return not is_meaningful_pdf_text(extract_text_from_pdf(content))


SCAN_REQUIRES_AI_WARNING = (
    "Document scanné ou photo — extraction IA obligatoire. "
    "Configurez OPENAI_API_KEY dans backend/.env, redémarrez uvicorn, "
    "et vérifiez la connexion depuis GitHub Pages. L'OCR Tesseract n'est pas utilisé."
)


KNOWN_ICE_SUPPLIERS: dict[str, tuple[str, str]] = {}


def pdf_to_png_pages(content: bytes, max_pages: int = 3, dpi: int = 200) -> list[bytes]:
    import pymupdf

    doc = pymupdf.open(stream=content, filetype="pdf")
    pages: list[bytes] = []
    for index in range(min(doc.page_count, max_pages)):
        pix = doc[index].get_pixmap(dpi=dpi)
        pages.append(pix.tobytes("png"))
    return pages


def pdf_page_count(content: bytes) -> int:
    import pymupdf

    doc = pymupdf.open(stream=content, filetype="pdf")
    try:
        return doc.page_count
    finally:
        doc.close()


def ai_max_pages() -> int:
    """Pages envoyées à l'IA. Un scan groupé contient souvent plusieurs factures."""
    try:
        value = int(os.getenv("AI_MAX_PAGES", "10"))
    except ValueError:
        return 10
    return max(1, min(value, 30))


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
    if any(word in lowered for word in ("téléphon", "telephon", "abonnement mobile", "forfait")):
        return Designation.TELEPHONIE
    if any(word in lowered for word in ("relevé de compte", "releve de compte", "agios", "frais bancaire")):
        return Designation.FRAIS_BANCAIRE
    # « bon de livraison » accompagne une facture de marchandises : ce n'est pas
    # une prestation de service.
    if re.search(r"\b(prestations?|honoraires?|frais de service)\b", lowered) or re.search(
        r"(?<!bon de )\bservice de livraison\b", lowered
    ):
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

    if ttc is None:
        net = NET_A_PAYER_PATTERN.search(text)
        if net:
            amount = _parse_amount(net.group(1))
            if amount is not None:
                ttc = amount

    ht, tva, ttc = _complete_zero_vat_amounts(text, ht, tva, ttc)

    if ht is None and ttc is not None and tva is not None:
        ht = round(ttc - tva, 2)
    if tva is None and ht is not None and ttc is not None:
        tva = round(ttc - ht, 2)
    if ttc is None and ht is not None and tva is not None:
        ttc = round(ht + tva, 2)

    ht, tva, ttc = (v if v is None else abs(v) for v in (ht, tva, ttc))
    return ht, tva, ttc


def _vat_percent_mentions(text: str) -> set[int]:
    return {int(match.group(1)) for match in VAT_PERCENT_PATTERN.finditer(text or "")}


def _complete_zero_vat_amounts(
    text: str,
    ht: float | None,
    tva: float | None,
    ttc: float | None,
) -> tuple[float | None, float | None, float | None]:
    """TVA 0 % est un taux légal : HT = TTC, pas une anomalie."""
    if ttc is None or abs(ttc) < 0.01:
        return ht, tva, ttc

    rates = _vat_percent_mentions(text)
    zero_only = rates == {0}
    tva_is_zero = tva is not None and abs(tva) < 0.05
    ht_matches_ttc = ht is not None and abs(abs(ht) - abs(ttc)) <= 0.05

    if zero_only or tva_is_zero or ht_matches_ttc:
        if tva is None:
            tva = 0.0
        if ht is None and abs(tva) < 0.05:
            ht = ttc
    return ht, tva, ttc


def _line_items_match_totals(
    items: list[dict[str, float | str]], totals: tuple[float, float, float]
) -> bool:
    """Le détail par ligne n'est retenu que s'il est cohérent et recoupe les totaux."""
    if not items:
        return False

    total_ht = 0.0
    for item in items:
        ht, tva, ttc = float(item["m_ht"]), float(item["tva"]), float(item["m_ttc"])
        if ht <= 0 or ttc <= 0:
            return False
        if abs(ht + tva - ttc) > max(0.05, ttc * 0.01):
            return False
        total_ht += ht

    return abs(round(total_ht, 2) - totals[0]) <= max(0.05, totals[0] * 0.01)


def _document_totals(text: str) -> tuple[float, float, float] | None:
    """Totaux du pied de page, retenus seulement s'ils sont cohérents entre eux."""
    ht, tva, ttc = _extract_amounts(text)
    if ht is None or ttc is None or ht <= 0 or ttc <= 0:
        return None
    if tva is None:
        tva = round(ttc - ht, 2)
    if abs(ht + tva - ttc) > max(0.05, ttc * 0.01):
        return None
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
    return taux_from_amounts(ht, tva)


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


def other_legal_ids(text: str) -> set[str]:
    """Numéros R.C., patente, CNSS, capital : jamais des identifiants fiscaux."""
    found: set[str] = set()
    for pattern in OTHER_LEGAL_IDS_PATTERNS:
        for match in pattern.finditer(text):
            digits = re.sub(r"\D", "", match.group(1))
            if digits:
                found.add(digits)
    return found


def reconcile_supplier_if(result: ExtractionResult, text: str) -> ExtractionResult:
    """Remplace un IF qui est en fait le R.C. / la patente / le CNSS du fournisseur."""
    if not text.strip():
        return result

    correct_if = _extract_supplier_if(text)
    if not correct_if:
        return result

    wrong_ids = other_legal_ids(text)
    for line in result.lines:
        current = re.sub(r"\D", "", line.if_fournisseur or "")
        if current == correct_if:
            continue
        if not current or current in wrong_ids:
            line.if_fournisseur = correct_if
    return result


def _extract_invoice_number(text: str, filename: str) -> str:
    # Sur un avoir, le numéro de l'avoir prime sur la facture d'origine citée.
    avoir = re.search(r"AVOIR\s*(?:N[°o\.]?|:)?\s*([A-Za-z0-9][A-Za-z0-9/_.-]{2,})", text, re.I)
    if avoir and not _is_reference_mention(text, avoir.start()):
        return avoir.group(1).strip()

    own = document_number_matches(text)
    if own:
        return own[0].group(1).strip()

    for pattern in (
        re.compile(r"(?:Facture|FACTURE)\s*:\s*([A-Za-z0-9][A-Za-z0-9/_.-]{2,})", re.I),
        re.compile(
            rf"(?:FACTURE|AVOIR)\s+{_DOC_NUM_LABEL}\s*[:\s]*(.+?)(?:\n|$)",
            re.I,
        ),
        re.compile(rf"^{_DOC_NUM_LABEL}\s*[:\s]+([A-Za-z0-9][A-Za-z0-9/_.-]+)", re.I | re.M),
        # Codes pièce usuels : FV264554, V081505, FR26-003076, MA-FVR26, FAC0111/2026
        re.compile(r"\b((?:F[VR]|BR|AV|V|FAC)\s?\d{2}[-/]?\d{3,}|[A-Z]{1,3}-?\d{4,})\b"),
    ):
        match = pattern.search(text)
        if (
            match
            and _looks_like_document_number(match.group(1))
            and not _is_reference_mention(text, match.start())
        ):
            number = match.group(1).strip()
            if any(ch.isdigit() for ch in number):
                number = number.replace(" ", "")
            return number
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
        if taux_norm not in (0.0, 0.1, 0.2):
            continue
        if abs(ht) > 0:
            ratio = round(abs(tva) / abs(ht), 2)
            if (
                ratio not in (0.0, 0.1, 0.2)
                and not (0.08 <= ratio <= 0.12 or 0.18 <= ratio <= 0.22)
                and not (abs(tva) < 0.05 and abs(ratio) < 0.02)
            ):
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


HEADER_LOOKBACK_LINES = 6

# Un avoir ou une facture cite souvent le document d'origine (« Transformé de :
# Facture N° ... »). Ces renvois ne doivent jamais ouvrir un nouveau document.
REFERENCE_MENTION = re.compile(
    r"(?:transform[ée]e?\s+de|r[ée]f[ée]rence|r[ée]f\.|suivant|origine|annule\s+et\s+remplace|"
    r"bon\s+de\s+(?:retour|livraison)|relatif?\s+[àa]|selon|voir|concerne|objet)"
    r"[\s:;,–-]*$",
    re.I,
)


def _is_reference_mention(text: str, match_start: int) -> bool:
    window = text[max(0, match_start - 80) : match_start]
    return bool(REFERENCE_MENTION.search(window))


def _looks_like_document_number(value: str) -> bool:
    """Lettres + chiffres sont courants (FAC0111/2026). Un mot isolé sans chiffre n'en est pas un."""
    token = value.strip()
    if len(token) < 3:
        return False
    letters = re.sub(r"[^A-Za-zÀ-ÿ]", "", token).lower()
    if letters in _FACT_NUM_STOPWORDS:
        return False
    if any(ch.isdigit() for ch in token):
        return True
    # Ex. « RELEVE BANCAIRE » : libellé après N°, pas « Vente » dans « Facture Vente N° ».
    return " " in token or "/" in token or "-" in token


def document_number_matches(text: str) -> list[re.Match]:
    """Numéros qui ouvrent réellement un document, hors renvois à un autre."""
    return [
        match
        for match in INVOICE_NUM_PATTERN.finditer(text)
        if _looks_like_document_number(match.group(1))
        and not _is_reference_mention(text, match.start())
    ]


def _segment_start(text: str, match_start: int, floor: int) -> int:
    """Remonte quelques lignes avant le numéro pour inclure l'en-tête fournisseur."""
    start = text.rfind("\n", 0, match_start) + 1
    for _ in range(HEADER_LOOKBACK_LINES):
        previous = text.rfind("\n", 0, max(start - 1, 0)) + 1
        if previous <= floor or previous >= start:
            break
        start = previous
    return max(start, floor)


def split_invoice_segments(text: str) -> list[str]:
    """Découpe un document qui contient plusieurs factures, une par numéro trouvé."""
    positions: list[int] = []
    seen: set[str] = set()
    for match in document_number_matches(text):
        number = match.group(1).strip()
        if len(number) < 3 or number in seen:
            continue
        seen.add(number)
        positions.append(match.start())

    if len(positions) < 2:
        return [text]

    boundaries = [0]
    for index in range(1, len(positions)):
        boundaries.append(_segment_start(text, positions[index], positions[index - 1]))
    boundaries.append(len(text))

    segments = [text[boundaries[i] : boundaries[i + 1]] for i in range(len(positions))]
    return [segment for segment in segments if segment.strip()] or [text]


def group_pages_by_invoice(pages: list[str]) -> list[str]:
    """Une nouvelle facture commence à la page où apparaît un nouveau numéro."""
    segments: list[str] = []
    current: list[str] = []
    current_number: str | None = None

    for page in pages:
        matches = document_number_matches(page)
        number = matches[0].group(1).strip() if matches else None
        if number and number != current_number:
            if current:
                segments.append("\n".join(current))
            current = [page]
            current_number = number
        else:
            current.append(page)

    if current:
        segments.append("\n".join(current))
    return segments


def _heuristic_extract(
    filename: str, text: str, pages: list[str] | None = None
) -> ExtractionResult:
    # Le découpage par page est plus fiable : l'en-tête fournisseur reste avec
    # sa propre facture, et une facture sur deux pages n'est pas coupée.
    if pages and len(pages) > 1:
        segments = group_pages_by_invoice(pages)
    else:
        segments = split_invoice_segments(text)
    if len(segments) < 2:
        return _heuristic_extract_single(filename, text)

    merged = ExtractionResult(
        filename=filename,
        lines=[],
        raw_text=text[:4000],
        confidence="medium",
        engine="text",
    )
    for segment in segments:
        part = _heuristic_extract_single(filename, segment)
        merged.lines.extend(part.lines)
        for warning in part.warnings:
            if warning not in merged.warnings:
                merged.warnings.append(warning)

    merged.warnings.append(f"{len(segments)} factures détectées dans ce document.")
    return merged


def _heuristic_extract_single(filename: str, text: str) -> ExtractionResult:
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

    # Les totaux du pied de page priment sur les lignes produit : sur un scan,
    # l'OCR confond facilement un prix unitaire avec le total HT.
    totals = _document_totals(text)
    if totals and ventilation:
        # Une ventilation valide se recoupe avec les totaux du document.
        sum_ht = round(sum(item["m_ht"] for item in ventilation), 2)
        if abs(sum_ht - totals[0]) > max(0.05, totals[0] * 0.01):
            ventilation = []
    if not ventilation and totals and not _line_items_match_totals(line_items, totals):
        # Sur un scan, l'OCR confond un prix unitaire avec le total HT : on ne
        # garde le détail par ligne que s'il se recoupe avec les totaux.
        line_items = []

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
                        "date_paie": None,
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
                        "date_paie": None,
                        "date_fac": invoice_date,
                    },
                )
            )
    else:
        ht, tva, ttc = totals if totals else _extract_amounts(text)
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
                    "date_paie": None,
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
   - TVA 0 % (exonéré : viande, lait, pain, etc.) : tva=0, m_ht=m_ttc, taux=0

3. **Auto-vérification mathématique** avant de répondre, pour chaque ligne :
   - m_ht + tva ≈ m_ttc (±0,05 MAD)
   - Si taux = 0 : tva = 0 et m_ht ≈ m_ttc
   - Sinon tva / m_ht ≈ taux (±2 %)  OU  tva / m_ttc ≈ taux/(1+taux)
   - Si ça ne colle pas : tu as confondu HT et TTC → recalcule (HT = TTC − TVA)

4. **Plusieurs taux** (0 %, 10 % et 20 %) — règle DED marocaine :
   - **Une entrée JSON par taux distinct**, jamais une ligne unique « résumée ».
   - Lis le tableau « Taux | Montant HT | TVA » ou les lignes « XXX TTC 20% YYY ».
   - **INTERDIT** : une ligne où TVA÷HT est ~17,5 % (mix 10 %+20 %) avec un seul taux.
   - Si 0 % + 20 % sur la même facture → 2 lignes JSON (même fact_num, taux différents).

5. **Plusieurs factures dans un même document** (scan groupé de plusieurs pages) :
   traite-les TOUTES. Une entrée par (facture, taux), avec le fact_num propre à
   chacune. N'en oublie aucune et ne fusionne jamais deux factures différentes.

6. **Renvois à un autre document** : « Transformé de : Facture N° ... »,
   « Référence », « Bon de retour », « Annule et remplace » désignent le
   document d'ORIGINE, jamais une facture supplémentaire. Un avoir reste UN
   seul document, identifié par son propre numéro d'avoir.

## Champs

- ICE fournisseur = 15 chiffres (pied de page légal, PAS l'ICE client en en-tête)
- IF = Identifiant Fiscal, 6 à 9 chiffres, noté « IF », « I.F. » ou « IF: ».
  NE JAMAIS y mettre le R.C. (registre de commerce), la PATENTE, le CNSS,
  le capital social ni l'ICE : ce sont des numéros différents.
  Un scan peut couper le libellé (« ...PATENTE:35891529I. » puis « F 14427958 »
  signifie PATENTE = 35891529 et IF = 14427958).
  Si aucun IF n'est identifiable avec certitude, renvoie une chaîne vide.
- designation : EXACTEMENT une de : "MATIERES CONSOMMABLES", "PRESTATIONS", "TELEPHONIE", "FRAIS BANCAIRE".
  Choisis d'après la NATURE DES ARTICLES facturés, jamais d'après un mot isolé :
  • "MATIERES CONSOMMABLES" = biens livrés : alimentaire (viande, bacon, légumes,
    boissons), emballages, fournitures, produits d'entretien, marchandises.
    C'est le cas par défaut d'une facture de fournisseur avec un tableau d'articles.
  • "PRESTATIONS" = service immatériel : honoraires, conseil, maintenance,
    transport facturé seul, publicité, location.
  • "TELEPHONIE" = abonnement ou communications téléphoniques / internet.
  • "FRAIS BANCAIRE" = commissions, agios, tenue de compte.
  Un « Bon de livraison » cité sur une facture de marchandises ne la transforme
  PAS en prestation : ce sont bien des matières consommables.
- id_paie : 1 (comptant) ou 4 (virement) — défaut 4
- taux : 0 (exonéré, TVA = 0), 0.1 (10 %) ou 0.2 (20 %). Ne jamais renvoyer un autre taux.
- date_fac : date d'émission de la facture
- date_paie : TOUJOURS null. Une facture ne prouve pas son paiement ; cette
  date est renseignée plus tard par rapprochement avec le relevé bancaire.
- AVOIR : montants HT, TVA et TTC négatifs
- Dates : YYYY-MM-DD

## Réponse JSON

Inclus un champ "verification" listant ton contrôle mathématique par ligne (ex. "20%: 1070+214=1284 OK").

{
  "verification": ["10%: 400+40=440 OK", "20%: 600+120=720 OK"],
  "lines": [
    {
      "fact_num": "...",
      "designation": "MATIERES CONSOMMABLES",
      "m_ht": 400.0,
      "tva": 40.0,
      "m_ttc": 440.0,
      "if": "...",
      "lib_frss": "...",
      "ice_frs": "...",
      "taux": 0.1,
      "id_paie": 4,
      "date_paie": null,
      "date_fac": "2026-06-13"
    },
    {
      "fact_num": "...",
      "designation": "MATIERES CONSOMMABLES",
      "m_ht": 600.0,
      "tva": 120.0,
      "m_ttc": 720.0,
      "if": "...",
      "lib_frss": "...",
      "ice_frs": "...",
      "taux": 0.2,
      "id_paie": 4,
      "date_paie": null,
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


def _as_optional_float(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_ai_lines(raw_lines: object) -> tuple[list[InvoiceLine], list[str]]:
    """Une ligne invalide ne doit pas faire échouer tout le document."""
    lines: list[InvoiceLine] = []
    warnings: list[str] = []
    if not isinstance(raw_lines, list):
        return lines, warnings

    for item in raw_lines:
        if not isinstance(item, dict):
            continue
        data = dict(item)
        try:
            data["taux"] = normalize_taux(data.get("taux"))
        except (TypeError, ValueError):
            data["taux"] = _guess_taux(
                _as_optional_float(data.get("m_ht")),
                _as_optional_float(data.get("tva")),
            )
        try:
            lines.append(InvoiceLine.model_validate(data))
        except ValidationError as exc:
            fact = data.get("fact_num") or "?"
            detail = exc.errors()[0].get("msg", str(exc)) if exc.errors() else str(exc)
            warnings.append(f"Ligne {fact} ignorée : {detail}")
    return lines, warnings


async def _extract_with_openai_images(
    filename: str,
    images: list[tuple[bytes, str]],
    model: str | None = None,
    *,
    prompt_suffix: str = "",
) -> ExtractionResult:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY non configurée")

    from normalize_results import get_excluded_client_ices

    prompt = AI_EXTRACTION_PROMPT + (prompt_suffix or "")
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

    lines, line_warnings = _parse_ai_lines(content_json.get("lines", []))
    warnings = list(content_json.get("warnings") or [])
    warnings.extend(line_warnings)
    result = ExtractionResult(
        filename=filename,
        lines=lines,
        confidence="high" if lines else "low",
        engine="ai",
        warnings=warnings,
    )

    from vat_intelligence import result_needs_escalation

    # Ventilation multi-taux : reportée à _supplement_ttc_ventilation (raw_text requis).
    # Ici on ne fait que conserver les lignes renvoyées par l'IA Vision.

    # Le détail du contrôle de l'IA n'a d'intérêt que s'il reste une incohérence.
    verification = content_json.get("verification")
    if isinstance(verification, list) and verification and result_needs_escalation(result):
        result.warnings.append(f"Contrôle IA : {'; '.join(str(v) for v in verification[:3])}")

    return result


async def _supplement_ttc_ventilation(
    result: ExtractionResult, filename: str, content: bytes, mime_type: str
) -> ExtractionResult:
    from vat_intelligence import apply_vat_reconciliation

    text = result.raw_text or ""
    if not text.strip() and mime_type == "application/pdf":
        text = await extract_text_from_pdf_async(content)
    if mime_type == "application/pdf" and tesseract_available():
        try:
            pages = await pdf_to_png_pages_async(content, max_pages=2)
            if pages:
                ocr_text = await ocr_pages_async(pages)
                if ocr_text.strip():
                    combined = f"{text}\n{ocr_text}".strip() if text.strip() else ocr_text
                    from vat_intelligence import ventilation_marker_count

                    if ventilation_marker_count(combined) > ventilation_marker_count(text):
                        text = combined
        except Exception:  # noqa: BLE001
            pass
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
        result.raw_text = text[:8000]

    result = reconcile_supplier_if(result, text)

    from vat_multi_rate import apply_multi_rate_postprocess, try_apply_ventilation_from_text

    result, applied = try_apply_ventilation_from_text(result, text)
    if not applied:
        result = apply_vat_reconciliation(result)
    return apply_multi_rate_postprocess(result)


async def _extract_with_ai_cascade(
    filename: str, images: list[tuple[bytes, str]]
) -> ExtractionResult:
    """Modèle économique par défaut, escalade vers un modèle plus capable si incohérent."""
    from vat_intelligence import result_needs_escalation
    from vat_multi_rate import AI_MULTI_RATE_ESCALATION_SUFFIX, result_has_blended_summary

    result = await _extract_with_openai_images(filename, images)

    fallback = vision_model_fallback()
    if not result_needs_escalation(result) or fallback == vision_model():
        return result

    blended = result_has_blended_summary(result)
    suffix = AI_MULTI_RATE_ESCALATION_SUFFIX if blended else ""

    try:
        upgraded = await _extract_with_openai_images(
            filename,
            images,
            model=fallback,
            prompt_suffix=suffix,
        )
    except Exception:  # noqa: BLE001
        return result

    if result_needs_escalation(upgraded) and result.lines and not blended:
        return result

    if result_needs_escalation(upgraded) and blended and result_has_blended_summary(upgraded):
        return result

    upgraded.warnings.append(f"Scan difficile : relu avec {fallback}.")
    return upgraded


async def _extract_pdf_with_ai(filename: str, content: bytes) -> ExtractionResult:
    limit = ai_max_pages()
    pages = await pdf_to_png_pages_async(content, max_pages=limit)
    if not pages:
        raise RuntimeError("Impossible de convertir le PDF en image pour l'IA.")

    result = await _extract_with_ai_cascade(filename, [(page, "image/png") for page in pages])

    total = await asyncio.to_thread(pdf_page_count, content)
    if total > len(pages):
        result.warnings.append(
            f"Document de {total} pages : seules les {len(pages)} premières ont été "
            f"analysées. Augmentez AI_MAX_PAGES pour tout traiter."
        )

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
        pages = await asyncio.to_thread(extract_text_from_pdf_pages, content)
        text = "\n".join(page for page in pages if page.strip())
        if is_meaningful_pdf_text(text):
            result = _heuristic_extract(filename, text, pages=pages)
            if ai_available() and _needs_ai_upgrade(result):
                try:
                    return await _extract_pdf_with_ai(filename, content)
                except Exception as exc:  # noqa: BLE001
                    result.warnings.append(
                        f"Extraction IA échouée ({format_openai_error(exc)}) — résultat texte conservé."
                    )
            return result

        # PDF scanné : IA Vision uniquement, jamais Tesseract.
        if ai_available():
            try:
                return await _extract_pdf_with_ai(filename, content)
            except Exception as exc:  # noqa: BLE001
                return ExtractionResult(
                    filename=filename,
                    lines=[],
                    confidence="low",
                    engine="scan",
                    warnings=[f"Extraction IA échouée: {format_openai_error(exc)}"],
                )

        return ExtractionResult(
            filename=filename,
            lines=[],
            confidence="low",
            engine="scan",
            warnings=[SCAN_REQUIRES_AI_WARNING],
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
                    engine="scan",
                    warnings=[f"Extraction IA échouée: {format_openai_error(exc)}"],
                )
        return ExtractionResult(
            filename=filename,
            lines=[],
            confidence="low",
            engine="scan",
            warnings=[SCAN_REQUIRES_AI_WARNING],
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
