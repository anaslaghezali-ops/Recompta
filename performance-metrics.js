// Mesures de performance locales.
// - Aucune requête réseau : les mesures restent dans ce navigateur (localStorage).
// - Aucune donnée métier : seulement le nom de l'action, la durée, le succès et
//   des volumes (clés se terminant par Count / Rows / Bytes / Attempts, ex. lineCount).
// - Plusieurs onglets écrivent dans la même liste : chaque mesure relit le stockage
//   avant d'ajouter la sienne, pour ne pas effacer celles des autres onglets.
// - Les 500 dernières mesures sont gardées entre deux pages ; export depuis l'admin.
const STORAGE_KEY = "recompta_perf_samples";
const MAX_SAMPLES = 500;

let storageBroken = false; // écriture refusée (quota) : on reste en mémoire
let samples = loadSamples();

function storage() {
  if (storageBroken) return null;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // stockage bloqué (navigation privée, iframe…)
  }
}

// Liste lue dans le stockage, ou null s'il est indisponible (on garde alors la mémoire).
function readStoredSamples() {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(-MAX_SAMPLES) : [];
  } catch {
    return null;
  }
}

function loadSamples() {
  return readStoredSamples() ?? [];
}

const SAFE_DETAIL_KEY = /^[a-z][A-Za-z]*(Count|Rows|Bytes|Attempts)$/;

function saveSamples() {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(samples));
  } catch {
    // Quota plein ou stockage indisponible : la mesure reste en mémoire pour
    // cet onglet (sinon la relecture du stockage l'effacerait).
    storageBroken = true;
  }
}

function now() {
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
}

function record(name, startedAt, details = {}, error = null) {
  const durationMs = Math.max(0, now() - startedAt);
  const safeDetails = {};
  for (const [key, value] of Object.entries(details || {})) {
    // Liste blanche stricte : « discount » ou « accountNumber » ne passent pas.
    if (SAFE_DETAIL_KEY.test(key) && Number.isFinite(Number(value))) {
      safeDetails[key] = Number(value);
    }
  }
  samples = readStoredSamples() ?? samples;
  samples.push({
    name: String(name),
    durationMs: Math.round(durationMs * 100) / 100,
    at: new Date().toISOString(),
    ok: !error,
    ...safeDetails,
  });
  if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
  saveSamples();
  return durationMs;
}

export function startPerformance(name, details = {}) {
  const startedAt = now();
  let ended = false;
  return (error = null, extra = {}) => {
    if (ended) return 0;
    ended = true;
    return record(name, startedAt, { ...details, ...extra }, error);
  };
}

export function measureSyncPerformance(name, operation, details = {}) {
  const end = startPerformance(name, details);
  try {
    const result = operation();
    end();
    return result;
  } catch (error) {
    end(error);
    throw error;
  }
}

export async function measurePerformance(name, operation, details = {}) {
  const end = startPerformance(name, details);
  try {
    const result = await operation();
    end();
    return result;
  } catch (error) {
    end(error);
    throw error;
  }
}

export function getPerformanceSnapshot() {
  samples = readStoredSamples() ?? samples;
  return samples.map((sample) => ({ ...sample }));
}

export function clearPerformanceSnapshot() {
  samples = [];
  saveSamples();
}

/** Médiane et pire cas par action, pour comparer avant / après. */
export function summarizePerformance(list = getPerformanceSnapshot()) {
  const byName = new Map();
  for (const sample of list) {
    if (!sample.ok) continue;
    if (!byName.has(sample.name)) byName.set(sample.name, []);
    byName.get(sample.name).push(sample.durationMs);
  }
  return [...byName.entries()].map(([name, durations]) => {
    const sorted = [...durations].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return { name, count: sorted.length, medianMs: median, worstMs: sorted[sorted.length - 1] };
  });
}

/** Télécharge les mesures et leur résumé dans un fichier JSON (navigateur uniquement). */
export function downloadPerformanceSnapshot() {
  const payload = {
    exportedAt: new Date().toISOString(),
    summary: summarizePerformance(),
    samples: getPerformanceSnapshot(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `recompta-mesures-${payload.exportedAt.slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return payload.samples.length;
}

if (typeof window !== "undefined") {
  window.RecomptaPerf = Object.freeze({
    snapshot: getPerformanceSnapshot,
    summary: summarizePerformance,
    clear: clearPerformanceSnapshot,
    download: downloadPerformanceSnapshot,
  });
}
