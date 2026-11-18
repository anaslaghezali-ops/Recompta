// Registre des ventes (portail) : montants, états, filtres, totaux du mois.
//
//   node test-sales-register.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

const stub = "export function createClient() { return {}; }";
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (specifier.startsWith("https://")) {
          return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(stub)}), shortCircuit: true };
        }
        return next(specifier, context);
      }
    `),
);

const { parseAmount, completeAmounts, saleState, filterSales, salesSummary } = await import("./sales-client.js");

// Montants saisis à la marocaine / française
assert.equal(parseAmount("1 200,50"), 1200.5);
assert.equal(parseAmount("1.200,50"), 1200.5);
assert.equal(parseAmount("1,200.50"), 1200.5);
assert.equal(parseAmount("1200"), 1200);
assert.equal(parseAmount("850 MAD"), 850);
assert.ok(Number.isNaN(parseAmount("")));
assert.ok(Number.isNaN(parseAmount("abc")));

// Deux montants suffisent
assert.deepEqual(completeAmounts({ ht: 1000, vat: NaN, ttc: 1200 }), { ht: 1000, vat: 200, ttc: 1200 });
assert.deepEqual(completeAmounts({ ht: 1000, vat: 200, ttc: NaN }), { ht: 1000, vat: 200, ttc: 1200 });
assert.deepEqual(completeAmounts({ ht: NaN, vat: 100, ttc: 1100 }), { ht: 1000, vat: 100, ttc: 1100 });
assert.deepEqual(completeAmounts({ ht: NaN, vat: NaN, ttc: 1200 }), { ht: 1000, vat: 200, ttc: 1200 }, "TTC seul → 20 % par défaut");

const sales = [
  { id: 1, status: "draft", total_ttc: 500, balance: 500 },
  { id: 2, status: "issued", payment_status: "unpaid", is_overdue: false, total_ttc: 1200, balance: 1200 },
  { id: 3, status: "issued", payment_status: "partial", is_overdue: false, total_ttc: 1200, balance: 800 },
  { id: 4, status: "issued", payment_status: "unpaid", is_overdue: true, days_overdue: 12, total_ttc: 600, balance: 600 },
  { id: 5, status: "issued", payment_status: "paid", is_overdue: false, total_ttc: 300, balance: 0 },
  { id: 6, status: "voided", payment_status: null, is_overdue: false, total_ttc: 900, balance: 900 },
];
assert.equal(saleState(sales[0]).label, "À valider");
assert.equal(saleState(sales[2]).label, "Partiellement payée");
assert.equal(saleState(sales[3]).label, "En retard de 12 jours");
assert.equal(saleState(sales[4]).label, "Payée");
assert.equal(saleState(sales[5]).label, "Annulée");

const ids = (list) => list.map((s) => s.id);
assert.deepEqual(ids(filterSales(sales, "unpaid")), [2, 3, 4]);
assert.deepEqual(ids(filterSales(sales, "overdue")), [4]);
assert.deepEqual(ids(filterSales(sales, "paid")), [5]);
assert.deepEqual(ids(filterSales(sales, "draft")), [1]);
assert.equal(filterSales(sales, "all").length, 6);

const payments = [
  { invoice_id: 3, paid_on: "2026-11-05", amount: 400 },
  { invoice_id: 5, paid_on: "2026-10-28", amount: 300 },  // mois précédent
  { invoice_id: 6, paid_on: "2026-11-02", amount: 50 },   // facture annulée : ignoré
];
const s = salesSummary(sales, payments, new Date("2026-11-18T10:00:00"));
assert.equal(s.collectedMonth, 400, "encaissé du mois = paiements datés du mois");
assert.equal(s.overdueAmount, 600);
assert.equal(s.overdueCount, 1);
assert.equal(s.openAmount, 2600, "reste à encaisser = 1200 + 800 + 600");
assert.equal(s.openCount, 3);
assert.equal(s.draftCount, 1);

console.log("OK test-sales-register");
