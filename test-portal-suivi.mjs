// Portail, onglet « Suivi » : liste « À faire » et achats des derniers mois.
//
//   node test-portal-suivi.mjs
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

const { portalTodo, purchaseMonths, salesOverview } = await import("./portal-sales.js");

const today = new Date(2026, 10, 19); // 19 novembre 2026
const dossiers = [
  { id: 12, period_year: 2026, period_month: 12, status: "draft" }, // futur : ignoré
  { id: 11, period_year: 2026, period_month: 11, status: "draft" },
  { id: 10, period_year: 2026, period_month: 10, status: "draft" },
  { id: 9, period_year: 2026, period_month: 9, status: "exported" },
  { id: 8, period_year: 2026, period_month: 8, status: "exported" },
];
const up = (id, dossier_id, doc_type, created_at, extra = {}) => ({ id, dossier_id, doc_type, created_at, status: "received", ...extra });

// Ventes pas encore chargées
assert.equal(salesOverview(), null);

// ---------- Achats des 3 derniers mois ----------
{
  const uploads = [
    up(1, 10, "invoice", "2026-11-02T10:00:00Z"),
    up(2, 10, "invoice", "2026-11-02T10:00:05Z"),
    up(3, 10, "invoice", "2026-11-02T10:00:09Z", { status: "rejected" }),
    up(4, 9, "bank", "2026-10-05T10:00:00Z"),
    up(5, 9, "other", "2026-10-05T10:01:00Z"),
  ];
  const months = purchaseMonths({ dossiers, uploads, today });
  assert.deepEqual(months.map((m) => m.key), ["2026-11", "2026-10", "2026-09"]);
  assert.equal(months[1].invoiceCount, 2, "le document refusé n'est pas compté");
  assert.equal(months[1].bankSent, false);
  assert.equal(months[2].bankSent, true);
  assert.equal(months[2].otherCount, 1);
  assert.equal(months[2].closed, true);
  assert.equal(months[0].closed, false);

  // Sans dossier : les trois mois précédents apparaissent quand même, vides
  const empty = purchaseMonths({ dossiers: [], uploads: [], today });
  assert.deepEqual(empty.map((m) => m.key), ["2026-10", "2026-09", "2026-08"]);
  assert.equal(empty[0].invoiceCount, 0);
}

// ---------- À faire ----------
{
  // Élision du mois, et mois précédent sans période créée : rien n'a été envoyé, la ligne s'affiche
  const habit = [up(1, 7, "bank", "2026-08-01T00:00:00Z")];
  const july = [{ id: 7, period_year: 2026, period_month: 7, status: "draft" }];
  assert.equal(portalTodo({ uploads: habit, dossiers: july, today: new Date(2026, 8, 10) })[0].title, "Relevé bancaire d'août 2026");
  assert.equal(portalTodo({ uploads: habit, dossiers: july, today: new Date(2026, 9, 10) })[0].title, "Relevé bancaire de septembre 2026");
  // Rien du tout
  assert.deepEqual(portalTodo({ dossiers, today }), []);

  const requests = [
    { id: 1, status: "open", label: "Facture Maroc Telecom", doc_type: "invoice", dossier_id: 10 },
    { id: 2, status: "received", label: "Relevé", doc_type: "bank", dossier_id: 9 },
  ];
  const uploads = [
    // refusé, renvoyé 2 jours après : traité
    up(1, 10, "invoice", "2026-11-01T10:00:00Z", { status: "rejected", original_filename: "a.pdf" }),
    up(2, 10, "invoice", "2026-11-03T10:00:00Z"),
    // refusé, rien après : à renvoyer
    up(3, 11, "other", "2026-11-10T10:00:00Z", { status: "rejected", original_filename: "b.pdf", reject_reason: "illisible" }),
    // envoi groupé dans la même minute : ne compte pas comme un renvoi
    up(4, 11, "other", "2026-11-10T10:00:20Z"),
    // refusé sur un mois clôturé : plus rien à faire
    up(5, 9, "invoice", "2026-10-01T10:00:00Z", { status: "rejected", original_filename: "c.pdf" }),
    // relevé de septembre envoyé par le portail : le client utilise le portail pour ses relevés
    up(6, 9, "bank", "2026-10-02T10:00:00Z"),
  ];
  const sales = { overdueCount: 2, overdueAmount: 1500.5, draftCount: 1 };
  const todo = portalTodo({ requests, uploads, dossiers, sales, today });
  assert.deepEqual(todo.map((t) => t.key), ["requests", "rejected", "bank", "overdue", "drafts"]);
  const byKey = Object.fromEntries(todo.map((t) => [t.key, t]));
  assert.equal(byKey.requests.title, "Votre cabinet attend 1 pièce");
  assert.equal(byKey.requests.period, "2026-10");
  assert.equal(byKey.rejected.title, "1 document à renvoyer");
  assert.match(byKey.rejected.detail, /b\.pdf : illisible/);
  assert.equal(byKey.rejected.period, "2026-11");
  assert.equal(byKey.bank.title, "Relevé bancaire d'octobre 2026");
  assert.equal(byKey.bank.period, "2026-10");
  assert.equal(byKey.overdue.view, "sales");
  assert.equal(byKey.overdue.filter, "overdue");
  assert.match(byKey.overdue.title, /^2 factures de vente en retard$/);
  assert.match(byKey.overdue.detail, /MAD à encaisser$/);
  assert.equal(byKey.drafts.filter, "draft");

  // Relevé d'octobre envoyé → plus de ligne « relevé »
  const withBank = portalTodo({ requests, uploads: [...uploads, up(7, 10, "bank", "2026-11-05T10:00:00Z")], dossiers, today });
  assert.ok(!withBank.some((t) => t.key === "bank"));

  // Client qui n'a jamais envoyé de relevé par le portail → pas de ligne « relevé » (on ne sait pas)
  const noHabit = portalTodo({ uploads: uploads.filter((u) => u.doc_type !== "bank"), dossiers, today });
  assert.ok(!noHabit.some((t) => t.key === "bank"));

  // Mois précédent clôturé → pas de ligne « relevé »
  const closedPrev = dossiers.map((d) => (d.id === 10 ? { ...d, status: "exported" } : d));
  assert.ok(!portalTodo({ uploads, dossiers: closedPrev, today }).some((t) => t.key === "bank"));

  // Relevé déjà demandé par le cabinet → couvert par la ligne « demandes »
  const asked = [{ id: 9, status: "open", label: "Relevé octobre", doc_type: "bank", dossier_id: 10 }];
  const t2 = portalTodo({ requests: asked, uploads, dossiers, today });
  assert.ok(!t2.some((t) => t.key === "bank"));

  // Document refusé lié à une demande rouverte : pas de doublon
  const linked = [up(8, 11, "invoice", "2026-11-12T10:00:00Z", { status: "rejected", request_id: 9, original_filename: "d.pdf" })];
  const t3 = portalTodo({ requests: [{ ...asked[0], dossier_id: 11 }], uploads: linked, dossiers, today });
  assert.deepEqual(t3.map((t) => t.key), ["requests"]);

  // Ventes à jour → aucune ligne ventes
  assert.deepEqual(portalTodo({ dossiers, sales: { overdueCount: 0, overdueAmount: 0, draftCount: 0 }, today }), []);
}

console.log("test-portal-suivi : OK");
