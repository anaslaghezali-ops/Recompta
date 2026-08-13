import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.86.0/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js";

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
    return "Clé API invalide. Collez la clé anon du projet Recompta dans docs/supabase-config.js (Settings → API Keys), puis attendez le déploiement GitHub Pages.";
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
