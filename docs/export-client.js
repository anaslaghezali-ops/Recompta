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

function lineLabel(line, index) {
  const fact = String(line.fact_num || "").trim();
  const supplier = String(line.lib_frss || "").trim();
  if (fact && supplier) return `Facture ${fact} (${supplier})`;
  if (fact) return `Facture ${fact}`;
  if (supplier) return `Ligne ${index + 1} (${supplier})`;
  return `Ligne ${index + 1}`;
}

function formatAmount(value) {
  return (Number(value) || 0).toLocaleString("fr-MA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Points à relire avant export. N'empêche jamais le téléchargement :
 * le comptable confirme, puis l'Excel part.
 */
export function collectExportReview(lines, { clientIce = "", duplicateIndexes = [] } = {}) {
  const issues = [];
  const client = String(clientIce || "").replace(/\D/g, "");
  const duplicates = new Set(duplicateIndexes);

  (lines || []).forEach((line, index) => {
    const label = lineLabel(line, index);
    const ht = Number(line.m_ht) || 0;
    const tva = Number(line.tva) || 0;
    const ttc = Number(line.m_ttc) || 0;
    const taux = Number(line.taux);
    const ice = String(line.ice_frs || "").replace(/\D/g, "");

    if (Math.abs(Math.abs(ht) + Math.abs(tva) - Math.abs(ttc)) > 0.05) {
      issues.push({
        level: "warn",
        text: `${label} — HT + TVA ≠ TTC (${formatAmount(ht)} + ${formatAmount(tva)} ≠ ${formatAmount(ttc)})`,
      });
    }

    if (!ice) {
      issues.push({ level: "warn", text: `${label} — ICE fournisseur manquant` });
    } else if (ice.length !== 15) {
      issues.push({ level: "warn", text: `${label} — ICE ${ice} n'a pas 15 chiffres` });
    } else if (client.length === 15 && ice === client) {
      issues.push({ level: "warn", text: `${label} — ICE fournisseur identique à l'ICE client` });
    } else if (line.ice_inferred) {
      issues.push({
        level: "info",
        text: `${label} — ICE repris d'une autre facture du même fournisseur (à confirmer)`,
      });
    }

    if (line.if_inferred && String(line.if || "").trim()) {
      issues.push({
        level: "info",
        text: `${label} — IF repris d'une autre facture du même fournisseur (à confirmer)`,
      });
    }

    if (!String(line.fact_num || "").trim()) {
      issues.push({ level: "warn", text: `${label} — numéro de facture vide` });
    }

    if (taux !== 0.1 && taux !== 0.2) {
      issues.push({
        level: "warn",
        text: `${label} — taux ${Number.isFinite(taux) ? `${taux * 100}%` : "?"} hors 10 / 20 %`,
      });
    }

    if (resolvedCodeTva(line) == null) {
      issues.push({
        level: "warn",
        text: `${label} — CODE TVA non déduit pour ${line.designation || "?"} à ${(taux || 0) * 100}%`,
      });
    }

    if (duplicates.has(index)) {
      issues.push({ level: "warn", text: `${label} — doublon probable` });
    }
  });

  return issues;
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
      Number(line.taux) || 0.2,
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
