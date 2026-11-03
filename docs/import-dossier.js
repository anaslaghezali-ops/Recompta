import { requireCabinetSession, formatMonthLabel, loadDossierContext } from "./dossiers-client.js?v=dash2";
import {
  createDebouncedSaver,
  createWorkspaceTracker,
  loadDossierWorkspace,
  logDossierActivity,
  saveDossierWorkspace,
} from "./dossier-persistence.js?v=persist5";
import { escapeHtml } from "./dashboard-ui.js?v=portfolio1";

export function shortFilename(name) {
  if (!name) return "";
  const parts = name.split("/");
  return parts.length > 1 ? parts.slice(-2).join("/") : name;
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export function workspaceBackHref(context) {
  return context?.clientId ? `workspace.html?client=${context.clientId}&dossier=${context.dossierId}` : "dossiers.html";
}

export async function initDossierImportPage() {
  const params = new URLSearchParams(window.location.search);
  const dossierId = Number(params.get("dossier"));
  if (!dossierId) {
    window.location.href = "dossiers.html";
    return null;
  }

  const membership = await requireCabinetSession();
  if (!membership) return null;

  const context = await loadDossierContext(dossierId);
  if (!context) {
    window.location.href = "dossiers.html";
    return null;
  }

  const tracker = createWorkspaceTracker();
  const workspace = await loadDossierWorkspace(dossierId, { tracker, adoptBank: true });
  const session = {
    tracker,
    membership,
    context,
    dossierId,
    lines: workspace?.lines || [],
    bankTransactions: workspace?.bank_transactions || [],
    bankMeta: {
      filename: "",
      bankName: "BANQUE",
      bankIce: "",
      bankIf: "",
      ...(workspace?.bank_meta || {}),
    },
    updatedAt: workspace?.updated_at || null,
  };

  return session;
}

export function renderImportContextBar(session, mount) {
  const { context } = session;
  mount.innerHTML = `
    <div class="imp-context-item">
      <span class="imp-context-label">Client</span>
      <strong>${escapeHtml(context.clientName)}</strong>
    </div>
    <div class="imp-context-item">
      <span class="imp-context-label">Période</span>
      <strong>${escapeHtml(formatMonthLabel(context.month))} ${context.year}</strong>
    </div>
    <div class="imp-context-item">
      <span class="imp-context-label">ICE</span>
      <strong>${escapeHtml(context.clientIce)}</strong>
    </div>
  `;
}

// Données importées par le serveur pendant que la page était ouverte : la
// sauvegarde les a conservées, la page les reprend.
function adoptSavedWorkspace(session, saved) {
  if (!saved) return;
  if (saved.added) session.lines = saved.lines;
  if (saved.bankChanged) {
    session.bankTransactions = saved.bank_transactions;
    session.bankMeta = { ...session.bankMeta, ...saved.bank_meta };
  }
}

export function createWorkspaceSaver(session, onStatus) {
  return createDebouncedSaver(async ({ eventType, summary, meta }) => {
    onStatus?.("Enregistrement…", "pending");
    const saved = await saveDossierWorkspace(session.dossierId, {
      lines: session.lines,
      bankTransactions: session.bankTransactions,
      bankMeta: session.bankMeta,
      tracker: session.tracker,
    });
    adoptSavedWorkspace(session, saved);
    if (eventType) {
      await logDossierActivity(session.dossierId, eventType, summary, meta);
    }
    onStatus?.("Enregistré", "success");
  }, 1200);
}

export async function persistWorkspaceNow(session, onStatus, eventType, summary, meta = {}) {
  onStatus?.("Enregistrement…", "pending");
  const saved = await saveDossierWorkspace(session.dossierId, {
    lines: session.lines,
    bankTransactions: session.bankTransactions,
    bankMeta: session.bankMeta,
    tracker: session.tracker,
  });
  adoptSavedWorkspace(session, saved);
  if (eventType) {
    await logDossierActivity(session.dossierId, eventType, summary, meta);
  }
  onStatus?.("Enregistré", "success");
}
