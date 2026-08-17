import { collectFieldConfidenceIssues } from "./field-confidence.js";

const HEADERS = [
  "OR",
  "FACT_NUM",
  "DESIGNATION",
  "M_HT",
  "TVA",
  "M_TTC",
  "IF",
  "LIB_FRSS",
  "ICE_FRS",
  "TAUX",
  "ID_PAIE",
  "DATE_PAIE",
  "DATE_FAC",
  "CODE TVA",
];

const CODE_TVA_BY_DESIGNATION_TAUX = {
  "MATIERES CONSOMMABLES|0.2": 146,
  "MATIERES CONSOMMABLES|0.1": 150,
  "PRESTATIONS|0.2": 140,
  "TELEPHONIE|0.2": 140,
  "FRAIS BANCAIRE|0.1": 142,
};

const COLUMN_WIDTHS = [5, 14, 22, 11, 10, 11, 10, 20, 18, 7, 8, 12, 12, 10];

const HEADER_STYLE = {
  font: { bold: true, color: { rgb: "FFFFFFFF" }, sz: 11 },
  fill: { patternType: "solid", fgColor: { rgb: "FF0B6BCB" } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: {
    top: { style: "thin", color: { rgb: "FFD9E3EF" } },
    bottom: { style: "thin", color: { rgb: "FFD9E3EF" } },
    left: { style: "thin", color: { rgb: "FFD9E3EF" } },
    right: { style: "thin", color: { rgb: "FFD9E3EF" } },
  },
};

const BODY_BORDER = {
  top: { style: "thin", color: { rgb: "FFE8EEF4" } },
  bottom: { style: "thin", color: { rgb: "FFE8EEF4" } },
  left: { style: "thin", color: { rgb: "FFE8EEF4" } },
  right: { style: "thin", color: { rgb: "FFE8EEF4" } },
};

function inferCodeTva(designation, taux) {
  return CODE_TVA_BY_DESIGNATION_TAUX[`${designation}|${taux}`] ?? null;
}

function normalizeIce(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 15 ? digits : "";
}

/** Série Excel en UTC (évite 46184,9583 à cause du fuseau horaire). */
function excelDateSerial(value) {
  if (!value) return null;
  const m = String(value).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return (utc - Date.UTC(1899, 11, 30)) / 86400000;
}

function resolvedCodeTva(line) {
  if (line.code_tva != null) return line.code_tva;
  return inferCodeTva(line.designation, Number(line.taux));
}

/**
 * Points à relire avant export (confiance par champ). N'empêche jamais le téléchargement.
 */
export function collectExportReview(lines, { clientIce = "", duplicateIndexes = [] } = {}) {
  return collectFieldConfidenceIssues(lines, { clientIce, duplicateIndexes }).map(({ level, text }) => ({
    level,
    text,
  }));
}

function safeFilename(clientName, period) {
  const safeClient = String(clientName || "CLIENT")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safeClient}_DED_TVA_${period}.xlsx`;
}

function styleWorksheet(ws, rowCount) {
  for (let c = 0; c < HEADERS.length; c += 1) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = HEADER_STYLE;
  }

  for (let r = 1; r < rowCount; r += 1) {
    for (let c = 0; c < HEADERS.length; c += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;
      const style = { border: BODY_BORDER };
      if (c === 3 || c === 4 || c === 5) {
        style.numFmt = "#,##0.00";
        style.alignment = { horizontal: "right" };
      } else if (c === 9) {
        style.numFmt = "0%";
        style.alignment = { horizontal: "center" };
      } else if (c === 11 || c === 12) {
        if (typeof cell.v === "number") {
          style.numFmt = "dd/mm/yyyy";
          style.alignment = { horizontal: "center" };
        }
      } else if (c === 0 || c === 10 || c === 13) {
        style.alignment = { horizontal: "center" };
      }
      cell.s = style;
    }
  }

  ws["!cols"] = COLUMN_WIDTHS.map((wch) => ({ wch }));
  ws["!autofilter"] = { ref: `A1:N${rowCount}` };
  ws["!freeze"] = {
    xSplit: 0,
    ySplit: 1,
    topLeftCell: "A2",
    activePane: "bottomLeft",
    state: "frozen",
  };
}

export async function ensureXlsxLoaded() {
  if (globalThis.XLSX) return globalThis.XLSX;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Impossible de charger la librairie Excel."));
    document.head.appendChild(script);
  });
  if (!globalThis.XLSX) throw new Error("Impossible de charger la librairie Excel.");
  return globalThis.XLSX;
}

export async function exportDedTvaExcel({ clientName, period, lines }) {
  if (!/^\d{6}$/.test(period)) {
    throw new Error("La période doit être au format MMAAAA (ex: 062026).");
  }
  await ensureXlsxLoaded();

  const sheetName = `EDI${period.slice(0, 2)}${period.slice(4, 6)}`;
  const rows = [HEADERS];

  for (const line of lines) {
    rows.push([
      line.or ?? null,
      line.fact_num ?? "",
      line.designation ?? "MATIERES CONSOMMABLES",
      Number(line.m_ht) || 0,
      Number(line.tva) || 0,
      Number(line.m_ttc) || 0,
      line.if ?? "",
      line.lib_frss ?? "",
      normalizeIce(line.ice_frs),
      Number.isFinite(Number(line.taux)) ? Number(line.taux) : 0.2,
      Number(line.id_paie) || 4,
      excelDateSerial(line.date_paie),
      excelDateSerial(line.date_fac),
      resolvedCodeTva(line),
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  styleWorksheet(ws, rows.length);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const filename = safeFilename(clientName, period);
  XLSX.writeFile(wb, filename);
  return filename;
}
