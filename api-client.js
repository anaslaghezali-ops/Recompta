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
  "Le serveur ne répond pas pour l'instant. Si le Codespace vient de démarrer, attendez 10–20 s puis réessayez. " +
  "Sinon : uvicorn actif, port 8000 en Public, URL à jour dans les paramètres ci-dessous.";

const PORT_ACCESS_HINT =
  "Accès refusé au Codespace — ouvrez l'onglet Ports, port 8000 → visibilité Public, puis réessayez.";

const FETCH_TIMEOUT_MS = 15000;
const HEALTH_TIMEOUT_MS = 12000;
const ANALYSIS_QUEUE_TIMEOUT_MS = 120000;
/** Scans + Vision : un lot peut dépasser 60 s (rendu PDF + appel OpenAI). */
const EXTRACT_TIMEOUT_MS = 300000;
const HEALTH_RETRY_ATTEMPTS = 3;

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `Le serveur met trop de temps à répondre (${Math.round(timeoutMs / 1000)} s). ` +
        (timeoutMs >= EXTRACT_TIMEOUT_MS
          ? "Les scans IA sont lourds — réessayez ou réduisez le nombre de fichiers par lot."
          : "Réessayez dans quelques secondes — le Codespace peut être en train de se réveiller."),
      );
    }
    throw new Error(UNREACHABLE_HINT);
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchOrExplain(url, options, { attempts = 2, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return fetchWithRetry(url, options, attempts, timeoutMs);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Une coupure ponctuelle du tunnel Codespace ne doit pas perdre le lot. */
async function fetchWithRetry(url, options, attempts = 2, timeoutMs = FETCH_TIMEOUT_MS) {
  for (let i = 0; ; i += 1) {
    try {
      return await fetchWithTimeout(url, options, timeoutMs);
    } catch (error) {
      if (i >= attempts - 1) throw error;
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
    return new Error(PORT_ACCESS_HINT);
  }
  return new Error(detail || `Erreur serveur (${response.status})`);
}

export async function fetchServerHealth(apiUrl, { refresh = false } = {}) {
  const url = refresh ? `${apiUrl}/api/health?refresh=true` : `${apiUrl}/api/health`;
  const response = await fetchOrExplain(url, {}, {
    attempts: HEALTH_RETRY_ATTEMPTS,
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
}

// Envoi par petits lots : une requête unique de 100 fichiers dépasserait
// largement les délais du navigateur et du proxy Codespace.
const DEFAULT_BATCH_SIZE = 4;
// Un seul lot HTTP en vol : évite de saturer le tunnel Codespace pendant la Vision.
const DEFAULT_PARALLEL_BATCHES = 1;
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

  const response = await fetchWithRetry(
    `${apiUrl}/api/extract`,
    {
      method: "POST",
      body: formData,
    },
    2,
    EXTRACT_TIMEOUT_MS,
  );
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

export async function ensureImportWorkerRunning(apiUrl, { limit = 2 } = {}) {
  if (!apiUrl) {
    return {
      ok: false,
      message:
        "URL serveur non configurée — renseignez l'URL publique du Codespace (port 8000) ci-dessous.",
    };
  }

  try {
    const health = await fetchServerHealth(apiUrl);
    if (!health.import_worker_enabled) {
      return {
        ok: false,
        message:
          "Worker inactif : ajoutez SUPABASE_SERVICE_ROLE_KEY dans backend/.env du Codespace, puis redémarrez uvicorn.",
      };
    }

    await kickImportJobWorker(apiUrl, { limit });
    return {
      ok: true,
      message: "Traitement lancé sur le serveur.",
      pollSeconds: health.import_worker_poll_seconds,
    };
  } catch (error) {
    return {
      ok: false,
      transient: true,
      message: error.message || UNREACHABLE_HINT,
    };
  }
}

export function uploadImportJobFile(apiUrl, jobId, file, { onProgress } = {}) {
  const base = (apiUrl || "").replace(/\/$/, "");
  if (!base || !jobId || !file) {
    return Promise.reject(new Error("Paramètres d'envoi invalides."));
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append("file", file, file.name);

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || !onProgress) return;
      const percent = 12 + Math.round((event.loaded / event.total) * 83);
      onProgress(`Envoi — ${file.name}`, percent);
    });

    xhr.addEventListener("load", () => {
      let body = {};
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        body = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body);
        return;
      }
      if (xhr.status === 405 || xhr.status === 404) {
        const error = new Error(
          "Backend Codespace pas à jour : dans le terminal, git pull origin main puis redémarrez uvicorn.",
        );
        error.code = "UPLOAD_ROUTE_MISSING";
        error.status = xhr.status;
        reject(error);
        return;
      }
      const detail = body.detail || xhr.responseText || `Erreur serveur (${xhr.status})`;
      reject(new Error(detail));
    });

    xhr.addEventListener("error", () => reject(new Error(UNREACHABLE_HINT)));
    xhr.addEventListener("abort", () => reject(new Error("Envoi annulé.")));

    xhr.open("POST", `${base}/api/import-jobs/${jobId}/upload`);
    xhr.send(formData);
  });
}

export async function startDossierAnalysis(apiUrl, dossierId, { docType = "invoice", clientIce = "" } = {}) {
  if (!apiUrl) throw new Error("Renseignez l'URL du Codespace (port 8000) pour lancer l'analyse IA.");
  const params = new URLSearchParams({ doc_type: docType, client_ice: clientIce || "" });
  const response = await fetchOrExplain(
    `${apiUrl.replace(/\/$/, "")}/api/dossiers/${dossierId}/analyze?${params}`,
    { method: "POST" },
    { attempts: 2, timeoutMs: ANALYSIS_QUEUE_TIMEOUT_MS },
  );
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
}
