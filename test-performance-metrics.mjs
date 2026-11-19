import assert from "node:assert/strict";
import { clearPerformanceSnapshot, getPerformanceSnapshot, measurePerformance, measureSyncPerformance, startPerformance, summarizePerformance } from "./performance-metrics.js";
clearPerformanceSnapshot();
assert.equal(measureSyncPerformance("test.sync", () => 7, { rowCount: 2 }), 7);
assert.equal(await measurePerformance("test.success", async () => 42, { lineCount: 3, dossierId: "must-not-be-kept" }), 42);
let rows = getPerformanceSnapshot();
assert.equal(rows.length, 2); assert.equal(rows[0].rowCount, 2); assert.equal(rows[1].ok, true);
assert.equal(rows[1].lineCount, 3); assert.equal("dossierId" in rows[1], false);
await assert.rejects(() => measurePerformance("test.error", async () => { throw new Error("expected"); }));
rows = getPerformanceSnapshot(); assert.equal(rows[2].ok, false);
const finish = startPerformance("test.once"); finish(); finish();
assert.equal(getPerformanceSnapshot().length, 4);
clearPerformanceSnapshot(); assert.equal(getPerformanceSnapshot().length, 0);
// Résumé : médiane et pire cas, erreurs exclues.
clearPerformanceSnapshot();
for (let i = 0; i < 3; i += 1) measureSyncPerformance("test.summary", () => i);
const [summary] = summarizePerformance();
assert.equal(summary.name, "test.summary"); assert.equal(summary.count, 3);
assert.ok(summary.worstMs >= summary.medianMs);
clearPerformanceSnapshot();
// Liste blanche des métadonnées : un montant ou un numéro ne passe pas.
measureSyncPerformance("test.meta", () => 1, { lineCount: 3, discount: 1500, accountNumber: 12345678, amount: 99 });
assert.deepEqual(Object.keys(getPerformanceSnapshot()[0]).sort(), ["at", "durationMs", "lineCount", "name", "ok"]);
clearPerformanceSnapshot();

// Stockage partagé : deux onglets (deux instances du module) ne s'effacent pas.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
const tabA = await import("./performance-metrics.js?tab=A");
const tabB = await import("./performance-metrics.js?tab=B");
tabA.measureSyncPerformance("onglet.A", () => 1);
tabB.measureSyncPerformance("onglet.B", () => 1);
assert.deepEqual(tabA.getPerformanceSnapshot().map((r) => r.name), ["onglet.A", "onglet.B"]);
// Limite de 500 mesures.
for (let i = 0; i < 520; i += 1) tabA.measureSyncPerformance("boucle", () => i);
assert.equal(JSON.parse(store.get("recompta_perf_samples")).length, 500);
// Stockage saturé : la mesure reste en mémoire, sans erreur pour l'application.
globalThis.localStorage = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
const tabC = await import("./performance-metrics.js?tab=C");
assert.equal(tabC.measureSyncPerformance("sature", () => 5), 5);
assert.equal(tabC.getPerformanceSnapshot().at(-1).name, "sature");
delete globalThis.localStorage;

console.log("performance-metrics: OK");
