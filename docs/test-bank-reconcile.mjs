import { applyBankStatement } from "./bank-statement-client.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const achibestLines = [
  {
    fact_num: "FV-001",
    lib_frss: "Achibest",
    designation: "Produit A",
    m_ttc: 3200.5,
    source_file: "achibest1.pdf",
  },
  {
    fact_num: "FV-002",
    lib_frss: "Achibest",
    designation: "Produit B",
    m_ttc: 4100.25,
    source_file: "achibest2.pdf",
  },
  {
    fact_num: "FV-003",
    lib_frss: "Achibest",
    designation: "Produit C",
    m_ttc: 2763.2,
    source_file: "achibest3.pdf",
  },
  {
    fact_num: "FV-004",
    lib_frss: "Achibest",
    designation: "Produit D",
    m_ttc: 3000,
    source_file: "achibest4.pdf",
  },
  {
    fact_num: "FV-010",
    lib_frss: "Orange",
    designation: "Abonnement",
    m_ttc: 500,
    source_file: "orange.pdf",
  },
];

const totalAchibest = achibestLines.slice(0, 4).reduce((sum, line) => sum + line.m_ttc, 0);
assert(Math.abs(totalAchibest - 13063.95) < 0.01, "fixture total");

const txn = {
  id: "pay-1",
  date: "2025-06-22",
  label:
    "EMISSION D'UN VIREMENT MOBPRO N° 014336 EN FAVEUR DE Achibest , 0117800000752100002 A BMCE CASABLANCA",
  amount: -13063.95,
  absAmount: 13063.95,
  type: "payment",
};

const result = applyBankStatement([txn], achibestLines);
assert(result.stats.paymentsMatched === 1, "one payment matched");
assert(result.stats.paymentsUnmatched === 0, "no unmatched payments");

const achibestUpdated = result.lines.filter((line) => line.lib_frss === "Achibest");
assert(
  achibestUpdated.every((line) => line.date_paie === "2025-06-22"),
  "all Achibest lines dated",
);
assert(
  result.lines.find((line) => line.lib_frss === "Orange")?.date_paie !== "2025-06-22",
  "Orange line untouched",
);
assert(result.matchedPayments[0].invoiceCount === 4, "four invoices matched");
assert(result.matchedPayments[0].lineCount === 4, "four lines matched");

const partialLines = [
  { fact_num: "A1", lib_frss: "Eat Meat SARL", m_ttc: 1000, designation: "x", source_file: "a.pdf" },
  { fact_num: "A2", lib_frss: "EATMEAT", m_ttc: 2000, designation: "y", source_file: "b.pdf" },
  { fact_num: "A3", lib_frss: "Eatmeat", m_ttc: 500, designation: "z", source_file: "c.pdf" },
];

const partialTxn = {
  id: "pay-2",
  date: "2025-07-01",
  label: "VIREMENT EN FAVEUR DE EATMEAT",
  amount: -3000,
  absAmount: 3000,
  type: "payment",
};

const partialResult = applyBankStatement([partialTxn], partialLines);
assert(partialResult.stats.paymentsMatched === 1, "subset payment matched");
const paid = partialResult.lines.filter((line) => line.date_paie === "2025-07-01");
assert(paid.length === 2, "two lines paid (1000 + 2000)");
assert(!partialResult.lines[2].date_paie, "third line still unpaid");

console.log("bank-reconcile tests ok");
