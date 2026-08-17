import { getSupabase } from "./auth-client.js?v=auth6";
import {
  expandUploadedFiles,
  isZipFile,
  officialNameForLine,
  supplierIdentityKey,
} from "./extract-client.js";

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
  skipIfSameNameAndSize = false,
}) {
  const file = new File([content], filename, { type: mime || "application/octet-stream" });
  return uploadDossierDocument({
    dossierId,
    file,
    docType,
    sourceId,
    skipIfSameNameAndSize,
  });
}

/** Aligne le chemin d'un membre ZIP sur la convention backend (zipStem/fichier.pdf). */
export function storagePathForZipMember(zipFilename, memberPath) {
  const normalized = String(memberPath || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (!parts.length) return normalized;
  const zipStem = zipArchiveStem(zipFilename);
  if (parts.length === 1) return `${zipStem}/${parts[0]}`;
  if (parts[0].toLowerCase() !== zipStem.toLowerCase()) {
    return `${zipStem}/${parts.join("/")}`;
  }
  return parts.join("/");
}

/**
 * Importe un fichier dans le dossier. Les ZIP sont décompressés immédiatement :
 * le conteneur est stocké en archive, chaque pièce exploitable en facture distincte.
 */
export async function uploadDossierFileForImport({
  dossierId,
  file,
  skipIfSameNameAndSize = true,
}) {
  if (!file) return null;

  if (isZipFile(file.name)) {
    const archive = await uploadDossierDocument({
      dossierId,
      file,
      docType: "archive",
      skipIfSameNameAndSize,
    });
    const expanded = await expandUploadedFiles([file]);
    if (!expanded.length) {
      throw new Error("Archive vide ou sans facture exploitable (PDF, image).");
    }

    const children = [];
    for (const item of expanded) {
      const filename = storagePathForZipMember(file.name, item.filename);
      const child = await uploadDossierDocumentFromBlob({
        dossierId,
        filename,
        content: item.content,
        mime: item.mime,
        docType: "invoice",
        skipIfSameNameAndSize,
      });
      if (child) children.push(child);
    }

    const allReused = Boolean(archive?.reused) && children.every((child) => child?.reused);
    return { archive, children, reused: allReused };
  }

  const document = await uploadDossierDocument({
    dossierId,
    file,
    docType: "invoice",
    skipIfSameNameAndSize,
  });
  return { document, children: [], reused: Boolean(document?.reused) };
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

function zipBasename(filename) {
  return String(filename || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
}

function zipUploadBounds(zipDoc, docs) {
  const zipCreated = String(zipDoc.created_at || "");
  const base = zipBasename(zipDoc.original_filename);
  let nextCreated = null;
  for (const doc of docs || []) {
    if (!doc || doc.id === zipDoc.id || !isZipDocument(doc)) continue;
    if (zipBasename(doc.original_filename) !== base) continue;
    const created = String(doc.created_at || "");
    if (created > zipCreated && (!nextCreated || created < nextCreated)) {
      nextCreated = created;
    }
  }
  return { zipCreated, nextCreated };
}

function docInZipWindow(doc, zipCreated, nextCreated) {
  const created = String(doc.created_at || "");
  if (created < zipCreated) return false;
  if (nextCreated && created >= nextCreated) return false;
  return true;
}

export function getZipChildDocuments(zipDoc, docs) {
  if (!zipDoc || !isZipDocument(zipDoc)) return [];
  const stemLower = zipArchiveStem(zipDoc.original_filename).toLowerCase();
  const stemPrefix = stemLower.split("-")[0].trim();
  const { zipCreated, nextCreated } = zipUploadBounds(zipDoc, docs);

  const direct = (docs || []).filter((doc) => {
    if (!doc || doc.id === zipDoc.id) return false;
    if (isZipDocument(doc)) return false;
    if (!docInZipWindow(doc, zipCreated, nextCreated)) return false;
    const path = String(doc.original_filename || "").replace(/\\/g, "/");
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) return false;
    const folderLower = parts[0].toLowerCase();
    return (
      folderLower === stemLower
      || stemLower.startsWith(folderLower)
      || folderLower === stemPrefix
    );
  });
  if (direct.length) return direct;

  const zips = (docs || []).filter((doc) => doc && isZipDocument(doc));
  if (zips.length !== 1 || zips[0].id !== zipDoc.id) return [];
  return (docs || []).filter((doc) => {
    if (!doc || doc.id === zipDoc.id || isZipDocument(doc)) return false;
    if (!docInZipWindow(doc, zipCreated, nextCreated)) return false;
    if (doc.doc_type && doc.doc_type !== "invoice") return false;
    const parts = String(doc.original_filename || "").replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length >= 2;
  });
}

export function isInvoiceDocumentProcessed(doc, processedKeys, sourceIdsWithLines = null) {
  const sid = doc?.source_id ? `sid:${doc.source_id}` : null;
  if (sid) {
    if (sourceIdsWithLines instanceof Set) {
      return sourceIdsWithLines.has(doc.source_id);
    }
    return processedKeys.has(sid);
  }
  const keys = documentIdentityKeys(doc?.original_filename || "");
  return [...keys].some((key) => processedKeys.has(key));
}

export function sourceIdsWithLines(lines = []) {
  const ids = new Set();
  for (const line of lines || []) {
    if (line?.source_id) ids.add(line.source_id);
  }
  return ids;
}

export function shouldSkipZipForAnalysis(doc, documents, processedKeys, sourceIdsWithLines = null) {
  if (!isZipDocument(doc)) return false;
  // ZIP importé comme conteneur : jamais une facture à extraire.
  if (doc?.doc_type === "archive") return true;
  const children = getZipChildDocuments(doc, documents);
  if (!children.length) return false;
  // Archive déjà décompressée : ne pas re-mettre le ZIP en file (seulement les PDFs).
  return true;
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
  if (!isZipDocument(zipDoc)) return false;
  if (zipDoc?.doc_type === "archive") return true;
  return getZipExtractedChildren(zipDoc, docs).length > 0;
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

export function countInvoiceDocuments(documents) {
  const { workingDocs } = partitionDocumentsForDisplay(documents);
  return workingDocs.filter((doc) => doc.doc_type === "invoice").length;
}

export function findLinesForDocument(doc, lines = []) {
  if (!doc) return [];
  return (lines || []).filter((line) => {
    if (!line) return false;
    if (doc.source_id && line.source_id && String(doc.source_id) === String(line.source_id)) {
      return true;
    }
    if (line.source_file && documentsShareIdentity(doc.original_filename, line.source_file)) {
      return true;
    }
    return false;
  });
}

function looksLikeDriveExportFolder(name) {
  return /-\d{8}T\d{6}Z(?:-\d+)*$/i.test(String(name || "").trim());
}

function pathSupplierFallback(doc) {
  const raw = String(doc?.original_filename || "").replace(/\\/g, "/");
  const parts = raw.split("/").filter(Boolean);
  if (parts.length >= 2 && looksLikeDriveExportFolder(parts[0]) && parts[1]) {
    return parts[1].trim();
  }
  if (parts.length >= 2) return parts[0].trim();
  return "";
}

export function documentSupplierGroup(doc, { lines = [], notebook = [] } = {}) {
  if (doc?.doc_type === "bank") {
    return {
      key: "__bank__",
      label: "Relevés bancaires",
      kind: "bank",
      filename: documentDisplayName(doc, { withSize: true }),
    };
  }

  const matchedLine = findLinesForDocument(doc, lines)[0];
  if (matchedLine) {
    const official = officialNameForLine(matchedLine, notebook)
      || String(matchedLine.lib_frss || "").trim();
    if (official) {
      return {
        key: supplierIdentityKey(matchedLine),
        label: official,
        kind: "supplier",
        filename: documentDisplayName(doc, { withSize: true }),
      };
    }
  }

  const raw = String(doc?.original_filename || "").replace(/\\/g, "/");
  const parts = raw.split("/").filter(Boolean);
  const folderSupplier = pathSupplierFallback(doc);
  if (folderSupplier) {
    return {
      key: `supplier:${folderSupplier.toLowerCase()}`,
      label: folderSupplier,
      kind: "supplier",
      filename: parts.slice(looksLikeDriveExportFolder(parts[0]) ? 2 : 1).join("/")
        || documentDisplayName(doc, { withSize: true }),
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

export function groupDocumentsBySupplier(docs, { lines = [], notebook = [] } = {}) {
  const map = new Map();
  for (const doc of docs || []) {
    const group = documentSupplierGroup(doc, { lines, notebook });
    if (!map.has(group.key)) {
      map.set(group.key, {
        key: group.key,
        label: group.label,
        kind: group.kind,
        docs: [],
      });
    }
    const bucket = map.get(group.key);
    bucket.docs.push({ ...doc, displayName: group.filename });
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

export async function fetchDossierDocumentBytes(doc) {
  const supabase = getSupabase();
  if (!supabase || !doc?.storage_path) {
    throw new Error("Lien de téléchargement indisponible.");
  }

  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .download(doc.storage_path);
  if (error || !data) {
    throw error || new Error("Téléchargement impossible.");
  }

  const content = await data.arrayBuffer();
  const mime = doc.mime_type || data.type || "application/octet-stream";
  return {
    content,
    mime,
    filename: (doc.original_filename || "document").split(/[/\\]/).pop(),
  };
}

export function findDocumentForLine(line, documents = []) {
  if (!line) return null;
  const invoiceDocs = (documents || []).filter(
    (doc) => doc && doc.doc_type !== "bank" && doc.doc_type !== "archive" && !isZipDocument(doc),
  );

  if (line.source_id) {
    const byId = invoiceDocs.find((doc) => doc.source_id === line.source_id);
    if (byId) return byId;
  }

  if (line.source_file) {
    return invoiceDocs.find(
      (doc) => documentsShareIdentity(doc.original_filename, line.source_file),
    ) || null;
  }

  return null;
}

export async function downloadDossierDocument(doc) {
  const { content, mime, filename } = await fetchDossierDocumentBytes(doc);
  const blob = new Blob([content], { type: mime || "application/octet-stream" });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename || "document";
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 2500);
  }
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
  return isInvoiceDocumentProcessed(doc, processedKeys, sourceIdsWithLines(lines));
}

export function collectDocumentsForDeletion(docs, allDocs, options = {}) {
  const {
    includeZipChildren = false,
    includeEmptyParentZips = false,
  } = options;
  const all = allDocs || [];
  const byId = new Map();
  for (const doc of docs || []) {
    if (doc?.id) byId.set(doc.id, doc);
  }

  if (includeZipChildren) {
    for (const doc of [...byId.values()]) {
      if (!isZipDocument(doc)) continue;
      for (const child of getZipExtractedChildren(doc, all)) {
        byId.set(child.id, child);
      }
    }
  }

  if (includeEmptyParentZips) {
    const selectedIds = new Set(byId.keys());
    for (const zip of all.filter((row) => row && isZipDocument(row))) {
      const children = getZipExtractedChildren(zip, all);
      if (!children.length) continue;
      if (children.every((child) => selectedIds.has(child.id))) {
        byId.set(zip.id, zip);
      }
    }
  }

  return [...byId.values()];
}

function documentRowIds(docs) {
  return [...new Set(
    (docs || [])
      .map((doc) => Number(doc?.id))
      .filter((id) => Number.isFinite(id) && id > 0),
  )];
}

export function parseDeletedIds(data) {
  const rows = Array.isArray(data) ? data : data != null ? [data] : [];
  return [...new Set(
    rows
      .map((row) => Number(row?.id ?? row))
      .filter((id) => Number.isFinite(id) && id > 0),
  )];
}

export function isRecreatedDeletedDocument(row, deletedDocs) {
  return (deletedDocs || []).some((doc) => {
    if (!row || !doc) return false;
    if (row.id != null && doc.id != null && Number(row.id) === Number(doc.id)) return true;
    if (row.storage_path && doc.storage_path && row.storage_path === doc.storage_path) return true;
    if (row.source_id && doc.source_id && String(row.source_id) === String(doc.source_id)) return true;
    if (
      row.original_filename
      && doc.original_filename
      && String(row.original_filename) === String(doc.original_filename)
    ) {
      return true;
    }
    return false;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRemainingDocumentIds(supabase, ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from("dossier_documents")
    .select("id")
    .in("id", ids);
  if (error) throw error;
  return parseDeletedIds(data);
}

async function removeStoragePaths(supabase, paths) {
  const unique = [...new Set((paths || []).filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { error } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .remove(chunk);
    if (error && !/not found|object not found/i.test(error.message || "")) {
      throw error;
    }
  }
}

async function deleteDossierDocumentRows(supabase, ids) {
  if (!ids.length) return [];

  const { error } = await supabase.rpc("delete_dossier_documents", { p_ids: ids });
  if (error) {
    const missingRpc = error.code === "PGRST202"
      || /could not find.*delete_dossier_documents|delete_dossier_documents/i.test(error.message || "");
    if (!missingRpc) throw error;
  }

  let remaining = await fetchRemainingDocumentIds(supabase, ids);
  if (remaining.length) {
    const { error: tableError } = await supabase
      .from("dossier_documents")
      .delete()
      .in("id", remaining);
    if (tableError) throw tableError;
    remaining = await fetchRemainingDocumentIds(supabase, ids);
  }

  if (remaining.length) {
    throw new Error(
      "La suppression n'a pas été enregistrée en base. Exécutez la migration SQL delete_dossier_documents dans Supabase, puis réessayez.",
    );
  }

  return ids;
}

export async function deleteDossierDocuments(docs) {
  const supabase = getSupabase();
  const list = [...new Map((docs || []).filter((doc) => doc?.id).map((doc) => [String(doc.id), doc])).values()];
  if (!list.length) return true;
  if (!supabase) throw new Error("Session indisponible.");

  const ids = documentRowIds(list);
  if (!ids.length) throw new Error("Document introuvable.");

  await deleteDossierDocumentRows(supabase, ids);
  await removeStoragePaths(supabase, list.map((doc) => doc.storage_path));

  const dossierId = list[0]?.dossier_id;
  if (dossierId) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const remaining = await listDossierDocuments(dossierId);
      const clones = remaining.filter((row) => isRecreatedDeletedDocument(row, list));
      if (!clones.length) break;
      if (attempt === 3) {
        throw new Error(
          "Le fichier a été recréé par une extraction ou un import encore en cours. Attendez la fin du traitement, puis supprimez à nouveau.",
        );
      }
      await sleep(400);
      await deleteDossierDocumentRows(supabase, documentRowIds(clones));
      await removeStoragePaths(supabase, clones.map((row) => row.storage_path));
    }
  }
  return true;
}

export async function deleteDossierDocument(doc) {
  return deleteDossierDocuments([doc]);
}
