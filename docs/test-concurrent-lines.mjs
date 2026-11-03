// Test : aucune page ouverte ne doit effacer ce qu'un import serveur a écrit
// pendant qu'elle était ouverte (dossier-persistence.js réel, Supabase simulé
// en mémoire, avec écritures concurrentes injectées au pire moment).
//
//   node test-concurrent-lines.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// Remplace les imports CDN (supabase-js) par une fausse base en mémoire.
const stub = `
export const db = { workspaces: new Map(), dossiers: new Map(), beforeWrite: null, writes: 0 };
globalThis.__fakeDb = db;
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
function table(name) {
  if (name === "dossier_workspaces") return db.workspaces;
  if (name === "client_dossiers") return db.dossiers;
  return new Map();
}
function query(name) {
  const filters = [];
  let op = "select";
  let body = null;
  const api = {
    select() { return api; },
    eq(col, val) { filters.push([col, val]); return api; },
    update(patch) { op = "update"; body = patch; return api; },
    insert(row) { op = "insert"; body = row; return api; },
    upsert(row) { op = "upsert"; body = row; return api; },
    order() { return api; },
    limit() { return api; },
    in() { return api; },
    async maybeSingle() { return run(true); },
    async single() { return run(true); },
    then(resolve, reject) { return Promise.resolve().then(() => run(false)).then(resolve, reject); },
  };
  const idCol = () => (name === "client_dossiers" ? "id" : "dossier_id");
  function key() {
    const f = filters.find(([c]) => c === idCol());
    return f ? f[1] : body?.dossier_id;
  }
  function matches(row) {
    return row && filters.every(([c, v]) => String(row[c]) === String(v));
  }
  function run(single) {
    const t = table(name);
    if (op === "select") {
      const row = t.get(key());
      return { data: matches(row) ? clone(row) : null, error: null };
    }
    if (db.beforeWrite && name === "dossier_workspaces") {
      const hook = db.beforeWrite;
      db.beforeWrite = null;
      hook();
    }
    if (op === "insert") {
      if (t.has(body.dossier_id)) return { data: null, error: { code: "23505", message: "duplicate" } };
      t.set(body.dossier_id, clone(body));
      db.writes += 1;
      return { data: [clone(body)], error: null };
    }
    if (op === "update") {
      const row = t.get(key());
      if (!matches(row)) return { data: [], error: null };
      t.set(key(), { ...row, ...clone(body) });
      if (name === "dossier_workspaces") db.writes += 1;
      return { data: [clone(t.get(key()))], error: null };
    }
    return { data: null, error: null };
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

const {
  createWorkspaceTracker,
  loadDossierWorkspace,
  saveDossierWorkspace,
  mergeConcurrentLines,
  resolveConcurrentBank,
} = await import("./dossier-persistence.js");
const db = globalThis.__fakeDb;
assert.ok(db, "fausse base non chargée");

let clock = 0;
const stamp = () => new Date(Date.UTC(2026, 10, 3, 3, 0, 0, ++clock)).toISOString();
const line = (sid, extra = {}) => ({ source_id: sid, source_file: `${sid}.pdf`, m_ht: 100, ...extra });
const sids = (lines) => lines.map((l) => l.source_id).sort();
const stored = (D) => db.workspaces.get(D);
function seed(D, lines, bank = []) {
  db.dossiers.set(D, { id: D, status: "in_review" });
  db.workspaces.set(D, { dossier_id: D, lines, bank_transactions: bank, bank_meta: {}, updated_at: stamp() });
}
// Écriture « serveur » (worker) : nouvelle valeur + nouvel updated_at.
function serverWrite(D, patch) {
  const row = stored(D);
  db.workspaces.set(D, { ...row, ...patch(row), updated_at: stamp() });
}

// ── Fonctions pures ──────────────────────────────────────────────────────
{
  const { lines, added } = mergeConcurrentLines([line("a")], [line("a"), line("b"), line("c")], new Set(["a", "b"]));
  assert.deepEqual(sids(lines), ["a", "c"], "b supprimé localement, c nouveau");
  assert.equal(added, 1);
  assert.equal(mergeConcurrentLines([line("a")], [line("z")], null).added, 0, "sans tracker : pas de fusion");
  assert.equal(mergeConcurrentLines([], [{ m_ht: 5 }], new Set()).added, 0, "ligne sans source_id ignorée");

  const local = { bank_transactions: [1], bank_meta: { a: 1 } };
  const server = { bank_transactions: [2], bank_meta: { a: 1 } };
  const adopted = JSON.stringify([[1], { a: 1 }]);
  assert.equal(resolveConcurrentBank(local, server, adopted).changed, true, "relevé non modifié localement : serveur");
  assert.equal(resolveConcurrentBank({ ...local, bank_transactions: [9] }, server, adopted).changed, false, "modifié : local");
  assert.equal(resolveConcurrentBank(local, server, null).changed, false, "sans tracker : local");
}

// ── 1. Revue ouverte pendant un import ───────────────────────────────────
{
  const D = 1;
  seed(D, [line("a"), line("b")]);
  const tracker = createWorkspaceTracker();
  let page = (await loadDossierWorkspace(D, { tracker })).lines;

  serverWrite(D, (row) => ({ lines: [...row.lines, line("c", { taux: 0.2 }), line("c", { taux: 0.1 })] }));

  page = page.filter((l) => l.source_id !== "b").map((l) => ({ ...l, m_ht: 999 }));
  const saved = await saveDossierWorkspace(D, { lines: page, tracker });
  assert.deepEqual(sids(stored(D).lines), ["a", "c", "c"], "c conservé (2 lignes), b reste supprimé");
  assert.equal(stored(D).lines.find((l) => l.source_id === "a").m_ht, 999, "modification locale conservée");
  assert.equal(saved.added, 2);
  page = saved.lines;

  const again = await saveDossierWorkspace(D, { lines: page, tracker });
  assert.equal(again.added, 0, "pas de doublon après reprise");

  page = page.filter((l) => l.source_id !== "c");
  await saveDossierWorkspace(D, { lines: page, tracker });
  assert.deepEqual(sids(stored(D).lines), ["a"], "c supprimé après avoir été vu : ne revient pas");

  await saveDossierWorkspace(D, { lines: [], tracker });
  assert.deepEqual(stored(D).lines, [], "réinitialisation du dossier");
}

// ── 2. Course : l'import écrit entre la relecture et l'écriture ──────────
{
  const D = 2;
  seed(D, [line("a")]);
  const tracker = createWorkspaceTracker();
  const page = (await loadDossierWorkspace(D, { tracker })).lines;
  db.beforeWrite = () => serverWrite(D, (row) => ({ lines: [...row.lines, line("late")] }));
  const saved = await saveDossierWorkspace(D, { lines: page.map((l) => ({ ...l, m_ht: 5 })), tracker });
  assert.deepEqual(sids(stored(D).lines), ["a", "late"], "écriture concurrente détectée, relue et fusionnée");
  assert.equal(saved.added, 1);
}

// ── 3. Sans tracker : jamais d'écrasement d'une écriture intermédiaire ───
{
  const D = 3;
  seed(D, [line("x")]);
  const before = db.writes;
  db.beforeWrite = () => serverWrite(D, () => ({ lines: [line("x"), line("y")] }));
  await saveDossierWorkspace(D, { lines: [line("z")] });
  assert.deepEqual(sids(stored(D).lines), ["z"], "dernier mot à la page, mais après relecture");
  assert.equal(db.writes - before, 1, "une seule écriture effective");
}

// ── 4. Relevé importé pendant qu'une page d'import achats est ouverte ────
{
  const D = 4;
  seed(D, [line("a")], []);
  const tracker = createWorkspaceTracker();
  const ws = await loadDossierWorkspace(D, { tracker, adoptBank: true });
  serverWrite(D, () => ({ bank_transactions: [{ id: 1, amount: 50 }], bank_meta: { filename: "releve.pdf" } }));
  const saved = await saveDossierWorkspace(D, {
    lines: ws.lines.map((l) => ({ ...l, lib_frss: "X" })),
    bankTransactions: ws.bank_transactions,
    bankMeta: ws.bank_meta,
    tracker,
  });
  assert.equal(stored(D).bank_transactions.length, 1, "relevé importé conservé");
  assert.equal(saved.bankChanged, true);
  assert.equal(stored(D).lines[0].lib_frss, "X", "modification des lignes conservée");

  // La page modifie ensuite elle-même le relevé : sa version gagne.
  await saveDossierWorkspace(D, {
    lines: saved.lines,
    bankTransactions: [],
    bankMeta: saved.bank_meta,
    tracker,
  });
  assert.equal(stored(D).bank_transactions.length, 0, "suppression locale du relevé respectée");
}

// ── 5. Deux composants sur la même page + une simple lecture ─────────────
{
  const D = 5;
  seed(D, [line("a")]);
  const review = createWorkspaceTracker();
  let reviewLines = (await loadDossierWorkspace(D, { tracker: review })).lines;

  serverWrite(D, (row) => ({ lines: [...row.lines, line("b")] }));

  // Onglet Documents : lecture sans tracker, ne doit rien « marquer vu ».
  await loadDossierWorkspace(D);
  // Rapprochement : reprend a + b et sauvegarde.
  const bank = createWorkspaceTracker();
  const bm = (await loadDossierWorkspace(D, { tracker: bank })).lines;
  await saveDossierWorkspace(D, { lines: bm.map((l) => ({ ...l, date_paie: "2026-11-01" })), tracker: bank });

  // La revue (qui n'a jamais vu b) sauvegarde ensuite : b doit survivre.
  reviewLines = reviewLines.map((l) => ({ ...l, m_ht: 7 }));
  const saved = await saveDossierWorkspace(D, { lines: reviewLines, tracker: review });
  assert.deepEqual(sids(stored(D).lines), ["a", "b"], "b conservé malgré la revue périmée");
  assert.equal(saved.added, 1);
}

// ── 6. Premier enregistrement concurrent (ligne absente puis créée) ──────
{
  const D = 6;
  db.dossiers.set(D, { id: D, status: "draft" });
  const tracker = createWorkspaceTracker();
  await loadDossierWorkspace(D, { tracker });
  db.beforeWrite = () =>
    db.workspaces.set(D, { dossier_id: D, lines: [line("w")], bank_transactions: [], bank_meta: {}, updated_at: stamp() });
  await saveDossierWorkspace(D, { lines: [line("p")], tracker });
  assert.deepEqual(sids(stored(D).lines), ["p", "w"], "conflit à l'insertion : relu et fusionné");
}

console.log("OK test-concurrent-lines");
