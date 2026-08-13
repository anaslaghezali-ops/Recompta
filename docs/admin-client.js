import {
  authHeaders,
  getSupabase,
  getSession,
  isSuperAdmin,
  requireSuperAdminSession,
  SUPABASE_URL,
} from "./auth-client.js?v=auth4";
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
