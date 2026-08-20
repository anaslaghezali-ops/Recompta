import { getSupabase, requireSuperAdminSession } from "./auth-client.js?v=auth8";

export function isBillableVisionEngine(engine) {
  return engine === "scan" || engine === "ai";
}

function normalizeRpcCredits(data) {
  if (data == null) return null;
  let payload = data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (payload?.cabinet_id == null) return null;
  return payload;
}

async function loadCreditsFromTable(cabinetId) {
  const supabase = getSupabase();
  if (!supabase || !cabinetId) return null;

  const { data, error } = await supabase
    .from("cabinet_vision_credits")
    .select("monthly_quota_override, used_this_period")
    .eq("cabinet_id", cabinetId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const quota = data.monthly_quota_override != null
    ? Number(data.monthly_quota_override)
    : null;
  if (quota == null || !Number.isFinite(quota)) return null;

  const used = Number(data.used_this_period || 0);
  return {
    cabinet_id: cabinetId,
    quota,
    used,
    remaining: Math.max(quota - used, 0),
  };
}

export async function loadMyVisionCredits(options = {}) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const sessionCabinetId = options.cabinetId ?? null;

  try {
    const { data, error } = await supabase.rpc("get_my_vision_credits");
    if (error) throw error;
    const normalized = normalizeRpcCredits(data);
    if (normalized) return normalized;
  } catch (err) {
    console.warn("[credits] get_my_vision_credits:", err?.message || err);
  }

  if (sessionCabinetId) {
    try {
      const fromTable = await loadCreditsFromTable(sessionCabinetId);
      if (fromTable) return fromTable;
    } catch (err) {
      console.warn("[credits] cabinet_vision_credits:", err?.message || err);
    }
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
  const { remaining = 0, quota = 0, used = 0 } = credits;
  return `${remaining}/${quota} crédits vision ce mois (${used} utilisés)`;
}

export function creditsDepleted(credits) {
  if (!credits?.cabinet_id) return false;
  return Number(credits.remaining || 0) <= 0;
}
