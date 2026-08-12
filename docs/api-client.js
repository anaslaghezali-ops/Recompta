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

export async function fetchServerHealth(apiUrl) {
  const response = await fetch(`${apiUrl}/api/health`);
  if (!response.ok) throw new Error(`Serveur injoignable (${response.status})`);
  return response.json();
}

export async function extractViaServer(files, apiUrl, onProgress) {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  if (onProgress) onProgress(0, files.length, "Envoi au serveur IA…");

  const response = await fetch(`${apiUrl}/api/extract`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Erreur serveur (${response.status})`);
  }

  if (onProgress) onProgress(files.length, files.length, "Terminé");
  return response.json();
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
