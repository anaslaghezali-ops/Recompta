import { getSupabase } from "./auth-client.js?v=auth6";

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
    cancel() {
      clearTimeout(timer);
      pending = null;
    },
  };
}

function parseCockpitRow(data) {
  const row = typeof data === "string" ? JSON.parse(data) : data;
  return {
    lineCount: Number(row.line_count) || 0,
    bankCount: Number(row.bank_count) || 0,
    anomalyCount: Number(row.anomaly_count) || 0,
    updated_at: row.updated_at || null,
    bank_meta: { ...DEFAULT_BANK_META, ...(row.bank_meta || {}) },
    lineRefs: Array.isArray(row.line_refs) ? row.line_refs : [],
    missingPaymentDates: Number(row.missing_payment_dates) || 0,
  };
}

export async function loadDossierWorkspaceSummary(dossierId) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) return null;

  const rpc = await supabase.rpc("get_workspace_cockpit", { p_dossier_id: dossierId });
  if (!rpc.error && rpc.data) {
    try {
      return parseCockpitRow(rpc.data);
    } catch {
      /* fallback below */
    }
  }

  const summary = await supabase
    .from("dossier_workspaces")
    .select("dossier_id, line_count, bank_count, anomaly_count, bank_meta, updated_at")
    .eq("dossier_id", dossierId)
    .maybeSingle();

  if (!summary.error && summary.data && !(Number(summary.data.line_count) > 0)) {
    return {
      lineCount: Number(summary.data.line_count) || 0,
      bankCount: Number(summary.data.bank_count) || 0,
      anomalyCount: Number(summary.data.anomaly_count) || 0,
      updated_at: summary.data.updated_at || null,
      bank_meta: { ...DEFAULT_BANK_META, ...(summary.data.bank_meta || {}) },
      lineRefs: [],
      missingPaymentDates: 0,
    };
  }

  const full = await loadDossierWorkspace(dossierId);
  if (!full) return null;
  const lines = full.lines || [];
  return {
    lineCount: lines.length,
    bankCount: (full.bank_transactions || []).length,
    anomalyCount: Number(summary.data?.anomaly_count) || 0,
    updated_at: full.updated_at,
    bank_meta: full.bank_meta,
    lineRefs: lines.map((line) => ({
      source_id: line.source_id || "",
      source_file: line.source_file || "",
    })),
    missingPaymentDates: lines.filter((line) => !String(line.date_paie || "").trim()).length,
    lines: full.lines,
    bank_transactions: full.bank_transactions,
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

  const { data: dossier, error: dossierError } = await supabase
    .from("client_dossiers")
    .select("status")
    .eq("id", dossierId)
    .maybeSingle();
  if (dossierError) throw dossierError;

  if (dossier?.status !== "exported") {
    const lineCount = (lines || []).length;
    let status = "draft";
    if (lineCount > 0) status = "in_review";

    const { error: statusError } = await supabase
      .from("client_dossiers")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", dossierId);
    if (statusError) throw statusError;
  }

  return data;
}

export async function markDossierExported(dossierId) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) return;
  const { error } = await supabase
    .from("client_dossiers")
    .update({ status: "exported", updated_at: new Date().toISOString() })
    .eq("id", dossierId);
  if (error) throw error;
}

export async function reopenDossierPeriod(dossierId) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) return null;

  const workspace = await loadDossierWorkspace(dossierId);
  const lineCount = workspace?.lines?.length || 0;
  const status = lineCount > 0 ? "in_review" : "draft";

  const { error } = await supabase
    .from("client_dossiers")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", dossierId);
  if (error) throw error;

  return status;
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
