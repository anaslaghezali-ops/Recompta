const STORAGE_KEY = "recompta_api_url";

export function getApiUrl() {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".onrender.com")) {
    return window.location.origin.replace(/\/$/, "");
  }
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved ? saved.replace(/\/$/, "") : "";
}

export function saveApiUrl(url) {
  const cleaned = (url || "").trim().replace(/\/$/, "");
  if (cleaned) localStorage.setItem(STORAGE_KEY, cleaned);
  else localStorage.removeItem(STORAGE_KEY);
}

const UNREACHABLE_HINT =
  "Connexion au serveur interrompue. Vérifiez, dans l'ordre : (1) uvicorn tourne " +
  "toujours dans le Codespace, (2) port 8000 en Public, (3) l'URL correspond au " +
  "Codespace actuel.";

async function fetchOrExplain(url, options) {
  try {
    return await fetch(url, options);
  } catch {
    throw new Error(UNREACHABLE_HINT);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Une coupure ponctuelle du tunnel Codespace ne doit pas perdre le lot. */
async function fetchWithRetry(url, options, attempts = 2) {
  for (let i = 0; ; i += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (i >= attempts - 1) throw new Error(UNREACHABLE_HINT);
      await sleep(1000 * (i + 1));
    }
  }
}

async function errorFromResponse(response) {
  let detail = "";
  try {
    const body = await response.text();
    try {
      detail = JSON.parse(body).detail || body;
    } catch {
      detail = body;
    }
  } catch {
    detail = "";
  }
  if (response.status === 302 || response.status === 401 || response.status === 403) {
    return new Error(UNREACHABLE_HINT);
  }
  return new Error(detail || `Erreur serveur (${response.status})`);
}

export async function fetchServerHealth(apiUrl, { refresh = false } = {}) {
  const url = refresh ? `${apiUrl}/api/health?refresh=true` : `${apiUrl}/api/health`;
  const response = await fetchOrExplain(url);
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
}

// Envoi par petits lots : une requête unique de 100 fichiers dépasserait
// largement les délais du navigateur et du proxy Codespace.
const DEFAULT_BATCH_SIZE = 4;
// Deux lots en vol : l'envoi du suivant recouvre le traitement du précédent.
const DEFAULT_PARALLEL_BATCHES = 2;
// Les scans font souvent 1 à 2 Mo ; au-delà, le tunnel Codespace coupe.
const MAX_BATCH_BYTES = 3 * 1024 * 1024;

/** Lots bornés à la fois en nombre de fichiers et en octets. */
function buildBatches(list, batchSize, maxBytes) {
  const batches = [];
  let current = [];
  let bytes = 0;

  for (const file of list) {
    const size = file.size || 0;
    if (current.length && (current.length >= batchSize || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function extractBatch(batch, apiUrl, normalizedIce) {
  const formData = new FormData();
  batch.forEach((file) => formData.append("files", file));
  if (normalizedIce.length === 15) formData.append("client_ice", normalizedIce);

  const response = await fetchWithRetry(`${apiUrl}/api/extract`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
}

export async function extractViaServer(
  files,
  apiUrl,
  {
    onProgress,
    clientIce,
    batchSize = DEFAULT_BATCH_SIZE,
    parallelBatches = DEFAULT_PARALLEL_BATCHES,
  } = {},
) {
  const normalizedIce = (clientIce || "").replace(/\D/g, "");
  const list = Array.from(files);

  const batches = buildBatches(list, batchSize, MAX_BATCH_BYTES);

  const results = new Array(batches.length);
  let nextIndex = 0;
  let done = 0;
  let abortError = null;

  const report = () => {
    if (onProgress) {
      onProgress(done, list.length, `Extraction IA — ${done}/${list.length} fichier(s)…`);
    }
  };

  async function worker() {
    while (!abortError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= batches.length) return;

      const batch = batches[index];
      try {
        results[index] = await extractBatch(batch, apiUrl, normalizedIce);
      } catch (error) {
        // Serveur injoignable : inutile d'insister sur les lots suivants.
        if (error.message === UNREACHABLE_HINT) {
          abortError = error;
          return;
        }
        results[index] = batch.map((file) => ({
          filename: file.name,
          lines: [],
          engine: "ai",
          warnings: [`Lot en échec : ${error.message}`],
        }));
      }
      done += batch.length;
      report();
    }
  }

  report();
  const workers = Math.max(1, Math.min(parallelBatches, batches.length));
  await Promise.all(Array.from({ length: workers }, worker));

  if (abortError) throw abortError;
  return results.flat();
}

export function needsAiRetry(result) {
  if (!result.lines?.length) return true;
  return result.lines.every(
    (line) => !(Math.abs(Number(line.m_ht)) > 0) && !(Math.abs(Number(line.m_ttc)) > 0),
  );
}

export function mergeWithAiRetry(localResults, aiResults) {
  const aiByFile = new Map(aiResults.map((r) => [r.filename, r]));
  return localResults.map((result) => {
    if (!needsAiRetry(result)) return result;
    const upgraded = aiByFile.get(result.filename);
    return upgraded?.lines?.length ? upgraded : result;
  });
}

export async function parseBankStatementViaServer(file, apiUrl) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetchWithRetry(`${apiUrl}/api/import-bank-statement`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
}

export async function kickImportJobWorker(apiUrl, { limit = 1 } = {}) {
  if (!apiUrl) return null;
  const response = await fetchOrExplain(
    `${apiUrl.replace(/\/$/, "")}/api/import-jobs/process?limit=${limit}`,
    { method: "POST" },
  );
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
}
