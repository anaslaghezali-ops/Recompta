import { getSupabase, requireSuperAdminSession } from "./auth-client.js?v=auth8";

export function isBillableVisionEngine(engine) {
  return engine === "scan" || engine === "ai";
}

const DEFAULT_VISION_QUOTA = 10;

export async function loadMyVisionCredits(options = {}) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const sessionCabinetId = options.cabinetId ?? null;

  try {
    const { data, error } = await supabase.rpc("get_my_vision_credits");
    if (error) throw error;
    if (data?.cabinet_id) return data;
  } catch (err) {
    console.warn("[credits] get_my_vision_credits:", err?.message || err);
  }

  if (sessionCabinetId) {
    return {
      cabinet_id: sessionCabinetId,
      quota: DEFAULT_VISION_QUOTA,
      used: 0,
      remaining: DEFAULT_VISION_QUOTA,
      fallback: true,
    };
  }

  return null;
}

export async function loadAdminVisionCreditsSettings() {
  await requireSuperAdminSession();
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase.rpc("admin_get_vision_credits_settings");
  if (error) throw error;
  return data;
}

export async function saveAdminVisionCreditsDefault(quota) {
  await requireSuperAdminSession();
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");

  const value = Number(quota);
  if (!Number.isFinite(value) || value < 0 || value > 100000) {
    throw new Error("Quota invalide (0 à 100000).");
  }

  const { data, error } = await supabase.rpc("admin_set_vision_credits_default", {
    p_quota: Math.trunc(value),
  });
  if (error) throw error;
  return data;
}

export async function saveAdminCabinetVisionQuota(cabinetId, quota) {
  await requireSuperAdminSession();
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");

  let parsed = null;
  if (quota !== "" && quota != null) {
    parsed = Number(quota);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000) {
      throw new Error("Quota cabinet invalide (0 à 100000, ou vide = défaut).");
    }
    parsed = Math.trunc(parsed);
  }

  const { data, error } = await supabase.rpc("admin_set_cabinet_vision_quota", {
    p_cabinet_id: cabinetId,
    p_quota: parsed,
  });
  if (error) throw error;
  return data;
}

export async function listAdminCabinetVisionCredits() {
  await requireSuperAdminSession();
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase.rpc("admin_list_cabinet_vision_credits");
  if (error) throw error;
  return data || [];
}

export function formatCreditsLabel(credits) {
  if (!credits?.cabinet_id) return "";
  const { remaining = 0, quota = 0, used = 0, fallback = false } = credits;
  const base = `${remaining}/${quota} crédits vision ce mois (${used} utilisés)`;
  return fallback ? `${base} · estimation (migration crédits à appliquer)` : base;
}

export function creditsDepleted(credits) {
  if (!credits?.cabinet_id) return false;
  return Number(credits.remaining || 0) <= 0;
}
