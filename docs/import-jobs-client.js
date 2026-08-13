import { getSupabase } from "./auth-client.js?v=auth6";
import { expandUploadedFiles } from "./extract-client.js";

export const IMPORT_QUEUE_BUCKET = "import-queue";

export const JOB_STATUS_LABELS = {
  uploading: "Envoi en cours",
  queued: "En attente",
  processing: "Traitement en cours",
  completed: "Terminé",
  failed: "Échoué",
  cancelled: "Annulé",
};

function nextSourceId() {
  return `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
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
