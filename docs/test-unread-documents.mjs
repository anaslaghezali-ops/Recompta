// Classement des factures : lues / non lues / écartées (import-jobs-client.js réel).
//
//   node test-unread-documents.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

const stub = "export const GlobalWorkerOptions = {}; export function createClient() { return {}; }";
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

const { classifyInvoiceDocuments, countPendingAnalysis } = await import("./import-jobs-client.js");

let id = 0;
const doc = (name, extra = {}) => ({
  id: ++id,
  doc_type: "invoice",
  original_filename: name,
  source_id: `src-${id}`,
  size_bytes: 1000 + id,
  created_at: `2026-11-03T03:00:${String(id).padStart(2, "0")}Z`,
  ...extra,
});
const names = (docs) => docs.map((d) => d.original_filename).sort();

const read = doc("lue.pdf", { extraction_status: "done" });
const failed = doc("floue.pdf", { extraction_status: "failed", extraction_error: "Scan illisible" });
const never = doc("nouvelle.pdf");
const ignored = doc("bon-livraison.pdf", { extraction_status: "ignored" });
const deleted = doc("lignes-supprimees.pdf", { extraction_status: "done" });
const ignoredWithLines = doc("ecartee-mais-lue.pdf", { extraction_status: "ignored" });
const bank = { ...doc("releve.pdf"), doc_type: "bank" };

const documents = [read, failed, never, ignored, deleted, ignoredWithLines, bank];
const workspace = {
  lines: [
    { source_id: read.source_id, source_file: read.original_filename },
    { source_id: ignoredWithLines.source_id, source_file: ignoredWithLines.original_filename },
  ],
  bank_transactions: [],
};

const c = classifyInvoiceDocuments(documents, workspace);
assert.deepEqual(names(c.read), ["lue.pdf"]);
assert.deepEqual(names(c.failed), ["floue.pdf"]);
assert.deepEqual(names(c.pending), ["nouvelle.pdf"]);
assert.deepEqual(names(c.ignored), ["bon-livraison.pdf", "ecartee-mais-lue.pdf"]);
assert.deepEqual(names(c.settled), ["lignes-supprimees.pdf"], "lignes supprimées volontairement : pas non lue");

const p = countPendingAnalysis(documents, workspace);
assert.equal(p.invoicePending, 2, "échec + jamais lue sont à (re)lancer");
assert.equal(p.invoiceFailed, 1);
assert.equal(p.invoiceNeverRead, 1);
assert.deepEqual(names(p.unreadDocuments), ["floue.pdf", "nouvelle.pdf"]);
assert.equal(p.bankPending, 1);
assert.equal(p.total, 3);

// Avant migration : pas de statut → tout document sans ligne est en attente.
const legacy = documents.map(({ extraction_status, extraction_error, ...rest }) => rest);
const lp = countPendingAnalysis(legacy, workspace);
assert.equal(lp.invoicePending, 4, "comportement d'origine conservé sans migration");
assert.equal(lp.invoiceFailed, 0);

console.log("OK test-unread-documents");
