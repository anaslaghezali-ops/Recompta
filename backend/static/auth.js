const AUTH_KEY = "recompta_session";

let _supabase = null;

export async function getSupabase() {
  if (_supabase) return _supabase;
  const res = await fetch("/api/config");
  const cfg = await res.json();
  if (!cfg.saas_enabled || !cfg.supabase_url) return null;
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.49.1");
  _supabase = createClient(cfg.supabase_url, cfg.supabase_anon_key);
  return _supabase;
}

export async function getAccessToken() {
  const sb = await getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function authHeaders() {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function requireAuth(redirectTo = "/login.html") {
  const sb = await getSupabase();
  if (!sb) return true; // mode sans SaaS
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    window.location.href = redirectTo;
    return false;
  }
  return true;
}

export async function signOut() {
  const sb = await getSupabase();
  if (sb) await sb.auth.signOut();
  window.location.href = "/login.html";
}
