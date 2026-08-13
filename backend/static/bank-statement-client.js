/**
 * Import relevé bancaire : extraction des mouvements, rapprochement paiements, frais bancaires.
 */

const FEE_KEYWORDS =
  /commission|frais\s*banc|agios|tenue\s*de\s*compte|cotisation|carte\s*banc|retrait\s*dab|frais\s*de\s*|pakage|package|interet|intérêt/i;

const SKIP_KEYWORDS =
  /virement\s+recu|virement\s+reçu|remise\s+cheque|remise\s+chèque|depot\s+especes|dépôt\s+espèces|solde\s+initial|solde\s+final|total\s+mouvement/i;

const DATE_HEADER = /date|valeur|opération|operation/i;
const LABEL_HEADER = /libell|description|intitul|motif|détail|detail/i;
const DEBIT_HEADER = /débit|debit|montant\s*débit/i;
const CREDIT_HEADER = /crédit|credit|montant\s*crédit/i;
const AMOUNT_HEADER = /^montant$|amount|somme/i;

const AMOUNT_TOLERANCE = 1.0;

const LEGAL_FORM_TOKENS = new Set([
  "SARL", "SARLAU", "SA", "SAS", "SASU", "SNC", "SCS", "STE", "SOCIETE", "AU", "EURL",
]);

function supplierNameKey(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.'']/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((token) => token && !LEGAL_FORM_TOKENS.has(token))
    .join("");
}

function isAvoirLine(line) {
  const text = `${line.fact_num || ""} ${line.designation || ""} ${line.source_file || ""}`;
  return /avoir/i.test(text);
}

/** TTC signé pour le rapprochement : les avoirs sont toujours soustraits. */
function lineTtcAmount(line) {
  const ttc = Number(line.m_ttc);
  if (!Number.isFinite(ttc)) return 0;
  if (isAvoirLine(line) || ttc < 0) return -Math.abs(ttc);
  return ttc;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmount(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  let text = String(value).trim().replace(/\s/g, "");
  if (!text) return null;
  const negative = text.startsWith("-") || text.startsWith("(");
  text = text.replace(/[()]/g, "").replace(/[^\d,.-]/g, "");
  if (text.includes(",") && text.includes(".")) {
    text = text.lastIndexOf(",") > text.lastIndexOf(".") ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (text.includes(",")) {
    text = text.replace(",", ".");
  }
  const num = Number(text);
  if (!Number.isFinite(num)) return null;
  return negative ? -Math.abs(num) : num;
}

function parseDate(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number" && value > 30000 && value < 60000) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + value * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const fr = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (fr) {
    const year = fr[3].length === 2 ? `20${fr[3]}` : fr[3];
    return `${year}-${fr[2].padStart(2, "0")}-${fr[1].padStart(2, "0")}`;
  }
  const d = new Date(text);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return "";
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0] || "";
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semicolons >= commas ? ";" : ",";
}

function sheetToRows(workbook) {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const joined = row.map((c) => normalizeText(c)).join(" ");
    if (DATE_HEADER.test(joined) && (LABEL_HEADER.test(joined) || DEBIT_HEADER.test(joined) || AMOUNT_HEADER.test(joined))) {
      return i;
    }
  }
  return 0;
}

function mapColumns(headerRow) {
  const cols = { date: -1, label: -1, debit: -1, credit: -1, amount: -1 };
  headerRow.forEach((cell, index) => {
    const h = normalizeText(cell);
    if (DATE_HEADER.test(h) && cols.date < 0) cols.date = index;
    else if (LABEL_HEADER.test(h) && cols.label < 0) cols.label = index;
    else if (DEBIT_HEADER.test(h) && cols.debit < 0) cols.debit = index;
    else if (CREDIT_HEADER.test(h) && cols.credit < 0) cols.credit = index;
    else if (AMOUNT_HEADER.test(h) && cols.amount < 0) cols.amount = index;
  });
  if (cols.label < 0) cols.label = headerRow.findIndex((c) => String(c).trim().length > 2);
  return cols;
}

function rowToTransaction(row, cols, index) {
  const label = String(row[cols.label] ?? "").trim();
  const date = parseDate(row[cols.date]);
  let amount = null;

  if (cols.debit >= 0 || cols.credit >= 0) {
    const debit = cols.debit >= 0 ? parseAmount(row[cols.debit]) : null;
    const credit = cols.credit >= 0 ? parseAmount(row[cols.credit]) : null;
    if (debit && Math.abs(debit) > 0) amount = -Math.abs(debit);
    else if (credit && Math.abs(credit) > 0) amount = Math.abs(credit);
  }
  if (amount == null && cols.amount >= 0) {
    amount = parseAmount(row[cols.amount]);
  }

  if (!date || amount == null || Math.abs(amount) < 0.01) return null;

  const normalizedLabel = normalizeText(label);
  if (SKIP_KEYWORDS.test(normalizedLabel)) return null;

  const isFee = FEE_KEYWORDS.test(normalizedLabel);
  const isDebit = amount < 0;

  let type = "other";
  if (isFee && isDebit) type = "fee";
  else if (isDebit) type = "payment";
  else type = "credit";

  return {
    id: `row-${index}`,
    date,
    label,
    amount: Math.abs(amount) * (isDebit ? -1 : 1),
    absAmount: Math.abs(amount),
    type,
  };
}

export function parseBankRows(rows) {
  if (!rows?.length) return { transactions: [], warnings: ["Fichier vide ou illisible."] };

  const headerIndex = findHeaderRow(rows);
  const cols = mapColumns(rows[headerIndex] || []);
  const warnings = [];

  if (cols.date < 0) warnings.push("Colonne date non détectée — vérifiez le format.");
  if (cols.label < 0) warnings.push("Colonne libellé non détectée.");

  const transactions = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row) || row.every((c) => !String(c).trim())) continue;
    const txn = rowToTransaction(row, cols, i);
    if (txn) transactions.push(txn);
  }

  if (!transactions.length) warnings.push("Aucun mouvement bancaire détecté dans le fichier.");

  return { transactions, warnings };
}

export async function parseBankFile(file) {
  const name = file.name || "releve";
  const lower = name.toLowerCase();

  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const text = await file.text();
    const delimiter = detectDelimiter(text);
    const rows = text.split(/\r?\n/).map((line) => line.split(delimiter));
    const result = parseBankRows(rows);
    return { filename: name, ...result };
  }

  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const rows = sheetToRows(workbook);
    const result = parseBankRows(rows);
    return { filename: name, ...result };
  }

  return {
    filename: name,
    transactions: [],
    warnings: ["Format non supporté côté navigateur. Utilisez CSV/Excel ou PDF via le serveur IA."],
  };
}

export function normalizeBankTransactions(rawList) {
  return (rawList || [])
    .map((item, index) => {
      const label = String(item.label || item.libelle || item.description || "").trim();
      const date = parseDate(item.date);
      let amount = parseAmount(item.amount ?? item.montant);
      if (amount == null) return null;

      const normalizedLabel = normalizeText(label);
      if (SKIP_KEYWORDS.test(normalizedLabel)) return null;

      const isDebit = amount < 0;
      const isFee = item.type === "fee" || (FEE_KEYWORDS.test(normalizedLabel) && isDebit);
      let type = item.type || "other";
      if (isFee) type = "fee";
      else if (isDebit) type = "payment";
      else type = "credit";

      return {
        id: item.id || `srv-${index}`,
        date,
        label,
        amount,
        absAmount: Math.abs(amount),
        type,
      };
    })
    .filter(Boolean);
}

function invoiceGroupKey(line) {
  return [line.fact_num || "", line.lib_frss || "", line.source_file || ""].join("|");
}

function buildInvoiceGroups(lines) {
  const groups = new Map();
  lines.forEach((line, index) => {
    if (line.designation === "FRAIS BANCAIRE") return;
    const key = invoiceGroupKey(line);
    if (!groups.has(key)) {
      groups.set(key, { key, indices: [], totalTtc: 0, lib_frss: line.lib_frss || "", fact_num: line.fact_num || "" });
    }
    const group = groups.get(key);
    group.indices.push(index);
    group.totalTtc = roundMoney(group.totalTtc + lineTtcAmount(line));
  });
  return [...groups.values()];
}

function labelScore(label, libFrss, factNum) {
  const hay = normalizeText(label);
  let score = 0;
  const supplier = normalizeText(libFrss);
  if (supplier) {
    supplier.split(/\s+/).filter((w) => w.length > 3).forEach((word) => {
      if (hay.includes(word)) score += 2;
    });
  }
  if (factNum && hay.includes(normalizeText(factNum))) score += 3;
  return score;
}

function amountsMatch(a, b) {
  return Math.abs(roundMoney(a) - roundMoney(b)) <= AMOUNT_TOLERANCE;
}

/** Sous-ensemble de groupes facture dont la somme TTC correspond au montant. */
function findInvoiceSubset(groups, targetAmount) {
  if (!groups.length) return null;

  const total = groups.reduce((sum, group) => sum + group.totalTtc, 0);
  if (amountsMatch(total, targetAmount)) return groups;

  if (groups.length > 24) return null;

  const count = groups.length;
  for (let mask = 1; mask < 1 << count; mask += 1) {
    const subset = [];
    let sum = 0;
    for (let i = 0; i < count; i += 1) {
      if (mask & (1 << i)) {
        subset.push(groups[i]);
        sum += groups[i].totalTtc;
      }
    }
    if (amountsMatch(sum, targetAmount)) return subset;
  }
  return null;
}

function supplierKeysFromLabel(label, groups, lines, usedLineIndices) {
  const keys = new Set();
  groups.forEach((group) => {
    if (labelScore(label, group.lib_frss, group.fact_num) > 0) {
      const key = supplierNameKey(group.lib_frss);
      if (key) keys.add(key);
    }
  });
  lines.forEach((line, index) => {
    if (usedLineIndices.has(index)) return;
    if (line.designation === "FRAIS BANCAIRE") return;
    if (labelScore(label, line.lib_frss, line.fact_num) > 0) {
      const key = supplierNameKey(line.lib_frss);
      if (key) keys.add(key);
    }
  });
  return keys;
}

function feeLineFromTransaction(txn, sourceFile, bankName = "BANQUE", bankIce = "", bankIf = "") {
  const ttc = txn.absAmount;
  const ht = Math.round((ttc / 1.1) * 100) / 100;
  const tva = Math.round((ttc - ht) * 100) / 100;
  const ice = String(bankIce || "").replace(/\D/g, "");
  return {
    source_file: sourceFile,
    fact_num: `FRAIS-${txn.date}`,
    designation: "FRAIS BANCAIRE",
    m_ht: ht,
    tva,
    m_ttc: ttc,
    if: bankIf || "",
    lib_frss: bankName,
    ice_frs: ice.length === 15 ? ice : "",
    taux: 0.1,
    id_paie: 4,
    date_paie: txn.date,
    date_fac: txn.date,
    _from_bank: true,
  };
}

function existingFeeKey(line) {
  return `${line.date_paie}|${Number(line.m_ttc).toFixed(2)}|${line.lib_frss}`;
}

/**
 * Applique le relevé : dates de paiement + lignes frais bancaires.
 * Retourne une copie des lignes modifiées (ne mute pas l'original).
 */
export function applyBankStatement(
  transactions,
  lines,
  { sourceFile = "releve_bancaire", bankName = "BANQUE", bankIce = "", bankIf = "" } = {},
) {
  const updated = lines.map((line) => ({ ...line }));
  const matchedPayments = [];
  const unmatchedPayments = [];
  const feeTransactions = [];
  const skipped = [];

  const usedGroupKeys = new Set();
  const usedLineIndices = new Set();
  const existingFees = new Set(
    updated.filter((l) => l.designation === "FRAIS BANCAIRE").map(existingFeeKey),
  );

  const groups = buildInvoiceGroups(updated);
  const paymentTxns = transactions.filter((t) => t.type === "payment");

  for (const txn of paymentTxns) {
    const debitAmount = txn.absAmount;

    const groupCandidates = groups
      .filter((g) => !usedGroupKeys.has(g.key) && g.totalTtc > 0 && amountsMatch(g.totalTtc, debitAmount))
      .map((g) => ({ ...g, score: labelScore(txn.label, g.lib_frss, g.fact_num) }))
      .sort((a, b) => b.score - a.score);

    if (groupCandidates.length > 0 && (groupCandidates[0].score > 0 || groupCandidates.length === 1)) {
      const group = groupCandidates[0];
      group.indices.forEach((idx) => {
        updated[idx].date_paie = txn.date;
        updated[idx].id_paie = 4;
        updated[idx].date_paie_from_bank = true;
        usedLineIndices.add(idx);
      });
      usedGroupKeys.add(group.key);
      matchedPayments.push({ txn, groupKey: group.key, lineCount: group.indices.length });
      continue;
    }

    const lineCandidates = updated
      .map((line, index) => ({ line, index }))
      .filter(({ line, index }) => {
        if (line.designation === "FRAIS BANCAIRE") return false;
        if (usedLineIndices.has(index)) return false;
        const ttc = lineTtcAmount(line);
        return ttc > 0 && amountsMatch(ttc, debitAmount);
      })
      .map(({ line, index }) => ({
        index,
        line,
        score: labelScore(txn.label, line.lib_frss, line.fact_num),
      }))
      .sort((a, b) => b.score - a.score);

    if (lineCandidates.length > 0 && (lineCandidates[0].score > 0 || lineCandidates.length === 1)) {
      const { index, line } = lineCandidates[0];
      updated[index].date_paie = txn.date;
      updated[index].id_paie = 4;
      updated[index].date_paie_from_bank = true;
      usedLineIndices.add(index);
      matchedPayments.push({ txn, factNum: line.fact_num, lineCount: 1 });
      continue;
    }

    const supplierKeys = supplierKeysFromLabel(txn.label, groups, updated, usedLineIndices);
    let supplierMatch = null;
    let supplierMatchScore = 0;

    for (const supplierKey of supplierKeys) {
      const supplierGroups = groups.filter(
        (group) => !usedGroupKeys.has(group.key) && supplierNameKey(group.lib_frss) === supplierKey,
      );
      const subset = findInvoiceSubset(supplierGroups, debitAmount);
      if (!subset) continue;

      const score = Math.max(
        ...subset.map((group) => labelScore(txn.label, group.lib_frss, group.fact_num)),
      );
      if (!supplierMatch || score > supplierMatchScore || subset.length > supplierMatch.length) {
        supplierMatch = subset;
        supplierMatchScore = score;
      }
    }

    if (supplierMatch?.length) {
      let lineCount = 0;
      supplierMatch.forEach((group) => {
        group.indices.forEach((idx) => {
          updated[idx].date_paie = txn.date;
          updated[idx].id_paie = 4;
          updated[idx].date_paie_from_bank = true;
          usedLineIndices.add(idx);
          lineCount += 1;
        });
        usedGroupKeys.add(group.key);
      });
      matchedPayments.push({
        txn,
        supplierKey: supplierNameKey(supplierMatch[0].lib_frss),
        invoiceCount: supplierMatch.length,
        lineCount,
      });
      continue;
    }

    unmatchedPayments.push(txn);
  }

  const newFeeLines = [];
  for (const txn of transactions) {
    if (txn.type !== "fee") {
      if (txn.type === "credit" || txn.type === "other") skipped.push(txn);
      continue;
    }
    feeTransactions.push(txn);
    const feeLine = feeLineFromTransaction(txn, sourceFile, bankName, bankIce, bankIf);
    const key = existingFeeKey(feeLine);
    if (existingFees.has(key)) continue;
    existingFees.add(key);
    newFeeLines.push(feeLine);
  }

  return {
    lines: [...updated, ...newFeeLines],
    stats: {
      paymentsMatched: matchedPayments.length,
      paymentsUnmatched: unmatchedPayments.length,
      feesAdded: newFeeLines.length,
      feesSkipped: feeTransactions.length - newFeeLines.length,
    },
    matchedPayments,
    unmatchedPayments,
    feeTransactions,
    skipped,
  };
}
