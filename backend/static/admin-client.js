import {
  authHeaders,
  getSupabase,
  getSession,
  isSuperAdmin,
  requireSuperAdminSession,
  SUPABASE_URL,
} from "./auth-client.js?v=auth10";
import { getApiUrl } from "./api-client.js";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function isValidSlug(slug) {
  return slugPattern.test(slug);
}

export async function listCabinetsWithOwners() {
  await requireSuperAdminSession();
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");

  const { data: cabinets, error: cabError } = await supabase
    .from("cabinets")
    .select("id, name, slug, is_active, created_at")
    .order("created_at", { ascending: false });
  if (cabError) throw cabError;

  const { data: members, error: memError } = await supabase
    .from("cabinet_members")
    .select("cabinet_id, user_id, role")
    .eq("role", "owner")
    .eq("is_active", true);
  if (memError) throw memError;

  const ownerIds = [...new Set((members || []).map((m) => m.user_id))];
  let profiles = [];
  if (ownerIds.length > 0) {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id, email, display_name")
      .in("user_id", ownerIds);
    if (error) throw error;
    profiles = data || [];
  }

  const profileByUser = Object.fromEntries(profiles.map((p) => [p.user_id, p]));
  const ownerByCabinet = Object.fromEntries(
    (members || []).map((m) => [m.cabinet_id, profileByUser[m.user_id] || null]),
  );

  return (cabinets || []).map((cabinet) => ({
    ...cabinet,
    owner: ownerByCabinet[cabinet.id] || null,
  }));
}

async function createViaEdgeFunction(session, payload) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/admin-create-cabinet`, {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify(payload),
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw new Error(body.error || `Erreur serveur (${response.status})`);
  }
  return body;
}

async function createViaBackend(session, payload) {
  const apiUrl = getApiUrl();
  if (!apiUrl) return null;
  const response = await fetch(`${apiUrl}/api/admin/cabinets`, {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify(payload),
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw new Error(body.detail || body.error || `Erreur serveur (${response.status})`);
  }
  return body;
}

export async function createCabinetWithOwner({
  cabinetName,
  slug,
  ownerEmail,
  ownerPassword,
  displayName,
}) {
  const session = await requireSuperAdminSession();
  const payload = {
    cabinet_name: cabinetName.trim(),
    slug: slug.trim().toLowerCase(),
    owner_email: ownerEmail.trim().toLowerCase(),
    owner_password: ownerPassword,
    display_name: (displayName || "").trim(),
  };

  try {
    return await createViaEdgeFunction(session, payload);
  } catch (edgeError) {
    const backendResult = await createViaBackend(session, payload);
    if (backendResult) return backendResult;
    throw edgeError;
  }
}

/**
 * Cabinets + tous leurs membres (pas seulement le responsable).
 */
export async function listCabinetsWithMembers() {
  await requireSuperAdminSession();
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");

  const [cabRes, memRes] = await Promise.all([
    supabase
      .from("cabinets")
      .select("id, name, slug, is_active, created_at, signup_source")
      .order("created_at", { ascending: false }),
    supabase.from("cabinet_members").select("cabinet_id, user_id, role, is_active, created_at"),
  ]);
  if (cabRes.error) throw cabRes.error;
  if (memRes.error) throw memRes.error;

  const members = memRes.data || [];
  const userIds = [...new Set(members.map((m) => m.user_id))];
  let profiles = [];
  if (userIds.length) {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id, email, display_name")
      .in("user_id", userIds);
    if (error) throw error;
    profiles = data || [];
  }
  const profileByUser = Object.fromEntries(profiles.map((p) => [p.user_id, p]));
  const roleOrder = { owner: 0, admin: 1, comptable: 2 };

  return (cabRes.data || []).map((cabinet) => {
    const cabMembers = members
      .filter((m) => m.cabinet_id === cabinet.id)
      .map((m) => ({ ...m, ...(profileByUser[m.user_id] || {}) }))
      .sort((a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9));
    return {
      ...cabinet,
      members: cabMembers,
      owner: cabMembers.find((m) => m.role === "owner") || null,
    };
  });
}

async function callManageAccounts(action, payload = {}) {
  const session = await requireSuperAdminSession();
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/admin-manage-accounts`, {
      method: "POST",
      headers: authHeaders(session),
      body: JSON.stringify({ action, ...payload }),
    });
  } catch {
    throw new Error(
      "Le service de gestion des comptes ne répond pas. Déployez l'Edge Function admin-manage-accounts (voir docs/ADMIN.md).",
    );
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (response.status === 404) {
    throw new Error(
      "Le service de gestion des comptes n'est pas encore déployé (Edge Function admin-manage-accounts, voir docs/ADMIN.md).",
    );
  }
  if (!response.ok) {
    throw new Error(body.error || `Erreur serveur (${response.status})`);
  }
  return body;
}

/** État Auth des comptes : { [user_id]: { blocked, last_sign_in_at, ... } } */
export async function loadAccountStatuses() {
  const body = await callManageAccounts("list");
  return Object.fromEntries((body.users || []).map((u) => [u.id, u]));
}

export function updateAccount(userId, changes) {
  return callManageAccounts("update_user", { user_id: userId, ...changes });
}

export function setAccountBlocked(userId, blocked) {
  return callManageAccounts("set_blocked", { user_id: userId, blocked });
}

export function renameCabinet(cabinetId, name) {
  return callManageAccounts("update_cabinet", { cabinet_id: cabinetId, name });
}

export function setCabinetActive(cabinetId, active) {
  return callManageAccounts("set_cabinet_active", { cabinet_id: cabinetId, active });
}

/** Mot de passe lisible : 3 blocs de 4 caractères sans ambiguïté (pas de 0/O, 1/l). */
export function generatePassword() {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((n) => alphabet[n % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export async function guardSuperAdminPage() {
  const session = await getSession();
  if (!session?.user) {
    window.location.href = "login.html";
    return null;
  }
  const admin = await isSuperAdmin(session.user.id);
  if (!admin) {
    window.location.href = "index.html";
    return null;
  }
  return session;
}
