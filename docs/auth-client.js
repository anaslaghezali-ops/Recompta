import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.86.0/+esm";

/** Config Supabase (inline : GitHub Pages ne sert pas supabase-config.js). */
export const SUPABASE_CONFIG_VERSION = "pbyoxfxngfutoiqjirkx-2";
export const SUPABASE_URL = "https://pbyoxfxngfutoiqjirkx.supabase.co";
const RAW_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBieW94ZnhuZ2Z1dG9pcWppcmt4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MzM0NTksImV4cCI6MjEwMjIwOTQ1OX0.XnBB0ZlLPLcdssCHfEyXSgVJlzi4oORkOxBAaWHT5kI";
export const SUPABASE_ANON_KEY = RAW_ANON_KEY.trim().replace(/^["']|["']$/g, "");

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
    return "Clé API refusée (souvent un ancien fichier en cache). Faites Ctrl+Shift+R. Vérifiez SUPABASE_ANON_KEY dans docs/auth-client.js (projet pbyoxfxngfutoiqjirkx).";
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

export function slugifyCabinetName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Inscription self-serve : crée compte Auth + cabinet + membership owner.
 * Nécessite l'Edge Function signup-cabinet déployée sur Supabase.
 */
export async function signUpCabinet({ email, password, cabinetName, displayName = "" }) {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase n'est pas configuré (clé anon manquante).");
  }

  const trimmedEmail = String(email || "").trim().toLowerCase();
  const trimmedCabinet = String(cabinetName || "").trim();
  const trimmedDisplay = String(displayName || "").trim();

  if (!trimmedCabinet || trimmedCabinet.length < 2) {
    throw new Error("Nom du cabinet requis (2 caractères minimum).");
  }
  if (!trimmedEmail || !trimmedEmail.includes("@")) {
    throw new Error("Email invalide.");
  }
  if (!password || password.length < 6) {
    throw new Error("Mot de passe requis (6 caractères minimum).");
  }

  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/signup-cabinet`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: trimmedEmail,
        password,
        cabinet_name: trimmedCabinet,
        display_name: trimmedDisplay,
      }),
    });
  } catch {
    throw new Error(
      "SIGNUP_FUNCTION_UNAVAILABLE: déployez signup-cabinet sur Supabase (voir docs/DEPLOY_SIGNUP.md).",
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
      "SIGNUP_FUNCTION_UNAVAILABLE: déployez signup-cabinet sur Supabase (voir docs/DEPLOY_SIGNUP.md).",
    );
  }

  if (!response.ok) {
    throw new Error(body.error || body.message || `Inscription impossible (${response.status})`);
  }

  return signIn(trimmedEmail, password);
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
  return "production.html";
}
