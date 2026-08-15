import { getSupabase } from "./auth-client.js?v=auth6";
import { isInvoiceFile, isZipFile } from "./extract-client.js";
import {
  documentIdentityKeys,
  shouldSkipZipForAnalysis,
  sourceIdsWithLines,
} from "./dossier-documents.js?v=doc10";
import { startDossierAnalysis as apiStartDossierAnalysis, uploadImportJobFile } from "./api-client.js?v=api3";

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
      "id, dossier_id, doc_type, status, total_files, uploaded_files, processed_files, failed_files, options, error_summary, created_at, started_at, finished_at, updated_at",
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
  uploading: 5 * 60 * 1000,
  queued: 2 * 60 * 1000,
  processing: 20 * 60 * 1000,
};

function importJobTouchedAt(job) {
  const raw = job?.updated_at || job?.started_at || job?.created_at;
  const time = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

export function isImportJobStale(job, now = Date.now()) {
  if (!job) return false;
  const touched = importJobTouchedAt(job);
  if (!touched) return true;

  if (job.status === "uploading" && (job.uploaded_files || 0) === 0) {
    return now - touched > 90 * 1000;
  }
  if (job.status === "queued" && (job.processed_files || 0) === 0) {
    return now - touched > 2 * 60 * 1000;
  }
  if (job.status === "processing" && (job.processed_files || 0) === 0) {
    return now - touched > 8 * 60 * 1000;
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
}

export function importDocTypeLabel(docType) {
  return DOC_TYPE_LABELS[docType] || "import";
}

export function isAnalysisJob(job) {
  return Boolean(job?.options?.analysis_from_documents);
}

function ensureImportToastContainer() {
  let container = document.getElementById("importToastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "importToastContainer";
    container.className = "import-toast-container";
    document.body.appendChild(container);
  }
  return container;
}

export function showWorkspaceToast({
  title,
  message,
  variant = "info",
  linkUrl = null,
  linkLabel = "Voir",
  durationMs = 12000,
} = {}) {
  const container = ensureImportToastContainer();
  const toast = document.createElement("div");
  toast.className = `import-toast import-toast-${variant}`;
  toast.innerHTML = `
    <div class="import-toast-body">
      <strong>${title || ""}</strong>
      ${message ? `<p>${message}</p>` : ""}
    </div>
    ${linkUrl ? `<a class="import-toast-link" href="${linkUrl}">${linkLabel}</a>` : ""}
  `;
  container.appendChild(toast);

  window.setTimeout(() => {
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

export function showExtractionStartedToast({
  fileCount = 0,
  dossierName = "",
  label = "Extraction lancée",
} = {}) {
  const prefix = dossierName ? `${dossierName} — ` : "";
  const countLabel = fileCount > 0
    ? `${fileCount} fichier${fileCount > 1 ? "s" : ""} en file d'attente`
    : "Traitement démarré";
  showWorkspaceToast({
    title: label,
    message: `${prefix}${countLabel}. Suivez la progression sur cette page.`,
    variant: "info",
    durationMs: 10000,
  });
}

export const showAnalysisStartedToast = showExtractionStartedToast;

export function workspacePageUrl(clientId, dossierId, { tab = null, view = null } = {}) {
  const params = new URLSearchParams();
  if (clientId) params.set("client", clientId);
  if (dossierId) params.set("dossier", dossierId);
  if (tab) params.set("tab", tab);
  if (view) params.set("view", view);
  const qs = params.toString();
  return `workspace.html${qs ? `?${qs}` : ""}`;
}

export function importJobPageUrl(job, dossierId, clientId = null) {
  const id = dossierId || job?.dossier_id;
  if (!id) return "dossiers.html";
  if (clientId) {
    return workspacePageUrl(clientId, id, { tab: "cockpit" });
  }
  if (job?.doc_type === "bank") return `import-banque.html?dossier=${id}`;
  return `import-achats.html?dossier=${id}`;
}

export function formatActiveImportLabel(job) {
  if (!job) return "";
  const progress = jobProgressPercent(job);
  const status = JOB_STATUS_LABELS[job.status] || job.status;
  const analysis = isAnalysisJob(job);
  const kind = analysis ? "Analyse IA" : importDocTypeLabel(job.doc_type);
  const docKind = importDocTypeLabel(job.doc_type);
  const counts = `${job.processed_files || 0}/${job.total_files || 0}`;
  const batchNote = job.aggregated_job_count > 1 ? ` · ${job.aggregated_job_count} lots` : "";
  if (job.status === "processing" || job.status === "uploading") {
    const detail = analysis ? docKind : kind;
    return `${kind} — ${detail} ${progress}% · ${counts} fichier(s)${batchNote}`;
  }
  if (job.status === "queued") {
    const detail = analysis ? docKind : kind;
    return `${kind} — ${detail} en attente · ${job.total_files || 0} fichier(s)${batchNote}`;
  }
  return `${kind} · ${status}`;
}

export function formatImportCompletionMessage(job) {
  if (!job) return "";
  const kind = importDocTypeLabel(job.doc_type);
  const analysis = isAnalysisJob(job);
  if (job.status === "failed") {
    if (analysis) {
      return `Analyse ${kind} échouée${job.error_summary ? ` — ${job.error_summary}` : ""}`;
    }
    return `Import ${kind} échoué${job.error_summary ? ` — ${job.error_summary}` : ""}`;
  }
  if (job.doc_type === "bank") {
    if (analysis) {
      return `Relevé bancaire analysé — ${job.processed_files || 1} fichier traité`;
    }
    return `Relevé bancaire importé — ${job.processed_files || 1} fichier traité`;
  }
  const total = job.total_files || 0;
  const processed = job.processed_files || 0;
  const failed = job.failed_files || 0;
  if (failed > 0) {
    if (analysis) {
      return `Analyse ${kind} terminée — ${processed}/${total} fichier(s), ${failed} erreur(s)`;
    }
    return `Import ${kind} terminé — ${processed}/${total} fichier(s), ${failed} erreur(s)`;
  }
  if (analysis) {
    return `Analyse ${kind} terminée — ${processed} fichier(s) traité(s)`;
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
  if (!job || !["completed", "failed"].includes(job.status)) return false;
  if (readSeenJobIds().includes(String(job.id))) return false;
  if (job.options?.analysis_from_documents) return true;
  if ((job.total_files || 0) >= COMPLETION_NOTIFY_MIN_FILES) return true;
  if (job.doc_type === "bank") return true;
  return (job.processed_files || 0) > 0;
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

export function showImportCompletionToast(job, { dossierName = "", clientId = null } = {}) {
  if (!job) return;
  markImportJobSeen(job.id);

  const message = formatImportCompletionMessage(job);
  const prefix = dossierName ? `${dossierName} — ` : "";
  const text = `${prefix}${message}`;
  const analysis = isAnalysisJob(job);
  const title = job.status === "failed"
    ? (analysis ? "Analyse échouée" : "Import échoué")
    : (analysis ? "Analyse IA terminée" : "Import terminé");
  const linkUrl = clientId
    ? workspacePageUrl(clientId, job.dossier_id, { tab: analysis ? "review" : "cockpit" })
    : importJobPageUrl(job, job.dossier_id, clientId);

  showWorkspaceToast({
    title,
    message: text,
    variant: job.status === "failed" ? "error" : "success",
    linkUrl,
    linkLabel: analysis ? "Revue" : "Voir",
  });

  if (shouldNotifyImportCompletion(job) && "Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, {
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
      "id, dossier_id, doc_type, status, total_files, uploaded_files, processed_files, failed_files, options, error_summary, finished_at, updated_at",
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

function isQueueableFile(file) {
  return isZipFile(file?.name) || isInvoiceFile(file?.name);
}

async function packFilesForQueue(files, onProgress) {
  const list = Array.from(files || []).filter(isQueueableFile);
  if (!list.length) throw new Error("Aucun fichier exploitable (PDF, image ou ZIP).");
  if (list.length === 1) return list;

  if (typeof JSZip === "undefined") return list;

  onProgress?.("Préparation de l'archive…", 8);
  const zip = new JSZip();
  const usedNames = new Set();
  for (let index = 0; index < list.length; index += 1) {
    const file = list[index];
    let entryName = file.name;
    if (usedNames.has(entryName)) {
      entryName = `${index + 1}_${file.name}`;
    }
    usedNames.add(entryName);
    zip.file(entryName, await file.arrayBuffer());
  }
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  return [new File([blob], `import-${Date.now()}.zip`, { type: "application/zip" })];
}

async function createUploadingInvoiceJob(dossierId, options, createdBy) {
  const supabase = getSupabase();
  const { data: job, error } = await supabase
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
  if (error) throw error;
  return job;
}

async function uploadInvoiceJobViaServer(apiUrl, jobId, file, { onProgress, onFileQueued, dossierId } = {}) {
  try {
    const result = await uploadImportJobFile(apiUrl, jobId, file, { onProgress });
    await onFileQueued?.(jobId);
    return result.job || (await getImportJob(jobId));
  } catch (error) {
    if (error?.code !== "UPLOAD_ROUTE_MISSING" || !dossierId) throw error;
    onProgress?.("Route serveur absente — envoi direct vers la plateforme…", 20);
    const job = await getImportJob(jobId);
    if (!job) throw error;
    return uploadInvoiceJobViaClient(dossierId, job, file, { onFileQueued });
  }
}

async function uploadInvoiceJobViaClient(dossierId, job, file, { onFileQueued } = {}) {
  const supabase = getSupabase();
  const sourceId = nextSourceId();
  const mimeType = file.type || (isZipFile(file.name) ? "application/zip" : "application/octet-stream");
  const storagePath = buildImportStoragePath(dossierId, job.id, file.name);

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

  await updateJob(job.id, {
    status: "queued",
    uploaded_files: 1,
    total_files: 1,
  });

  await onFileQueued?.(job.id);
  return getImportJob(job.id);
}

async function runInvoiceUploadBatch({
  dossierId,
  packed,
  options,
  createdBy,
  apiUrl,
  onProgress,
  onFileQueued,
}) {
  const failures = [];
  const jobs = [];
  const total = packed.length;

  for (let index = 0; index < packed.length; index += 1) {
    const file = packed[index];
    try {
      const job = await createUploadingInvoiceJob(dossierId, options, createdBy);
      onProgress?.(
        total === 1 ? `Envoi — ${file.name}` : `Envoi ${index + 1}/${total} — ${file.name}`,
        12 + Math.round((index / total) * 8),
      );
      const uploadedJob = apiUrl
        ? await uploadInvoiceJobViaServer(apiUrl, job.id, file, { onProgress, onFileQueued, dossierId })
        : await uploadInvoiceJobViaClient(dossierId, job, file, { onFileQueued });
      jobs.push(uploadedJob);
    } catch (error) {
      failures.push({ filename: file.name, error: error.message });
    }
  }

  if (!jobs.length && failures.length) {
    throw new Error(failures[0]?.error || "Échec de l'envoi des fichiers.");
  }

  onProgress?.(
    "Envoi terminé. Le serveur décompresse et traite les factures — vous pouvez quitter cette page.",
    100,
  );

  return {
    job: aggregateActiveImportJobs(jobs) || jobs[0],
    jobs,
    uploaded: jobs.length,
    skipped: failures.length,
    failures,
  };
}

/**
 * Démarre l'envoi sans bloquer la page : le job apparaît tout de suite, l'upload continue en arrière-plan.
 */
export async function startInvoiceImportUpload({
  dossierId,
  files,
  options = {},
  onProgress,
  onFileQueued,
  onComplete,
  onError,
}) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) throw new Error("Session ou dossier invalide.");
  if (!files?.length) throw new Error("Aucun fichier sélectionné.");

  const apiUrl = options?.api_url?.replace(/\/$/, "") || "";
  if (!apiUrl) {
    const result = await queueInvoiceImport({ dossierId, files, options, onProgress, onFileQueued });
    onComplete?.(result);
    return result;
  }

  onProgress?.("Préparation de l'envoi…", 5);
  const packed = await packFilesForQueue(files, onProgress);
  const { data: userData } = await supabase.auth.getUser();
  const createdBy = userData?.user?.id || null;

  const pending = [];
  for (const file of packed) {
    const job = await createUploadingInvoiceJob(dossierId, options, createdBy);
    pending.push({ job, file });
    await onFileQueued?.(job.id);
  }

  onProgress?.(
    "Envoi démarré — suivez la progression ici ou sur le workspace (nouvel onglet).",
    8,
  );

  (async () => {
    const failures = [];
    const jobs = [];
    try {
      for (let index = 0; index < pending.length; index += 1) {
        const { job, file } = pending[index];
        try {
          const uploadedJob = await uploadInvoiceJobViaServer(apiUrl, job.id, file, {
            onProgress,
            onFileQueued,
            dossierId,
          });
          jobs.push(uploadedJob);
        } catch (error) {
          failures.push({ filename: file.name, error: error.message });
        }
      }
      if (!jobs.length && failures.length) {
        throw new Error(failures[0]?.error || "Échec de l'envoi des fichiers.");
      }
      onProgress?.(
        "Envoi terminé. Le serveur décompresse et traite les factures — vous pouvez quitter cette page.",
        100,
      );
      onComplete?.({
        job: aggregateActiveImportJobs(jobs) || jobs[0],
        jobs,
        uploaded: jobs.length,
        skipped: failures.length,
        failures,
      });
    } catch (error) {
      onError?.(error);
    }
  })();

  return {
    started: true,
    fileCount: pending.length,
    jobs: pending.map((item) => item.job),
  };
}

/**
 * Envoie les fichiers originaux (ZIP inclus) sans les décompresser dans le navigateur.
 * Le worker backend décompresse et traite les factures après l'envoi.
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

  onProgress?.("Préparation de l'envoi…", 5);
  const packed = await packFilesForQueue(files, onProgress);
  const { data: userData } = await supabase.auth.getUser();
  const createdBy = userData?.user?.id || null;
  const apiUrl = options?.api_url?.replace(/\/$/, "") || "";

  return runInvoiceUploadBatch({
    dossierId,
    packed,
    options,
    createdBy,
    apiUrl,
    onProgress,
    onFileQueued,
  });
}

/**
 * Import relevé bancaire asynchrone (1 fichier par job).
 */
export async function queueBankImport({
  dossierId,
  file,
  options = {},
  onProgress,
  onFileQueued,
}) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) throw new Error("Session ou dossier invalide.");
  if (!file) throw new Error("Aucun fichier sélectionné.");

  onProgress?.("Préparation du relevé…", 5);

  const { data: userData } = await supabase.auth.getUser();
  const createdBy = userData?.user?.id || null;
  const apiUrl = options?.api_url?.replace(/\/$/, "") || "";

  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .insert({
      dossier_id: dossierId,
      doc_type: "bank",
      status: "uploading",
      total_files: 1,
      options,
      created_by: createdBy,
    })
    .select("id, dossier_id, doc_type, status, total_files, uploaded_files, processed_files, failed_files, created_at")
    .single();

  if (jobError) throw jobError;

  onProgress?.(`Envoi — ${file.name}`, 12);
  await onFileQueued?.(job.id);

  if (apiUrl) {
    const uploaded = await uploadInvoiceJobViaServer(apiUrl, job.id, file, {
      onProgress,
      onFileQueued,
      dossierId,
    });
    onProgress?.("Relevé en file d'attente. Le serveur analyse le fichier — vous pouvez quitter cette page.", 100);
    return { job: uploaded, uploaded: 1 };
  }

  const sourceId = nextSourceId();
  const storagePath = buildImportStoragePath(dossierId, job.id, file.name);
  const mimeType = file.type || "application/octet-stream";

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

export async function startBankImportUpload({
  dossierId,
  file,
  options = {},
  onProgress,
  onFileQueued,
  onComplete,
  onError,
}) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) throw new Error("Session ou dossier invalide.");
  if (!file) throw new Error("Aucun fichier sélectionné.");

  const apiUrl = options?.api_url?.replace(/\/$/, "") || "";
  if (!apiUrl) {
    const result = await queueBankImport({ dossierId, file, options, onProgress, onFileQueued });
    onComplete?.(result);
    return result;
  }

  onProgress?.("Préparation de l'envoi…", 5);
  const { data: userData } = await supabase.auth.getUser();
  const createdBy = userData?.user?.id || null;

  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .insert({
      dossier_id: dossierId,
      doc_type: "bank",
      status: "uploading",
      total_files: 1,
      options,
      created_by: createdBy,
    })
    .select("id, dossier_id, doc_type, status, total_files, uploaded_files, processed_files, failed_files, created_at")
    .single();

  if (jobError) throw jobError;
  await onFileQueued?.(job.id);
  onProgress?.("Envoi démarré — suivez la progression ici ou sur le workspace (nouvel onglet).", 8);

  (async () => {
    try {
      const uploaded = await uploadInvoiceJobViaServer(apiUrl, job.id, file, {
        onProgress,
        onFileQueued,
        dossierId,
      });
      onProgress?.(
        "Envoi terminé. Le serveur analyse le relevé — vous pouvez quitter cette page.",
        100,
      );
      onComplete?.({ job: uploaded, uploaded: 1 });
    } catch (error) {
      onError?.(error);
    }
  })();

  return { started: true, job };
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

export function countPendingAnalysis(documents, workspace) {
  const lines = workspace?.lines || [];
  const bank = workspace?.bank_transactions || [];
  const processedKeys = new Set();

  for (const line of lines) {
    for (const key of documentIdentityKeys(line.source_file || "")) {
      processedKeys.add(key);
    }
    if (line.source_id) processedKeys.add(`sid:${line.source_id}`);
  }

  let invoicePending = 0;
  let bankPending = 0;
  const withLines = sourceIdsWithLines(lines);

  for (const doc of documents || []) {
    if (doc.doc_type === "invoice") {
      if (shouldSkipZipForAnalysis(doc, documents, processedKeys, withLines)) continue;
      const sid = doc.source_id ? `sid:${doc.source_id}` : null;
      const keys = documentIdentityKeys(doc.original_filename || "");
      const processed = sid
        ? withLines.has(doc.source_id)
        : [...keys].some((key) => processedKeys.has(key));
      if (!processed) invoicePending += 1;
    } else if (doc.doc_type === "bank" && bank.length === 0) {
      bankPending += 1;
    }
  }

  return {
    invoicePending,
    bankPending,
    total: invoicePending + bankPending,
  };
}

export async function launchDossierAnalysis(apiUrl, dossierId, { docType = "invoice", clientIce = "" } = {}) {
  return apiStartDossierAnalysis(apiUrl, dossierId, { docType, clientIce });
}
