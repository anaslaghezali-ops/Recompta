import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.86.0/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js?v=pbyoxfxngfutoiqjirkx-1";

let client = null;

export function isSupabaseConfigured() {
  const key = SUPABASE_ANON_KEY || "";
  const looksValid =
    (key.startsWith("eyJ") || key.startsWith("sb_publishable_")) && key.length > 30;
  return Boolean(SUPABASE_URL && looksValid);
}

export function authErrorMessage(error) {
  const message = error?.message || "Échec de la connexion.";
  if (/invalid api key/i.test(message)) {
    return "Clé API refusée (souvent un ancien fichier en cache). Faites Ctrl+Shift+R. La clé dans docs/supabase-config.js doit être celle du projet pbyoxfxngfutoiqjirkx.";
  }
  return message;
}

export function getSupabase() {
  if (!isSupabaseConfigured()) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}

export async function getSession() {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function isSuperAdmin(userId) {
  const supabase = getSupabase();
  if (!supabase || !userId) return false;
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  return data?.role === "super_admin";
}

export async function signIn(email, password) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase n'est pas configuré (clé anon manquante).");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signUp(email, password) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase n'est pas configuré (clé anon manquante).");
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export function authHeaders(session) {
  return {
    Authorization: `Bearer ${session.access_token}`,
    apikey: SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
  };
}

export async function requireSuperAdminSession() {
  const session = await getSession();
  if (!session?.user) {
    throw new Error("Connectez-vous en tant que super-admin.");
  }
  const admin = await isSuperAdmin(session.user.id);
  if (!admin) {
    throw new Error("Accès réservé au super-admin.");
  }
  return session;
}

export async function getUserCabinetMembership() {
  const session = await getSession();
  if (!session?.user) return null;

  const supabase = getSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("cabinet_members")
    .select("cabinet_id, role, cabinets(id, name, slug, is_active)")
    .eq("user_id", session.user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error) return null;
  if (!data?.cabinets?.is_active) return null;

  return {
    session,
    cabinet_id: data.cabinet_id,
    role: data.role,
    cabinet: data.cabinets,
  };
}

export async function redirectAfterLogin(userId) {
  if (await isSuperAdmin(userId)) return "admin.html";
  const membership = await getUserCabinetMembership();
  if (membership) return "dossiers.html";
  return "index.html";
}

export { SUPABASE_URL } from "./supabase-config.js?v=pbyoxfxngfutoiqjirkx-1";
