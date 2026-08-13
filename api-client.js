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
  "Serveur injoignable. Dans le Codespace : onglet Ports → 8000 → clic droit → " +
  "Port Visibility → Public. La visibilité redevient Privée à chaque redémarrage du Codespace.";

async function fetchOrExplain(url, options) {
  try {
    return await fetch(url, options);
  } catch {
    throw new Error(UNREACHABLE_HINT);
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

export async function fetchServerHealth(apiUrl) {
  const response = await fetchOrExplain(`${apiUrl}/api/health`);
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
}

// Envoi par petits lots : une requête unique de 100 fichiers dépasserait
// largement les délais du navigateur et du proxy Codespace.
const DEFAULT_BATCH_SIZE = 4;

async function extractBatch(batch, apiUrl, normalizedIce) {
  const formData = new FormData();
  batch.forEach((file) => formData.append("files", file));
  if (normalizedIce.length === 15) formData.append("client_ice", normalizedIce);

  const response = await fetchOrExplain(`${apiUrl}/api/extract`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
}

export async function extractViaServer(
  files,
  apiUrl,
  { onProgress, clientIce, batchSize = DEFAULT_BATCH_SIZE } = {},
) {
  const normalizedIce = (clientIce || "").replace(/\D/g, "");
  const list = Array.from(files);

  const batches = [];
  for (let i = 0; i < list.length; i += batchSize) {
    batches.push(list.slice(i, i + batchSize));
  }

  const results = [];
  let done = 0;

  for (const batch of batches) {
    if (onProgress) {
      onProgress(done, list.length, `Extraction IA — ${done}/${list.length} fichier(s)…`);
    }

    try {
      results.push(...(await extractBatch(batch, apiUrl, normalizedIce)));
    } catch (error) {
      // Serveur injoignable : inutile d'insister sur les lots suivants.
      if (error.message === UNREACHABLE_HINT) throw error;
      batch.forEach((file) => {
        results.push({
          filename: file.name,
          lines: [],
          engine: "ai",
          warnings: [`Lot en échec : ${error.message}`],
        });
      });
    }

    done += batch.length;
    if (onProgress) {
      onProgress(done, list.length, `Extraction IA — ${done}/${list.length} fichier(s)…`);
    }
  }

  return results;
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
