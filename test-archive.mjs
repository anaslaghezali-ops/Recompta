// Vue « Tous les documents » / « Archives » : classement, filtres, ZIP.
//
//   node test-archive.mjs
import assert from "node:assert/strict";
import {
  BANK_GROUP_KEY,
  UNREAD_GROUP_KEY,
  buildArchiveEntries,
  filterEntries,
  groupByMonth,
  groupByParty,
  normalizePartyName,
  planZipParts,
  readableFilename,
  recapRows,
  safeName,
  zipFilename,
  zipPaths,
} from "./archive-core.js";

const doc = (id, dossier, year, month, name, extra = {}) => ({
  id, dossier_id: dossier, period_year: year, period_month: month, doc_type: "invoice",
  original_filename: name, storage_path: `dossier/${dossier}/${id}_${name}`, size_bytes: 1000,
  created_at: `${year}-${String(month).padStart(2, "0")}-28T10:00:00Z`, ...extra,
});
const line = (dossier, extra) => ({ dossier_id: dossier, ...extra });

const documents = [
  doc(1, 10, 2026, 8, "scan-aout.pdf", { source_id: "src-1" }),
  doc(2, 11, 2026, 9, "scan-sept.pdf", { source_id: "src-1" }),          // même source_id, autre période
  doc(3, 11, 2026, 9, "Achibest/FV-3.pdf", { source_id: "src-2" }),
  doc(4, 11, 2026, 9, "srm.pdf", { source_id: "src-3" }),                 // multi-taux : 2 lignes
  doc(5, 11, 2026, 9, "pas-lu.pdf", { source_id: "src-9" }),               // aucune ligne
  doc(6, 11, 2026, 9, "releve.pdf", { doc_type: "bank" }),
  doc(7, 11, 2026, 9, "lot.zip", { doc_type: "archive" }),                 // conteneur : exclu
  doc(8, 11, 2026, 9, "menu.pdf", { extraction_status: "ignored" }),
  doc(9, 12, 2026, 10, "nom-seul.pdf"),                                    // rattaché par nom de fichier
];
const lines = [
  line(10, { source_id: "src-1", lib_frss: "ACHI-BEST FOOD SARL", ice_frs: "001234567000089", fact_num: "FV-1", date_fac: "2026-08-03", date_paie: "2026-08-20", m_ttc: 120, tva: 20 }),
  line(11, { source_id: "src-1", lib_frss: "Glovo", fact_num: "G-77", date_fac: "2026-09-02", m_ttc: 60, tva: 10 }),
  line(11, { source_id: "src-2", lib_frss: "Achibest", fact_num: "FV-3", date_fac: "2026-09-05", m_ttc: 240, tva: 40 }),
  line(11, { source_id: "src-3", lib_frss: "SRM", fact_num: "S1", date_fac: "2026-09-10", date_paie: "2026-09-30", m_ttc: 120, tva: 20, taux: 0.2 }),
  line(11, { source_id: "src-3", lib_frss: "SRM", fact_num: "S1", date_fac: "2026-09-10", date_paie: "2026-10-02", m_ttc: 107, tva: 7, taux: 0.07 }),
  line(11, { lib_frss: "SAHAM BANK", source_file: "releve.pdf", from_bank: true, m_ttc: 15 }),
  line(12, { lib_frss: "Mose Food S.A.R.L.a.u", source_file: "nom-seul.pdf", fact_num: "M-1", date_fac: "2026-10-01", m_ttc: 50, tva: 0 }),
];
const sales = [
  { id: 100, status: "issued", origin: "created", kind: "invoice", number: "FA-2026-0001", issue_date: "2026-09-12", customer_name: "Hôtel Atlas", total_ttc: 1200, total_vat: 200, last_paid_on: "2026-10-01" },
  { id: 101, status: "issued", origin: "uploaded", kind: "invoice", external_number: "F-77", issue_date: "2026-09-20", customer_name: "Hôtel Atlas", total_ttc: 600, total_vat: 100, document_path: "9101/abc_f77.pdf" },
  { id: 102, status: "draft", origin: "created", kind: "invoice", issue_date: "2026-09-25", customer_name: "Brouillon", total_ttc: 1 },
  { id: 103, status: "issued", origin: "uploaded", kind: "invoice", external_number: "F-78", issue_date: "2026-09-21", customer_name: "Sans fichier", total_ttc: 10 },
  { id: 104, status: "issued", origin: "created", kind: "credit_note", number: "FA-2026-0002", issue_date: "2026-10-02", customer_name: "Hôtel Atlas", total_ttc: 600, total_vat: 100 },
];

const entries = buildArchiveEntries({ documents, lines, sales });
const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));

// Construction
assert.equal(byKey["doc:7"], undefined, "ZIP conteneur exclu");
assert.equal(byKey["doc:1"].partyName, "ACHI-BEST FOOD SARL", "source_id dans la bonne période");
assert.equal(byKey["doc:2"].partyName, "Glovo", "source_id identique dans une autre période : pas de mélange");
assert.equal(byKey["doc:4"].ttc, 227, "multi-taux : TTC additionné");
assert.equal(byKey["doc:4"].tva, 27);
assert.equal(byKey["doc:4"].paidOn, "2026-10-02", "date de paiement la plus récente");
assert.equal(byKey["doc:5"].analyzed, false);
assert.equal(byKey["doc:5"].partyKey, UNREAD_GROUP_KEY);
assert.equal(byKey["doc:6"].kind, "bank");
assert.equal(byKey["doc:6"].partyKey, BANK_GROUP_KEY, "relevé : pas rattaché à la ligne banque");
assert.equal(byKey["doc:9"].partyName, "Mose Food S.A.R.L.a.u", "rattaché par nom de fichier");
assert.equal(byKey["doc:8"].ignored, true);
assert.equal(byKey["sale:102"], undefined, "brouillon exclu");
assert.equal(byKey["sale:103"], undefined, "vente importée sans fichier exclue");
assert.equal(byKey["sale:100"].generated, true, "facture créée : PDF à générer");
assert.equal(byKey["sale:101"].generated, false);
assert.equal(byKey["sale:101"].bucket, "sales-documents");
assert.equal(byKey["sale:100"].period, "2026-09", "vente : mois d'émission");

// Même fournisseur, avec et sans ICE, orthographes différentes
assert.equal(normalizePartyName("MOSE Food S.A.R.L.a.u"), normalizePartyName("Mose food"));
assert.equal(byKey["doc:3"].partyKey, byKey["doc:1"].partyKey, "« Achibest » sans ICE rattaché à « ACHI-BEST FOOD » avec ICE");
assert.notEqual(byKey["doc:2"].partyKey, byKey["doc:1"].partyKey);

// Filtres
assert.equal(filterEntries(entries).some((e) => e.ignored), false, "écartés masqués par défaut");
assert.equal(filterEntries(entries, { showIgnored: true }).some((e) => e.ignored), true);
assert.deepEqual(filterEntries(entries, { unreadOnly: true }).map((e) => e.key), ["doc:5"]);
assert.deepEqual(filterEntries(entries, { query: "achibest" }).map((e) => e.key).sort(), ["doc:1", "doc:3"].sort(), "recherche compacte (ACHI-BEST)");
assert.deepEqual(filterEntries(entries, { query: "227" }).map((e) => e.key), ["doc:4"], "recherche par montant");
assert.deepEqual(filterEntries(entries, { query: "fv-3" }).map((e) => e.key), ["doc:3"], "recherche par n°");
assert.equal(filterEntries(entries, { kinds: ["sale"] }).every((e) => e.kind === "sale"), true);
assert.deepEqual(
  [...new Set(filterEntries(entries, { from: "2026-09", to: "2026-09" }).map((e) => e.period))],
  ["2026-09"],
  "plage de périodes",
);

// Par mois
const months = groupByMonth(filterEntries(entries));
assert.deepEqual(months.map((m) => m.key), ["2026-10", "2026-09", "2026-08"]);
assert.equal(months[0].label, "Octobre 2026");
const oct = months[0];
assert.equal(oct.ttc, 50 - 600, "avoir déduit du total");

// Par tiers
const parties = groupByParty(filterEntries(entries));
const labels = parties.map((p) => p.label);
assert.ok(labels.indexOf("Pas encore analysées") === labels.length - 1, "non analysées en dernier");
assert.ok(labels.indexOf("Relevés bancaires") === labels.length - 2, "relevés avant-derniers");
const atlas = parties.find((p) => p.label === "Hôtel Atlas");
assert.equal(atlas.count, 3, "ventes groupées par client acheteur");
assert.equal(atlas.kind, "sale");
const achibest = parties.find((p) => p.entries.some((e) => e.key === "doc:1"));
assert.equal(achibest.firstPeriod, "2026-08");
assert.equal(achibest.count, 2);
assert.equal(achibest.lastPeriod, "2026-09");

// Noms de fichiers et ZIP
assert.equal(readableFilename(byKey["doc:3"]), "Achibest_FV-3_05-09-2026.pdf");
assert.equal(readableFilename(byKey["doc:5"]), "pas-lu.pdf", "non analysée : nom d'origine");
assert.equal(readableFilename(byKey["sale:104"]), "Avoir_Hotel-Atlas_FA-2026-0002_02-10-2026.pdf");
assert.equal(safeName("a/b:c*?"), "a b c");

const purchases = filterEntries(entries, { kinds: ["purchase"] });
const byMonth = zipPaths(purchases, "month");
assert.ok(byMonth.every(({ path }) => /^\d{4}-\d{2}\//.test(path)), "rangé par mois, sans dossier de type");
const mixed = zipPaths(filterEntries(entries), "party");
assert.ok(mixed.some(({ path }) => path.startsWith("Ventes/Hotel Atlas/")), "type puis client");
assert.ok(mixed.some(({ path }) => path.startsWith("Achats/")));
const dup = zipPaths([byKey["doc:3"], { ...byKey["doc:3"], key: "x" }], "flat");
assert.deepEqual(dup.map((d) => d.path), ["Achibest_FV-3_05-09-2026.pdf", "Achibest_FV-3_05-09-2026 (2).pdf"], "doublons renommés");

const big = Array.from({ length: 7 }, (_, i) => ({ entry: { sizeBytes: 100 }, i }));
assert.deepEqual(planZipParts(big, 250).map((p) => p.length), [2, 2, 2, 1], "découpage par taille");
assert.deepEqual(planZipParts([{ entry: { sizeBytes: 999 } }], 250).map((p) => p.length), [1], "un fichier trop gros reste entier");

const recap = recapRows(byMonth);
assert.equal(recap.length, byMonth.length);
assert.equal(recap.find((r) => r[3] === "S1")[5], 227);

assert.equal(zipFilename("Ferfer SARL", { today: new Date(2026, 10, 18) }), "Ferfer-SARL_documents_2026-11-18.zip");
assert.equal(zipFilename("Ferfer", { part: 1, parts: 3, today: new Date(2026, 10, 18) }), "Ferfer_documents_2026-11-18_partie-2-sur-3.zip");

console.log("test-archive ok");
