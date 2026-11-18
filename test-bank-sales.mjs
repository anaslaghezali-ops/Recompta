// Encaissements des ventes depuis le relevé (phase 5) : virement exact, groupé,
// partiel, réimport sans doublon, crédit sans facture.
//
//   node test-bank-sales.mjs
import assert from "node:assert/strict";
import {
  collectedByRate,
  collectedCsv,
  creditRefs,
  matchSalesReceipts,
  nameInLabel,
  paymentRows,
} from "./bank-sales-match.js";

const inv = (id, customer, cid, balance, due) => ({
  id, kind: "invoice", status: "issued", customer_name: customer, customer_id: cid, balance, total_ttc: balance, due_date: due,
});
const invoices = [
  inv(1, "Hôtel Kenzi Tower SARL", 31, 22200, "2026-10-01"),
  inv(2, "Marjane Holding", 33, 12000, "2026-09-20"),
  inv(3, "Marjane Holding", 33, 8000, "2026-10-15"),
  inv(4, "Restaurant Le Cabestan", 32, 3900, "2026-11-01"),
  inv(5, "Atlas Voyages", 34, 3900, "2026-11-02"),
];
const t = (id, date, label, amount) => ({ id, date, label, type: "credit", amount, absAmount: amount });
const transactions = [
  t("a", "2026-10-03", "RECEPTION D'UN VIREMENT DE KENZI TOWER HOTEL", 22200),        // exact + nom → auto
  t("b", "2026-10-05", "VIR RECU MARJANE HOLDING FACT 2 ET 3", 20000),                 // groupé
  t("c", "2026-10-07", "VIREMENT CABESTAN ACOMPTE", 1000),                             // partiel
  t("d", "2026-10-08", "VIREMENT RECU REF 88412", 3900),                              // exact mais sans nom (2 factures à 3 900)
  t("e", "2026-10-09", "VERSEMENT ESPECES AGENCE", 4500),                             // sans facture
  t("f", "2026-10-09", "RECEPTION D'UN VIREMENT D'ORDRE DE NAPS MOTIF : NAPS 09/10", 924.34), // carte
  { id: "g", date: "2026-10-10", label: "PAIEMENT FOURNISSEUR", type: "payment", amount: -500, absAmount: 500 }, // débit ignoré
];

assert.ok(nameInLabel("Hôtel Kenzi Tower SARL", "VIREMENT DE KENZI TOWER HOTEL"));
assert.ok(nameInLabel("Restaurant Le Cabestan", "VIREMENT CABESTAN ACOMPTE"));
assert.ok(!nameInLabel("Atlas Voyages", "VIREMENT RECU REF 88412"));
assert.ok(nameInLabel("ACHI-BEST FOOD", "VIR ACHIBEST"), "nom compacté");

const r = matchSalesReceipts({ transactions, invoices, payments: [] });

// Virement exact : automatique
assert.equal(r.auto.length, 1);
assert.equal(r.auto[0].allocations[0].invoice.id, 1);
assert.equal(r.auto[0].allocations[0].amount, 22200);

// Virement groupé : suggestion avec les deux factures Marjane
const grouped = r.suggestions.find((s) => s.txn.id === "b");
assert.ok(grouped, "suggestion groupée");
const g = grouped.proposals.find((p) => p.kind === "group");
assert.deepEqual(g.allocations.map((a) => a.invoice.id).sort(), [2, 3]);
assert.equal(g.allocations.reduce((s, a) => s + a.amount, 0), 20000);

// Paiement partiel : suggestion, montant du crédit sur la facture Cabestan
const partial = r.suggestions.find((s) => s.txn.id === "c");
assert.equal(partial.proposals[0].kind, "partial");
assert.equal(partial.proposals[0].allocations[0].invoice.id, 4);
assert.equal(partial.proposals[0].allocations[0].amount, 1000);

// Montant exact sans nom, deux candidates : jamais automatique
const ambiguous = r.suggestions.find((s) => s.txn.id === "d");
assert.equal(ambiguous.proposals.filter((p) => p.kind === "exact").length, 2);
assert.ok(!r.auto.some((a) => a.txn.id === "d"));

// Crédits sans facture, catégorisés ; débits ignorés
assert.deepEqual(r.unmatched.map((u) => u.txn.id), ["e", "f"]);
assert.equal(r.unmatched[0].category, "Dépôt d'espèces");
assert.equal(r.unmatched[1].category, "Encaissement carte ou plateforme");

// Lignes de paiement : traçables (bank_ref, libellé, dossier)
const rows = paymentRows({ credit: r.auto[0], allocations: r.auto[0].allocations, dossierId: 19 });
assert.equal(rows[0].source, "bank");
assert.equal(rows[0].paid_on, "2026-10-03");
assert.equal(rows[0].bank_dossier_id, 19);
assert.ok(rows[0].bank_ref.startsWith("2026-10-03|22200.00|"));

// Réimport du même relevé (identifiants différents) : mêmes références → rien de nouveau
const reimported = transactions.map((x, i) => ({ ...x, id: `srv-${i}` }));
const payments = [...rows, ...paymentRows({ credit: grouped, allocations: g.allocations })];
const r2 = matchSalesReceipts({
  transactions: reimported,
  invoices: invoices.map((i) => (i.id === 1 || i.id === 2 || i.id === 3 ? { ...i, balance: 0 } : i)),
  payments,
});
assert.equal(r2.auto.length, 0, "pas de doublon au réimport");
assert.deepEqual(r2.already.map((c) => c.txn.label).sort(), [transactions[0].label, transactions[1].label].sort());

// Deux crédits identiques le même jour : références distinctes
const twins = creditRefs([t("x", "2026-10-11", "VIR CLIENT", 100), t("y", "2026-10-11", "VIR CLIENT", 100)]);
assert.notEqual(twins[0].ref, twins[1].ref);

// TVA collectée : synthèse par taux et CSV
const detail = [
  { number: "FA-2026-0001", kind: "invoice", customer_name: "Client; Sept", customer_ice: "001", issue_date: "2026-09-15", paid_on: "2026-10-08", payment_method: "virement", rate: 20, base_ht: 500, vat: 100, ttc: 600 },
  { number: "FA-2026-0001", kind: "invoice", customer_name: "Client; Sept", customer_ice: "001", issue_date: "2026-09-15", paid_on: "2026-10-08", payment_method: "virement", rate: 14, base_ht: 500, vat: 70, ttc: 570 },
];
const s = collectedByRate(detail);
assert.deepEqual(s.total, { base: 1000, vat: 170, ttc: 1170 });
assert.equal(s.list[0].rate, 20);
const csv = collectedCsv(detail);
assert.ok(csv.startsWith("﻿N° document;"));
assert.ok(csv.includes('"Client; Sept"'), "séparateur échappé");
assert.ok(csv.includes(";20,00;500,00;100,00;600,00"));

console.log("OK test-bank-sales");
