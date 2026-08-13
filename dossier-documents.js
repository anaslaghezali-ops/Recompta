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
  const ascii = base.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const safe = ascii
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 180);
  return safe || "document";
}

export function buildStoragePath(dossierId, originalFilename) {
  const safe = sanitizeFilename(originalFilename);
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return `dossier/${dossierId}/${unique}_${safe}`;
}

export function documentIdentityKeys(filename) {
  const name = String(filename || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = name.split("/").filter(Boolean);
  const keys = new Set();
  if (parts.length >= 2) {
    keys.add(`${parts[parts.length - 2].toLowerCase()}/${parts[parts.length - 1].toLowerCase()}`);
  }
  if (parts.length) keys.add(parts[parts.length - 1].toLowerCase());
  if (!keys.size) keys.add("document");
  return keys;
}

export function documentsShareIdentity(a, b) {
  const keysA = documentIdentityKeys(a);
  const keysB = documentIdentityKeys(b);
  for (const key of keysA) {
    if (keysB.has(key)) return true;
  }
  return false;
}

export function dedupeDocuments(docs) {
  const kept = [];
  for (const doc of docs || []) {
    const duplicateIndex = kept.findIndex(
      (row) => row.doc_type === doc.doc_type
        && documentsShareIdentity(row.original_filename, doc.original_filename),
    );
    if (duplicateIndex === -1) {
      kept.push(doc);
      continue;
    }
    if (new Date(doc.created_at) > new Date(kept[duplicateIndex].created_at)) {
      kept[duplicateIndex] = doc;
    }
  }
  return kept.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

export async function findDossierDocumentByIdentity(dossierId, filename) {
  const supabase = getSupabase();
  if (!supabase || !dossierId || !filename) return null;

  const { data, error } = await supabase
    .from("dossier_documents")
    .select("id, dossier_id, doc_type, original_filename, storage_path, mime_type, size_bytes, source_id, created_at")
    .eq("dossier_id", dossierId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw error;
  return (data || []).find(
    (row) => documentsShareIdentity(row.original_filename, filename),
  ) || null;
}

export async function uploadDossierDocument({ dossierId, file, docType, sourceId = null }) {
  const supabase = getSupabase();
  if (!supabase || !dossierId || !file) return null;

  const originalFilename = file.name || "document";
  const existing = await findDossierDocumentByIdentity(dossierId, originalFilename);
  if (existing) return existing;

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

export function documentDisplayName(filename) {
  const parts = String(filename || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || filename || "document";
}

export function documentSupplierGroup(doc) {
  if (doc?.doc_type === "bank") {
    return {
      key: "__bank__",
      label: "Relevés bancaires",
      kind: "bank",
      filename: documentDisplayName(doc.original_filename),
    };
  }

  const raw = String(doc?.original_filename || "").replace(/\\/g, "/");
  const parts = raw.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const supplier = parts[0].trim();
    return {
      key: `supplier:${supplier.toLowerCase()}`,
      label: supplier,
      kind: "supplier",
      filename: parts.slice(1).join("/"),
    };
  }

  const base = parts[0] || "document";
  if (/\.zip$/i.test(base)) {
    return { key: "__archive__", label: "Archives ZIP", kind: "archive", filename: base };
  }
  return { key: "__other__", label: "Autres documents", kind: "other", filename: base };
}

const GROUP_KIND_ORDER = { supplier: 0, bank: 1, archive: 2, other: 3 };

export function groupDocumentsBySupplier(docs) {
  const map = new Map();
  for (const doc of docs || []) {
    const group = documentSupplierGroup(doc);
    if (!map.has(group.key)) {
      map.set(group.key, {
        key: group.key,
        label: group.label,
        kind: group.kind,
        docs: [],
      });
    }
    map.get(group.key).docs.push({ ...doc, displayName: group.filename });
  }

  return [...map.values()].sort((a, b) => {
    const order = (GROUP_KIND_ORDER[a.kind] ?? 9) - (GROUP_KIND_ORDER[b.kind] ?? 9);
    if (order !== 0) return order;
    return a.label.localeCompare(b.label, "fr", { sensitivity: "base" });
  });
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
  return dedupeDocuments(data || []);
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
