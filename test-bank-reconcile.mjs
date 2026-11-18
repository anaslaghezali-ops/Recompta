import {
  applyBankStatement,
  applyPartialPaymentToLineIndices,
  applyPaymentToLineIndices,
  extractBankBeneficiaryToken,
  findSupplierAmountCandidates,
} from "./bank-statement-client.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(extractBankBeneficiaryToken("EMISSION VIREMENT EN FAVEUR DE MPro , BMCE") === "MPRO", "beneficiary token");

const modeFoodLines = [
  { fact_num: "F1", lib_frss: "Mode Food", m_ttc: 1284, designation: "A", source_file: "a.pdf" },
  { fact_num: "F2", lib_frss: "Mode Food", m_ttc: 450, designation: "B", source_file: "b.pdf" },
  { fact_num: "F3", lib_frss: "Mode Food", m_ttc: 1740, designation: "C", source_file: "c.pdf" },
];

const mproTxn = {
  id: "mpro-1",
  date: "2025-06-15",
  label: "EMISSION D'UN VIREMENT EN FAVEUR DE MPro , BMCE CASABLANCA",
  amount: -3474,
  absAmount: 3474,
  type: "payment",
};

const pendingResult = applyBankStatement([mproTxn], modeFoodLines);
assert(pendingResult.stats.paymentsMatched === 0, "MPro without alias not auto-matched");
assert(pendingResult.pendingMatches.length === 1, "one pending match for MPro");
assert(pendingResult.pendingMatches[0].proposals.length === 1, "one Mode Food proposal");
assert(pendingResult.pendingMatches[0].proposals[0].invoiceCount === 3, "three invoices proposed");
assert(pendingResult.pendingMatches[0].bankToken === "MPRO", "bank token for learning");

const aliasResult = applyBankStatement([mproTxn], modeFoodLines, {
  supplierAliases: { MPRO: "MODEFOOD" },
});
assert(aliasResult.stats.paymentsMatched === 1, "MPro auto-matched with learned alias");
assert(aliasResult.pendingMatches.length === 0, "no pending with alias");

const ambiguousLines = [
  { fact_num: "A1", lib_frss: "Mode Food", m_ttc: 3474, designation: "x", source_file: "a.pdf" },
  { fact_num: "B1", lib_frss: "Eat Meat", m_ttc: 3474, designation: "y", source_file: "b.pdf" },
];
const ambiguousTxn = { ...mproTxn, id: "amb-1", absAmount: 3474, amount: -3474 };
const ambiguousResult = applyBankStatement([ambiguousTxn], ambiguousLines);
assert(ambiguousResult.pendingMatches[0].proposals.length === 2, "two proposals when ambiguous");

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

const achibestWithAvoirLines = [
  {
    fact_num: "FV-001",
    lib_frss: "Achibest",
    designation: "Produit A",
    m_ttc: 5200.5,
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
    fact_num: "AVOIR-003",
    lib_frss: "Achibest",
    designation: "Avoir retour",
    m_ttc: 936.05,
    source_file: "achibest-avoir.pdf",
  },
  {
    fact_num: "FV-004",
    lib_frss: "Achibest",
    designation: "Produit D",
    m_ttc: 4699.25,
    source_file: "achibest4.pdf",
  },
];

const avoirTotal = achibestWithAvoirLines.reduce(
  (sum, line) => sum + (line.fact_num.startsWith("AVOIR") ? -line.m_ttc : line.m_ttc),
  0,
);
assert(Math.abs(avoirTotal - 13063.95) < 0.01, "avoir fixture total");

const avoirResult = applyBankStatement([txn], achibestWithAvoirLines);
assert(avoirResult.stats.paymentsMatched === 1, "avoir payment matched");
assert(
  avoirResult.lines.every((line) => line.lib_frss !== "Achibest" || line.date_paie === "2025-06-22"),
  "all Achibest lines including avoir dated",
);

// --- Paiements partiels (Achibest : 72 804,48 TTC réglés par 2 virements de 20 000) ---
{
  const lines = [
    { fact_num: "FV26-039149", lib_frss: "Achibest", m_ht: 60670.4, tva: 12134.08, m_ttc: 72804.48, taux: 0.2, date_fac: "2026-09-03", source_file: "a.pdf" },
    { fact_num: "FV26-039745", lib_frss: "Achibest", m_ht: 405.82, tva: 81.16, m_ttc: 486.98, taux: 0.2, date_fac: "2026-09-07", source_file: "b.pdf" },
  ];
  const t1 = { id: "t1", date: "2026-09-04", label: "EMISSION D'UN VIREMENT MOBPRO EN FAVEUR DE Achibest , BMCE", amount: -20000, absAmount: 20000, type: "payment" };
  const t2 = { id: "t2", date: "2026-09-28", label: "PAIEMENT CHEQUE ACHIBEST", amount: -20000, absAmount: 20000, type: "payment" };
  const r = applyBankStatement([t1, t2], lines);
  assert(r.stats.paymentsMatched === 0, "partial not auto-applied");
  assert(r.pendingMatches.length === 2, "two partial proposals pending");
  const p1 = r.pendingMatches[0].proposals.find((p) => p.kind === "partial");
  assert(p1 && p1.indices.length === 1 && p1.indices[0] === 0, "partial targets FV26-039149 only (FV26-039745 dated after the transfer)");
  let after = applyPartialPaymentToLineIndices(r.lines, p1.indices, t1, 20000);
  assert(after.length === 3, "paid part appended");
  assert(after[2].m_ttc === 20000 && after[2].date_paie === "2026-09-04", "paid part amounts");
  assert(Math.abs(after[2].tva - 3333.33) < 0.01, "VAT prorata 3333.33");
  assert(Math.abs(after[0].m_ttc - 52804.48) < 0.01 && !after[0].date_paie, "rest kept unpaid");
  after = applyPartialPaymentToLineIndices(after, [0], t2, 20000);
  assert(Math.abs(after[0].m_ttc - 32804.48) < 0.01, "rest after 2nd payment");
  const totalTva = after.filter((l) => l.fact_num === "FV26-039149").reduce((s, l) => s + l.tva, 0);
  assert(Math.abs(totalTva - 12134.08) < 0.01, "VAT preserved across split");
  assert(after[0].partial_payment.invoice_ttc === 72804.48, "original invoice amount kept");
  // le solde exact est rapproché automatiquement au relevé suivant
  const t3 = { id: "t3", date: "2026-10-10", label: "VIREMENT EN FAVEUR DE Achibest", amount: -32804.48, absAmount: 32804.48, type: "payment" };
  const r3 = applyBankStatement([t3], after);
  assert(r3.stats.paymentsMatched === 1 && r3.lines[0].date_paie === "2026-10-10", "balance auto-matched");
}

// --- Virement couvrant plusieurs factures dont une absente du dossier (Mose Food 6 332 = 3 872 + 2 460) ---
{
  const lines = [
    { fact_num: "L002103", lib_frss: "MOSE Food", m_ttc: 3872, tva: 645.33, m_ht: 3226.67, date_fac: "2026-09-03", source_file: "m1.pdf" },
    { fact_num: "V085900", lib_frss: "MOSE Food", m_ttc: 3286, tva: 547.67, m_ht: 2738.33, date_fac: "2026-09-18", source_file: "m2.pdf" },
  ];
  const t = { id: "m", date: "2026-09-07", label: "EMISSION D'UN VIREMENT EN FAVEUR DE Mpro", amount: -6332, absAmount: 6332, type: "payment" };
  const none = applyBankStatement([t], lines);
  assert(none.pendingMatches.length === 0, "unknown beneficiary: no guess");
  const r = applyBankStatement([t], lines, { supplierAliases: { MPRO: "MOSEFOOD" } });
  const s = r.pendingMatches[0]?.proposals.find((p) => p.kind === "surplus");
  assert(s && s.indices.length === 1 && s.indices[0] === 0, "surplus proposes L002103 only (V085900 dated after)");
  assert(Math.abs(s.unexplained - 2460) < 0.01, "2460 unexplained");
}

console.log("bank-reconcile tests ok");
