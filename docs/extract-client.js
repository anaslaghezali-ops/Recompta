import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

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

const ICE_PATTERN = /\bI\.?C\.?E\.?\s*[:\s]*(\d{15})\b/i;
const IF_PATTERN = /\b(?:IF|I\.F\.|1F|Identifiant\s+fiscal)\s*[:\s-]*([0-9A-Za-z]+)/i;
const IF_FOOTER_PATTERN = /\bF\s+(\d{6,9})\b/;
const INVOICE_NUM_PATTERN =
  /(?:FACTURE|AVOIR|N[°o]\s*Pi[eè]ce)\s*(?:N[°o\.]?|:)?\s*([A-Za-z0-9][A-Za-z0-9/_.-]{2,})/i;
const SUPPLIER_SKIP = /^(ICE|IF|FACTURE|Date|Désignation|HT|TVA|TTC|TOTAL|Facture de test)/i;
const AMOUNT_LINE = /^\d[\d., ]+$/;

function extOf(filename) {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx).toLowerCase() : "";
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

function parseAmount(raw) {
  let cleaned = raw.replace(/\u00a0/g, "").replace(/ /g, "").trim();
  if (!cleaned || cleaned === "-" || cleaned === "--") return null;
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
  return Number.isFinite(value) ? value : null;
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

async function extractTextFromPdf(content) {
  const pdf = await pdfjsLib.getDocument({ data: content }).promise;
  const chunks = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items.map((item) => item.str).join(" ");
    if (text.trim()) chunks.push(text);
  }
  return chunks.join("\n");
}

async function pdfFirstPageToCanvas(content) {
  const pdf = await pdfjsLib.getDocument({ data: content }).promise;
  if (pdf.numPages === 0) return null;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function ocrCanvas(canvas) {
  const { data } = await Tesseract.recognize(canvas, "fra+eng", {
    logger: () => {},
  });
  return data.text || "";
}

function guessDesignation(text) {
  const lowered = text.toLowerCase();
  if (/(orange|inwi|iam|téléphon|telephon)/.test(lowered)) return "TELEPHONIE";
  if (/(banque|bancaire|relevé|releve|commission)/.test(lowered)) return "FRAIS BANCAIRE";
  if (/(prestation|service|honoraire|glovo|livraison)/.test(lowered)) return "PRESTATIONS";
  return "MATIERES CONSOMMABLES";
}

function extractAmounts(text) {
  const labels = {
    ht: /Total\s+H\.?T\.?\s*(?:Net)?\s*[;:\s]*\n?\s*([-\d .,\u00a0]+)\s*(?:DH)?/i,
    ttc: /Total\s+T\.?T\.?C\.?\s*[:\s]*\n?\s*([-\d .,\u00a0]+)\s*(?:DH)?/i,
    tva: /Total\s+T\.?V\.?A\.?\s*[:\s]*\n?\s*([-\d .,\u00a0]+)\s*(?:DH)?/i,
  };
  const found = {};
  for (const [key, pattern] of Object.entries(labels)) {
    const match = text.match(pattern);
    if (match) {
      const amount = parseAmount(match[1]);
      if (amount !== null) found[key] = amount;
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

function guessTaux(ht, tva) {
  if (ht && tva && ht > 0) {
    const ratio = Math.round((tva / ht) * 100) / 100;
    if (ratio === 0.1 || ratio === 0.2) return ratio;
    if (ratio >= 0.08 && ratio <= 0.12) return 0.1;
    if (ratio >= 0.18 && ratio <= 0.22) return 0.2;
  }
  return 0.2;
}

function extractSupplierName(text) {
  const branded = text.match(/\b(ACHIBEST|EATMEAT|MOSE\s*Food|ORANGE|GLOVO|CARREFOUR)\b/i);
  if (branded) {
    const name = branded[1].toUpperCase().replace(/  /g, " ");
    if (name.includes("MOSE")) return "MOSE Food";
    if (name.includes("EATMEAT")) return "EATMEAT";
    return name === "ACHIBEST" ? "ACHIBEST" : name.charAt(0) + name.slice(1).toLowerCase();
  }
  if (text.toLowerCase().includes("partenaire des tables gourmandes")) return "ACHIBEST";

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

function extractSupplierIce(text) {
  const matches = [...text.matchAll(new RegExp(ICE_PATTERN.source, "gi"))].map((m) => m[1]);
  if (matches.length) return matches[matches.length - 1];
  const plain = [...text.matchAll(/\b(\d{15})\b/g)].map((m) => m[1]);
  return plain.length ? plain[plain.length - 1] : "";
}

function extractSupplierIf(text) {
  const ifMatch = text.match(IF_PATTERN);
  if (ifMatch) return ifMatch[1].trim();
  const footer = text.match(IF_FOOTER_PATTERN);
  if (footer) return footer[1].trim();
  return "";
}

function extractInvoiceNumber(text, filename) {
  const patterns = [
    INVOICE_NUM_PATTERN,
    /(?:Facture|FACTURE)\s*:\s*([A-Za-z0-9][A-Za-z0-9/_.-]{2,})/i,
    /AVOIR\s*:\s*([A-Za-z0-9][A-Za-z0-9/_.-]{2,})/i,
    /FACTURE\s+N[°o\.]?\s*(.+?)(?:\n|$)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  const base = filename.split("/").pop() || filename;
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
  const pattern = /(\d+[,.]\d+)\s*[.\s]+([\d .,\u00a0]+)\s+([\d .,\u00a0]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const taux = parseAmount(match[1]);
    const ht = parseAmount(match[2]);
    const tva = parseAmount(match[3]);
    if (taux === null || ht === null || tva === null || ht <= 0) continue;
    const tauxNorm = taux > 1 ? taux / 100 : taux;
    if (tauxNorm !== 0.1 && tauxNorm !== 0.2) continue;
    items.push({ m_ht: ht, tva, m_ttc: Math.round((ht + tva) * 100) / 100, taux: tauxNorm });
  }
  return items;
}

function extractTvaVentilation(text) {
  const items = [];
  const pattern = /(\d+[,.]\d+)\s*TTC\s+(\d+[,.]\d+)\s*%\s+([\d.,]+)/gi;
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

function extractMadAmounts(text) {
  const amounts = [...text.matchAll(/([\d .,\u00a0]+)\s*MAD/gi)]
    .map((m) => parseAmount(m[1]))
    .filter((a) => a !== null && a > 0);
  if (amounts.length >= 3) {
    amounts.sort((a, b) => a - b);
    let [tva, ht, ttc] = amounts;
    if (ttc < ht) [ht, ttc] = [ttc, ht];
    return { ht, tva, ttc };
  }
  return { ht: null, tva: null, ttc: null };
}

function heuristicExtract(filename, text) {
  const warnings = [];
  if (!text.trim()) warnings.push("Aucun texte extrait du document. Saisie manuelle requise.");

  const ice = extractSupplierIce(text);
  const ifFiscal = extractSupplierIf(text);
  const factNum = extractInvoiceNumber(text, filename);
  const supplier = extractSupplierName(text);

  const dateCandidates = [];
  for (const pattern of [/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/g, /(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/g]) {
    for (const match of text.matchAll(pattern)) {
      const parsed = parseDate(match[0]);
      if (parsed) dateCandidates.push(parsed);
    }
  }
  const invoiceDate = dateCandidates[0] || "";

  const lineItems = extractLineItems(text);
  const achibestLines =
    supplier.toUpperCase().includes("ACHIBEST") || text.toLowerCase().includes("partenaire des tables gourmandes")
      ? extractAchibestTvaTable(text)
      : [];
  const ventilation = extractTvaVentilation(text);

  let source = [];
  if (achibestLines.length) source = achibestLines;
  else if (ventilation.length) source = ventilation;

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
    date_paie: invoiceDate,
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

    const taux = guessTaux(ht, tva);
    if (tva === null && ht !== null) tva = Math.round(ht * taux * 100) / 100;
    if (ttc === null && ht !== null && tva !== null) ttc = Math.round((ht + tva) * 100) / 100;

    lines.push(
      makeLine({
        m_ht: ht || 0,
        tva: tva || 0,
        m_ttc: ttc || 0,
        taux,
      }),
    );
  }

  return {
    filename,
    lines,
    engine: "text",
    warnings,
  };
}

async function extractWithOcr(filename, imageSource) {
  const text = await ocrCanvas(imageSource);
  if (!text.trim()) {
    return {
      filename,
      lines: [],
      engine: "tesseract",
      warnings: ["OCR n'a extrait aucun texte de l'image."],
    };
  }
  const result = heuristicExtract(filename, text);
  result.engine = "tesseract";
  result.warnings.push("Extraction Tesseract (navigateur) — vérifiez les montants.");
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

export async function extractInvoice(filename, content, mimeType) {
  if (mimeType === "application/pdf") {
    const text = await extractTextFromPdf(content);
    if (text.trim()) return heuristicExtract(filename, text);

    try {
      const canvas = await pdfFirstPageToCanvas(content);
      if (canvas) {
        const result = await extractWithOcr(filename, canvas);
        result.warnings.unshift("PDF scanné — OCR dans le navigateur (1–2 min par page).");
        return result;
      }
    } catch (err) {
      return {
        filename,
        lines: [],
        engine: "tesseract",
        warnings: [`OCR échoué: ${err.message}`],
      };
    }

    return {
      filename,
      lines: [],
      engine: "tesseract",
      warnings: ["PDF scanné : impossible d'extraire le texte."],
    };
  }

  if (mimeType.startsWith("image/")) {
    try {
      const canvas = await imageToCanvas(content, mimeType);
      return extractWithOcr(filename, canvas);
    } catch (err) {
      return {
        filename,
        lines: [],
        engine: "tesseract",
        warnings: [`OCR échoué: ${err.message}`],
      };
    }
  }

  return {
    filename,
    lines: [],
    engine: "manual",
    warnings: [`Type de fichier non supporté: ${mimeType}`],
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
        if (name.startsWith("__MACOSX/") || name.includes("/.")) continue;
        if (!isInvoiceFile(name)) continue;
        expanded.push({
          filename: name,
          content: await entry.async("arraybuffer"),
          mime: mimeForFilename(name),
        });
      }
    } else if (isInvoiceFile(file.name)) {
      expanded.push({
        filename: file.name,
        content: await file.arrayBuffer(),
        mime: file.type || mimeForFilename(file.name),
      });
    }
  }

  return expanded;
}

export async function extractAllFiles(files, onProgress) {
  const expanded = await expandUploadedFiles(files);
  const results = [];

  for (let i = 0; i < expanded.length; i += 1) {
    const item = expanded[i];
    if (onProgress) onProgress(i + 1, expanded.length, item.filename);
    const result = await extractInvoice(item.filename, item.content, item.mime);
    results.push(result);
  }

  return results;
}
