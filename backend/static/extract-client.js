import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import { attachFieldConfidence } from "./field-confidence.js";
import { parseSourceFilename } from "./source-id.js";
import { appendBlendedWarnings, tryApplyVentilationFromText } from "./vat-multi-rate.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const ALLOWED_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tiff", ".tif"]);
const EXTENSION_MIME = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

const ZIP_SKIP_NAMES = /^(?:\._.*|\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const MIN_FILE_BYTES = 400;
const MAX_OCR_PAGES = 3;

let excludedClientIces = new Set();

export function setExtractionContext({ clientIce } = {}) {
  excludedClientIces = new Set();
  const normalized = normalizeIceDigits(clientIce || "");
  if (normalized) excludedClientIces.add(normalized);
}

function isExcludedIce(ice) {
  const normalized = normalizeIceDigits(ice || "");
  return Boolean(normalized && excludedClientIces.has(normalized));
}

// « N° », « No », « Numéro » s'intercalent souvent entre le libellé et le numéro.
const ICE_PATTERN = /\bI\.?C\.?E\.?\s*(?:N\s*[°ºo]?\.?|Num[ée]ro)?\s*[:\s]*(\d{15})\b/i;
const IF_PATTERN =
  /\b(?:IF|I\.F\.|1F|Identifiant\s+fiscal)\s*(?:N\s*[°ºo]?\.?|Num[ée]ro)?\s*[:\s-]*([0-9A-Za-z]+)/i;
const IF_FOOTER_PATTERN = /\bF\s+(\d{6,9})\b/;
const INVOICE_NUM_PATTERN =
  /(?:FACTURE|AVOIR|N[°o]\s*Pi[eè]ce)\s*(?:N[°o\.]?|:)?\s*([A-Za-z0-9][A-Za-z0-9/_.-]{2,})/i;
const SUPPLIER_SKIP = /^(ICE|IF|FACTURE|Date|Désignation|HT|TVA|TTC|TOTAL|Facture de test)/i;
const AMOUNT_LINE = /^\d[\d., ]+$/;

let ocrWorkerPromise = null;

function extOf(filename) {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx).toLowerCase() : "";
}

function basename(filename) {
  const parts = filename.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filename;
}

export function mimeForFilename(filename) {
  return EXTENSION_MIME[extOf(filename)] || "application/octet-stream";
}

export function isInvoiceFile(filename) {
  return ALLOWED_EXTENSIONS.has(extOf(filename));
}

export function isZipFile(filename) {
  return extOf(filename) === ".zip";
}

function shouldSkipArchiveEntry(name, byteLength) {
  const base = basename(name);
  if (!base || base.startsWith(".")) return true;
  if (ZIP_SKIP_NAMES.test(base)) return true;
  if (name.startsWith("__MACOSX/") || name.includes("/.")) return true;
  if (byteLength < MIN_FILE_BYTES) return true;
  return !isInvoiceFile(name);
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker("fra+eng", 1, {
      logger: () => {},
    });
  }
  return ocrWorkerPromise;
}

function prepareCanvasForOcr(source) {
  const minWidth = 2400;
  const scale = source.width < minWidth ? minWidth / source.width : 1;
  const width = Math.round(source.width * scale);
  const height = Math.round(source.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const boosted = gray < 140 ? Math.max(0, gray * 0.8) : Math.min(255, gray * 1.08);
    data[i] = data[i + 1] = data[i + 2] = boosted;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function parseAmount(raw) {
  let cleaned = raw.replace(/\u00a0/g, "").replace(/ /g, "").trim();
  if (!cleaned || cleaned === "-" || cleaned === "--") return null;
  cleaned = cleaned.replace(/^\(|\)$/g, "").replace(/^-/, "");
  if (cleaned.includes(",") && cleaned.includes(".")) {
    if (cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")) {
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }
  } else {
    cleaned = cleaned.replace(/,/g, ".");
  }
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.abs(value);
}

function parseDate(raw) {
  const patterns = [
    /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/,
    /(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    const parts = match.slice(1).map(Number);
    let year;
    let month;
    let day;
    if (parts[0] > 1900) {
      [year, month, day] = parts;
    } else {
      [day, month, year] = parts;
    }
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) {
      return formatIsoDate(d);
    }
  }
  return null;
}

function formatIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const SCAN_REQUIRES_AI =
  "Document scanné ou photo — extraction IA obligatoire (Codespace port 8000). " +
  "L'OCR navigateur n'est pas utilisé pour la DED TVA.";

export function isMeaningfulPdfText(text) {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 60) return false;
  return (
    /\d{15}/.test(text) ||
    /total\s+(?:ht|ttc|tva)/i.test(text) ||
    /facture/i.test(text) ||
    /\bICE\b/i.test(text)
  );
}

function pdfBytes(content) {
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content.slice(0));
  }
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  return content;
}

async function openPdf(content) {
  return pdfjsLib.getDocument({ data: pdfBytes(content) }).promise;
}

async function extractTextFromPdfDocument(pdf) {
  const chunks = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items.map((item) => item.str).join(" ");
    if (text.trim()) chunks.push(text);
  }
  return chunks.join("\n");
}

async function pdfPageToCanvas(pdf, pageNumber, scale = 2.5) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function ocrCanvas(canvas) {
  const worker = await getOcrWorker();
  const prepared = prepareCanvasForOcr(canvas);
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: "6",
      preserve_interword_spaces: "1",
    });
  } catch {
    /* ignore unsupported params */
  }
  const { data } = await worker.recognize(prepared);
  return data.text || "";
}

async function ocrPdfFromDocument(pdf, onPage) {
  const pages = Math.min(pdf.numPages, MAX_OCR_PAGES);
  const chunks = [];

  for (let i = 1; i <= pages; i += 1) {
    if (onPage) onPage(i, pages);
    const canvas = await pdfPageToCanvas(pdf, i);
    const text = await ocrCanvas(canvas);
    if (text.trim()) chunks.push(text);
  }

  return chunks.join("\n");
}

function normalizeDesignation(value) {
  const text = String(value || "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, " ");
  if (text === "MATIERES CONSOMMABLES" || text === "PRESTATIONS" || text === "TELEPHONIE" || text === "FRAIS BANCAIRE") {
    return text;
  }
  const compact = text
    .replace(/MATIERE /g, "MATIERES ")
    .replace(/CONSOMABLES/g, "CONSOMMABLES")
    .replace(/CONSOMABLE/g, "CONSOMMABLES");
  if (compact === "MATIERES CONSOMMABLES" || compact === "PRESTATIONS" || compact === "TELEPHONIE" || compact === "FRAIS BANCAIRE") {
    return compact;
  }
  return guessDesignation(text);
}

function guessDesignation(text) {
  const lowered = text.toLowerCase();
  if (/(téléphon|telephon|abonnement mobile|forfait)/.test(lowered)) return "TELEPHONIE";
  if (/(relevé de compte|releve de compte|agios|frais bancaire)/.test(lowered)) return "FRAIS BANCAIRE";
  // « bon de livraison » accompagne une facture de marchandises : ce n'est pas
  // une prestation de service.
  if (/\b(prestations?|honoraires?|frais de service)\b/.test(lowered)) return "PRESTATIONS";
  return "MATIERES CONSOMMABLES";
}

function extractAmounts(text) {
  const patterns = {
    ht: [
      /Total\s+H\.?T\.?\s*(?:Net)?\s*[;:\s]*\n?\s*(-?[\d .,\u00a0]+)\s*(?:DH|MAD)?/i,
      /Montant\s+H\.?T\.?\s*[:\s]+(-?[\d .,\u00a0]+)/i,
      /Base\s+H\.?T\.?\s*[:\s]+(-?[\d .,\u00a0]+)/i,
    ],
    ttc: [
      /Total\s+T\.?T\.?C\.?\s*[:\s]*\n?\s*(-?[\d .,\u00a0]+)\s*(?:DH|MAD)?/i,
      /Net\s+[àa]\s+payer\s*[:\s]+(-?[\d .,\u00a0]+)/i,
      /Montant\s+total\s*[:\s]+(-?[\d .,\u00a0]+)/i,
    ],
    tva: [
      /Total\s+T\.?V\.?A\.?\s*[:\s]*\n?\s*(-?[\d .,\u00a0]+)\s*(?:DH|MAD)?/i,
      /Montant\s+T\.?V\.?A\.?\s*[:\s]+(-?[\d .,\u00a0]+)/i,
    ],
  };

  const found = {};
  for (const [key, list] of Object.entries(patterns)) {
    for (const pattern of list) {
      const match = text.match(pattern);
      if (!match) continue;
      const amount = parseAmount(match[1]);
      if (amount !== null) {
        found[key] = amount;
        break;
      }
    }
  }

  let ht = found.ht ?? null;
  let ttc = found.ttc ?? null;
  let tva = found.tva ?? null;
  if (ht === null && ttc !== null && tva !== null) ht = Math.round((ttc - tva) * 100) / 100;
  if (tva === null && ht !== null && ttc !== null) tva = Math.round((ttc - ht) * 100) / 100;
  if (ttc === null && ht !== null && tva !== null) ttc = Math.round((ht + tva) * 100) / 100;
  return { ht, tva, ttc };
}

function isAchibestDocument(text, filename) {
  const haystack = `${filename}\n${text}`.toLowerCase();
  return haystack.includes("achibest") || haystack.includes("partenaire des tables gourmandes");
}

function isEatMeatDocument(text, filename) {
  return /eatmeat/i.test(`${filename}\n${text}`);
}

function isAvoirDocument(text, filename, factNum = "") {
  return /avoir/i.test(`${filename}\n${text}\n${factNum}`);
}

function applyAvoirSigns(result) {
  const isAvoir =
    isAvoirDocument(result.raw_text || "", result.filename) ||
    (result.lines || []).some((line) => isAvoirDocument("", "", line.fact_num));
  if (!isAvoir) return result;

  for (const line of result.lines || []) {
    if (Number(line.m_ht) > 0) line.m_ht = -Math.abs(Number(line.m_ht));
    if (Number(line.tva) > 0) line.tva = -Math.abs(Number(line.tva));
    if (Number(line.m_ttc) > 0) line.m_ttc = -Math.abs(Number(line.m_ttc));
  }
  return result;
}

function folderKey(filename) {
  const parts = filename.replace(/\\/g, "/").split("/");
  return parts.length > 1 ? parts[0].toLowerCase().trim() : "";
}

const FOLDER_SUPPLIERS = {};

function supplierHintFromPath(filename) {
  const key = folderKey(filename);
  if (!key || [".", "..", "unknown", "factures", "invoices"].includes(key)) return null;
  const label = key
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return label ? { lib_frss: label } : null;
}

function normalizeIceDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 15 ? digits : "";
}

function pickMostCommon(values) {
  const counts = new Map();
  for (const raw of values) {
    const value = String(raw || "").trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  if (!counts.size) return "";
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function pickBestIce(candidates) {
  const counts = new Map();
  for (const raw of candidates) {
    const ice = normalizeIceDigits(raw);
    if (ice.length !== 15 || /^0+$/.test(ice) || isExcludedIce(ice)) continue;
    counts.set(ice, (counts.get(ice) || 0) + 1);
  }
  if (!counts.size) return "";

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]));
  const [bestIce, bestCount] = sorted[0];

  for (const [ice, count] of sorted.slice(1)) {
    if (count < bestCount) break;
    let diff = 0;
    for (let i = 0; i < 15; i += 1) {
      if (ice[i] !== bestIce[i]) diff += 1;
    }
    if (diff <= 2 && count >= bestCount - 1) return bestIce;
  }
  return bestIce;
}

function applySupplierPathHints(filename, line) {
  const hint = supplierHintFromPath(filename);
  if (!hint) return;
  if (hint.lib_frss) line.lib_frss = hint.lib_frss;
  if (hint.ice) line.ice_frs = hint.ice;
  if (hint.if) line.if = hint.if;
}

function isHtFormulaOnTtcAmount(mHt, tva, taux) {
  const ht = Math.abs(Number(mHt));
  const tv = Math.abs(Number(tva));
  const rate = Number(taux);
  if (ht < 0.01 || tv < 0.01 || (rate !== 0.1 && rate !== 0.2)) return false;
  if (Math.abs(tv - Math.round(ht * rate * 100) / 100) > 0.05) return false;
  const impliedHt = ht / (1 + rate);
  return Math.abs(tv - Math.round(impliedHt * rate * 100) / 100) > 0.05;
}

function amountLabeledTtcInText(text, amount) {
  if (!text?.trim() || Math.abs(Number(amount)) < 0.01) return false;
  const value = Math.abs(Number(amount));
  const whole = Math.floor(value);
  const frac = Math.round((value - whole) * 100);
  const variants = [
    `${whole},${String(frac).padStart(2, "0")}`,
    `${whole}.${String(frac).padStart(2, "0")}`,
    String(whole),
  ];
  return variants.some((variant) => new RegExp(`${variant.replace(".", "\\.")}\\s*TTC`, "i").test(text));
}

function convertTtcAmountToHtLine(line, ttcValue) {
  const sign = Number(ttcValue) < 0 ? -1 : 1;
  const ttcAbs = Math.abs(Number(ttcValue));
  const rate = Number(line.taux);
  let tvaAbs = Math.abs(Number(line.tva));
  let htAbs;
  if (isHtFormulaOnTtcAmount(line.m_ht, line.tva, line.taux)) {
    htAbs = Math.round((ttcAbs / (1 + rate)) * 100) / 100;
    tvaAbs = Math.round((ttcAbs - htAbs) * 100) / 100;
  } else if (tvaAbs > 0.01) {
    htAbs = Math.round((ttcAbs - tvaAbs) * 100) / 100;
  } else {
    htAbs = Math.round((ttcAbs / (1 + rate)) * 100) / 100;
    tvaAbs = Math.round((ttcAbs - htAbs) * 100) / 100;
  }
  return {
    ...line,
    m_ht: htAbs * sign,
    tva: tvaAbs * sign,
    m_ttc: Math.round(ttcAbs * 100) / 100 * sign,
  };
}

function isTtcMislabeledAsHt(mHt, tva, taux) {
  const ht = Math.abs(Number(mHt));
  const tv = Math.abs(Number(tva));
  const rate = Number(taux);
  if (ht < 0.01 || tv < 0.01 || (rate !== 0.1 && rate !== 0.2)) return false;
  const ratio = tv / ht;
  const asHtRate = Math.abs(ratio - rate) <= 0.025;
  const asTtcRate = Math.abs(ratio - rate / (1 + rate)) <= 0.025;
  if (!asTtcRate || asHtRate) return false;
  const recomputedHt = ht - tv;
  if (recomputedHt <= 0) return false;
  return Math.abs(tv / recomputedHt - rate) <= 0.025;
}

// Ne corrige que sur preuve : « HT=150, TVA=30 » (correct) et « TTC=150 pris
// pour du HT avec TVA recalculée » donnent exactement les mêmes nombres.
// Seul le document, ou un ratio TVA/HT impossible, permet de trancher.
function fixTtcMislabeledLine(line, text = "", footerHt = null) {
  // Le document étiquette ce montant « Total HT » : ne pas le réinterpréter.
  // Sur une facture à plusieurs taux, le ratio global (17,5 % par exemple)
  // ressemble à tort à un montant TTC.
  if (footerHt != null && Math.abs(Math.abs(Number(line.m_ht)) - footerHt) <= Math.max(0.05, footerHt * 0.01)) {
    return line;
  }
  if (amountLabeledTtcInText(text, line.m_ht)) return convertTtcAmountToHtLine(line, line.m_ht);
  if (isTtcMislabeledAsHt(line.m_ht, line.tva, line.taux)) {
    return convertTtcAmountToHtLine(line, line.m_ht);
  }
  return line;
}

function extractFooterTotals(text) {
  const found = {};
  const patterns = {
    ht: /Total\s+H\.?T\.?\s*(?:Net)?\s*[;:\s]*\n?\s*([-\d .,\u00a0]+)\s*(?:DH)?/i,
    ttc: /Total\s+T\.?T\.?C\.?\s*[:\s]*\n?\s*([-\d .,\u00a0]+)\s*(?:DH)?/i,
    tva: /Total\s+(?:T\.?V\.?A\.?|Taxes)\s*[:\s]*\n?\s*([-\d .,\u00a0]+)\s*(?:DH)?/i,
  };
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = text.match(pattern);
    if (match) {
      const amount = parseAmount(match[1]);
      if (amount !== null) found[key] = Math.abs(amount);
    }
  }
  return found;
}

function alignLinesWithFooterTotals(lines, text) {
  const { ht: footerHt, tva: footerTva, ttc: footerTtc } = extractFooterTotals(text);
  if (footerHt == null || footerTtc == null) return lines;
  return lines.map((line) => {
    if (Math.abs(Math.abs(Number(line.m_ht)) - footerTtc) <= 1 && Math.abs(Math.abs(Number(line.m_ht)) - footerHt) > 1) {
      return convertTtcAmountToHtLine(line, line.m_ht);
    }
    if (
      lines.length === 1 &&
      Math.abs(Math.abs(Number(line.m_ht)) - footerTtc) <= 1 &&
      Math.abs(Math.abs(Number(line.m_ttc)) - footerTtc) <= 1 &&
      Math.abs(Math.abs(Number(line.m_ht)) - footerHt) > 1
    ) {
      const sign = Number(line.m_ht) < 0 ? -1 : 1;
      return {
        ...line,
        m_ht: footerHt * sign,
        tva: (footerTva ?? line.tva) * sign,
        m_ttc: footerTtc * sign,
      };
    }
    return line;
  });
}

function applyTtcVentilationFixes(result) {
  const text = result.raw_text || "";
  const helpers = {
    extractVatLinesFromText,
    isAvoirDocument,
    sanitizeImpossibleAmounts,
    fillMissingTtc,
  };

  const { result: ventilated, applied } = tryApplyVentilationFromText(result, text, helpers);
  if (applied) {
    return appendBlendedWarnings(ventilated);
  }

  const warnings = [...(result.warnings || [])];
  const footerHt = extractFooterTotals(text).ht ?? null;
  const aligned = alignLinesWithFooterTotals(result.lines || [], text);
  const isAvoir =
    isAvoirDocument(text, result.filename) ||
    (result.lines || []).some((line) => isAvoirDocument("", "", line.fact_num));
  const lines = aligned.map((line) =>
    fillMissingTtc(sanitizeImpossibleAmounts(fixTtcMislabeledLine(line, text, footerHt), isAvoir)),
  );
  return appendBlendedWarnings({ ...result, lines, warnings });
}

export function fillMissingTtc(line) {
  const ht = Number(line.m_ht) || 0;
  const tva = Number(line.tva) || 0;
  const ttc = Number(line.m_ttc) || 0;
  if (Math.abs(ttc) >= 0.01 || Math.abs(ht) < 0.01) return line;
  if (signsAreMixed(ht, tva, ttc)) return line;
  if (Math.abs(tva) < 0.01) {
    if (Number(line.taux) === 0) {
      return { ...line, m_ttc: Math.round(ht * 100) / 100, ttc_reconstructed: true };
    }
    return line;
  }
  if (Math.abs(tva) > Math.abs(ht) + 0.05) return line;
  return { ...line, m_ttc: Math.round((ht + tva) * 100) / 100, ttc_reconstructed: true };
}

function signsAreMixed(ht, tva, ttc) {
  const vals = [ht, tva, ttc].filter((v) => Math.abs(v) >= 0.01);
  if (vals.length < 2) return false;
  return new Set(vals.map((v) => (v > 0 ? 1 : -1))).size > 1;
}

function magnitudesCoherent(ht, tva, ttc, taux) {
  const absHt = Math.abs(ht);
  const absTva = Math.abs(tva);
  const absTtc = Math.abs(ttc);
  if (absHt < 0.01 && absTtc < 0.01) return false;
  if (Math.abs(absHt + absTva - absTtc) > 0.05) return false;
  if (absHt > 0.01 && (taux === 0 || taux === 0.1 || taux === 0.2)) {
    if (taux === 0) return absTva <= 0.05 && Math.abs(absHt - absTtc) <= 0.05;
    return Math.abs(absTva / absHt - taux) <= 0.025;
  }
  return true;
}

function isBlendedMultiRate(ht, tva) {
  if (Math.abs(ht) < 0.01 || Math.abs(tva) < 0.01) return false;
  const rate = Math.abs(tva) / Math.abs(ht);
  const in10 = rate >= 0.085 && rate <= 0.115;
  const in20 = rate >= 0.185 && rate <= 0.215;
  return rate >= 0.085 && rate <= 0.215 && !in10 && !in20;
}

function htIsActuallyTheRate(ht, tva, ttc) {
  const absHt = Math.abs(ht);
  const absTva = Math.abs(tva);
  const absTtc = Math.abs(ttc);
  let rate = null;
  if (Math.abs(absHt - 20) <= 0.011 || Math.abs(absHt - 0.2) <= 1e-6) rate = 0.2;
  else if (Math.abs(absHt - 10) <= 0.011 || Math.abs(absHt - 0.1) <= 1e-6) rate = 0.1;
  if (rate == null) return null;
  if (absHt > 0.01 && absTva / absHt <= 0.25) return null;
  if (absTtc < 50 && absTva < 50) return null;
  return rate;
}

function isZeroRateLine(ht, tva, ttc) {
  const absHt = Math.abs(ht);
  const absTva = Math.abs(tva);
  const absTtc = Math.abs(ttc);
  if (absHt < 0.01) return false;
  return absTva <= 0.05 && Math.abs(absHt - absTtc) <= 0.05;
}

function rebuildFromTtc(line, ttcAbs, taux, sign) {
  const htAbs = Math.round((ttcAbs / (1 + taux)) * 100) / 100;
  const tvaAbs = Math.round((ttcAbs - htAbs) * 100) / 100;
  return {
    ...line,
    m_ht: htAbs * sign,
    tva: tvaAbs * sign,
    m_ttc: Math.round(ttcAbs * 100) / 100 * sign,
    taux,
    amounts_sanitized: true,
    tva_calculated: true,
  };
}

function finalizeSanitize(line, before) {
  const after = [line.m_ht, line.tva, line.m_ttc, line.taux];
  if (after.some((v, i) => v !== before[i]) && !line.amounts_sanitized) {
    return { ...line, amounts_sanitized: true };
  }
  return line;
}

export function sanitizeImpossibleAmounts(line, isAvoir = false) {
  const before = [line.m_ht, line.tva, line.m_ttc, line.taux];
  const sign = isAvoir ? -1 : 1;
  const ht = Math.abs(Number(line.m_ht) || 0) * sign;
  const tva = Math.abs(Number(line.tva) || 0) * sign;
  const ttc = Math.abs(Number(line.m_ttc) || 0) * sign;
  const taux = Number(line.taux) === 0 || Number(line.taux) === 0.1 || Number(line.taux) === 0.2
    ? Number(line.taux)
    : 0.2;

  if (isZeroRateLine(ht, tva, ttc)) {
    return finalizeSanitize({ ...line, m_ht: ht, tva, m_ttc: ttc, taux: 0 }, before);
  }

  const rateFromHt = htIsActuallyTheRate(ht, tva, ttc);
  if (rateFromHt != null) {
    let ttcAbs = Math.abs(ttc);
    if (ttcAbs < 50 && Math.abs(tva) > 50) {
      ttcAbs = Math.round((Math.abs(tva) / rateFromHt) * 100) / 100;
    }
    return rebuildFromTtc(line, ttcAbs, rateFromHt, sign);
  }

  const unified = { ...line, m_ht: ht, tva, m_ttc: ttc };
  if (magnitudesCoherent(ht, tva, ttc, taux)) return finalizeSanitize(unified, before);
  if (isBlendedMultiRate(ht, tva) && Math.abs(Math.abs(ht) + Math.abs(tva) - Math.abs(ttc)) <= 0.05) {
    return finalizeSanitize(unified, before);
  }

  const ordered = [Math.abs(ht), Math.abs(tva), Math.abs(ttc)].sort((a, b) => b - a);
  const [largest, mid, small] = ordered;
  if (largest > 0.01 && Math.abs(mid + small - largest) <= 0.05 && mid > 0.01) {
    const ratio = small / mid;
    if (Math.abs(ratio - 0.1) <= 0.025) {
      return finalizeSanitize(
        { ...line, m_ht: mid * sign, tva: small * sign, m_ttc: largest * sign, taux: 0.1 },
        before,
      );
    }
    if (Math.abs(ratio - 0.2) <= 0.025) {
      return finalizeSanitize(
        { ...line, m_ht: mid * sign, tva: small * sign, m_ttc: largest * sign, taux: 0.2 },
        before,
      );
    }
  }

  if (largest > 0.01) return rebuildFromTtc(line, largest, taux, sign);
  return finalizeSanitize(unified, before);
}

function shouldConsolidateGroup(group) {
  if (group.length <= 1) return false;
  const hasZeroTva = group.some((line) => Math.abs(Number(line.tva)) < 1e-9);
  const hasNonZeroTva = group.some((line) => Math.abs(Number(line.tva)) >= 1e-9);
  return hasZeroTva && hasNonZeroTva;
}

function consolidateLines(lines) {
  if (lines.length <= 1) return lines;

  const groups = new Map();
  for (const line of lines) {
    const key = `${line.fact_num || ""}|${Number(line.taux)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }

  const merged = [];
  for (const group of groups.values()) {
    if (group.length === 1 || !shouldConsolidateGroup(group)) {
      merged.push(...group);
      continue;
    }

    const taux = Number(group[0].taux);
    let totalHt = Math.round(group.reduce((sum, line) => sum + Number(line.m_ht || 0), 0) * 100) / 100;
    let totalTva = Math.round(group.reduce((sum, line) => sum + Number(line.tva || 0), 0) * 100) / 100;
    let totalTtc = Math.round(group.reduce((sum, line) => sum + Number(line.m_ttc || 0), 0) * 100) / 100;
    const sign = totalHt < 0 || group.some((line) => Number(line.m_ht) < 0) ? -1 : 1;
    const absHt = Math.abs(totalHt);

    if (absHt > 0) {
      const expectedTva = Math.round(absHt * taux * 100) / 100 * sign;
      if (Math.abs(totalTva) < 1e-9 || group.some((line) => Number(line.tva) === 0)) {
        totalTva = expectedTva;
      }
      if (Math.abs(totalTtc) <= absHt || group.some((line) => Math.abs(Number(line.m_ttc)) <= Math.abs(Number(line.m_ht)))) {
        totalTtc = Math.round((totalHt + totalTva) * 100) / 100;
      }
    }

    merged.push({
      ...group[0],
      m_ht: totalHt,
      tva: totalTva,
      m_ttc: totalTtc,
    });
  }

  return merged;
}

export function normalizeExtractionResults(results) {
  const normalized = results.map((result) => {
    const withAvoir = applyAvoirSigns({ ...result, lines: result.lines || [] });
    const withIf = reconcileSupplierIf(withAvoir);
    const withTtc = applyTtcVentilationFixes(withIf);
    return {
      ...withTtc,
      lines: consolidateLines(withTtc.lines || []).map((line) => {
        const isAvoir =
          isAvoirDocument(withTtc.raw_text || "", withTtc.filename) ||
          isAvoirDocument("", "", line.fact_num);
        return fillMissingTtc(sanitizeImpossibleAmounts(line, isAvoir));
      }),
      warnings: [...new Set(withTtc.warnings || [])],
    };
  });

  const groups = new Map();
  for (const result of normalized) {
    const groupKey =
      folderKey(result.filename) || supplierNameKey(result.lines[0]?.lib_frss) || "unknown";
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { filenames: [], lines: [], ices: [], ifs: [] });
    }
    const group = groups.get(groupKey);
    group.filenames.push(result.filename);
    for (const line of result.lines) {
      group.lines.push(line);
      if (line.ice_frs) group.ices.push(line.ice_frs);
      if (line.if) group.ifs.push(line.if);
    }
  }

  for (const [, group] of groups) {
    const pathHint = supplierHintFromPath(group.filenames[0] || "");
    const bestIce = pickBestIce(group.ices);
    const bestIf = pickMostCommon(group.ifs);
    const bestName = pickMostCommon(group.lines.map((l) => l.lib_frss));

    for (const line of group.lines) {
      line.designation = normalizeDesignation(line.designation);
      // Renseignée uniquement par le rapprochement bancaire.
      line.date_paie = "";
      if (pathHint?.lib_frss) {
        line.lib_frss = pathHint.lib_frss;
        line.supplier_from_folder = true;
      } else if (!line.lib_frss && bestName) {
        line.lib_frss = bestName;
      }
      if (bestIce && (!line.ice_frs || isExcludedIce(line.ice_frs))) {
        line.ice_frs = bestIce;
        line.ice_inferred = true;
      }
      if (bestIf && !line.if) {
        line.if = bestIf;
        line.if_inferred = true;
      }
    }
  }

  // Dernier passage, tous fichiers confondus : une facture sans ICE hérite de
  // celui des autres factures du même fournisseur.
  completeSupplierIdentifiers(normalized.flatMap((result) => result.lines));

  for (const result of normalized) {
    for (const line of result.lines) {
      line.extraction_engine = result.engine || line.extraction_engine || "";
    }
    attachFieldConfidence(result.lines, { documentWarnings: result.warnings || [] });
  }

  return normalized;
}

function guessTaux(ht, tva) {
  if (ht && Math.abs(ht) > 0) {
    if (!tva || Math.abs(tva) < 0.05) return 0;
    const ratio = Math.round((Math.abs(tva) / Math.abs(ht)) * 100) / 100;
    if (ratio === 0.1 || ratio === 0.2) return ratio;
    if (ratio >= 0.08 && ratio <= 0.12) return 0.1;
    if (ratio >= 0.18 && ratio <= 0.22) return 0.2;
  }
  return 0.2;
}

function extractVatLinesFromText(text) {
  const candidates = [extractTvaVentilation(text), extractAchibestTvaTable(text)].filter((c) => c.length);
  if (!candidates.length) return [];
  return candidates.sort((a, b) => b.length - a.length)[0];
}

function extractSupplierName(text, filename = "") {
  const pathHint = supplierHintFromPath(filename);
  if (pathHint?.lib_frss) return pathHint.lib_frss;

  const companyPattern = /\b(SARL|SA|STE|S\.A\.R\.L|S\.A\.R\.L\.A\.U)\b/i;
  for (const line of text.split("\n")) {
    const candidate = line.trim();
    if (!candidate || candidate.length < 3 || SUPPLIER_SKIP.test(candidate)) continue;
    if (candidate.toUpperCase().includes("AICHOUM")) continue;
    if (ICE_PATTERN.test(candidate) || IF_PATTERN.test(candidate)) continue;
    if (companyPattern.test(candidate) || /^[A-Z][A-Za-z0-9 .&'-]{2,}$/.test(candidate)) {
      return candidate;
    }
  }
  return "";
}

function extractSupplierIce(text, filename = "") {
  const candidates = [...text.matchAll(new RegExp(ICE_PATTERN.source, "gi"))].map((m) => m[1]);
  const plain = [...text.matchAll(/\b(\d{15})\b/g)].map((m) => m[1]);
  const all = [...candidates, ...plain]
    .map(normalizeIceDigits)
    .filter((ice) => ice.length === 15 && !isExcludedIce(ice));
  if (!all.length) return "";

  const counts = new Map();
  for (const ice of all) counts.set(ice, (counts.get(ice) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function extractSupplierIf(text) {
  const ifMatch = text.match(IF_PATTERN);
  if (ifMatch) return ifMatch[1].trim();
  const footer = text.match(IF_FOOTER_PATTERN);
  if (footer) return footer[1].trim();
  return "";
}

/** R.C., patente, CNSS, capital : jamais des identifiants fiscaux. */
function otherLegalIds(text) {
  const found = new Set();
  const patterns = [
    /\b(?:R\.?\s?C\.?|Registre\s+de\s+commerce)\s*[:\s.]*(\d{3,10})\b/gi,
    /\bPATENTE\s*[:\s.]*(\d{5,12})/gi,
    /\bCNSS\s*[:\s.]*(\d{5,12})/gi,
    /\bCAPITAL[^\n]*?(\d[\d .,]{4,})/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const digits = match[1].replace(/\D/g, "");
      if (digits) found.add(digits);
    }
  }
  return found;
}

function reconcileSupplierIf(result) {
  const text = result.raw_text || "";
  if (!text.trim()) return result;

  const correct = extractSupplierIf(text);
  if (!correct) return result;

  const wrong = otherLegalIds(text);
  for (const line of result.lines || []) {
    const current = String(line.if || "").replace(/\D/g, "");
    if (current === correct) continue;
    if (!current || wrong.has(current)) line.if = correct;
  }
  return result;
}

function extractInvoiceNumber(text, filename) {
  const patterns = [
    INVOICE_NUM_PATTERN,
    /(?:Facture|FACTURE)\s*:\s*([A-Za-z0-9][A-Za-z0-9/_.-]{2,})/i,
    /AVOIR\s*:\s*([A-Za-z0-9][A-Za-z0-9/_.-]{2,})/i,
    /FACTURE\s+N[°o\.]?\s*(.+?)(?:\n|$)/i,
    /\b([A-Z]{1,3}\d{2,}[-/]\d{3,})\b/,
    /\b(V\d{5,})\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  const base = basename(parseSourceFilename(filename).filename);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(0, dot) : base;
}

function extractLineItems(text) {
  const totalIdx = text.toUpperCase().indexOf("TOTAL HT");
  const section = totalIdx !== -1 ? text.slice(0, totalIdx) : text;
  let lines = section.split("\n").map((l) => l.trim()).filter(Boolean);

  let start = 0;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (line.toUpperCase() === "HT" || line.toUpperCase() === "TVA" || line.toUpperCase() === "TTC" || /désignation/i.test(line)) {
      start = idx + 1;
    }
  }
  lines = lines.slice(start);

  const items = [];
  let i = 0;
  while (i < lines.length) {
    if (
      i + 3 < lines.length &&
      AMOUNT_LINE.test(lines[i + 1]) &&
      AMOUNT_LINE.test(lines[i + 2]) &&
      AMOUNT_LINE.test(lines[i + 3])
    ) {
      const ht = parseAmount(lines[i + 1]);
      const tva = parseAmount(lines[i + 2]);
      const ttc = parseAmount(lines[i + 3]);
      if (ht !== null && tva !== null && ttc !== null) {
        items.push({ label: lines[i], m_ht: ht, tva, m_ttc: ttc });
        i += 4;
        continue;
      }
    }
    i += 1;
  }
  return items;
}

function extractAchibestTvaTable(text) {
  const items = [];
  let block = text;
  const lower = text.toLowerCase();
  for (const marker of ["taux", "montant ht", "ventilation"]) {
    const idx = lower.indexOf(marker);
    if (idx !== -1) {
      block = text.slice(idx);
      break;
    }
  }

  const amount = String.raw`(?:-?[\d]{1,3}(?:[.\s]\d{3})*(?:,\d{2})|-?[\d]+,\d{2})`;
  const rowPattern = new RegExp(String.raw`^\s*(\d{1,2}[,.]\d{2})\s+(${amount})\s+(${amount})\s*$`, "gm");
  let match;
  while ((match = rowPattern.exec(block)) !== null) {
    const taux = parseAmount(match[1]);
    const ht = parseAmount(match[2]);
    const tva = parseAmount(match[3]);
    if (taux === null || ht === null || tva === null) continue;
    if (Math.abs(ht) < 0.01 && Math.abs(tva) < 0.01) continue;
    const tauxNorm = taux > 1 ? taux / 100 : taux;
    if (tauxNorm !== 0 && tauxNorm !== 0.1 && tauxNorm !== 0.2) continue;
    if (Math.abs(ht) > 0) {
      const ratio = Math.round((Math.abs(tva) / Math.abs(ht)) * 100) / 100;
      if (
        ratio !== 0 &&
        ratio !== 0.1 &&
        ratio !== 0.2 &&
        !(ratio >= 0.08 && ratio <= 0.12) &&
        !(ratio >= 0.18 && ratio <= 0.22) &&
        !(Math.abs(tva) < 0.05 && Math.abs(ratio) < 0.02)
      ) {
        continue;
      }
    }
    const sign = ht < 0 || tva < 0 ? -1 : 1;
    const htVal = Math.abs(ht) * sign;
    const tvaVal = Math.abs(tva) * sign;
    items.push({
      m_ht: htVal,
      tva: tvaVal,
      m_ttc: Math.round((htVal + tvaVal) * 100) / 100,
      taux: tauxNorm,
    });
  }
  return items;
}

function extractTvaVentilation(text) {
  const items = [];
  const pattern = /(\d+[,.]\d+)\s*TTC\s+(\d+[,.]\d+)\s*%?\s+([\d.,]+)/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const ttc = parseAmount(match[1]);
    const taux = parseAmount(match[2]);
    const tva = parseAmount(match[3]);
    if (ttc === null || taux === null || tva === null) continue;
    const tauxNorm = taux > 1 ? taux / 100 : taux;
    const ht = Math.round((ttc - tva) * 100) / 100;
    items.push({ m_ht: ht, tva, m_ttc: ttc, taux: tauxNorm });
  }
  return items;
}

function extractAllDecimalAmounts(text) {
  const matches = [
    ...text.matchAll(/([\d .,\u00a0]{2,})\s*(?:MAD|DH|Dhs?)\b/gi),
    ...text.matchAll(/\b(\d{1,3}(?:[ \u00a0.,]\d{3})*[.,]\d{2})\b/g),
  ];
  const amounts = [];
  for (const match of matches) {
    const value = parseAmount(match[1]);
    if (value !== null && value >= 1 && value < 5000000) amounts.push(value);
  }
  return amounts;
}

function findAmountTriplet(amounts) {
  const uniq = [...new Set(amounts)].sort((a, b) => a - b);
  for (const ttc of uniq) {
    for (const tva of uniq) {
      for (const ht of uniq) {
        if (ht <= 0 || tva <= 0 || ttc <= 0) continue;
        if (ht >= ttc) continue;
        if (Math.abs(ht + tva - ttc) <= Math.max(0.05, ttc * 0.01)) {
          return { ht, tva, ttc };
        }
      }
    }
  }
  if (uniq.length >= 3) {
    const slice = uniq.slice(-3);
    const [tva, ht, ttc] = slice;
    if (ttc >= ht) return { ht, tva, ttc };
  }
  return null;
}

function extractMadAmounts(text) {
  const amounts = extractAllDecimalAmounts(text);
  const triplet = findAmountTriplet(amounts);
  if (triplet) return triplet;

  const tail = text.slice(Math.max(0, text.length - 1200));
  const tailTriplet = findAmountTriplet(extractAllDecimalAmounts(tail));
  if (tailTriplet) return tailTriplet;

  return { ht: null, tva: null, ttc: null };
}

function heuristicExtract(filename, text) {
  const warnings = [];
  if (!text.trim()) warnings.push("Aucun texte extrait du document. Saisie manuelle requise.");

  const ice = extractSupplierIce(text, filename);
  const ifFiscal = extractSupplierIf(text);
  const factNum = extractInvoiceNumber(text, filename);
  const supplier = extractSupplierName(text, filename);

  const dateCandidates = [];
  for (const pattern of [/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/g, /(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/g]) {
    for (const match of text.matchAll(pattern)) {
      const parsed = parseDate(match[0]);
      if (parsed) dateCandidates.push(parsed);
    }
  }
  const invoiceDate = dateCandidates[0] || "";

  const lineItems = extractLineItems(text);
  const source = extractVatLinesFromText(text);

  const lines = [];

  const makeLine = (overrides) => ({
    fact_num: factNum,
    designation: guessDesignation(text),
    m_ht: 0,
    tva: 0,
    m_ttc: 0,
    if: ifFiscal,
    lib_frss: supplier,
    ice_frs: ice,
    taux: 0.2,
    id_paie: 4,
    date_paie: "",
    date_fac: invoiceDate,
    ...overrides,
  });

  if (source.length) {
    for (const item of source) {
      lines.push(
        makeLine({
          m_ht: item.m_ht,
          tva: item.tva,
          m_ttc: item.m_ttc,
          taux: item.taux,
        }),
      );
    }
  } else if (lineItems.length) {
    for (const item of lineItems) {
      const ht = item.m_ht;
      const tva = item.tva;
      const ttc = item.m_ttc;
      lines.push(
        makeLine({
          designation: guessDesignation(`${text}\n${item.label}`),
          m_ht: ht,
          tva,
          m_ttc: ttc,
          taux: guessTaux(ht, tva),
        }),
      );
    }
  } else {
    let { ht, tva, ttc } = extractAmounts(text);
    if (ht === null || ttc === null) {
      const mad = extractMadAmounts(text);
      ht = ht ?? mad.ht;
      tva = tva ?? mad.tva;
      ttc = ttc ?? mad.ttc;
    }
    if (ht === null || ttc === null) warnings.push("Montants HT/TTC non détectés automatiquement.");
    if (isAvoirDocument(text, filename)) warnings.push("Document AVOIR détecté — montants en négatif.");

    const taux = guessTaux(ht, tva);
    if (tva === null && ht !== null) tva = Math.round(ht * taux * 100) / 100;
    if (ttc === null && ht !== null && tva !== null) ttc = Math.round((ht + tva) * 100) / 100;

    if (isAvoirDocument(text, filename)) {
      if (ht > 0) ht = -Math.abs(ht);
      if (tva > 0) tva = -Math.abs(tva);
      if (ttc > 0) ttc = -Math.abs(ttc);
    }

    lines.push(
      makeLine({
        m_ht: ht || 0,
        tva: tva || 0,
        m_ttc: ttc || 0,
        taux,
      }),
    );
  }

  for (const line of lines) {
    applySupplierPathHints(filename, line);
  }

  return {
    filename,
    lines,
    engine: "text",
    warnings,
  };
}

async function extractWithOcr(filename, textOrCanvas, options = {}) {
  const text =
    typeof textOrCanvas === "string" ? textOrCanvas : await ocrCanvas(textOrCanvas);

  if (!text.trim()) {
    return {
      filename,
      lines: [],
      engine: "tesseract",
      warnings: ["OCR n'a extrait aucun texte — scan illisible ou fichier corrompu."],
    };
  }

  const result = heuristicExtract(filename, text);
  result.engine = "tesseract";
  if (options.pageInfo) {
    result.warnings.unshift(`OCR ${options.pageInfo} page(s) dans le navigateur.`);
  }
  const hasAmounts = result.lines.some((line) => (line.m_ht || 0) > 0 && (line.m_ttc || 0) > 0);
  if (!hasAmounts) {
    result.warnings.push("Montants HT/TTC non détectés — saisie manuelle probable.");
  } else if (result.warnings.some((w) => w.includes("non détectés"))) {
    result.warnings = result.warnings.filter((w) => !w.includes("non détectés"));
  }
  return result;
}

async function imageToCanvas(content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function extractInvoice(filename, content, mimeType, onOcrPage) {
  const parsed = parseSourceFilename(filename);
  const result = await extractInvoiceFromFile(parsed.filename || filename, content, mimeType, onOcrPage);
  result.filename = parsed.filename || result.filename;
  if (parsed.sourceId) result.source_id = parsed.sourceId;
  return result;
}

async function extractInvoiceFromFile(filename, content, mimeType, onOcrPage) {
  if (mimeType === "application/pdf") {
    let pdf;
    try {
      pdf = await openPdf(content);
    } catch (err) {
      return {
        filename,
        lines: [],
        engine: "scan",
        warnings: [`PDF illisible: ${err.message}`],
      };
    }

    let text = "";
    try {
      text = await extractTextFromPdfDocument(pdf);
    } catch {
      text = "";
    }

    if (isMeaningfulPdfText(text)) {
      const result = heuristicExtract(filename, text);
      result.engine = "text";
      return result;
    }

    // PDF scanné : pas d'OCR Tesseract — l'IA Vision via le serveur est obligatoire.
    return {
      filename,
      lines: [],
      engine: "scan",
      warnings: [SCAN_REQUIRES_AI],
    };
  }

  if (mimeType.startsWith("image/")) {
    return {
      filename,
      lines: [],
      engine: "scan",
      warnings: [SCAN_REQUIRES_AI],
    };
  }

  return {
    filename,
    lines: [],
    engine: "manual",
    warnings: [`Type non supporté (${mimeType}) — utilisez PDF, JPG ou PNG.`],
  };
}

export async function expandUploadedFiles(files) {
  const expanded = [];

  for (const file of files) {
    if (isZipFile(file.name)) {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const entries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.dir) continue;
        const name = entry.name.replace(/\\/g, "/");
        const content = await entry.async("arraybuffer");
        if (shouldSkipArchiveEntry(name, content.byteLength)) continue;
        expanded.push({
          filename: name,
          content,
          mime: mimeForFilename(name),
        });
      }
    } else if (isInvoiceFile(file.name)) {
      const content = await file.arrayBuffer();
      if (shouldSkipArchiveEntry(file.name, content.byteLength)) continue;
      expanded.push({
        filename: file.name,
        content,
        mime: file.type || mimeForFilename(file.name),
      });
    }
  }

  return expanded;
}

/**
 * Développe les ZIP côté navigateur pour que l'envoi au serveur puisse être
 * découpé en lots (un ZIP de 100 factures resterait sinon une seule requête).
 * Le chemin relatif est conservé dans le nom : il sert au regroupement par dossier.
 */
export async function expandUploadedFilesToFiles(files) {
  const expanded = await expandUploadedFiles(files);
  return expanded.map(
    (item) => new File([item.content], item.filename, { type: item.mime }),
  );
}

const LEGAL_FORM_TOKENS = new Set([
  "SARL", "SARLAU", "SA", "SAS", "SASU", "SNC", "SCS", "STE", "SOCIETE", "AU", "EURL",
]);

/**
 * Clé de fournisseur tolérante aux variations de saisie : « EAT MEAT »,
 * « EATMEAT SARL » et « EATMEAT » désignent la même société.
 */
export function supplierNameKey(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.'']/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((token) => token && !LEGAL_FORM_TOKENS.has(token))
    .join("");
}

/**
 * Complète l'ICE et l'IF manquants à partir des autres factures du même
 * fournisseur : une facture mal lue hérite des identifiants déjà confirmés
 * ailleurs. Renvoie le nombre de champs complétés.
 */
export function completeSupplierIdentifiers(lines) {
  const bySupplier = new Map();
  const ifByIce = new Map();

  const push = (map, key, value) => {
    if (!key || !value) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };

  for (const line of lines || []) {
    const key = supplierNameKey(line.lib_frss);
    const ice = normalizeIceDigits(line.ice_frs);
    const fiscal = String(line.if || "").replace(/\D/g, "");

    if (key) {
      if (!bySupplier.has(key)) bySupplier.set(key, { ices: [], ifs: [] });
      if (ice && !isExcludedIce(ice)) bySupplier.get(key).ices.push(ice);
      if (fiscal) bySupplier.get(key).ifs.push(fiscal);
    }
    if (ice && fiscal) push(ifByIce, ice, fiscal);
  }

  let completed = 0;
  for (const line of lines || []) {
    const group = bySupplier.get(supplierNameKey(line.lib_frss));

    if (!normalizeIceDigits(line.ice_frs) && group?.ices.length) {
      line.ice_frs = pickMostCommon(group.ices);
      line.ice_inferred = true;
      completed += 1;
    }

    if (!String(line.if || "").trim()) {
      const ice = normalizeIceDigits(line.ice_frs);
      const candidates = (ice && ifByIce.get(ice)) || group?.ifs || [];
      if (candidates.length) {
        line.if = pickMostCommon(candidates);
        line.if_inferred = true;
        completed += 1;
      }
    }
  }

  return completed;
}

function duplicateSignature(line) {
  const factNum = String(line.fact_num || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!factNum) return "";

  const ice = normalizeIceDigits(line.ice_frs);
  const supplier =
    ice ||
    String(line.lib_frss || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

  const ttc = Math.round((Number(line.m_ttc) || 0) * 100);
  return `${supplier}|${factNum}|${Number(line.taux)}|${ttc}`;
}

/**
 * Repère les lignes déjà présentes : même fournisseur, même numéro de facture,
 * même taux et même montant TTC. Couvre la facture scannée deux fois comme le
 * même fichier importé en double. Renvoie les indices des occurrences
 * surnuméraires — la première est toujours conservée.
 */
export function findDuplicateLineIndexes(lines) {
  const seen = new Map();
  const duplicates = [];

  (lines || []).forEach((line, index) => {
    const signature = duplicateSignature(line);
    if (!signature) return;
    if (seen.has(signature)) duplicates.push(index);
    else seen.set(signature, index);
  });

  return duplicates;
}

export async function extractAllFiles(files, onProgress) {
  const expanded = await expandUploadedFiles(files);
  const results = [];

  if (!expanded.length) {
    return [
      {
        filename: "(import)",
        lines: [],
        engine: "manual",
        warnings: ["Aucun PDF ou image valide trouvé dans la sélection."],
      },
    ];
  }

  for (let i = 0; i < expanded.length; i += 1) {
    const item = expanded[i];
    if (onProgress) onProgress(i + 1, expanded.length, item.filename, null);
    const result = await extractInvoice(item.filename, item.content, item.mime, (page, total) => {
      if (onProgress) {
        onProgress(i + 1, expanded.length, item.filename, `OCR page ${page}/${total}`);
      }
    });
    if (item.source_id && !result.source_id) result.source_id = item.source_id;
    results.push(result);
  }

  return normalizeExtractionResults(results);
}
