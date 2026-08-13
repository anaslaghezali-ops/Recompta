import { getSupabase } from "./auth-client.js?v=auth6";

export const DOCUMENTS_BUCKET = "dossier-documents";

export const DOC_TYPE_LABELS = {
  invoice: "Facture achat",
  bank: "Relevé bancaire",
  archive: "Archive",
};

export const DOC_TYPE_ICONS = {
  invoice: "file-text",
  bank: "landmark",
  archive: "archive",
};

function sanitizeFilename(name) {
  const base = (name || "document").split(/[/\\]/).pop();
  return base.replace(/[^\w.\- ()àâäéèêëïîôùûüçÀÂÄÉÈÊËÏÎÔÙÛÜÇ]/gi, "_").slice(0, 180);
}

export function buildStoragePath(dossierId, originalFilename) {
  const safe = sanitizeFilename(originalFilename);
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return `dossier/${dossierId}/${unique}_${safe}`;
}

export async function uploadDossierDocument({ dossierId, file, docType, sourceId = null }) {
  const supabase = getSupabase();
  if (!supabase || !dossierId || !file) return null;

  const originalFilename = file.name || "document";
  const storagePath = buildStoragePath(dossierId, originalFilename);
  const mimeType = file.type || "application/octet-stream";

  const { error: uploadError } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath, file, { contentType: mimeType, upsert: false });

  if (uploadError) throw uploadError;

  const { data: userData } = await supabase.auth.getUser();
  const uploadedBy = userData?.user?.id || null;

  const { data, error } = await supabase
    .from("dossier_documents")
    .insert({
      dossier_id: dossierId,
      doc_type: docType,
      original_filename: originalFilename,
      storage_path: storagePath,
      mime_type: mimeType,
      size_bytes: file.size || 0,
      source_id: sourceId,
      uploaded_by: uploadedBy,
    })
    .select("id, dossier_id, doc_type, original_filename, storage_path, mime_type, size_bytes, source_id, created_at")
    .single();

  if (error) {
    await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath]);
    throw error;
  }

  return data;
}

export async function uploadDossierDocumentFromBlob({
  dossierId,
  filename,
  content,
  mime,
  docType,
  sourceId = null,
}) {
  const file = new File([content], filename, { type: mime || "application/octet-stream" });
  return uploadDossierDocument({ dossierId, file, docType, sourceId });
}

export async function listDossierDocuments(dossierId, { docType = null } = {}) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) return [];

  let query = supabase
    .from("dossier_documents")
    .select("id, dossier_id, doc_type, original_filename, storage_path, mime_type, size_bytes, source_id, created_at")
    .eq("dossier_id", dossierId)
    .order("created_at", { ascending: false });

  if (docType) query = query.eq("doc_type", docType);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getDocumentDownloadUrl(storagePath, expiresIn = 3600) {
  const supabase = getSupabase();
  if (!supabase || !storagePath) return null;

  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(storagePath, expiresIn);

  if (error) throw error;
  return data?.signedUrl || null;
}

export async function downloadDossierDocument(doc) {
  const url = await getDocumentDownloadUrl(doc.storage_path);
  if (!url) throw new Error("Lien de téléchargement indisponible.");

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = doc.original_filename || "document";
  anchor.rel = "noopener";
  anchor.target = "_blank";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
