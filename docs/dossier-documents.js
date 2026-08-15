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

export function documentsAreExactDuplicates(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  if (a.storage_path && b.storage_path && a.storage_path === b.storage_path) return true;
  if (a.source_id && b.source_id && a.source_id === b.source_id) return true;
  return false;
}

export function dedupeDocuments(docs) {
  const kept = [];
  for (const doc of docs || []) {
    const duplicateIndex = kept.findIndex((row) => documentsAreExactDuplicates(row, doc));
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

function nextDocumentSourceId() {
  return `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function uploadDossierDocument({
  dossierId,
  file,
  docType,
  sourceId = null,
  skipIfSameNameAndSize = false,
}) {
  const supabase = getSupabase();
  if (!supabase || !dossierId || !file) return null;

  const originalFilename = file.name || "document";
  const fileSize = file.size || 0;

  if (skipIfSameNameAndSize) {
    const existing = await findDossierDocumentByIdentity(dossierId, originalFilename);
    if (existing && Number(existing.size_bytes || 0) === Number(fileSize)) {
      return { ...existing, reused: true };
    }
  }

  const resolvedSourceId = sourceId || nextDocumentSourceId();
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
      size_bytes: fileSize,
      source_id: resolvedSourceId,
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

export function isZipDocument(docOrFilename) {
  const name = typeof docOrFilename === "object"
    ? docOrFilename?.original_filename
    : docOrFilename;
  const base = String(name || "").replace(/\\/g, "/").split("/").pop() || "";
  return /\.zip$/i.test(base);
}

function zipArchiveStem(filename) {
  const base = String(filename || "").replace(/\\/g, "/").split("/").pop() || "";
  return base.replace(/\.zip$/i, "");
}

export function getZipChildDocuments(zipDoc, docs) {
  if (!zipDoc || !isZipDocument(zipDoc)) return [];
  const stemLower = zipArchiveStem(zipDoc.original_filename).toLowerCase();
  const stemPrefix = stemLower.split("-")[0].trim();

  return (docs || []).filter((doc) => {
    if (!doc || doc.id === zipDoc.id) return false;
    if (isZipDocument(doc)) return false;
    const path = String(doc.original_filename || "").replace(/\\/g, "/");
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) return false;
    const folderLower = parts[0].toLowerCase();
    return stemLower.startsWith(folderLower) || folderLower === stemPrefix;
  });
}

export function isInvoiceDocumentProcessed(doc, processedKeys) {
  const sid = doc?.source_id ? `sid:${doc.source_id}` : null;
  const keys = documentIdentityKeys(doc?.original_filename || "");
  return (sid && processedKeys.has(sid))
    || [...keys].some((key) => processedKeys.has(key));
}

export function shouldSkipZipForAnalysis(doc, documents, processedKeys) {
  if (!isZipDocument(doc)) return false;
  const children = getZipChildDocuments(doc, documents);
  if (!children.length) return false;
  return children.some((child) => isInvoiceDocumentProcessed(child, processedKeys));
}

export function documentDisplayName(docOrFilename, { withSize = false } = {}) {
  const doc = typeof docOrFilename === "object" ? docOrFilename : null;
  const filename = doc?.original_filename || docOrFilename || "";
  const parts = String(filename).replace(/\\/g, "/").split("/").filter(Boolean);
  const base = parts[parts.length - 1] || filename || "document";
  if (!withSize || !doc?.size_bytes) return base;
  const sizeKb = Math.max(1, Math.round(Number(doc.size_bytes) / 1024));
  return `${base} (${sizeKb} Ko)`;
}

export function getZipExtractedChildren(zipDoc, docs) {
  return getZipChildDocuments(zipDoc, docs);
}

export function isExtractedArchiveZip(zipDoc, docs) {
  return isZipDocument(zipDoc) && getZipExtractedChildren(zipDoc, docs).length > 0;
}

export function partitionDocumentsForDisplay(docs) {
  const all = dedupeDocuments(docs || []);
  const sourceArchives = [];
  const workingDocs = [];

  for (const doc of all) {
    if (isExtractedArchiveZip(doc, all)) {
      sourceArchives.push({
        ...doc,
        displayName: documentDisplayName(doc, { withSize: true }),
        extractedCount: getZipExtractedChildren(doc, all).length,
      });
      continue;
    }
    workingDocs.push(doc);
  }

  return { workingDocs, sourceArchives };
}

export function documentSupplierGroup(doc) {
  if (doc?.doc_type === "bank") {
    return {
      key: "__bank__",
      label: "Relevés bancaires",
      kind: "bank",
      filename: documentDisplayName(doc, { withSize: true }),
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
    return {
      key: "__archive__",
      label: "Archives ZIP",
      kind: "archive",
      filename: documentDisplayName(doc, { withSize: true }),
    };
  }
  return {
    key: "__other__",
    label: "Autres documents",
    kind: "other",
    filename: documentDisplayName(doc, { withSize: true }),
  };
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

export function isDocumentAnalyzed(doc, workspace) {
  if (!doc) return false;
  const lines = workspace?.lines || [];
  const bank = workspace?.bank_transactions || [];
  const processedKeys = new Set();

  for (const line of lines) {
    for (const key of documentIdentityKeys(line.source_file || "")) {
      processedKeys.add(key);
    }
    if (line.source_id) processedKeys.add(`sid:${line.source_id}`);
  }

  if (doc.doc_type === "bank") {
    return bank.length > 0;
  }
  return isInvoiceDocumentProcessed(doc, processedKeys);
}

export async function deleteDossierDocument(doc) {
  const supabase = getSupabase();
  if (!supabase || !doc?.id) throw new Error("Document introuvable.");

  if (doc.storage_path) {
    const { error: storageError } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .remove([doc.storage_path]);
    if (storageError && !/not found|object not found/i.test(storageError.message || "")) {
      throw storageError;
    }
  }

  const { error } = await supabase
    .from("dossier_documents")
    .delete()
    .eq("id", doc.id);

  if (error) throw error;
  return true;
}
