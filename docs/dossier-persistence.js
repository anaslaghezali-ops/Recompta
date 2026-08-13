import { getSupabase } from "./auth-client.js?v=auth5";

const DEFAULT_BANK_META = {
  filename: "",
  bankName: "BANQUE",
  bankIce: "",
  bankIf: "",
};

export function createDebouncedSaver(fn, delayMs = 2000) {
  let timer = null;
  let pending = null;

  function run() {
    if (!pending) return Promise.resolve();
    const payload = pending;
    pending = null;
    return fn(payload);
  }

  return {
    schedule(payload) {
      pending = payload;
      clearTimeout(timer);
      timer = setTimeout(() => {
        run().catch(() => {});
      }, delayMs);
    },
    flush() {
      clearTimeout(timer);
      return run();
    },
  };
}

export async function loadDossierWorkspace(dossierId) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) return null;

  const { data, error } = await supabase
    .from("dossier_workspaces")
    .select("dossier_id, lines, bank_transactions, bank_meta, updated_at")
    .eq("dossier_id", dossierId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    return {
      lines: [],
      bank_transactions: [],
      bank_meta: { ...DEFAULT_BANK_META },
      updated_at: null,
    };
  }

  return {
    lines: Array.isArray(data.lines) ? data.lines : [],
    bank_transactions: Array.isArray(data.bank_transactions) ? data.bank_transactions : [],
    bank_meta: { ...DEFAULT_BANK_META, ...(data.bank_meta || {}) },
    updated_at: data.updated_at,
  };
}

export async function saveDossierWorkspace(dossierId, { lines, bankTransactions, bankMeta }) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) return null;

  const payload = {
    dossier_id: dossierId,
    lines: lines || [],
    bank_transactions: bankTransactions || [],
    bank_meta: bankMeta || DEFAULT_BANK_META,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("dossier_workspaces")
    .upsert(payload, { onConflict: "dossier_id" })
    .select("dossier_id, updated_at")
    .single();

  if (error) throw error;

  const lineCount = (lines || []).length;
  let status = "draft";
  if (lineCount > 0) status = "in_review";

  await supabase
    .from("client_dossiers")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", dossierId);

  return data;
}

export async function markDossierExported(dossierId) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) return;
  await supabase
    .from("client_dossiers")
    .update({ status: "exported", updated_at: new Date().toISOString() })
    .eq("id", dossierId);
}

export async function logDossierActivity(dossierId, eventType, summary, meta = {}) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) return;
  const { error } = await supabase.from("dossier_activity").insert({
    dossier_id: dossierId,
    event_type: eventType,
    summary,
    meta,
  });
  if (error) console.warn("activity log:", error.message);
}

export async function listDossierActivity(dossierId, limit = 20) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) return [];
  const { data, error } = await supabase
    .from("dossier_activity")
    .select("id, event_type, summary, meta, created_at")
    .eq("dossier_id", dossierId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function listClientActivity(clientId, limit = 30) {
  const supabase = getSupabase();
  if (!supabase || !clientId) return [];

  const { data: dossiers, error: dossierError } = await supabase
    .from("client_dossiers")
    .select("id")
    .eq("client_id", clientId);
  if (dossierError) throw dossierError;

  const dossierIds = (dossiers || []).map((d) => d.id);
  if (!dossierIds.length) return [];

  const { data, error } = await supabase
    .from("dossier_activity")
    .select("id, dossier_id, event_type, summary, meta, created_at")
    .in("dossier_id", dossierIds)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}
