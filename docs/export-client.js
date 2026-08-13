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

function inferCodeTva(designation, taux) {
  return CODE_TVA_BY_DESIGNATION_TAUX[`${designation}|${taux}`] ?? null;
}

function normalizeIce(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 15 ? digits : "";
}

function excelDate(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const epoch = Date.UTC(1899, 11, 30);
  return (d.getTime() - epoch) / 86400000;
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

export function exportDedTvaExcel({ clientName, period, lines }) {
  if (!/^\d{6}$/.test(period)) {
    throw new Error("La période doit être au format MMAAAA (ex: 062026).");
  }

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
      excelDate(line.date_paie),
      excelDate(line.date_fac),
      resolvedCodeTva(line),
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);

  for (let r = 1; r < rows.length; r += 1) {
    const datePaie = ws[XLSX.utils.encode_cell({ r, c: 11 })];
    const dateFac = ws[XLSX.utils.encode_cell({ r, c: 12 })];
    if (datePaie && typeof datePaie.v === "number") datePaie.t = "n";
    if (dateFac && typeof dateFac.v === "number") dateFac.t = "n";
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const filename = safeFilename(clientName, period);
  XLSX.writeFile(wb, filename);
  return filename;
}
