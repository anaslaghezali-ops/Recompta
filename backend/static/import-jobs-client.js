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
  const ascii = base.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const safe = ascii
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 180);
  return safe || "document";
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
  if (activeOnly) return filterActiveImportJobs(data);
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
  if (job.status === "queued") {
    if ((job.uploaded_files || 0) >= job.total_files) return 0;
    return Math.round((job.uploaded_files / job.total_files) * 100);
  }
  return 0;
}

const STATUS_PRIORITY = { uploading: 3, processing: 2, queued: 1 };

export function aggregateActiveImportJobs(jobs) {
  if (!jobs?.length) return null;
  if (jobs.length === 1) return jobs[0];

  const sorted = [...jobs].sort(
    (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime(),
  );
  const base = sorted[0];
  let uploadedFiles = 0;
  let processedFiles = 0;
  let totalFiles = 0;
  let failedFiles = 0;
  let bestStatus = "queued";
  let bestPriority = 0;

  for (const job of jobs) {
    totalFiles += job.total_files || 0;
    uploadedFiles += job.uploaded_files || 0;
    processedFiles += job.processed_files || 0;
    failedFiles += job.failed_files || 0;
    const priority = STATUS_PRIORITY[job.status] || 0;
    if (priority > bestPriority) {
      bestPriority = priority;
      bestStatus = job.status;
    }
  }

  return {
    ...base,
    status: bestStatus,
    total_files: totalFiles,
    uploaded_files: uploadedFiles,
    processed_files: processedFiles,
    failed_files: failedFiles,
    aggregated_job_count: jobs.length,
  };
}

const STALE_IMPORT_MS = {
  uploading: 15 * 60 * 1000,
  queued: 30 * 60 * 1000,
  processing: 2 * 60 * 60 * 1000,
};

function importJobTouchedAt(job) {
  const raw = job?.updated_at || job?.started_at || job?.created_at;
  const time = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

export function isImportJobStale(job, now = Date.now()) {
  if (!job) return false;
  const touched = importJobTouchedAt(job);
  if (!touched) return false;

  if (job.status === "uploading" && (job.uploaded_files || 0) === 0) {
    return now - touched > 5 * 60 * 1000;
  }

  const maxAge = STALE_IMPORT_MS[job.status];
  if (!maxAge) return false;
  return now - touched > maxAge;
}

export function isImportJobActive(job, now = Date.now()) {
  if (!job) return false;
  if (!["uploading", "queued", "processing"].includes(job.status)) return false;
  return !isImportJobStale(job, now);
}

export async function abandonStaleImportJob(job) {
  if (!isImportJobStale(job)) return false;

  if (job.status === "uploading" && (job.uploaded_files || 0) > 0) {
    const uploaded = job.uploaded_files || 0;
    const total = job.total_files || uploaded;
    await updateJob(job.id, {
      status: "queued",
      total_files: uploaded,
      error_summary: uploaded < total
        ? `Envoi interrompu — ${uploaded}/${total} fichier(s) reçu(s), traitement partiel.`
        : null,
    });
    return true;
  }

  const supabase = getSupabase();
  if (!supabase || !job?.id) return false;

  const { error } = await supabase
    .from("import_jobs")
    .update({
      status: "failed",
      error_summary: "Import interrompu ou expiré.",
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id)
    .in("status", ["uploading", "queued", "processing"]);

  if (!error) markImportJobSeen(job.id);
  return !error;
}

async function filterActiveImportJobs(jobs) {
  const active = [];
  for (const job of jobs || []) {
    if (isImportJobActive(job)) {
      active.push(job);
      continue;
    }
    if (isImportJobStale(job)) {
      await abandonStaleImportJob(job);
    }
  }
  return active;
}

export async function reconcileStaleImportJobs(dossierIds) {
  const supabase = getSupabase();
  if (!supabase || !dossierIds?.length) return;

  const { data, error } = await supabase
    .from("import_jobs")
    .select(
      "id, dossier_id, doc_type, status, total_files, uploaded_files, processed_files, failed_files, error_summary, created_at, started_at, finished_at, updated_at",
    )
    .in("dossier_id", dossierIds)
    .in("status", ["uploading", "queued", "processing"]);

  if (error) throw error;

  for (const job of data || []) {
    if (isImportJobStale(job)) {
      await abandonStaleImportJob(job);
    }
  }

  const { data: failedRecent, error: failedError } = await supabase
    .from("import_jobs")
    .select("id")
    .in("dossier_id", dossierIds)
    .eq("status", "failed")
    .gte("finished_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  if (!failedError) {
    for (const job of failedRecent || []) {
      markImportJobSeen(job.id);
    }
  }
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
  const batchNote = job.aggregated_job_count > 1 ? ` · ${job.aggregated_job_count} lots` : "";
  if (job.status === "processing" || job.status === "uploading") {
    return `${kind} ${progress}% · ${counts} fichier(s)${batchNote}`;
  }
  if (job.status === "queued") {
    return `${kind} en attente · ${job.total_files || 0} fichier(s)${batchNote}`;
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
  if (!job || job.status === "failed") return;
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
    .eq("status", "completed")
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
  const byDossier = new Map();
  for (const job of await filterActiveImportJobs(data)) {
    if (!byDossier.has(job.dossier_id)) byDossier.set(job.dossier_id, []);
    byDossier.get(job.dossier_id).push(job);
  }
  for (const [dossierId, jobs] of byDossier.entries()) {
    map.set(dossierId, aggregateActiveImportJobs(jobs));
  }
  return map;
}

export function countActiveImportJobs(importMap) {
  return importMap?.size || 0;
}

/**
 * Étape 1 : un job par fichier pour que le traitement serveur puisse démarrer
 * pendant l'envoi et survivre à une fermeture de page (fichiers déjà en queue).
 */
export async function queueInvoiceImport({
  dossierId,
  files,
  options = {},
  onProgress,
  onFileQueued,
}) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) throw new Error("Session ou dossier invalide.");
  if (!files?.length) throw new Error("Aucun fichier sélectionné.");

  onProgress?.("Préparation des fichiers…", 5);
  const expanded = await expandUploadedFiles(files);
  if (!expanded.length) throw new Error("Aucun fichier exploitable dans la sélection.");

  const { data: userData } = await supabase.auth.getUser();
  const createdBy = userData?.user?.id || null;

  const failures = [];
  const jobs = [];
  let uploaded = 0;
  const total = expanded.length;

  for (let index = 0; index < expanded.length; index += 1) {
    const item = expanded[index];
    const sourceId = nextSourceId();
    const mimeType = item.mime || "application/octet-stream";
    const blob = new Blob([item.content], { type: mimeType });

    onProgress?.(
      `Envoi ${index + 1}/${total} — ${item.filename}`,
      10 + Math.round((index / total) * 85),
    );

    const { data: job, error: jobError } = await supabase
      .from("import_jobs")
      .insert({
        dossier_id: dossierId,
        doc_type: "invoice",
        status: "uploading",
        total_files: 1,
        options,
        created_by: createdBy,
      })
      .select("id, dossier_id, doc_type, status, total_files, uploaded_files, processed_files, failed_files, created_at")
      .single();

    if (jobError) {
      failures.push({ filename: item.filename, error: jobError.message });
      continue;
    }

    const storagePath = buildImportStoragePath(dossierId, job.id, item.filename);

    const { error: uploadError } = await supabase.storage
      .from(IMPORT_QUEUE_BUCKET)
      .upload(storagePath, blob, { contentType: mimeType, upsert: false });

    if (uploadError) {
      await updateJob(job.id, {
        status: "failed",
        error_summary: uploadError.message,
        finished_at: new Date().toISOString(),
      });
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
      await updateJob(job.id, {
        status: "failed",
        error_summary: fileError.message,
        finished_at: new Date().toISOString(),
      });
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

    await updateJob(job.id, {
      status: "queued",
      uploaded_files: 1,
      total_files: 1,
    });

    uploaded += 1;
    jobs.push(await getImportJob(job.id));
    await onFileQueued?.(job.id, uploaded, total);
  }

  if (uploaded === 0) {
    throw new Error(failures[0]?.error || "Échec de l'envoi des fichiers.");
  }

  onProgress?.(
    failures.length
      ? `${uploaded}/${total} fichier(s) en file d'attente (${failures.length} échec(s)).`
      : "Tous les fichiers sont en file d'attente.",
    100,
  );

  return {
    job: aggregateActiveImportJobs(jobs) || jobs[0],
    jobs,
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

export async function getActiveImportSummary(dossierId) {
  const jobs = await listImportJobs(dossierId, { limit: 50, activeOnly: true });
  return aggregateActiveImportJobs(jobs);
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
