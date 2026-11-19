// Tests du saver différé : coalescence, sérialisation, reprise après erreur et annulation.
// Exécution : node test-debounced-saver.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

const stub = `
export function createClient() { return {}; }
`;
register(
  "data:text/javascript," + encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier.startsWith("https://")) {
        return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(stub)}), shortCircuit: true };
      }
      return next(specifier, context);
    }
  `),
);

const { createDebouncedSaver } = await import("./dossier-persistence.js");
const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// Plusieurs changements avant le flush : seul le dernier état est écrit.
{
  const writes = [];
  const saver = createDebouncedSaver(async (value) => writes.push(value), 60_000);
  saver.schedule("ancien");
  saver.schedule("dernier");
  await saver.flush();
  assert.deepEqual(writes, ["dernier"]);
}

// Une sauvegarde en cours ne chevauche jamais la suivante ; le dernier état
// reçu pendant l'écriture est traité ensuite.
{
  const writes = [];
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const saver = createDebouncedSaver(async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    writes.push(value);
    if (value === "A") await gate;
    active -= 1;
  }, 60_000);

  saver.schedule("A");
  const first = saver.flush();
  await pause();
  saver.schedule("B");
  const second = saver.flush();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(writes, ["A", "B"]);
  assert.equal(maxActive, 1, "les écritures doivent être séquentielles");
}

// Après un échec, le payload reste disponible et flush peut le retenter.
{
  const writes = [];
  let fail = true;
  const saver = createDebouncedSaver(async (value) => {
    writes.push(value);
    if (fail) {
      fail = false;
      throw new Error("échec simulé");
    }
  }, 60_000);

  saver.schedule({ id: 7 });
  await assert.rejects(saver.flush(), /échec simulé/);
  await saver.flush();
  assert.deepEqual(writes, [{ id: 7 }, { id: 7 }]);
}

// Un nouveau payload remplace l'ancien, y compris une valeur falsy.
{
  const writes = [];
  const saver = createDebouncedSaver(async (value) => writes.push(value), 60_000);
  saver.schedule("à remplacer");
  saver.schedule(false);
  await saver.flush();
  assert.deepEqual(writes, [false]);
}

// cancel efface le travail en attente.
{
  const writes = [];
  const saver = createDebouncedSaver(async (value) => writes.push(value), 60_000);
  saver.schedule("annulé");
  saver.cancel();
  await saver.flush();
  assert.deepEqual(writes, []);
}

// Un changement arrivé pendant une écriture qui échoue est quand même écrit
// (régression : il restait en attente sans nouvel essai).
{
  const writes = [];
  let failNext = true;
  const saver = createDebouncedSaver(async (value) => {
    await pause(20);
    if (failNext) {
      failNext = false;
      throw new Error("réseau");
    }
    writes.push(value);
  }, 5);
  saver.schedule("A");
  await pause(10);
  saver.schedule("B");
  await pause(120);
  assert.deepEqual(writes, ["B"]);
}

console.log("OK test-debounced-saver");
