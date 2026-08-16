import { getSupabase } from "./auth-client.js?v=auth6";
import { fetchActiveImportMap } from "./import-jobs-client.js?v=jobs13";
import { countLinesNeedingReview } from "./field-confidence.js";
import { findDuplicateLineIndexes } from "./extract-client.js";
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

export function countLineAnomalies(lines, clientIce = "") {
  return countLinesNeedingReview(lines, {
    clientIce,
    duplicateIndexes: findDuplicateLineIndexes(lines || []),
  });
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

export function resolveNextAction({ dossier, workspace, anomalyCount, statusKey, clientId = null }) {
  if (!dossier) {
    return { label: "Créer une période TVA", href: null, action: "create_period" };
  }
  if (statusKey === "exported") {
    return { label: "Période clôturée", href: null, action: "done" };
  }

  const lines = workspace?.lines || [];
  const bank = workspace?.bank_transactions || [];
  const pendingAnalysis = workspace?.pendingAnalysis || 0;
  const bankPending = workspace?.bankPending || 0;
  const invoicePending = workspace?.invoicePending || 0;
  const invoiceDocumentCount = workspace?.invoiceDocumentCount || 0;
  const wsBase = clientId
    ? `workspace.html?client=${clientId}&dossier=${dossier.id}`
    : null;

  if (bank.length === 0 && bankPending === 0) {
    return {
      label: "Importer le relevé bancaire",
      href: `import-banque.html?dossier=${dossier.id}`,
      action: "bank",
    };
  }
  if (bank.length === 0 && bankPending > 0 && lines.length === 0) {
    return {
      label: "Extraire le relevé bancaire",
      href: wsBase ? `${wsBase}&tab=cockpit` : null,
      action: "extract_bank",
      tab: "cockpit",
    };
  }
  if (lines.length === 0 && pendingAnalysis > 0) {
    return {
      label: "Lancer l'extraction",
      href: wsBase ? `${wsBase}&tab=cockpit` : null,
      action: "analysis",
    };
  }
  if (lines.length === 0 && pendingAnalysis === 0 && (bank.length > 0 || invoiceDocumentCount > 0)) {
    if (bank.length > 0 && invoiceDocumentCount > 0) {
      return {
        label: "Lancer le rapprochement bancaire",
        href: wsBase ? `${wsBase}&tab=cockpit` : null,
        action: "bank_match",
        tab: "cockpit",
      };
    }
    return {
      label: invoiceDocumentCount > 0 ? "Vérifier la revue" : "Vérifier le relevé bancaire",
      href: wsBase ? `${wsBase}&tab=review` : null,
      action: "review",
      tab: "review",
    };
  }
  if (lines.length === 0) {
    return {
      label: "Importer les factures achats",
      href: `import-achats.html?dossier=${dossier.id}`,
      action: "purchases",
    };
  }
  if (anomalyCount > 0) {
    return {
      label: `Corriger ${anomalyCount} anomalie${anomalyCount > 1 ? "s" : ""}`,
      href: wsBase ? `${wsBase}&tab=review&view=anomalies` : null,
      action: "fix",
      tab: "review",
      view: "anomalies",
    };
  }
  if (statusKey !== "exported") {
    return {
      label: "Valider la déclaration TVA",
      href: wsBase ? `${wsBase}&tab=review` : null,
      action: "declare",
      tab: "review",
    };
  }
  return {
    label: "Vérifier et exporter",
    href: wsBase ? `${wsBase}&tab=review` : null,
    action: "continue",
    tab: "review",
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

export function buildPortfolioRow(client, workspaceByDossierId = {}, activeImportByDossierId = new Map()) {
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
    clientId: client.id,
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
    importJob: activeDossier ? activeImportByDossierId.get(activeDossier.id) || null : null,
  };
}

export function computePortfolioKpis(rows) {
  const activeClients = rows.filter((r) => r.dossierId && !r.isDone).length;
  const periodsInProgress = rows.reduce((sum, r) => sum + r.openPeriodCount, 0);
  const aiExceptions = rows.reduce((sum, r) => sum + r.anomalyCount, 0);
  const exportsReady = rows.filter((r) => r.isDone).length;
  const tvaLate = rows.filter((r) => r.isLate).length;
  const activeImports = rows.filter((r) => r.importJob).length;

  return {
    activeClients,
    periodsInProgress,
    aiExceptions,
    exportsReady,
    tvaLate,
    activeImports,
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
  let activeImportByDossierId = new Map();
  if (dossierIds.length > 0) {
    const supabase = getSupabase();
    if (supabase) {
      const [{ data, error }, importMap] = await Promise.all([
        supabase
          .from("dossier_workspaces")
          .select("dossier_id, lines, bank_transactions, updated_at")
          .in("dossier_id", dossierIds),
        fetchActiveImportMap(dossierIds),
      ]);
      if (error) throw error;
      for (const ws of data || []) {
        workspaceByDossierId[ws.dossier_id] = ws;
      }
      activeImportByDossierId = importMap;
    }
  }

  const rows = clients.map((client) => buildPortfolioRow(client, workspaceByDossierId, activeImportByDossierId));

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
