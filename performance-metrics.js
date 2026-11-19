// Mesures de performance locales : aucune requête réseau et aucune donnée métier conservée.
const samples = [];
const MAX_SAMPLES = 200;
function now() { return globalThis.performance?.now ? globalThis.performance.now() : Date.now(); }
function record(name, startedAt, details = {}, error = null) {
  const durationMs = Math.max(0, now() - startedAt);
  const safeDetails = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (/count|rows|bytes|attempts/i.test(key) && Number.isFinite(Number(value))) safeDetails[key] = Number(value);
  }
  samples.push({ name: String(name), durationMs: Math.round(durationMs * 100) / 100, at: new Date().toISOString(), ok: !error, ...safeDetails });
  if (samples.length > MAX_SAMPLES) samples.shift();
  return durationMs;
}
export function startPerformance(name, details = {}) {
  const startedAt = now(); let ended = false;
  return (error = null, extra = {}) => { if (ended) return 0; ended = true; return record(name, startedAt, { ...details, ...extra }, error); };
}
export function measureSyncPerformance(name, operation, details = {}) {
  const end = startPerformance(name, details);
  try { const result = operation(); end(); return result; } catch (error) { end(error); throw error; }
}
export async function measurePerformance(name, operation, details = {}) {
  const end = startPerformance(name, details);
  try { const result = await operation(); end(); return result; } catch (error) { end(error); throw error; }
}
export function getPerformanceSnapshot() { return samples.map((sample) => ({ ...sample })); }
export function clearPerformanceSnapshot() { samples.length = 0; }
if (typeof window !== "undefined") window.RecomptaPerf = Object.freeze({ snapshot: getPerformanceSnapshot, clear: clearPerformanceSnapshot });
