/**
 * Portail client : appels communs (cabinet et client).
 * Les droits sont appliqués en base (migration 20261118090000_client_portal.sql)
 * et par l'Edge Function client-portal.
 */
import { SUPABASE_ANON_KEY, SUPABASE_URL, authHeaders, getSession, getSupabase } from "./auth-client.js?v=auth10";

export const PORTAL_BUCKET = "dossier-documents";
export const PORTAL_MAX_BYTES = 50 * 1024 * 1024;
export const PORTAL_DOC_TYPES = {
  invoice: { label: "Factures d'achat", short: "Facture d'achat", icon: "file-text" },
  bank: { label: "Relevé bancaire", short: "Relevé bancaire", icon: "landmark" },
  other: { label: "Autre document", short: "Autre document", icon: "paperclip" },
};
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export const periodLabel = (year, month) => `${MONTHS[month - 1]} ${year}`;
export const periodLabelCap = (year, month) => {
  const s = periodLabel(year, month);
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function db() {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Connexion au service impossible");
  return supabase;
}

function fail(error) {
  if (!error) return;
  const msg = String(error.message || error);
  if (/client_portal_access|portal_uploads|document_requests/.test(msg) && /does not exist|schema cache/i.test(msg)) {
    throw new Error("Le portail client n'est pas encore installé sur la base de données.");
  }
  throw new Error(msg.replace(/^.*?ERROR:\s*/i, ""));
}

/** URL publique du portail (même dossier que la page courante). */
export function portalUrl() {
  return new URL("portail.html", window.location.href).href.split("#")[0].split("?")[0];
}

async function callFunction(payload, { anonymous = false } = {}) {
  let headers;
  if (anonymous) {
    headers = { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" };
  } else {
    const session = await getSession();
    if (!session?.access_token) throw new Error("Session expirée. Reconnectez-vous.");
    headers = authHeaders(session);
  }
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/client-portal`, { method: "POST", headers, body: JSON.stringify(payload) });
  } catch {
    throw new Error("Le service ne répond pas. Vérifiez votre connexion puis réessayez.");
  }
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (response.status === 404 && !body.error) throw new Error("Le portail client n'est pas encore déployé.");
  if (!response.ok) throw new Error(body.error || `Erreur serveur (${response.status})`);
  return body;
}

// ---------------------------------------------------------------------------
// Côté cabinet
// ---------------------------------------------------------------------------

export const portalStatus = (clientId) => callFunction({ action: "status", client_id: clientId });
export const portalInvite = (clientId, contact) => callFunction({ action: "invite", client_id: clientId, portal_url: portalUrl(), ...contact });
export const portalNewLink = (clientId) => callFunction({ action: "new_link", client_id: clientId, portal_url: portalUrl() });
export const portalRevoke = (clientId) => callFunction({ action: "revoke", client_id: clientId });
export const portalUpdateContact = (clientId, contact) => callFunction({ action: "update_contact", client_id: clientId, ...contact });

export async function listRequests(clientId) {
  const { data, error } = await db().from("document_requests").select("*").eq("client_id", clientId).order("created_at", { ascending: true });
  fail(error);
  return data || [];
}

export async function createRequest({ cabinetId, clientId, dossierId, docType, label, note = null }) {
  const { data: userData } = await db().auth.getUser();
  const { error } = await db().from("document_requests").insert({
    cabinet_id: cabinetId,
    client_id: clientId,
    dossier_id: dossierId,
    doc_type: docType,
    label: String(label || "").trim(),
    note: String(note || "").trim() || null,
    created_by: userData?.user?.id || null,
  });
  fail(error);
}

export async function setRequestStatus(id, status) {
  const patch = { status };
  if (status === "closed") patch.closed_at = new Date().toISOString();
  if (status === "open") { patch.closed_at = null; patch.received_at = null; }
  const { error } = await db().from("document_requests").update(patch).eq("id", id);
  fail(error);
}

export async function deleteRequest(id) {
  const { error } = await db().from("document_requests").delete().eq("id", id);
  fail(error);
}

export async function listPortalUploads(clientId) {
  const { data, error } = await db().from("portal_uploads").select("*").eq("client_id", clientId).order("created_at", { ascending: false }).limit(300);
  fail(error);
  return data || [];
}

export async function countUnseenUploads(clientIds = null) {
  let query = db().from("portal_uploads").select("client_id").is("seen_at", null).eq("status", "received");
  if (clientIds?.length) query = query.in("client_id", clientIds);
  const { data, error } = await query;
  if (error) return {};
  const counts = {};
  for (const row of data || []) counts[row.client_id] = (counts[row.client_id] || 0) + 1;
  return counts;
}

export async function markUploadsSeen(clientId) {
  const { error } = await db().rpc("portal_mark_seen", { p_client_id: clientId });
  fail(error);
}

export async function rejectUpload(upload, reason) {
  const { error } = await db().rpc("portal_reject_upload", { p_upload_id: upload.id, p_reason: reason });
  fail(error);
  // Le fichier refusé n'a plus de raison d'être conservé.
  if (upload.storage_path) await db().storage.from(PORTAL_BUCKET).remove([upload.storage_path]).catch(() => {});
}

export async function uploadPreviewUrl(storagePath) {
  const { data, error } = await db().storage.from(PORTAL_BUCKET).createSignedUrl(storagePath, 600);
  fail(error);
  return data?.signedUrl;
}

// ---------------------------------------------------------------------------
// Côté client (portail)
// ---------------------------------------------------------------------------

/** Échange le lien personnel (#acces=…) contre une session. */
export async function exchangeAccessToken(token) {
  const { token_hash: tokenHash } = await callFunction({ action: "exchange", token }, { anonymous: true });
  const { error } = await db().auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  if (error) throw new Error("Connexion impossible : demandez un nouveau lien à votre cabinet.");
}

/** Contexte du portail pour l'utilisateur connecté, ou null s'il n'est pas un client. */
export async function loadPortalContext() {
  const { data: userData } = await db().auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return null;
  const { data: access, error } = await db()
    .from("client_portal_access")
    .select("client_id, cabinet_id, contact_name, is_active")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !access?.is_active) return null;
  const [client, cabinet, dossiers] = await Promise.all([
    db().from("cabinet_clients").select("id, name, ice").eq("id", access.client_id).maybeSingle(),
    db().from("cabinets").select("id, name").eq("id", access.cabinet_id).maybeSingle(),
    db().from("client_dossiers").select("id, period_year, period_month, status").eq("client_id", access.client_id)
      .order("period_year", { ascending: false }).order("period_month", { ascending: false }),
  ]);
  if (!client.data) return null;
  return { access, client: client.data, cabinet: cabinet.data, dossiers: dossiers.data || [] };
}

export async function ensurePeriod(year, month) {
  const { data, error } = await db().rpc("portal_ensure_period", { p_year: year, p_month: month });
  fail(error);
  return data;
}

function safeName(name) {
  const base = String(name || "document").split(/[/\\]/).pop();
  const ascii = base.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return ascii.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 150) || "document";
}

const ACCEPTED = /^(application\/pdf|image\/(png|jpe?g|webp|tiff))$/i;
const ACCEPTED_EXT = /\.(pdf|png|jpe?g|webp|tiff?)$/i;

export function checkPortalFile(file) {
  if (!ACCEPTED.test(file.type || "") && !ACCEPTED_EXT.test(file.name || "")) return "Format non accepté : envoyez un PDF ou une photo.";
  if (file.size > PORTAL_MAX_BYTES) return "Fichier trop lourd (50 Mo maximum).";
  if (!file.size) return "Fichier vide.";
  return "";
}

export async function uploadPortalFile({ dossierId, docType, file, requestId = null }) {
  const problem = checkPortalFile(file);
  if (problem) throw new Error(problem);
  const path = `dossier/${dossierId}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}_${safeName(file.name)}`;
  const contentType = file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : "application/octet-stream");
  const { error: upError } = await db().storage.from(PORTAL_BUCKET).upload(path, file, { contentType, upsert: false });
  if (upError) throw new Error(/size|large/i.test(upError.message || "") ? "Fichier trop lourd." : "Envoi interrompu : vérifiez votre connexion et réessayez.");
  const { data, error } = await db().rpc("portal_register_upload", {
    p_dossier_id: dossierId,
    p_doc_type: docType,
    p_storage_path: path,
    p_original_filename: file.name || "document",
    p_mime_type: contentType,
    p_size_bytes: file.size,
    p_request_id: requestId,
  });
  fail(error);
  return data;
}

export async function listMyRequests() {
  const { data, error } = await db().from("document_requests").select("*").neq("status", "closed").order("created_at", { ascending: true });
  fail(error);
  return data || [];
}

export async function listMyUploads() {
  const { data, error } = await db().from("portal_uploads")
    .select("id, dossier_id, request_id, doc_type, original_filename, size_bytes, status, reject_reason, created_at")
    .order("created_at", { ascending: false }).limit(300);
  fail(error);
  return data || [];
}
