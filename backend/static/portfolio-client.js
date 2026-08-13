import { getSupabase } from "./auth-client.js?v=auth5";
import {
  formatMonthLabel,
  formatRelativeTime,
  listClientsWithDossiers,
  periodToMmaaaa,
  STATUS_META,
} from "./dossiers-client.js?v=portfolio1";

export { formatRelativeTime, STATUS_META };

/** Échéance TVA Maroc : 20 du mois suivant la période */
export function tvaDeadlineDate(year, month) {
  return new Date(year, month, 20, 23, 59, 59);
}

export function daysUntilDeadline(year, month) {
  const deadline = tvaDeadlineDate(year, month);
  return Math.ceil((deadline.getTime() - Date.now()) / 86400000);
}

export function countLineAnomalies(lines) {
  return (lines || []).filter((line) => {
    const ice = String(line.ice_frs || "").replace(/\D/g, "");
    if (ice.length !== 15) return true;
    if (!String(line.fact_num || "").trim()) return true;
    if (!String(line.lib_frss || "").trim()) return true;
    const conf = line.field_confidence || {};
    if (Object.values(conf).some((v) => v === "error" || v === "warn")) return true;
    return false;
  }).length;
}

export function computeProgress(dossier, workspace) {
  if (!dossier) return 0;
  if (dossier.status === "exported") return 100;

  const lines = workspace?.lines || [];
  const bank = workspace?.bank_transactions || [];
  const anomalies = countLineAnomalies(lines);

  let score = 0;
  if (bank.length > 0) score += 20;
  if (lines.length > 0) score += 35;
  if (lines.length > 0 && anomalies === 0) score += 25;
  else if (lines.length > 0 && anomalies < lines.length * 0.1) score += 15;
  if (dossier.status === "in_review" && anomalies === 0) score += 15;
  if (dossier.status === "in_review") score += 5;

  return Math.min(99, score);
}

export function resolvePriority({ dossier, progress, anomalyCount, daysLeft, statusKey }) {
  if (!dossier) return { key: "low", label: "Nouveau", tone: "neutral" };
  if (statusKey === "exported") return { key: "done", label: "Terminé", tone: "success" };
  if (daysLeft < 0) return { key: "critical", label: "En retard", tone: "danger" };
  if (daysLeft <= 7 || anomalyCount >= 5) return { key: "critical", label: "Urgent", tone: "danger" };
  if (daysLeft <= 14 || anomalyCount > 0 || statusKey === "in_review") {
    return { key: "high", label: "Prioritaire", tone: "warn" };
  }
  if (progress > 0) return { key: "normal", label: "En cours", tone: "accent" };
  return { key: "low", label: "À démarrer", tone: "neutral" };
}

export function resolveNextAction({ dossier, workspace, anomalyCount, statusKey }) {
  if (!dossier) {
    return { label: "Créer une période TVA", href: null, action: "create_period" };
  }
  if (statusKey === "exported") {
    return { label: "Période clôturée", href: null, action: "done" };
  }

  const lines = workspace?.lines || [];
  const bank = workspace?.bank_transactions || [];

  if (bank.length === 0) {
    return {
      label: "Importer le relevé bancaire",
      href: `index.html?dossier=${dossier.id}`,
      action: "bank",
    };
  }
  if (lines.length === 0) {
    return {
      label: "Importer les factures achats",
      href: `index.html?dossier=${dossier.id}`,
      action: "purchases",
    };
  }
  if (anomalyCount > 0) {
    return {
      label: `Corriger ${anomalyCount} anomalie${anomalyCount > 1 ? "s" : ""}`,
      href: `index.html?dossier=${dossier.id}`,
      action: "fix",
    };
  }
  if (statusKey === "in_review") {
    return {
      label: "Valider et exporter",
      href: `index.html?dossier=${dossier.id}`,
      action: "export",
    };
  }
  return {
    label: "Poursuivre la production",
    href: `index.html?dossier=${dossier.id}`,
    action: "continue",
  };
}

function pickActiveDossier(dossiers) {
  if (!dossiers?.length) return null;
  const open = dossiers.filter((d) => d.status !== "exported");
  const pool = open.length ? open : dossiers;
  return pool.reduce((best, d) => {
    if (!best) return d;
    const bestTs = new Date(best.updated_at || best.created_at || 0).getTime();
    const curTs = new Date(d.updated_at || d.created_at || 0).getTime();
    return curTs > bestTs ? d : best;
  }, null);
}

export function buildPortfolioRow(client, workspaceByDossierId = {}) {
  const activeDossier = pickActiveDossier(client.dossiers);
  const workspace = activeDossier ? workspaceByDossierId[activeDossier.id] : null;
  const lines = workspace?.lines || [];
  const bank = workspace?.bank_transactions || [];
  const anomalyCount = countLineAnomalies(lines);
  const operationCount = lines.length + bank.length;
  const progress = computeProgress(activeDossier, workspace);
  const statusKey = activeDossier?.status || "draft";
  const statusLabel = activeDossier
    ? (STATUS_META[statusKey]?.label || "En cours")
    : "Nouveau";

  const daysLeft = activeDossier
    ? daysUntilDeadline(activeDossier.period_year, activeDossier.period_month)
    : null;

  const priority = resolvePriority({
    dossier: activeDossier,
    progress,
    anomalyCount,
    daysLeft: daysLeft ?? 999,
    statusKey,
  });

  const nextAction = resolveNextAction({
    dossier: activeDossier,
    workspace,
    anomalyCount,
    statusKey,
  });

  const lastActivity = workspace?.updated_at
    || activeDossier?.updated_at
    || activeDossier?.created_at
    || client.created_at;

  const periodLabel = activeDossier
    ? `${formatMonthLabel(activeDossier.period_month)} ${activeDossier.period_year}`
    : null;

  const periodCode = activeDossier
    ? periodToMmaaaa(activeDossier.period_year, activeDossier.period_month)
    : null;

  return {
    clientId: client.id,
    name: client.name,
    ice: client.ice,
    dossierId: activeDossier?.id || null,
    periodLabel,
    periodCode,
    progress,
    operationCount,
    lineCount: lines.length,
    bankCount: bank.length,
    anomalyCount,
    lastActivity,
    lastActivityLabel: formatRelativeTime(lastActivity),
    nextAction,
    statusKey,
    statusLabel,
    priority,
    daysLeft,
    isLate: daysLeft !== null && daysLeft < 0 && statusKey !== "exported",
    isDone: statusKey === "exported",
    needsValidation: statusKey === "in_review" || anomalyCount > 0,
    openPeriodCount: (client.dossiers || []).filter((d) => d.status !== "exported").length,
  };
}

export function computePortfolioKpis(rows) {
  const activeClients = rows.filter((r) => r.dossierId && !r.isDone).length;
  const periodsInProgress = rows.reduce((sum, r) => sum + r.openPeriodCount, 0);
  const aiExceptions = rows.reduce((sum, r) => sum + r.anomalyCount, 0);
  const exportsReady = rows.filter((r) => r.isDone).length;
  const tvaLate = rows.filter((r) => r.isLate).length;

  return {
    activeClients,
    periodsInProgress,
    aiExceptions,
    exportsReady,
    tvaLate,
  };
}

export function matchesPortfolioFilter(row, filter, userId) {
  switch (filter) {
    case "all":
      return true;
    case "priority":
      return row.priority.key === "critical" || row.priority.key === "high";
    case "late":
      return row.isLate;
    case "validate":
      return row.needsValidation && !row.isDone;
    case "done":
      return row.isDone;
    case "mine":
      return true; // MVP : tous les clients du cabinet
    default:
      return true;
  }
}

export async function listPortfolioRows(cabinetId) {
  const clients = await listClientsWithDossiers(cabinetId);
  const dossierIds = clients.flatMap((c) => (c.dossiers || []).map((d) => d.id));

  const workspaceByDossierId = {};
  if (dossierIds.length > 0) {
    const supabase = getSupabase();
    if (supabase) {
      const { data, error } = await supabase
        .from("dossier_workspaces")
        .select("dossier_id, lines, bank_transactions, updated_at")
        .in("dossier_id", dossierIds);
      if (error) throw error;
      for (const ws of data || []) {
        workspaceByDossierId[ws.dossier_id] = ws;
      }
    }
  }

  const rows = clients.map((client) => buildPortfolioRow(client, workspaceByDossierId));

  rows.sort((a, b) => {
    const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3, done: 4 };
    const pa = priorityOrder[a.priority.key] ?? 5;
    const pb = priorityOrder[b.priority.key] ?? 5;
    if (pa !== pb) return pa - pb;
    if (a.anomalyCount !== b.anomalyCount) return b.anomalyCount - a.anomalyCount;
    return String(a.name).localeCompare(String(b.name), "fr");
  });

  return rows;
}
