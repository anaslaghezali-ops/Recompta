// Test : une page ouverte ne doit pas effacer les lignes ajoutées par un import
// serveur pendant qu'elle était ouverte (dossier-persistence.js réel, Supabase
// simulé en mémoire).
//
//   node test-concurrent-lines.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// Remplace les imports CDN (supabase-js) par une fausse base en mémoire.
const stub = `
export const db = { workspaces: new Map(), dossiers: new Map() };
globalThis.__fakeDb = db;
function table(name) {
  if (name === "dossier_workspaces") return db.workspaces;
  if (name === "client_dossiers") return db.dossiers;
  return new Map();
}
function query(name) {
  const filters = [];
  let pendingUpsert = null;
  let pendingUpdate = null;
  const api = {
    select() { return api; },
    eq(col, val) { filters.push([col, val]); return api; },
    upsert(payload) { pendingUpsert = payload; return api; },
    update(patch) { pendingUpdate = patch; return api; },
    insert() { return Promise.resolve({ error: null }); },
    order() { return api; },
    limit() { return api; },
    in() { return api; },
    async maybeSingle() { return { data: find() || null, error: null }; },
    async single() { return run(); },
    then(resolve) { return Promise.resolve(run()).then(resolve); },
  };
  function key() { return filters.length ? filters[0][1] : null; }
  function find() {
    const t = table(name);
    const row = t.get(key());
    return row ? JSON.parse(JSON.stringify(row)) : null;
  }
  function run() {
    const t = table(name);
    if (pendingUpsert) {
      t.set(pendingUpsert.dossier_id, { ...(t.get(pendingUpsert.dossier_id) || {}), ...JSON.parse(JSON.stringify(pendingUpsert)) });
      return { data: { dossier_id: pendingUpsert.dossier_id, updated_at: pendingUpsert.updated_at }, error: null };
    }
    if (pendingUpdate) {
      t.set(key(), { ...(t.get(key()) || {}), ...pendingUpdate });
      return { data: null, error: null };
    }
    return { data: find(), error: null };
  }
  return api;
}
export function createClient() {
  return { from: query, rpc: async () => ({ data: null, error: { message: "no rpc" } }) };
}
`;
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

const persistence = await import("./dossier-persistence.js");
const {
  loadDossierWorkspace,
  saveDossierWorkspace,
  mergeConcurrentLines,
} = persistence;
const db = globalThis.__fakeDb;
assert.ok(db, "fausse base non chargée");

const line = (sid, extra = {}) => ({ source_id: sid, source_file: `${sid}.pdf`, m_ht: 100, ...extra });
const sids = (lines) => lines.map((l) => l.source_id).sort();

// ── Fonction pure ────────────────────────────────────────────────────────
{
  const seen = new Set(["a", "b"]);
  const { lines, added } = mergeConcurrentLines([line("a")], [line("a"), line("b"), line("c")], seen);
  assert.deepEqual(sids(lines), ["a", "c"], "b supprimé localement, c nouveau");
  assert.equal(added, 1);
  assert.equal(mergeConcurrentLines([line("a")], [line("z")], null).added, 0, "sans historique : comportement inchangé");
  const noSid = mergeConcurrentLines([], [{ m_ht: 5 }], new Set());
  assert.equal(noSid.added, 0, "ligne sans source_id ignorée");
}

// ── Scénario : revue ouverte pendant un import serveur ───────────────────
{
  const D = 1;
  db.dossiers.set(D, { id: D, status: "in_review" });
  db.workspaces.set(D, { dossier_id: D, lines: [line("a"), line("b")], bank_transactions: [], bank_meta: {} });

  // La page charge le dossier (a, b).
  const loaded = await loadDossierWorkspace(D);
  let pageLines = loaded.lines;

  // Le serveur ajoute c (2 lignes : facture multi-taux) pendant ce temps.
  const ws = db.workspaces.get(D);
  ws.lines = [...ws.lines, line("c", { taux: 0.2 }), line("c", { taux: 0.1 })];

  // L'utilisateur supprime b et modifie a, puis la page sauvegarde.
  pageLines = pageLines.filter((l) => l.source_id !== "b").map((l) => ({ ...l, m_ht: 999 }));
  const pre = await loadDossierWorkspace(D, { adopt: false }); // relecture du relevé
  const saved = await saveDossierWorkspace(D, {
    lines: pageLines,
    bankTransactions: pre.bank_transactions,
    bankMeta: pre.bank_meta,
  });

  const stored = db.workspaces.get(D).lines;
  assert.deepEqual(sids(stored), ["a", "c", "c"], "c conservé (2 lignes), b reste supprimé");
  assert.equal(stored.find((l) => l.source_id === "a").m_ht, 999, "modification locale conservée");
  assert.equal(saved.added, 2);
  pageLines = saved.lines;

  // Sauvegarde suivante après adoption : rien n'est dupliqué ni ressuscité.
  const again = await saveDossierWorkspace(D, { lines: pageLines, bankTransactions: [], bankMeta: {} });
  assert.equal(again.added, 0);
  assert.deepEqual(sids(db.workspaces.get(D).lines), ["a", "c", "c"]);

  // L'utilisateur supprime c après l'avoir vu : il ne revient pas.
  pageLines = pageLines.filter((l) => l.source_id !== "c");
  await saveDossierWorkspace(D, { lines: pageLines, bankTransactions: [], bankMeta: {} });
  assert.deepEqual(sids(db.workspaces.get(D).lines), ["a"]);

  // « Réinitialiser le dossier » vide bien tout.
  await saveDossierWorkspace(D, { lines: [], bankTransactions: [], bankMeta: {} });
  assert.deepEqual(db.workspaces.get(D).lines, []);
}

// ── Page qui n'a jamais chargé le dossier : comportement inchangé ────────
{
  const D = 2;
  db.dossiers.set(D, { id: D, status: "draft" });
  db.workspaces.set(D, { dossier_id: D, lines: [line("x")], bank_transactions: [], bank_meta: {} });
  const saved = await saveDossierWorkspace(D, { lines: [line("y")], bankTransactions: [], bankMeta: {} });
  assert.equal(saved.added, 0);
  assert.deepEqual(sids(db.workspaces.get(D).lines), ["y"]);
}

console.log("OK test-concurrent-lines");
