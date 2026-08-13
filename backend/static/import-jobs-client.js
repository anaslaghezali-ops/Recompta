import { getSupabase } from "./auth-client.js?v=auth6";
import { expandUploadedFiles } from "./extract-client.js";
import { uploadDossierDocument, uploadDossierDocumentFromBlob } from "./dossier-documents.js?v=doc1";

export const IMPORT_QUEUE_BUCKET = "import-queue";

export const JOB_STATUS_LABELS = {
  uploading: "Envoi en cours",
  queued: "En attente",
  processing: "Traitement en cours",
  completed: "Terminé",
  failed: "Échoué",
  cancelled: "Annulé",
};

export const DOC_TYPE_LABELS = {
  invoice: "factures",
  bank: "relevé bancaire",
};

const COMPLETION_NOTIFY_MIN_FILES = 5;
const COMPLETION_NOTIFY_MIN_TXNS = 50;
const SEEN_JOBS_STORAGE_KEY = "recompta_seen_import_jobs";

function nextSourceId() {
  return `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeFilename(name) {
  const base = (name || "document").split(/[/\\]/).pop();
  return base.replace(/[^\w.\- ()àâäéèêëïîôùûüçÀÂÄÉÈÊËÏÎÔÙÛÜÇ]/gi, "_").slice(0, 180);
}

export function buildImportStoragePath(dossierId, jobId, originalFilename) {
  const safe = sanitizeFilename(originalFilename);
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return `jobs/${dossierId}/${jobId}/${unique}_${safe}`;
}

export async function listImportJobs(dossierId, { limit = 10, activeOnly = false } = {}) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) return [];

  let query = supabase
    .from("import_jobs")
    .select(
      "id, dossier_id, doc_type, status, total_files, uploaded_files, processed_files, failed_files, error_summary, created_at, started_at, finished_at, updated_at",
    )
    .eq("dossier_id", dossierId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (activeOnly) {
    query = query.in("status", ["uploading", "queued", "processing"]);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getImportJob(jobId) {
  const supabase = getSupabase();
  if (!supabase || !jobId) return null;

  const { data, error } = await supabase
    .from("import_jobs")
    .select(
      "id, dossier_id, doc_type, status, total_files, uploaded_files, processed_files, failed_files, options, error_summary, created_at, started_at, finished_at, updated_at",
    )
    .eq("id", jobId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function updateJob(jobId, patch) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("import_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw error;
}

export function jobProgressPercent(job) {
  if (!job?.total_files) return 0;
  if (job.status === "uploading") {
    return Math.round((job.uploaded_files / job.total_files) * 100);
  }
  if (job.status === "processing" || job.status === "completed" || job.status === "failed") {
    return Math.round((job.processed_files / job.total_files) * 100);
  }
  if (job.status === "queued") return 0;
  return 0;
}

export function importDocTypeLabel(docType) {
  return DOC_TYPE_LABELS[docType] || "import";
}

export function importJobPageUrl(job, dossierId) {
  const id = dossierId || job?.dossier_id;
  if (!id) return "dossiers.html";
  if (job?.doc_type === "bank") return `import-banque.html?dossier=${id}`;
  return `import-achats.html?dossier=${id}`;
}

export function formatActiveImportLabel(job) {
  if (!job) return "";
  const progress = jobProgressPercent(job);
  const status = JOB_STATUS_LABELS[job.status] || job.status;
  const kind = importDocTypeLabel(job.doc_type);
  const counts = `${job.processed_files || 0}/${job.total_files || 0}`;
  if (job.status === "processing" || job.status === "uploading") {
    return `${kind} ${progress}% · ${counts} fichier(s)`;
  }
  if (job.status === "queued") {
    return `${kind} en attente · ${job.total_files || 0} fichier(s)`;
  }
  return `${kind} · ${status}`;
}

export function formatImportCompletionMessage(job) {
  if (!job) return "";
  const kind = importDocTypeLabel(job.doc_type);
  if (job.status === "failed") {
    return `Import ${kind} échoué${job.error_summary ? ` — ${job.error_summary}` : ""}`;
  }
  if (job.doc_type === "bank") {
    return `Relevé bancaire importé — ${job.processed_files || 1} fichier traité`;
  }
  const total = job.total_files || 0;
  const processed = job.processed_files || 0;
  const failed = job.failed_files || 0;
  if (failed > 0) {
    return `Import ${kind} terminé — ${processed}/${total} fichier(s), ${failed} erreur(s)`;
  }
  return `Import ${kind} terminé — ${processed} fichier(s) traité(s)`;
}

function readSeenJobIds() {
  try {
    const raw = localStorage.getItem(SEEN_JOBS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function writeSeenJobIds(ids) {
  const trimmed = ids.slice(-200);
  localStorage.setItem(SEEN_JOBS_STORAGE_KEY, JSON.stringify(trimmed));
}

export function markImportJobSeen(jobId) {
  if (!jobId) return;
  const key = String(jobId);
  const seen = readSeenJobIds();
  if (!seen.includes(key)) {
    writeSeenJobIds([...seen, key]);
  }
}

export function shouldNotifyImportCompletion(job) {
  if (!job || job.status !== "completed") return false;
  if (readSeenJobIds().includes(String(job.id))) return false;
  if ((job.total_files || 0) >= COMPLETION_NOTIFY_MIN_FILES) return true;
  if (job.doc_type === "bank") return true;
  return false;
}

export async function requestImportNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    const result = await Notification.requestPermission();
    return result === "granted";
  } catch {
    return false;
  }
}

export function showImportCompletionToast(job, { dossierName = "" } = {}) {
  if (!job) return;
  markImportJobSeen(job.id);

  const message = formatImportCompletionMessage(job);
  const prefix = dossierName ? `${dossierName} — ` : "";
  const text = `${prefix}${message}`;

  let container = document.getElementById("importToastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "importToastContainer";
    container.className = "import-toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `import-toast import-toast-${job.status === "failed" ? "error" : "success"}`;
  toast.innerHTML = `
    <div class="import-toast-body">
      <strong>${job.status === "failed" ? "Import échoué" : "Import terminé"}</strong>
      <p>${text}</p>
    </div>
    <a class="import-toast-link" href="${importJobPageUrl(job)}">Voir</a>
  `;
  container.appendChild(toast);

  window.setTimeout(() => {
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 300);
  }, 12000);

  if (shouldNotifyImportCompletion(job) && "Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(job.status === "failed" ? "Import échoué" : "Import terminé", {
        body: text,
        tag: `import-job-${job.id}`,
      });
    } catch {
      /* ignore notification errors */
    }
  }
}

export async function pollImportCompletions(dossierIds, onComplete, { sinceMinutes = 180 } = {}) {
  const supabase = getSupabase();
  if (!supabase || !dossierIds?.length) return [];

  const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("import_jobs")
    .select(
      "id, dossier_id, doc_type, status, total_files, uploaded_files, processed_files, failed_files, error_summary, finished_at, updated_at",
    )
    .in("dossier_id", dossierIds)
    .in("status", ["completed", "failed"])
    .gte("finished_at", since)
    .order("finished_at", { ascending: false })
    .limit(20);

  if (error) throw error;

  const fresh = (data || []).filter((job) => !readSeenJobIds().includes(String(job.id)));
  for (const job of fresh) {
    onComplete?.(job);
  }
  return fresh;
}

export function startImportCompletionWatcher(dossierIds, onComplete, intervalMs = 10000) {
  let stopped = false;
  requestImportNotificationPermission().catch(() => {});

  async function tick() {
    if (stopped) return;
    try {
      await pollImportCompletions(dossierIds, onComplete);
    } catch {
      /* ignore transient errors */
    }
  }

  tick();
  const timer = setInterval(tick, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function fetchActiveImportMap(dossierIds) {
  const supabase = getSupabase();
  if (!supabase || !dossierIds?.length) return new Map();

  const { data, error } = await supabase
    .from("import_jobs")
    .select(
      "id, dossier_id, doc_type, status, total_files, uploaded_files, processed_files, failed_files, created_at, updated_at",
    )
    .in("dossier_id", dossierIds)
    .in("status", ["uploading", "queued", "processing"])
    .order("created_at", { ascending: false });

  if (error) throw error;

  const map = new Map();
  for (const job of data || []) {
    if (!map.has(job.dossier_id)) map.set(job.dossier_id, job);
  }
  return map;
}

export function countActiveImportJobs(importMap) {
  return importMap?.size || 0;
}

/**
 * Étape 1 : prépare le lot, envoie les fichiers vers Storage, passe le job en `queued`.
 * Le traitement IA se fera côté worker (étape 2).
 */
export async function queueInvoiceImport({
  dossierId,
  files,
  options = {},
  onProgress,
}) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) throw new Error("Session ou dossier invalide.");
  if (!files?.length) throw new Error("Aucun fichier sélectionné.");

  onProgress?.("Préparation des fichiers…", 5);
  const expanded = await expandUploadedFiles(files);
  if (!expanded.length) throw new Error("Aucun fichier exploitable dans la sélection.");

  const { data: userData } = await supabase.auth.getUser();
  const createdBy = userData?.user?.id || null;

  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .insert({
      dossier_id: dossierId,
      doc_type: "invoice",
      status: "uploading",
      total_files: expanded.length,
      options,
      created_by: createdBy,
    })
    .select("id, dossier_id, doc_type, status, total_files, uploaded_files, processed_files, failed_files, created_at")
    .single();

  if (jobError) throw jobError;

  let uploaded = 0;
  const failures = [];

  for (let index = 0; index < expanded.length; index += 1) {
    const item = expanded[index];
    const sourceId = nextSourceId();
    const storagePath = buildImportStoragePath(dossierId, job.id, item.filename);
    const mimeType = item.mime || "application/octet-stream";
    const blob = new Blob([item.content], { type: mimeType });

    onProgress?.(
      `Envoi ${index + 1}/${expanded.length} — ${item.filename}`,
      10 + Math.round((index / expanded.length) * 80),
    );

    const { error: uploadError } = await supabase.storage
      .from(IMPORT_QUEUE_BUCKET)
      .upload(storagePath, blob, { contentType: mimeType, upsert: false });

    if (uploadError) {
      failures.push({ filename: item.filename, error: uploadError.message });
      continue;
    }

    const { error: fileError } = await supabase.from("import_job_files").insert({
      job_id: job.id,
      original_filename: item.filename,
      storage_path: storagePath,
      mime_type: mimeType,
      size_bytes: blob.size,
      status: "uploaded",
      source_id: sourceId,
    });

    if (fileError) {
      await supabase.storage.from(IMPORT_QUEUE_BUCKET).remove([storagePath]);
      failures.push({ filename: item.filename, error: fileError.message });
      continue;
    }

    uploadDossierDocumentFromBlob({
      dossierId,
      filename: item.filename,
      content: item.content,
      mime: mimeType,
      docType: "invoice",
      sourceId,
    }).catch(() => {});

    uploaded += 1;
    await updateJob(job.id, { uploaded_files: uploaded });
  }

  if (uploaded === 0) {
    await updateJob(job.id, {
      status: "failed",
      error_summary: failures[0]?.error || "Échec de l'envoi des fichiers.",
      finished_at: new Date().toISOString(),
    });
    throw new Error(failures[0]?.error || "Échec de l'envoi des fichiers.");
  }

  const finalStatus = failures.length ? "queued" : "queued";
  const errorSummary = failures.length
    ? `${failures.length} fichier(s) non envoyé(s) sur ${expanded.length}.`
    : null;

  await updateJob(job.id, {
    status: finalStatus,
    uploaded_files: uploaded,
    total_files: uploaded,
    error_summary: errorSummary,
  });

  onProgress?.("Import mis en file d'attente.", 100);

  return {
    job: await getImportJob(job.id),
    uploaded,
    skipped: failures.length,
    failures,
  };
}

/**
 * Import relevé bancaire asynchrone (1 fichier par job).
 */
export async function queueBankImport({
  dossierId,
  file,
  onProgress,
}) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) throw new Error("Session ou dossier invalide.");
  if (!file) throw new Error("Aucun fichier sélectionné.");

  onProgress?.("Préparation du relevé…", 5);

  const { data: userData } = await supabase.auth.getUser();
  const createdBy = userData?.user?.id || null;

  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .insert({
      dossier_id: dossierId,
      doc_type: "bank",
      status: "uploading",
      total_files: 1,
      options: {},
      created_by: createdBy,
    })
    .select("id, dossier_id, doc_type, status, total_files, uploaded_files, processed_files, failed_files, created_at")
    .single();

  if (jobError) throw jobError;

  const sourceId = nextSourceId();
  const storagePath = buildImportStoragePath(dossierId, job.id, file.name);
  const mimeType = file.type || "application/octet-stream";

  onProgress?.(`Envoi — ${file.name}`, 40);

  const { error: uploadError } = await supabase.storage
    .from(IMPORT_QUEUE_BUCKET)
    .upload(storagePath, file, { contentType: mimeType, upsert: false });

  if (uploadError) {
    await updateJob(job.id, {
      status: "failed",
      error_summary: uploadError.message,
      finished_at: new Date().toISOString(),
    });
    throw new Error(uploadError.message);
  }

  const { error: fileError } = await supabase.from("import_job_files").insert({
    job_id: job.id,
    original_filename: file.name,
    storage_path: storagePath,
    mime_type: mimeType,
    size_bytes: file.size,
    status: "uploaded",
    source_id: sourceId,
  });

  if (fileError) {
    await supabase.storage.from(IMPORT_QUEUE_BUCKET).remove([storagePath]);
    await updateJob(job.id, {
      status: "failed",
      error_summary: fileError.message,
      finished_at: new Date().toISOString(),
    });
    throw new Error(fileError.message);
  }

  uploadDossierDocument({
    dossierId,
    file,
    docType: "bank",
    sourceId,
  }).catch(() => {});

  await updateJob(job.id, {
    status: "queued",
    uploaded_files: 1,
    total_files: 1,
  });

  onProgress?.("Relevé mis en file d'attente.", 100);

  return {
    job: await getImportJob(job.id),
    uploaded: 1,
  };
}

export function startImportJobPolling(dossierId, onUpdate, intervalMs = 5000) {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const jobs = await listImportJobs(dossierId, { limit: 5, activeOnly: true });
      onUpdate(jobs);
      if (!jobs.length) stopped = true;
    } catch {
      /* ignore transient errors */
    }
  }

  tick();
  const timer = setInterval(tick, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
