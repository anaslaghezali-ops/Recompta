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

/** Prefers full lines when present; empty lineRefs must not hide them. */
export function workspaceLinesForAnalysis(workspace) {
  if (Array.isArray(workspace?.lines) && workspace.lines.length) return workspace.lines;
  if (Array.isArray(workspace?.lineRefs) && workspace.lineRefs.length) return workspace.lineRefs;
  return [];
}

/** Keep lines/bank already loaded (documents / revue) when a summary refresh arrives. */
export function mergeWorkspaceSnapshot(current, next) {
  if (!next) return current || null;
  if ((next.lines && next.lines.length) || (next.bank_transactions && next.bank_transactions.length)) {
    return next;
  }
  if ((current?.lines && current.lines.length) || (current?.bank_transactions && current.bank_transactions.length)) {
    return {
      ...current,
      ...next,
      lines: current.lines,
      bank_transactions: current.bank_transactions,
    };
  }
  return next;
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
  const storedAnomalies = summary.data?.anomaly_count;
  return {
    lineCount: lines.length,
    bankCount: (full.bank_transactions || []).length,
    anomalyCount: storedAnomalies != null ? Number(storedAnomalies) || 0 : undefined,
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

// ── Écritures concurrentes ────────────────────────────────────────────────
// Le serveur (imports en arrière-plan) et chaque page ouverte écrivent la même
// ligne dossier_workspaces. Deux protections :
//
// 1. Écriture conditionnelle (compare-and-swap sur updated_at) : on relit,
//    on fusionne, on écrit seulement si personne n'a écrit entre-temps, sinon
//    on recommence. Aucune écriture concurrente n'est écrasée en aveugle.
// 2. Fusion, via un « tracker » propre à chaque composant qui détient des
//    lignes (revue, rapprochement, page d'import…) : un composant ne peut
//    avoir supprimé que des documents qu'il a repris dans son état. Toute
//    ligne serveur d'un document jamais repris est donc conservée. Idem pour
//    le relevé : si le composant n'a pas modifié le relevé qu'il a repris,
//    celui du serveur (importé entre-temps) est conservé.
//
// Sans tracker : écriture conditionnelle seule (dernier état écrasé, mais
// jamais une écriture intermédiaire).
const SAVE_ATTEMPTS = 5;

function sourceIdOf(line) {
  return String(line?.source_id || "").trim();
}

function bankKey(transactions, meta) {
  const sortedMeta = Object.fromEntries(Object.entries(meta || {}).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify([transactions || [], sortedMeta]);
}

/** Un tracker par composant qui garde des lignes en mémoire et les sauvegarde. */
export function createWorkspaceTracker() {
  return { seen: new Set(), bank: null };
}

export function trackerAdoptLines(tracker, lines) {
  if (!tracker) return;
  for (const line of lines || []) {
    const sid = sourceIdOf(line);
    if (sid) tracker.seen.add(sid);
  }
}

export function trackerAdoptBank(tracker, transactions, meta) {
  if (tracker) tracker.bank = bankKey(transactions, meta);
}

/**
 * Lignes locales + lignes serveur de documents jamais vus localement.
 * Fonction pure (testée dans test-concurrent-lines.mjs).
 */
export function mergeConcurrentLines(localLines, serverLines, seen) {
  const local = Array.isArray(localLines) ? localLines : [];
  if (!seen) return { lines: local, added: 0 };
  const localSources = new Set(local.map(sourceIdOf).filter(Boolean));
  const extra = (serverLines || []).filter((line) => {
    const sid = sourceIdOf(line);
    return sid && !seen.has(sid) && !localSources.has(sid);
  });
  if (!extra.length) return { lines: local, added: 0 };
  return { lines: [...local, ...extra], added: extra.length };
}

/** Relevé à écrire : celui du serveur si le composant n'a pas touché au sien. */
export function resolveConcurrentBank(local, server, adoptedKey) {
  const localKey = bankKey(local.bank_transactions, local.bank_meta);
  const serverKey = bankKey(server.bank_transactions, server.bank_meta);
  if (adoptedKey != null && localKey === adoptedKey && serverKey !== adoptedKey) {
    return {
      bank_transactions: server.bank_transactions,
      bank_meta: server.bank_meta,
      changed: true,
    };
  }
  return { bank_transactions: local.bank_transactions, bank_meta: local.bank_meta, changed: false };
}

/**
 * @param {object} [options]
 * @param {object} [options.tracker] tracker du composant qui reprend ces
 *   données comme état local. Ne pas le passer pour une simple lecture.
 * @param {boolean} [options.adoptLines=true] le composant reprend les lignes.
 * @param {boolean} [options.adoptBank=false] le composant reprend le relevé.
 */
export async function loadDossierWorkspace(dossierId, { tracker = null, adoptLines = true, adoptBank = false } = {}) {
  const result = await fetchDossierWorkspace(dossierId);
  if (result && tracker) {
    if (adoptLines) trackerAdoptLines(tracker, result.lines);
    if (adoptBank) trackerAdoptBank(tracker, result.bank_transactions, result.bank_meta);
  }
  return result;
}

async function fetchDossierWorkspace(dossierId) {
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
      exists: false,
      lines: [],
      bank_transactions: [],
      bank_meta: { ...DEFAULT_BANK_META },
      updated_at: null,
    };
  }

  return {
    exists: true,
    lines: Array.isArray(data.lines) ? data.lines : [],
    bank_transactions: Array.isArray(data.bank_transactions) ? data.bank_transactions : [],
    bank_meta: { ...DEFAULT_BANK_META, ...(data.bank_meta || {}) },
    updated_at: data.updated_at,
  };
}

function nextUpdatedAt(previous) {
  const now = Date.now();
  const prev = previous ? Date.parse(previous) : NaN;
  return new Date(Number.isFinite(prev) && prev >= now ? prev + 1 : now).toISOString();
}

/**
 * Retourne `{ dossier_id, updated_at, lines, added, bank_transactions,
 * bank_meta, bankChanged }`. Si `added > 0` ou `bankChanged`, des données
 * importées entre-temps ont été conservées : l'appelant doit reprendre
 * `lines` (et le relevé) comme nouvel état local.
 */
export async function saveDossierWorkspace(dossierId, { lines, bankTransactions, bankMeta, tracker = null }) {
  const supabase = getSupabase();
  if (!supabase || !dossierId) return null;

  const local = {
    lines: lines || [],
    bank_transactions: bankTransactions || [],
    bank_meta: bankMeta || DEFAULT_BANK_META,
  };

  let data = null;
  let finalLines = local.lines;
  let added = 0;
  let bank = { bank_transactions: local.bank_transactions, bank_meta: local.bank_meta, changed: false };

  for (let attempt = 1; ; attempt += 1) {
    const server = await fetchDossierWorkspace(dossierId);
    ({ lines: finalLines, added } = mergeConcurrentLines(local.lines, server.lines, tracker?.seen));
    bank = resolveConcurrentBank(local, server, tracker?.bank);

    const payload = {
      lines: finalLines,
      bank_transactions: bank.bank_transactions,
      bank_meta: bank.bank_meta,
      updated_at: nextUpdatedAt(server.updated_at),
    };

    let result;
    if (server.exists) {
      // N'écrit que si personne n'a écrit depuis la relecture.
      result = await supabase
        .from("dossier_workspaces")
        .update(payload)
        .eq("dossier_id", dossierId)
        .eq("updated_at", server.updated_at)
        .select("dossier_id, updated_at");
    } else {
      result = await supabase
        .from("dossier_workspaces")
        .insert({ dossier_id: dossierId, ...payload })
        .select("dossier_id, updated_at");
    }

    const conflict = result.error?.code === "23505";
    if (result.error && !conflict) throw result.error;
    const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
    if (!conflict && rows.length) {
      data = rows[0];
      break;
    }
    if (attempt >= SAVE_ATTEMPTS) {
      throw new Error("Enregistrement impossible : le dossier est modifié ailleurs en continu. Réessayez.");
    }
    await new Promise((resolve) => setTimeout(resolve, 80 * attempt + Math.random() * 120));
  }

  trackerAdoptLines(tracker, finalLines);
  trackerAdoptBank(tracker, bank.bank_transactions, bank.bank_meta);

  const { data: dossier, error: dossierError } = await supabase
    .from("client_dossiers")
    .select("status")
    .eq("id", dossierId)
    .maybeSingle();
  if (dossierError) throw dossierError;

  if (dossier?.status !== "exported") {
    const lineCount = finalLines.length;
    let status = "draft";
    if (lineCount > 0) status = "in_review";

    const { error: statusError } = await supabase
      .from("client_dossiers")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", dossierId);
    if (statusError) throw statusError;
  }

  return {
    ...data,
    lines: finalLines,
    added,
    bank_transactions: bank.bank_transactions,
    bank_meta: bank.bank_meta,
    bankChanged: bank.changed,
  };
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
