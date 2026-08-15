import { loadDossierWorkspace } from "./dossier-persistence.js?v=persist1";
import {
  formatMonthLabel,
  formatRelativeTime,
  periodToMmaaaa,
  STATUS_META,
} from "./dossiers-client.js?v=dash2";
import {
  computeProgress,
  countLineAnomalies,
  daysUntilDeadline,
  resolveNextAction,
  resolvePriority,
  tvaDeadlineDate,
} from "./portfolio-client.js?v=portfolio4";

export function pickActiveDossier(dossiers, preferredId = null) {
  if (!dossiers?.length) return null;
  if (preferredId) {
    const match = dossiers.find((d) => d.id === preferredId);
    if (match) return match;
  }
  const open = dossiers.filter((d) => d.status !== "exported");
  const pool = open.length ? open : dossiers;
  return pool.reduce((best, d) => {
    if (!best) return d;
    const bestTs = new Date(best.updated_at || best.created_at || 0).getTime();
    const curTs = new Date(d.updated_at || d.created_at || 0).getTime();
    return curTs > bestTs ? d : best;
  }, null);
}

export function formatDeadlineLabel(daysLeft, year, month) {
  if (daysLeft === null || daysLeft === undefined) return "—";
  const deadline = tvaDeadlineDate(year, month);
  const dateStr = deadline.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
  if (daysLeft < 0) return `Échéance dépassée (${dateStr})`;
  if (daysLeft === 0) return `Échéance aujourd'hui — ${dateStr}`;
  if (daysLeft === 1) return `Échéance demain — ${dateStr}`;
  return `Échéance dans ${daysLeft} j — ${dateStr}`;
}

export function buildPipelineSteps({
  dossier,
  workspace,
  anomalyCount,
  statusKey,
  clientId = null,
  pendingAnalysis = 0,
  bankPending = 0,
}) {
  const lines = workspace?.lines || [];
  const bank = workspace?.bank_transactions || [];
  const hasBank = bank.length > 0;
  const hasBankDocument = hasBank || bankPending > 0;
  const hasLines = lines.length > 0;
  const hasDocuments = hasLines || pendingAnalysis > 0;
  const isExported = statusKey === "exported";
  const isReview = statusKey === "in_review";

  function stepStatus(done, current) {
    if (done) return "done";
    if (current) return "current";
    return "pending";
  }

  const bankDone = hasBankDocument;
  const purchasesDone = hasDocuments;
  const analysisDone = hasLines;
  const reviewDone = hasLines && anomalyCount === 0;
  const exportDone = isExported;

  const bankCurrent = !hasBankDocument && !isExported;
  const purchasesCurrent = hasBankDocument && !hasDocuments && !isExported;
  const analysisCurrent = hasDocuments && !hasLines && !isExported;
  const reviewCurrent = hasLines && anomalyCount > 0 && !isExported;
  const exportCurrent = hasLines && anomalyCount === 0 && !isExported && !isReview;

  const wsReview = clientId && dossier
    ? `workspace.html?client=${clientId}&dossier=${dossier.id}&tab=review`
    : null;
  const wsAnomalies = clientId && dossier
    ? `workspace.html?client=${clientId}&dossier=${dossier.id}&tab=review&view=anomalies`
    : null;

  return [
    {
      key: "bank",
      label: "Relevé bancaire",
      desc: hasBank
        ? `${bank.length} opération${bank.length > 1 ? "s" : ""}`
        : bankPending > 0
          ? "Importé — analyse en attente"
          : "Importer le relevé",
      icon: "landmark",
      status: stepStatus(bankDone, bankCurrent),
      href: dossier ? `import-banque.html?dossier=${dossier.id}` : null,
    },
    {
      key: "purchases",
      label: "Factures achats",
      desc: hasLines ? `${lines.length} ligne${lines.length > 1 ? "s" : ""}` : "Importer les factures",
      icon: "file-input",
      status: stepStatus(purchasesDone, purchasesCurrent && !hasLines),
      href: dossier ? `import-achats.html?dossier=${dossier.id}` : null,
    },
    {
      key: "analysis",
      label: "Analyse IA",
      desc: hasLines ? "Extraction terminée" : "Lancer l'extraction",
      icon: "sparkles",
      status: stepStatus(hasLines, !hasLines && purchasesDone && !isExported),
      action: "analysis",
    },
    {
      key: "review",
      label: "Contrôle & revue",
      desc: anomalyCount > 0 ? `${anomalyCount} anomalie${anomalyCount > 1 ? "s" : ""}` : "Vérifier les lignes",
      icon: "shield-check",
      status: stepStatus(reviewDone, reviewCurrent),
      href: wsAnomalies || wsReview,
      tab: "review",
      view: anomalyCount > 0 ? "anomalies" : null,
    },
    {
      key: "export",
      label: "Export TVA",
      desc: isExported ? "Déclaration exportée" : "Excel DED TVA",
      icon: "file-spreadsheet",
      status: stepStatus(exportDone, exportCurrent),
      href: wsReview,
      tab: "review",
    },
  ];
}

export function buildCockpitState(client, dossier, workspace, { pendingAnalysis = 0, bankPending = 0, invoicePending = 0 } = {}) {
  if (!dossier) {
    return {
      hasPeriod: false,
      dossier: null,
      openPeriods: (client.dossiers || []).filter((d) => d.status !== "exported"),
    };
  }

  const lines = workspace?.lines || [];
  const bank = workspace?.bank_transactions || [];
  const anomalyCount = countLineAnomalies(lines);
  const progress = computeProgress(dossier, workspace);
  const statusKey = dossier.status || "draft";
  const statusLabel = STATUS_META[statusKey]?.label || "En cours";
  const daysLeft = daysUntilDeadline(dossier.period_year, dossier.period_month);
  const priority = resolvePriority({
    dossier,
    progress,
    anomalyCount,
    daysLeft,
    statusKey,
  });
  const nextAction = resolveNextAction({
    dossier,
    workspace: { ...(workspace || {}), pendingAnalysis, bankPending, invoicePending },
    anomalyCount,
    statusKey,
    clientId: client.id,
  });
  const pipeline = buildPipelineSteps({
    dossier,
    workspace,
    anomalyCount,
    statusKey,
    clientId: client.id,
    pendingAnalysis,
    bankPending,
  });
  const lastActivity = workspace?.updated_at || dossier.updated_at || dossier.created_at;

  return {
    hasPeriod: true,
    dossier,
    clientId: client.id,
    periodLabel: `${formatMonthLabel(dossier.period_month)} ${dossier.period_year}`,
    periodCode: periodToMmaaaa(dossier.period_year, dossier.period_month),
    progress: statusKey === "exported" ? 100 : progress,
    lineCount: lines.length,
    bankCount: bank.length,
    bankPending,
    invoicePending,
    operationCount: lines.length + bank.length,
    anomalyCount,
    daysLeft,
    deadlineLabel: formatDeadlineLabel(daysLeft, dossier.period_year, dossier.period_month),
    isLate: daysLeft < 0 && statusKey !== "exported",
    statusKey,
    statusLabel,
    priority,
    nextAction,
    pipeline,
    lastActivity,
    lastActivityLabel: formatRelativeTime(lastActivity),
    openPeriods: (client.dossiers || []).filter((d) => d.status !== "exported"),
    allPeriods: client.dossiers || [],
  };
}

export async function loadWorkspaceCockpit(
  client,
  preferredDossierId = null,
  { pendingAnalysis = 0, bankPending = 0, invoicePending = 0 } = {},
) {
  const dossier = pickActiveDossier(client.dossiers, preferredDossierId);
  const workspace = dossier ? await loadDossierWorkspace(dossier.id) : null;
  return buildCockpitState(client, dossier, workspace, { pendingAnalysis, bankPending, invoicePending });
}
