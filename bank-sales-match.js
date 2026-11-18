/**
 * Encaissements des ventes depuis le relevé bancaire (phase 5).
 * Fonctions pures : aucune écriture ici (voir workspace-sales.js).
 *
 * Règles :
 *  - automatique seulement si montant exact + nom du client dans le libellé
 *    + une seule facture candidate ;
 *  - sinon suggestions à confirmer : montant exact sans nom, plusieurs
 *    factures du même client (virement groupé), paiement partiel ;
 *  - crédits sans facture listés à part, avec une catégorie ;
 *  - chaque crédit a une référence stable (bank_ref) : un relevé réimporté ou
 *    un rapprochement relancé ne crée jamais de doublon.
 */

const TOL = 0.01;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function normalizeLabel(label) {
  return String(label || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

const compact = (s) => normalizeLabel(s).replace(/ /g, "");

const LEGAL_WORDS = new Set(["SARL", "SA", "SAS", "SNC", "AU", "SARLAU", "STE", "STE.", "SOCIETE", "STE", "ETS", "ETABLISSEMENTS",
  "GROUPE", "HOLDING", "MAROC", "MOROCCO", "LA", "LE", "LES", "DE", "DU", "DES", "ET", "THE", "AND", "CIE", "CO", "INTERNATIONAL"]);

/** Mots significatifs d'un nom de client (formes juridiques et mots vides retirés). */
export function nameTokens(name) {
  return normalizeLabel(name).split(" ").filter((w) => w.length >= 3 && !LEGAL_WORDS.has(w));
}

/** Le nom du client apparaît-il dans le libellé bancaire ? */
export function nameInLabel(name, label) {
  const hay = ` ${normalizeLabel(label)} `;
  const tokens = nameTokens(name);
  if (!tokens.length) return false;
  if (tokens.some((t) => t.length >= 4 && hay.includes(` ${t} `))) return true;
  // Noms écrits autrement : « ACHI-BEST FOOD » ↔ « ACHIBEST » (suites de mots collées)
  const flat = compact(label);
  for (let i = 0; i < tokens.length; i += 1) {
    let key = "";
    for (let j = i; j < tokens.length; j += 1) {
      key += tokens[j];
      if (key.length >= 6 && j > i && flat.includes(key)) return true;
    }
  }
  return false;
}

export const isCredit = (t) => (t.type ? t.type === "credit" : Number(t.amount) > 0) && Math.abs(Number(t.amount)) > 0;

/** Références stables des crédits : date | montant | libellé | rang parmi les identiques. */
export function creditRefs(transactions) {
  const seen = new Map();
  return (transactions || []).filter(isCredit).map((txn) => {
    const amount = Math.abs(Number(txn.absAmount ?? txn.amount));
    const base = `${String(txn.date || "").slice(0, 10)}|${amount.toFixed(2)}|${normalizeLabel(txn.label).slice(0, 80)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { txn, ref: `${base}|${n}`, amount: round2(amount) };
  });
}

export function creditCategory(label) {
  const l = normalizeLabel(label);
  if (/VERSEMENT|DEPOT ESPECES|VERS ESP|ESPECES/.test(l)) return "Dépôt d'espèces";
  if (/\bNAPS\b|\bTPE\b|\bCMI\b|MONETIQUE|CARTE|GLOVO|JUMIA/.test(l)) return "Encaissement carte ou plateforme";
  if (/REMISE.*CHEQUE|CHEQUE|CHQ/.test(l)) return "Remise de chèque sans facture correspondante";
  if (/VIR|VIREMENT/.test(l)) return "Virement reçu sans facture correspondante (vente non facturée ?)";
  return "Autre crédit";
}

export function guessMethod(label) {
  const l = normalizeLabel(label);
  if (/CHEQUE|CHQ/.test(l)) return "cheque";
  if (/EFFET|LCN|TRAITE/.test(l)) return "effet";
  if (/VERSEMENT|ESPECES/.test(l)) return "especes";
  if (/PRELEVEMENT/.test(l)) return "prelevement";
  return "virement";
}

function subsetsMatching(invoices, amount, limit = 12) {
  const list = invoices.slice(0, limit);
  const out = [];
  for (let mask = 1; mask < 1 << list.length; mask += 1) {
    const pick = list.filter((_, i) => mask & (1 << i));
    if (pick.length < 2) continue;
    const sum = round2(pick.reduce((s, x) => s + x.balance, 0));
    if (Math.abs(sum - amount) <= TOL) out.push(pick);
    if (out.length >= 3) break;
  }
  return out;
}

const byDue = (a, b) => String(a.due_date || a.issue_date || "").localeCompare(String(b.due_date || b.issue_date || ""));

/**
 * @param transactions lignes du relevé du dossier
 * @param invoices     ventes (vue sales_invoices) de la société
 * @param payments     paiements existants (avec bank_ref) de la société
 * @returns { auto, suggestions, unmatched, already }
 */
export function matchSalesReceipts({ transactions, invoices, payments }) {
  const usedRefs = new Set((payments || []).filter((p) => p.bank_ref).map((p) => p.bank_ref));
  const open = (invoices || [])
    .filter((s) => (s.kind || "invoice") === "invoice" && s.status === "issued" && Number(s.balance) > TOL)
    .map((s) => ({ ...s, balance: round2(s.balance) }))
    .sort(byDue);
  const result = { auto: [], suggestions: [], unmatched: [], already: [] };

  for (const credit of creditRefs(transactions)) {
    if (usedRefs.has(credit.ref)) {
      result.already.push(credit);
      continue;
    }
    const live = open.filter((s) => s.balance > TOL);
    const named = live.filter((s) => nameInLabel(s.customer_name, credit.txn.label));
    const exact = live.filter((s) => Math.abs(s.balance - credit.amount) <= TOL);
    const exactNamed = exact.filter((s) => named.includes(s));

    if (exactNamed.length === 1) {
      const inv = exactNamed[0];
      result.auto.push({ ...credit, allocations: [{ invoice: inv, amount: credit.amount }] });
      inv.balance = 0;
      continue;
    }

    const proposals = [];
    for (const inv of [...exactNamed, ...exact.filter((s) => !exactNamed.includes(s))]) {
      proposals.push({ kind: "exact", label: "Montant exact", allocations: [{ invoice: inv, amount: credit.amount }] });
    }
    // Virement groupé : plusieurs factures d'un même client (nom dans le libellé)
    const namedByCustomer = new Map();
    for (const s of named) namedByCustomer.set(s.customer_id, [...(namedByCustomer.get(s.customer_id) || []), s]);
    for (const group of namedByCustomer.values()) {
      for (const pick of subsetsMatching(group, credit.amount)) {
        proposals.push({ kind: "group", label: `${pick.length} factures`, allocations: pick.map((inv) => ({ invoice: inv, amount: inv.balance })) });
      }
    }
    // Paiement partiel : la plus ancienne facture du client dont le reste dépasse le crédit
    for (const group of namedByCustomer.values()) {
      const target = group.find((s) => s.balance - credit.amount > TOL);
      if (target) proposals.push({ kind: "partial", label: "Paiement partiel", allocations: [{ invoice: target, amount: credit.amount }] });
    }

    if (proposals.length) result.suggestions.push({ ...credit, proposals: proposals.slice(0, 5) });
    else result.unmatched.push({ ...credit, category: creditCategory(credit.txn.label) });
  }
  return result;
}

/** Lignes invoice_payments à créer pour une allocation confirmée. */
export function paymentRows({ credit, allocations, dossierId }) {
  return allocations.map(({ invoice, amount }) => ({
    invoice_id: invoice.id,
    amount: round2(amount),
    paid_on: String(credit.txn.date || "").slice(0, 10),
    method: guessMethod(credit.txn.label),
    reference: String(credit.txn.label || "").slice(0, 120) || null,
    source: "bank",
    bank_ref: credit.ref,
    bank_label: String(credit.txn.label || "").slice(0, 300) || null,
    bank_dossier_id: dossierId || null,
  }));
}

/** Synthèse de la TVA collectée par taux (lignes de sales_collected_detail). */
export function collectedByRate(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const rate = Number(r.rate);
    const cur = map.get(rate) || { rate, base: 0, vat: 0, ttc: 0 };
    cur.base = round2(cur.base + Number(r.base_ht));
    cur.vat = round2(cur.vat + Number(r.vat));
    cur.ttc = round2(cur.ttc + Number(r.ttc));
    map.set(rate, cur);
  }
  const list = [...map.values()].sort((a, b) => b.rate - a.rate);
  const total = list.reduce((t, x) => ({ base: round2(t.base + x.base), vat: round2(t.vat + x.vat), ttc: round2(t.ttc + x.ttc) }), { base: 0, vat: 0, ttc: 0 });
  return { list, total };
}

/** Export CSV (Excel FR : séparateur « ; », virgule décimale, BOM UTF-8). */
export function collectedCsv(rows) {
  const num = (n) => (Number(n) || 0).toFixed(2).replace(".", ",");
  const esc = (v) => {
    const s = String(v ?? "");
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["N° document", "Type", "Client", "ICE client", "Date facture", "Date encaissement", "Mode", "Taux TVA", "Base HT", "TVA", "TTC"];
  const kinds = { invoice: "Facture", credit_note: "Avoir" };
  const lines = (rows || []).map((r) => [
    r.number, kinds[r.kind] || r.kind, r.customer_name, r.customer_ice, r.issue_date, r.paid_on || "", r.payment_method || "",
    num(r.rate), num(r.base_ht), num(r.vat), num(r.ttc),
  ].map(esc).join(";"));
  return `﻿${[head.join(";"), ...lines].join("\r\n")}\r\n`;
}
