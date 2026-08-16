import {
  applyFieldValueBulk,
  applySupplierFieldValueBulk,
  BULK_EDIT_FIELDS,
  completeSupplierIdentifiers,
  countLinesWithFieldValue,
  countSupplierFieldTargets,
  expandUploadedFiles,
  extractInvoice,
  fieldValuesMatch,
  findDuplicateLineIndexes,
  normalizeExtractionResults,
  setExtractionContext,
} from "./extract-client.js?v=ifdot1";
import { collectExportReview, exportDedTvaExcel } from "./export-client.js";
import {
  applyConfidenceToInput,
  countConfidenceIssues,
  lineNeedsReview,
  refreshLinesFieldConfidence,
} from "./field-confidence.js";
import {
  applyBankStatement,
  applyPaymentToLineIndices,
  normalizeBankTransactions,
  parseBankFile,
} from "./bank-statement-client.js";
import {
  bankAliasLookup,
  normalizeBankAliasToken,
  saveBankAlias,
} from "./bank-match-client.js";
import {
  assignSourceIds,
  bindPreviewControls,
  cacheSourceFiles,
  clearSourceFiles,
  findFirstReviewLineIndex,
  parseSourceFilename,
  showLinePreview,
  tagSourceFilename,
} from "./document-preview.js?v=preview8";
import {
  extractViaServer,
  fetchServerHealth,
  getApiUrl,
  parseBankStatementViaServer,
  saveApiUrl,
} from "./api-client.js?v=api8";
import {
  getSession,
  getUserCabinetMembership,
  isSuperAdmin,
  isSupabaseConfigured,
  signOut,
} from "./auth-client.js?v=auth6";
import {
  formatMonthLabel,
  loadDossierContext,
} from "./dossiers-client.js?v=dash2";
import {
  createDebouncedSaver,
  loadDossierWorkspace,
  logDossierActivity,
  markDossierExported,
  saveDossierWorkspace,
} from "./dossier-persistence.js?v=persist1";

const dossierState = {
  mode: "solo",
  context: null,
};

let extractionInProgress = false;
let workspaceSaver = null;

function isDossierMode() {
  return dossierState.mode === "dossier" && dossierState.context?.dossierId;
}

function setSaveStatus(text, tone = "muted") {
  const el = document.getElementById("saveStatus");
  if (!el || !isDossierMode()) return;
  el.textContent = text || "";
  el.style.color = tone === "error" ? "var(--danger)"
    : tone === "success" ? "var(--success)"
      : "var(--muted)";
}

function getWorkspacePayload() {
  return {
    lines: state.lines,
    bankTransactions: state.bankTransactions,
    bankMeta: state.bankMeta,
  };
}

async function persistWorkspaceNow(eventType, summary, meta = {}) {
  if (!isDossierMode()) return;
  const dossierId = dossierState.context.dossierId;
  setSaveStatus("Enregistrement…");
  try {
    await saveDossierWorkspace(dossierId, getWorkspacePayload());
    if (eventType) {
      await logDossierActivity(dossierId, eventType, summary, meta);
    }
    setSaveStatus("Enregistré sur Supabase", "success");
  } catch (error) {
    setSaveStatus(`Erreur sauvegarde : ${error.message}`, "error");
    throw error;
  }
}

function scheduleWorkspaceSave(eventType = "save", summary = "Modifications enregistrées") {
  if (!isDossierMode()) return;
  setSaveStatus("Modifications en attente…");
  workspaceSaver?.schedule({ eventType, summary });
}

function initWorkspacePersistence() {
  if (!isDossierMode()) return;
  workspaceSaver = createDebouncedSaver(async ({ eventType, summary }) => {
    await persistWorkspaceNow(eventType, summary, {
      line_count: state.lines.length,
    });
  }, 1500);

  window.addEventListener("beforeunload", (event) => {
    if (extractionInProgress) {
      event.preventDefault();
      event.returnValue = "";
      return;
    }
    if (workspaceSaver) {
      workspaceSaver.flush();
    }
  });
}

async function loadPersistedWorkspace() {
  if (!isDossierMode()) return;
  setSaveStatus("Chargement du dossier…");
  try {
    const data = await loadDossierWorkspace(dossierState.context.dossierId);
    state.lines = data.lines || [];
    state.bankTransactions = data.bank_transactions || [];
    state.bankMeta = { ...state.bankMeta, ...(data.bank_meta || {}) };
    refreshAllFieldConfidence();
    renderTable();
    updateButtons();
    if (state.lines.length > 0) {
      setStep(3);
      els.extractionStatus.textContent =
        `${state.lines.length} ligne(s) restaurée(s) depuis Supabase.`;
      els.extractionStatus.classList.add("success");
    }
    if (data.updated_at) {
      setSaveStatus(`Dernière sauvegarde : ${new Date(data.updated_at).toLocaleString("fr-FR")}`, "success");
    } else {
      setSaveStatus("Nouveau dossier — les modifications seront sauvegardées automatiquement");
    }
  } catch (error) {
    setSaveStatus(`Impossible de charger : ${error.message}`, "error");
  }
}

const state = {
  files: [],
  lines: [],
  selectedLineIndex: null,
  previewOpen: false,
  bankFile: null,
  bankTransactions: [],
  bankMeta: { filename: "", bankName: "BANQUE", bankIce: "", bankIf: "" },
};

const DESIGNATIONS = [
  "MATIERES CONSOMMABLES",
  "PRESTATIONS",
  "TELEPHONIE",
  "FRAIS BANCAIRE",
];

const els = {
  container: document.querySelector("main.container"),
  heroAuth: document.getElementById("heroAuth"),
  clientName: document.getElementById("clientName"),
  clientIce: document.getElementById("clientIce"),
  period: document.getElementById("period"),
  filenamePreview: document.getElementById("filenamePreview"),
  engineBadge: document.getElementById("engineBadge"),
  useAiServer: document.getElementById("useAiServer"),
  apiServerUrl: document.getElementById("apiServerUrl"),
  testServerBtn: document.getElementById("testServerBtn"),
  apiSetupHint: document.getElementById("apiSetupHint"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  fileList: document.getElementById("fileList"),
  extractBtn: document.getElementById("extractBtn"),
  addLineBtn: document.getElementById("addLineBtn"),
  clearBtn: document.getElementById("clearBtn"),
  exportBtn: document.getElementById("exportBtn"),
  extractionStatus: document.getElementById("extractionStatus"),
  warningList: document.getElementById("warningList"),
  linesTableBody: document.querySelector("#linesTable tbody"),
  lineCount: document.getElementById("lineCount"),
  fileCount: document.getElementById("fileCount"),
  duplicateBadge: document.getElementById("duplicateBadge"),
  confidenceBadge: document.getElementById("confidenceBadge"),
  removeDuplicatesBtn: document.getElementById("removeDuplicatesBtn"),
  emptyState: document.getElementById("emptyState"),
  reviewLayout: document.getElementById("reviewLayout"),
  tableWrap: document.getElementById("tableWrap"),
  previewPanel: document.getElementById("documentPreviewPanel"),
  previewCloseBtn: document.getElementById("previewCloseBtn"),
  previewTitle: document.getElementById("previewTitle"),
  previewSubtitle: document.getElementById("previewSubtitle"),
  previewNav: document.getElementById("previewNav"),
  previewPrevPage: document.getElementById("previewPrevPage"),
  previewNextPage: document.getElementById("previewNextPage"),
  previewPageInfo: document.getElementById("previewPageInfo"),
  previewZoom: document.getElementById("previewZoom"),
  previewZoomIn: document.getElementById("previewZoomIn"),
  previewZoomOut: document.getElementById("previewZoomOut"),
  previewZoomReset: document.getElementById("previewZoomReset"),
  previewZoomLabel: document.getElementById("previewZoomLabel"),
  previewIssues: document.getElementById("previewIssues"),
  previewEmpty: document.getElementById("previewEmpty"),
  previewMissing: document.getElementById("previewMissing"),
  previewCanvasWrap: document.getElementById("previewCanvasWrap"),
  previewCanvas: document.getElementById("previewCanvas"),
  previewImage: document.getElementById("previewImage"),
  steps: document.querySelectorAll(".step"),
  bankDropZone: document.getElementById("bankDropZone"),
  bankFileInput: document.getElementById("bankFileInput"),
  bankFileInfo: document.getElementById("bankFileInfo"),
  applyBankBtn: document.getElementById("applyBankBtn"),
  bankStatus: document.getElementById("bankStatus"),
  exportReviewDialog: document.getElementById("exportReviewDialog"),
  exportReviewIntro: document.getElementById("exportReviewIntro"),
  exportReviewList: document.getElementById("exportReviewList"),
  exportReviewConfirm: document.getElementById("exportReviewConfirm"),
  fieldBulkDialog: document.getElementById("fieldBulkDialog"),
  fieldBulkTitle: document.getElementById("fieldBulkTitle"),
  fieldBulkIntro: document.getElementById("fieldBulkIntro"),
  fieldBulkApplyAll: document.getElementById("fieldBulkApplyAll"),
  bankMatchDialog: document.getElementById("bankMatchDialog"),
  bankMatchForm: document.getElementById("bankMatchForm"),
  bankMatchTitle: document.getElementById("bankMatchTitle"),
  bankMatchIntro: document.getElementById("bankMatchIntro"),
  bankMatchTxnDate: document.getElementById("bankMatchTxnDate"),
  bankMatchTxnAmount: document.getElementById("bankMatchTxnAmount"),
  bankMatchTxnLabel: document.getElementById("bankMatchTxnLabel"),
  bankMatchProposals: document.getElementById("bankMatchProposals"),
  bankMatchInvoiceDetail: document.getElementById("bankMatchInvoiceDetail"),
  bankMatchInvoiceList: document.getElementById("bankMatchInvoiceList"),
  bankMatchLearnWrap: document.getElementById("bankMatchLearnWrap"),
  bankMatchLearnAlias: document.getElementById("bankMatchLearnAlias"),
  bankMatchConfirm: document.getElementById("bankMatchConfirm"),
};

let pendingBankMatchQueue = [];
let lastBankApplyStats = null;
let skipBankMatchCloseHandler = false;

const previewUi = {
  panel: els.previewPanel,
  title: els.previewTitle,
  subtitle: els.previewSubtitle,
  nav: els.previewNav,
  prevBtn: els.previewPrevPage,
  nextBtn: els.previewNextPage,
  pageInfo: els.previewPageInfo,
  zoom: els.previewZoom,
  zoomInBtn: els.previewZoomIn,
  zoomOutBtn: els.previewZoomOut,
  zoomResetBtn: els.previewZoomReset,
  zoomLabel: els.previewZoomLabel,
  issues: els.previewIssues,
  empty: els.previewEmpty,
  missing: els.previewMissing,
  canvasWrap: els.previewCanvasWrap,
  canvas: els.previewCanvas,
  image: els.previewImage,
};

let pendingFieldBulk = null;

const SUPPLIER_SCOPED_BULK_FIELDS = new Set(["ice_frs", "if"]);

function openFieldBulkDialog(fieldKey, oldValue, newValue, otherCount, { supplierName = "", scope = "value" } = {}) {
  const label = BULK_EDIT_FIELDS[fieldKey] || fieldKey;
  pendingFieldBulk = { fieldKey, oldValue, newValue, supplierName, scope };
  els.fieldBulkTitle.textContent = `${label} modifié`;
  if (scope === "supplier" && supplierName) {
    els.fieldBulkIntro.textContent =
      `Appliquer l'${label} « ${newValue} » aux ${otherCount} autre(s) facture(s) de « ${supplierName} » sans ${label} ?`;
  } else {
    els.fieldBulkIntro.textContent =
      `Remplacer « ${oldValue} » par « ${newValue} » pour le champ ${label} sur ${otherCount} autre(s) ligne(s) ?`;
  }
  els.fieldBulkDialog.showModal();
}

function applyPendingFieldBulk() {
  if (!pendingFieldBulk) return 0;
  const { fieldKey, oldValue, newValue, supplierName, scope } = pendingFieldBulk;
  const updated =
    scope === "supplier" && supplierName
      ? applySupplierFieldValueBulk(state.lines, fieldKey, supplierName, oldValue, newValue)
      : applyFieldValueBulk(state.lines, fieldKey, oldValue, newValue);
  for (const line of updated) markFieldVerified(line, fieldKey);
  pendingFieldBulk = null;
  els.fieldBulkDialog.close();
  return updated.length;
}

function maybeOfferFieldBulk(fieldKey, oldValue, newValue, lineIndex) {
  if (!newValue || fieldValuesMatch(fieldKey, oldValue, newValue)) return;

  const line = state.lines[lineIndex];
  const supplierName = String(line?.lib_frss || "").trim();
  const emptyOldValue = !String(oldValue || "").trim();

  if (emptyOldValue && SUPPLIER_SCOPED_BULK_FIELDS.has(fieldKey) && supplierName) {
    const others = countSupplierFieldTargets(state.lines, fieldKey, supplierName, oldValue, lineIndex);
    if (others > 0) {
      openFieldBulkDialog(fieldKey, oldValue, newValue, others, {
        supplierName,
        scope: "supplier",
      });
    }
    return;
  }

  if (emptyOldValue) return;

  const others = countLinesWithFieldValue(state.lines, fieldKey, oldValue, lineIndex);
  if (others > 0) openFieldBulkDialog(fieldKey, oldValue, newValue, others);
}

function syncPreviewLayout() {
  const open = state.lines.length > 0 && state.previewOpen;
  els.reviewLayout?.classList.toggle("review-layout--preview-open", open);
  if (els.previewPanel) els.previewPanel.hidden = !open;
}

function closeLinePreview({ clearSelection = false } = {}) {
  state.previewOpen = false;
  if (clearSelection) state.selectedLineIndex = null;
  showLinePreview(previewUi, null);
  syncPreviewLayout();
  renderTable();
}

function openLinePreview(index) {
  if (index == null || index < 0 || index >= state.lines.length) {
    closeLinePreview({ clearSelection: true });
    return;
  }
  state.previewOpen = true;
  state.selectedLineIndex = index;
  syncPreviewLayout();
  showLinePreview(previewUi, state.lines[index], index);
  renderTable();
}

function selectLine(index) {
  openLinePreview(index);
}

function emptyLine(sourceFile = "") {
  return {
    source_file: sourceFile,
    source_id: "",
    fact_num: "",
    designation: "MATIERES CONSOMMABLES",
    m_ht: 0,
    tva: 0,
    m_ttc: 0,
    if: "",
    lib_frss: "",
    ice_frs: "",
    ice_inferred: false,
    if_inferred: false,
    ttc_reconstructed: false,
    tva_calculated: false,
    amounts_sanitized: false,
    supplier_from_folder: false,
    date_paie_from_bank: false,
    extraction_engine: "",
    user_verified_fields: [],
    field_confidence: {},
    taux: 0.2,
    id_paie: 4,
    date_paie: "",
    date_fac: "",
  };
}

function refreshAllFieldConfidence() {
  refreshLinesFieldConfidence(state.lines, {
    clientIce: currentClientIce(),
    duplicateIndexes: findDuplicateLineIndexes(state.lines),
  });
}

function markFieldVerified(line, fieldKey) {
  if (!line.user_verified_fields) line.user_verified_fields = [];
  if (!line.user_verified_fields.includes(fieldKey)) {
    line.user_verified_fields.push(fieldKey);
  }
  if (fieldKey === "ice_frs") line.ice_inferred = false;
  if (fieldKey === "if") line.if_inferred = false;
}

function updateFilenamePreview() {
  const client = els.clientName.value.trim() || "CLIENT";
  const period = els.period.value.trim() || "000000";
  els.filenamePreview.textContent = `Fichier généré : ${client}_DED_TVA_${period}.xlsx`;
}

function setStep(step) {
  els.steps.forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle("active", n === step);
    el.classList.toggle("done", n < step);
  });
}

function updateButtons() {
  const extracting = els.extractBtn.classList.contains("loading");
  els.extractBtn.disabled = state.files.length === 0 || extracting;
  els.exportBtn.disabled = state.lines.length === 0;

  els.clearBtn.hidden = state.files.length === 0 && state.lines.length === 0;

  els.applyBankBtn.disabled = state.lines.length === 0 || state.bankTransactions.length === 0;

  const uniqueFiles = new Set(state.lines.map((l) => l.source_file).filter(Boolean));
  els.lineCount.textContent = `${state.lines.length} ligne(s)`;
  els.fileCount.textContent = `${uniqueFiles.size} fichier(s)`;

  const duplicateCount = findDuplicateLineIndexes(state.lines).length;
  els.duplicateBadge.hidden = duplicateCount === 0;
  els.duplicateBadge.textContent = `${duplicateCount} doublon(s)`;
  els.removeDuplicatesBtn.hidden = duplicateCount === 0;

  refreshAllFieldConfidence();
  const { errors, warns } = countConfidenceIssues(state.lines);
  const reviewCount = errors + warns;
  if (els.confidenceBadge) {
    els.confidenceBadge.hidden = reviewCount === 0;
    els.confidenceBadge.textContent =
      errors > 0 ? `${errors} critique(s), ${warns} à relire` : `${warns} champ(s) à relire`;
    els.confidenceBadge.className = errors > 0 ? "badge danger" : "badge warn";
  }

  const hasLines = state.lines.length > 0;
  els.container?.classList.toggle("container--review", hasLines);
  els.emptyState.hidden = hasLines;
  els.reviewLayout.hidden = !hasLines;
  if (!hasLines) {
    state.selectedLineIndex = null;
    state.previewOpen = false;
    showLinePreview(previewUi, null);
  }
  syncPreviewLayout();

  if (hasLines) setStep(3);
  else if (state.files.length > 0) setStep(2);
  else setStep(1);
}

function recalcTva(line) {
  const ht = Number(line.m_ht) || 0;
  const taux = Number(line.taux);
  const rate = Number.isFinite(taux) ? taux : 0.2;
  line.tva = Math.round(ht * rate * 100) / 100;
  line.m_ttc = Math.round((ht + line.tva) * 100) / 100;
  line.tva_calculated = true;
  line.ttc_reconstructed = false;
}

function shortFilename(name) {
  if (!name) return "";
  const parts = name.split("/");
  return parts.length > 1 ? parts.slice(-2).join("/") : name;
}

function renderFileList() {
  if (!state.files.length) {
    els.fileList.hidden = true;
    els.fileList.innerHTML = "";
    return;
  }

  els.fileList.hidden = false;
  els.fileList.innerHTML = state.files
    .map((file) => {
      const isZip = file.name.toLowerCase().endsWith(".zip");
      const icon = isZip ? "🗜️" : file.type === "application/pdf" ? "📄" : "🖼️";
      return `<div class="file-item">${icon} <span>${file.name}</span> <span class="file-size">${formatSize(file.size)}</span></div>`;
    })
    .join("");
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function isAnomaliesReviewView() {
  return new URLSearchParams(window.location.search).get("view") === "anomalies";
}

function lineNeedsReviewRow(line, isDuplicate) {
  return lineNeedsReview(line, { isDuplicate });
}

function renderTable() {
  refreshAllFieldConfidence();
  els.linesTableBody.innerHTML = "";
  const duplicates = new Set(findDuplicateLineIndexes(state.lines));
  const anomaliesOnly = isAnomaliesReviewView();

  state.lines.forEach((line, index) => {
    if (anomaliesOnly && !lineNeedsReviewRow(line, duplicates.has(index))) return;
    const tr = document.createElement("tr");
    if (index === state.selectedLineIndex) {
      tr.classList.add("selected-row");
    }
    if (duplicates.has(index)) {
      tr.classList.add("duplicate-row");
      tr.title = "Doublon probable : même fournisseur, facture, taux et montant TTC.";
    }

    const fields = [
      { key: "source_file", type: "text", readonly: true, title: true },
      { key: "fact_num", type: "text" },
      { key: "lib_frss", type: "text" },
      { key: "ice_frs", type: "text" },
      { key: "if", type: "text" },
      { key: "designation", type: "select", options: DESIGNATIONS },
      { key: "m_ht", type: "number", step: "0.01" },
      { key: "tva", type: "number", step: "0.01", readonly: true },
      { key: "m_ttc", type: "number", step: "0.01", readonly: true },
      { key: "taux", type: "select", options: ["0", "0.1", "0.2"] },
      { key: "date_fac", type: "date" },
      { key: "date_paie", type: "date" },
      { key: "id_paie", type: "select", options: ["1", "4"] },
    ];

    fields.forEach((field) => {
      const td = document.createElement("td");
      let input;

      if (field.type === "select") {
        input = document.createElement("select");
        field.options.forEach((opt) => {
          const option = document.createElement("option");
          option.value = opt;
          option.textContent = field.key === "taux" ? `${Number(opt) * 100}%` : opt;
          input.appendChild(option);
        });
        input.value = String(line[field.key] ?? "");
      } else {
        input = document.createElement("input");
        input.type = field.type;
        if (field.step) input.step = field.step;
        if (field.readonly) input.readOnly = true;
        if (field.key === "ice_frs") {
          input.maxLength = 15;
          input.inputMode = "numeric";
          input.placeholder = "15 chiffres";
        }
        const display =
          field.key === "source_file" ? shortFilename(line[field.key]) : (line[field.key] ?? "");
        input.value = display;
        if (field.title && line[field.key] && field.key === "source_file") {
          input.title = line[field.key];
        }
      }

      if (field.key !== "source_file" && field.key !== "id_paie") {
        applyConfidenceToInput(input, field.key, line);
      }

      if (!field.readonly) {
        if (field.key in BULK_EDIT_FIELDS) {
          input.addEventListener("focus", () => {
            input.dataset.prevValue = line[field.key] ?? "";
          });
        }
        input.addEventListener("change", () => {
          let oldValue = "";
          let newValue = "";

          if (field.type === "number") {
            line[field.key] = Number(input.value) || 0;
          } else if (field.key === "taux" || field.key === "id_paie") {
            line[field.key] = Number(input.value);
          } else if (field.key === "ice_frs") {
            oldValue = String(input.dataset.prevValue ?? line.ice_frs ?? "");
            const digits = input.value.replace(/\D/g, "").slice(0, 15);
            line.ice_frs = digits.length === 15 ? digits : "";
            input.value = line.ice_frs;
            newValue = line.ice_frs;
            line.ice_inferred = false;
          } else if (field.key === "if") {
            oldValue = String(input.dataset.prevValue ?? line.if ?? "");
            line.if = input.value.trim();
            input.value = line.if;
            newValue = line.if;
            line.if_inferred = false;
          } else if (field.key === "lib_frss") {
            oldValue = String(input.dataset.prevValue ?? line.lib_frss ?? "").trim();
            newValue = String(input.value ?? "").trim();
            line.lib_frss = newValue;
            line.supplier_from_folder = false;
          } else {
            line[field.key] = input.value;
          }

          markFieldVerified(line, field.key);
          if (field.key === "date_paie") line.date_paie_from_bank = false;
          if (["m_ht", "taux"].includes(field.key)) {
            recalcTva(line);
            markFieldVerified(line, "tva");
            markFieldVerified(line, "m_ttc");
          }
          renderTable();
          updateButtons();
          scheduleWorkspaceSave();
          if (field.key in BULK_EDIT_FIELDS) {
            maybeOfferFieldBulk(field.key, oldValue, newValue, index);
          }
        });
      }

      td.appendChild(input);
      tr.appendChild(td);
    });

    const actionTd = document.createElement("td");
    actionTd.className = "row-actions";

    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "view-btn";
    const previewingThisLine = state.previewOpen && state.selectedLineIndex === index;
    viewBtn.textContent = previewingThisLine ? "Masquer" : "Voir";
    viewBtn.title = previewingThisLine
      ? "Fermer l'aperçu document"
      : "Afficher la facture à côté pour revue";
    viewBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (previewingThisLine) closeLinePreview();
      else openLinePreview(index);
    });
    actionTd.appendChild(viewBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = duplicates.has(index) ? "Supprimer le doublon" : "Supprimer";
    deleteBtn.className = duplicates.has(index) ? "delete-btn delete-btn-dup" : "delete-btn";
    deleteBtn.title = "Supprimer cette ligne";
    deleteBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteLineAt(index);
    });
    actionTd.appendChild(deleteBtn);
    tr.appendChild(actionTd);

    els.linesTableBody.appendChild(tr);
  });
}

function addFiles(fileList) {
  const incoming = Array.from(fileList);
  const existing = new Set(state.files.map((f) => `${f.name}-${f.size}`));
  incoming.forEach((file) => {
    const key = `${file.name}-${file.size}`;
    if (!existing.has(key)) {
      state.files.push(file);
      existing.add(key);
    }
  });
  renderFileList();
  updateButtons();
  if (state.files.length > 0) {
    els.extractionStatus.textContent = `${state.files.length} fichier(s) prêt(s) à extraire.`;
    els.extractionStatus.classList.remove("error", "success", "warn");
  }
}

function renderWarnings(warnings) {
  if (!warnings.length) {
    els.warningList.hidden = true;
    els.warningList.innerHTML = "";
    return;
  }
  els.warningList.hidden = false;
  els.warningList.innerHTML = warnings.map((w) => `<li>${w}</li>`).join("");
}

function clearWarnings() {
  renderWarnings([]);
}

function setLoading(loading) {
  els.extractBtn.classList.toggle("loading", loading);
  els.extractBtn.querySelector(".btn-label").textContent = loading
    ? "Extraction en cours…"
    : "Extraire les factures";
  els.extractBtn.querySelector(".spinner").hidden = !loading;
  updateButtons();
}

function engineLabel(engine) {
  if (engine === "ai") return "IA";
  if (engine === "scan") return "Scan";
  if (engine === "tesseract") return "OCR";
  if (engine === "text") return "PDF";
  if (engine === "manual") return "Manuel";
  return "";
}

function resolvedApiUrl() {
  const typed = els.apiServerUrl.value.trim().replace(/\/$/, "");
  if (typed) return typed;
  return getApiUrl();
}

function loadClientSettings() {
  if (dossierState.mode === "dossier") return;
  const savedIce = localStorage.getItem("recompta_client_ice");
  if (savedIce) els.clientIce.value = savedIce;
}

function applyDossierContext(context) {
  dossierState.mode = "dossier";
  dossierState.context = context;
  els.clientName.value = context.clientName;
  els.clientIce.value = context.clientIce;
  els.period.value = context.period;
  els.clientName.readOnly = true;
  els.clientIce.readOnly = true;
  els.period.readOnly = true;

  const dossierBanner = document.getElementById("dossierContext");
  const dossierTitle = document.getElementById("dossierClientTitle");
  const dossierPeriod = document.getElementById("dossierPeriodLabel");
  if (dossierBanner) dossierBanner.hidden = false;
  if (dossierTitle) dossierTitle.textContent = context.clientName;
  if (dossierPeriod) {
    dossierPeriod.textContent =
      `${formatMonthLabel(context.month)} ${context.year} — ICE ${context.clientIce}`;
  }
  const backLink = document.getElementById("dossierBackLink");
  if (backLink && context.clientId) {
    backLink.href = `workspace.html?client=${context.clientId}`;
    backLink.textContent = "← Retour au dossier";
  }
  applyExtractionContext();
  updateFilenamePreview();
}

async function initCabinetAccess() {
  if (!isSupabaseConfigured()) return;

  const params = new URLSearchParams(window.location.search);
  const dossierId = params.get("dossier");
  // Sans ?dossier= : mode solo — production.html reste utilisable même si connecté.
  if (!dossierId) return;

  const session = await getSession();
  if (!session?.user) return;

  const context = await loadDossierContext(dossierId);
  if (!context) return;

  const view = params.get("view");
  const reviewParams = new URLSearchParams({
    client: context.clientId,
    dossier: dossierId,
    tab: "review",
  });
  if (view) reviewParams.set("view", view);
  window.location.replace(`workspace.html?${reviewParams.toString()}`);
}

function persistClientIce() {
  if (dossierState.mode === "dossier") return;
  const ice = els.clientIce.value.trim().replace(/\D/g, "").slice(0, 15);
  els.clientIce.value = ice;
  if (ice.length === 15) localStorage.setItem("recompta_client_ice", ice);
  else localStorage.removeItem("recompta_client_ice");
}

function currentClientIce() {
  const digits = els.clientIce.value.trim().replace(/\D/g, "");
  return digits.length === 15 ? digits : "";
}

function applyExtractionContext() {
  setExtractionContext({ clientIce: currentClientIce() });
}

function loadApiSettings() {
  const saved = localStorage.getItem("recompta_api_url") || "";
  els.apiServerUrl.value = saved;
  els.useAiServer.checked = localStorage.getItem("recompta_use_ai") !== "false";
}

function persistApiSettings() {
  saveApiUrl(els.apiServerUrl.value);
  localStorage.setItem("recompta_use_ai", els.useAiServer.checked ? "true" : "false");
  refreshEngineBadge();
}

async function testServerConnection() {
  const apiUrl = resolvedApiUrl();
  if (!apiUrl) {
    els.apiSetupHint.textContent = "Collez d'abord l'URL publique du Codespace (port 8000).";
    els.apiSetupHint.classList.add("warn");
    return;
  }
  els.testServerBtn.disabled = true;
  els.testServerBtn.textContent = "Test…";
  try {
    const health = await fetchServerHealth(apiUrl, { refresh: true });
    if (health.ai_verified) {
      els.apiSetupHint.textContent = "Connexion OK — clé OpenAI valide. Utilisez cette page normalement.";
      els.apiSetupHint.classList.remove("warn");
      persistApiSettings();
      await refreshEngineBadge();
    } else if (health.ai_configured) {
      els.apiSetupHint.textContent =
        health.ai_message ||
        "Clé OpenAI présente mais refusée. Éditez backend/.env dans le Codespace puis redémarrez uvicorn.";
      els.apiSetupHint.classList.add("warn");
      await refreshEngineBadge();
    } else {
      els.apiSetupHint.textContent = "Serveur joignable mais OPENAI_API_KEY manquante dans backend/.env du Codespace.";
      els.apiSetupHint.classList.add("warn");
    }
  } catch (error) {
    els.apiSetupHint.textContent = `Connexion impossible : ${error.message}. Vérifiez que uvicorn tourne et que le port 8000 est Public.`;
    els.apiSetupHint.classList.add("warn");
  } finally {
    els.testServerBtn.disabled = false;
    els.testServerBtn.textContent = "Tester la connexion";
  }
}

async function refreshEngineBadge() {
  const apiUrl = resolvedApiUrl();
  const wantAi = els.useAiServer.checked;

  if (wantAi && apiUrl) {
    try {
      const health = await fetchServerHealth(apiUrl);
      if (health.ai_verified) {
        els.engineBadge.className = "engine-badge ai";
        els.engineBadge.textContent = "✓ Extraction IA activée (clé OpenAI valide)";
        return;
      }
      if (health.ai_configured) {
        els.engineBadge.className = "engine-badge tesseract";
        els.engineBadge.textContent = health.ai_message || "Clé OpenAI invalide — éditez backend/.env";
        return;
      }
      els.engineBadge.className = "engine-badge tesseract";
      els.engineBadge.textContent = "Serveur OK mais OPENAI_API_KEY manquante";
      return;
    } catch {
      els.engineBadge.className = "engine-badge tesseract";
      els.engineBadge.textContent = "Serveur IA injoignable — scans impossibles sans IA";
      return;
    }
  }

  els.engineBadge.className = "engine-badge tesseract";
  els.engineBadge.textContent = "Mode local — PDF texte uniquement ; scans = serveur IA";
}

async function extractFromExpanded(expanded, onProgress) {
  const results = [];
  for (let i = 0; i < expanded.length; i += 1) {
    const item = expanded[i];
    if (onProgress) onProgress(i + 1, expanded.length, item.filename);
    const result = await extractInvoice(item.filename, item.content, item.mime);
    if (item.source_id && !result.source_id) result.source_id = item.source_id;
    results.push(result);
  }
  return normalizeExtractionResults(results);
}

async function runExtraction(expanded) {
  applyExtractionContext();
  const clientIce = currentClientIce();
  const apiUrl = resolvedApiUrl();
  const wantAi = els.useAiServer.checked;

  if (wantAi && !apiUrl) {
    throw new Error("Indiquez l'URL du serveur Recompta (Codespace port 8000).");
  }

  if (wantAi && apiUrl) {
    try {
      const health = await fetchServerHealth(apiUrl);
      if (health.ai_verified) {
        els.extractionStatus.textContent = "Extraction IA en cours — les scans peuvent prendre 1 à 3 min par lot…";
        const serverFiles = expanded.map(
          (item) => new File([item.content], item.filename, { type: item.mime }),
        );
        return await extractViaServer(serverFiles, apiUrl, {
          clientIce,
          onProgress: (_c, _t, label) => {
            els.extractionStatus.textContent = label;
          },
        });
      }
      if (health.ai_configured) {
        throw new Error(
          health.ai_message ||
            "Clé OpenAI invalide. Éditez backend/.env dans le Codespace puis redémarrez uvicorn."
        );
      }
      throw new Error(
        "OPENAI_API_KEY manquante dans le Codespace. Les scans et photos exigent l'IA Vision."
      );
    } catch (error) {
      if (
        error.message.includes("Clé OpenAI") ||
        error.message.includes("OPENAI_API_KEY") ||
        error.message.includes("Connexion au serveur")
      ) {
        throw error;
      }
      throw new Error(
        `Serveur IA indisponible (${error.message}). Les scans ne peuvent pas être traités sans IA — pas de repli OCR.`
      );
    }
  }

  // Sans serveur IA : uniquement les PDF avec couche texte (factures natives).
  return extractFromExpanded(expanded, (current, total, name) => {
    els.extractionStatus.textContent = `Fichier ${current}/${total} — ${shortFilename(name)}…`;
  });
}

async function extractFiles() {
  if (!state.files.length) return;

  extractionInProgress = true;
  setLoading(true);
  clearWarnings();
  els.extractionStatus.textContent = "Extraction en cours — patientez, les scans IA sont lents…";
  els.extractionStatus.classList.remove("error", "success", "warn");

  const filesToProcess = [...state.files];

  try {
    const expanded = await expandUploadedFiles(filesToProcess);
    const sourceRecords = cacheSourceFiles(expanded);
    const tagged = expanded.map((item, index) => ({
      ...item,
      filename: tagSourceFilename(item.filename, sourceRecords[index].id),
    }));
    const results = normalizeExtractionResults(await runExtraction(tagged));
    const sourceIds = assignSourceIds(sourceRecords, results);
    const firstNewIndex = state.lines.length;

    let newLines = 0;
    let okFiles = 0;
    let warnFiles = 0;
    const warnings = [];

    results.forEach((result, resultIndex) => {
      const parsed = parseSourceFilename(result.filename);
      const sourceId = result.source_id || parsed.sourceId || sourceIds[resultIndex] || "";
      const displayName = parsed.filename || result.filename;
      if (result.lines?.length) {
        okFiles += 1;
        result.lines.forEach((line) => {
          state.lines.push({
            ...emptyLine(displayName),
            ...line,
            source_file: displayName,
            source_id: sourceId,
            extraction_engine: result.engine || line.extraction_engine || "",
            date_fac: line.date_fac ? String(line.date_fac).slice(0, 10) : "",
            date_paie: line.date_paie ? String(line.date_paie).slice(0, 10) : "",
          });
          newLines += 1;
        });
      } else {
        warnFiles += 1;
      }
      if (result.warnings?.length) {
        const eng = engineLabel(result.engine);
        warnings.push(`[${eng}] ${shortFilename(displayName)}: ${result.warnings.join(", ")}`);
      }
    });

    // Sur l'ensemble du tableau, imports précédents compris : une facture sans
    // ICE reprend celui déjà confirmé pour ce fournisseur.
    const completedIds = completeSupplierIdentifiers(state.lines);
    refreshAllFieldConfidence();

    const newSlice = state.lines.slice(firstNewIndex);
    const localReview = findFirstReviewLineIndex(newSlice);
    state.selectedLineIndex =
      localReview != null ? firstNewIndex + localReview : newLines ? firstNewIndex : findFirstReviewLineIndex(state.lines);
    state.previewOpen = false;

    state.files = [];
    renderFileList();
    renderTable();
    updateButtons();
    setStep(3);

    let msg = `${newLines} ligne(s) extraite(s) depuis ${okFiles} facture(s).`;
    const aiFiles = results.filter((result) => result.engine === "ai").length;
    if (aiFiles) msg += ` ${aiFiles} via IA.`;
    if (warnFiles) msg += ` ${warnFiles} fichier(s) sans résultat.`;
    if (completedIds) msg += ` ${completedIds} ICE/IF complété(s) depuis d'autres factures.`;

    const duplicateCount = findDuplicateLineIndexes(state.lines).length;
    if (duplicateCount) {
      msg += ` ${duplicateCount} doublon(s) détecté(s).`;
      warnings.push(
        `${duplicateCount} ligne(s) en double : même fournisseur, numéro de facture, ` +
          `taux et montant TTC. Vérifiez les lignes surlignées avant d'exporter.`,
      );
    }

    els.extractionStatus.textContent = msg;
    els.extractionStatus.classList.remove("error", "success", "warn");
    renderWarnings(warnings);
    if (warnings.length || warnFiles) els.extractionStatus.classList.add("warn");
    else if (newLines > 0) els.extractionStatus.classList.add("success");

    await persistWorkspaceNow(
      "extraction",
      `${newLines} ligne(s) extraite(s)`,
      { new_lines: newLines, ok_files: okFiles },
    );
  } catch (error) {
    els.extractionStatus.textContent = `Erreur : ${error.message}`;
    els.extractionStatus.classList.add("error");
  } finally {
    extractionInProgress = false;
    setLoading(false);
  }
}

function downloadExcel() {
  setStep(4);
  els.exportBtn.disabled = true;
  els.exportBtn.textContent = "Génération…";

  (async () => {
  try {
    const filename = exportDedTvaExcel({
      clientName: els.clientName.value.trim() || "CLIENT",
      period: els.period.value.trim(),
      lines: state.lines.map(
        ({
          source_file,
          source_id,
          ice_inferred,
          if_inferred,
          field_confidence,
          user_verified_fields,
          extraction_engine,
          ttc_reconstructed,
          tva_calculated,
          amounts_sanitized,
          supplier_from_folder,
          date_paie_from_bank,
          ...line
        }) => ({
          ...line,
          taux: Number(line.taux),
          id_paie: Number(line.id_paie),
        }),
      ),
    });

    els.extractionStatus.textContent = `Fichier ${filename} téléchargé avec succès.`;
    els.extractionStatus.classList.remove("error", "warn");
    els.extractionStatus.classList.add("success");
    if (isDossierMode()) {
      await logDossierActivity(
        dossierState.context.dossierId,
        "export",
        `Export Excel ${filename}`,
        { line_count: state.lines.length },
      );
      setSaveStatus("Export téléchargé — clôturez la période manuellement après déclaration", "success");
    }
  } catch (error) {
    alert(`Export impossible : ${error.message}`);
  } finally {
    els.exportBtn.textContent = "Télécharger Excel";
    updateButtons();
  }
  })();
}

function openExportReview(issues) {
  const errors = issues.filter((issue) => issue.level === "error").length;
  const warns = issues.filter((issue) => issue.level === "warn").length;
  els.exportReviewIntro.textContent = errors
    ? `${errors} point(s) critique(s) et ${warns} à relire. Corrigez ou confirmez — l'export n'est jamais bloqué.`
    : warns
      ? `${warns} champ(s) à relire. Corrigez les lignes ou exportez après confirmation.`
      : "Confirmez puis exportez.";
  els.exportReviewList.innerHTML = issues
    .map((issue) => `<li class="review-${issue.level}">${issue.text}</li>`)
    .join("");
  els.exportReviewDialog.showModal();
}

function exportExcel() {
  try {
    if (!/^\d{6}$/.test(els.period.value.trim())) {
      alert("La période doit être au format MMAAAA (ex: 062026).");
      return;
    }

    refreshAllFieldConfidence();
    const issues = collectExportReview(state.lines, {
      clientIce: currentClientIce(),
      duplicateIndexes: findDuplicateLineIndexes(state.lines),
    });

    if (!issues.length) {
      downloadExcel();
      return;
    }
    openExportReview(issues);
  } catch (error) {
    alert(`Export impossible : ${error.message}`);
  }
}

function clearBankState() {
  state.bankFile = null;
  state.bankTransactions = [];
  state.bankMeta = { filename: "", bankName: "BANQUE", bankIce: "", bankIf: "" };
  pendingBankMatchQueue = [];
  lastBankApplyStats = null;
  els.bankFileInput.value = "";
  els.bankFileInfo.hidden = true;
  els.bankFileInfo.innerHTML = "";
  els.bankStatus.textContent = "";
  els.bankStatus.className = "status";
}

function renderBankFileInfo() {
  if (!state.bankFile) {
    els.bankFileInfo.hidden = true;
    return;
  }
  const payments = state.bankTransactions.filter((t) => t.type === "payment").length;
  const fees = state.bankTransactions.filter((t) => t.type === "fee").length;
  els.bankFileInfo.hidden = false;
  els.bankFileInfo.innerHTML = `<div class="file-item">${shortFilename(state.bankFile.name)} — ${state.bankTransactions.length} mouvement(s) (${payments} paiement(s), ${fees} frais)</div>`;
}

async function loadBankFile(file) {
  if (!file) return;
  els.bankStatus.textContent = "Lecture du relevé…";
  els.bankStatus.className = "status";

  const lower = (file.name || "").toLowerCase();
  const isSpreadsheet = lower.endsWith(".csv") || lower.endsWith(".txt") || lower.endsWith(".xlsx") || lower.endsWith(".xls");

  try {
    let transactions = [];
    let bankName = "BANQUE";
    const warnings = [];

    if (isSpreadsheet) {
      const parsed = await parseBankFile(file);
      transactions = parsed.transactions;
      if (parsed.warnings?.length) warnings.push(...parsed.warnings);
      state.bankMeta = { filename: parsed.filename, bankName };
    } else {
      const apiUrl = resolvedApiUrl();
      if (!apiUrl) {
        throw new Error("Pour un relevé PDF/image, configurez l'URL du Codespace (port 8000).");
      }
      const result = await parseBankStatementViaServer(file, apiUrl);
      transactions = normalizeBankTransactions(result.transactions);
      bankName = result.bank_name || "BANQUE";
      if (result.warnings?.length) warnings.push(...result.warnings);
      if (!transactions.length) {
        warnings.push("Aucun mouvement extrait — essayez un export CSV depuis votre banque.");
      }
      state.bankMeta = {
        filename: result.filename || file.name,
        bankName,
        bankIce: result.bank_ice || "",
        bankIf: result.bank_if || "",
      };
    }

    state.bankFile = file;
    state.bankTransactions = transactions;
    renderBankFileInfo();
    updateButtons();

    let msg = `${transactions.length} mouvement(s) chargé(s).`;
    if (state.lines.length) msg += " Cliquez sur « Appliquer dates & frais ».";
    els.bankStatus.textContent = msg;
    if (warnings.length) {
      els.bankStatus.textContent += ` ${warnings.join(" ")}`;
      els.bankStatus.classList.add("warn");
    }
    scheduleWorkspaceSave("bank_import", `Relevé bancaire importé (${transactions.length} mvts)`);
  } catch (error) {
    clearBankState();
    els.bankStatus.textContent = `Erreur relevé : ${error.message}`;
    els.bankStatus.classList.add("error");
    updateButtons();
  }
}

function formatMad(amount) {
  return Number(amount).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatBankDate(isoDate) {
  if (!isoDate) return "";
  const [year, month, day] = isoDate.split("-");
  if (!day) return isoDate;
  return `${day}/${month}/${year}`;
}

function updateBankStatusMessage() {
  if (!lastBankApplyStats) return;
  const { paymentsMatched, paymentsUnmatched, paymentsPending, feesAdded } = lastBankApplyStats;
  let msg = `${paymentsMatched} paiement(s) rapproché(s), ${feesAdded} ligne(s) frais bancaire ajoutée(s).`;
  if (paymentsPending) msg += ` ${paymentsPending} virement(s) à confirmer.`;
  if (paymentsUnmatched) msg += ` ${paymentsUnmatched} débit(s) sans facture correspondante.`;
  els.bankStatus.textContent = msg;
  els.bankStatus.classList.remove("error", "warn", "success");
  if (paymentsUnmatched || paymentsPending) els.bankStatus.classList.add("warn");
  else els.bankStatus.classList.add("success");
}

function validBankMatchProposals(item) {
  return (item.proposals || []).filter((proposal) =>
    proposal.indices.every((index) => !state.lines[index]?.date_paie_from_bank),
  );
}

function bankTxnPosition(txn) {
  const payments = state.bankTransactions.filter((entry) => entry.type === "payment");
  const index = payments.findIndex((entry) => entry.id === txn.id);
  if (index < 0) return "";
  return ` (${index + 1}/${payments.length} sur le relevé)`;
}

function proposalInvoiceRows(proposal) {
  const byFact = new Map();
  for (const index of proposal.indices) {
    const line = state.lines[index];
    if (!line) continue;
    const factNum = String(line.fact_num || "").trim() || "Sans n°";
    if (!byFact.has(factNum)) {
      byFact.set(factNum, { fact_num: factNum, total: 0 });
    }
    byFact.get(factNum).total += Number(line.m_ttc) || 0;
  }
  return [...byFact.values()].map((row) => ({
    ...row,
    total: Math.round(row.total * 100) / 100,
  }));
}

function renderBankMatchTxn(item) {
  const txn = item.txn;
  const date = formatBankDate(txn.date);
  const position = bankTxnPosition(txn);
  els.bankMatchTxnDate.textContent = date ? `${date}${position}` : position || "—";
  els.bankMatchTxnAmount.textContent = `${formatMad(txn.absAmount)} MAD`;
  els.bankMatchTxnLabel.textContent = String(txn.label || "").trim() || "—";
}

function renderBankMatchInvoiceDetail(proposal) {
  if (!proposal) {
    els.bankMatchInvoiceDetail.hidden = true;
    els.bankMatchInvoiceList.replaceChildren();
    return;
  }

  const rows = proposalInvoiceRows(proposal);
  els.bankMatchInvoiceList.replaceChildren();
  rows.forEach((row) => {
    const li = document.createElement("li");
    li.textContent = `${row.fact_num} — ${formatMad(row.total)} MAD`;
    els.bankMatchInvoiceList.appendChild(li);
  });
  els.bankMatchInvoiceDetail.hidden = rows.length === 0;
}

function selectedBankMatchProposal() {
  const item = pendingBankMatchQueue[0];
  if (!item) return null;
  const proposals = validBankMatchProposals(item);
  const selectedId = els.bankMatchProposals.querySelector('input[name="bankProposal"]:checked')?.value;
  return proposals.find((entry) => entry.id === selectedId) || proposals[0] || null;
}

function updateBankMatchInvoiceDetail() {
  renderBankMatchInvoiceDetail(selectedBankMatchProposal());
}

function showNextBankMatchDialog() {
  while (pendingBankMatchQueue.length > 0) {
    const item = pendingBankMatchQueue[0];
    const proposals = validBankMatchProposals(item);
    if (!proposals.length) {
      pendingBankMatchQueue.shift();
      continue;
    }

    renderBankMatchTxn(item);

    els.bankMatchProposals.replaceChildren();
    proposals.forEach((proposal, index) => {
      const option = document.createElement("label");
      option.className = "bank-match-option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "bankProposal";
      radio.value = proposal.id;
      radio.checked = index === 0;
      const text = document.createElement("div");
      const invoiceLabel =
        proposal.invoiceCount === 1
          ? "1 facture"
          : `${proposal.invoiceCount} factures (${proposal.lineCount} lignes)`;
      text.innerHTML =
        `<strong>${proposal.lib_frss}</strong>` +
        `${invoiceLabel} — total ${formatMad(proposal.totalTtc)} MAD`;
      option.append(radio, text);
      els.bankMatchProposals.appendChild(option);
    });

    updateBankMatchInvoiceDetail();

    const label = String(item.txn.label || "").trim();
    const bankToken = item.bankToken || normalizeBankAliasToken(label);
    const showLearn = Boolean(bankToken);
    els.bankMatchLearnWrap.hidden = !showLearn;
    if (showLearn) els.bankMatchLearnAlias.checked = true;

    els.bankMatchDialog.showModal();
    return;
  }

  updateBankStatusMessage();
}

function confirmBankMatch() {
  const item = pendingBankMatchQueue[0];
  if (!item) return;

  const selectedId = els.bankMatchProposals.querySelector('input[name="bankProposal"]:checked')?.value;
  const proposals = validBankMatchProposals(item);
  const proposal = proposals.find((entry) => entry.id === selectedId) || proposals[0];
  if (!proposal) {
    pendingBankMatchQueue.shift();
    showNextBankMatchDialog();
    return;
  }

  applyPaymentToLineIndices(state.lines, proposal.indices, item.txn);
  proposal.indices.forEach((index) => markFieldVerified(state.lines[index], "date_paie"));

  const bankToken = item.bankToken || normalizeBankAliasToken(item.txn.label);
  if (els.bankMatchLearnAlias.checked && bankToken) {
    saveBankAlias(currentClientIce(), bankToken, proposal.supplierKey, proposal.lib_frss);
  }

  if (lastBankApplyStats) {
    lastBankApplyStats.paymentsMatched += 1;
    if (lastBankApplyStats.paymentsPending > 0) lastBankApplyStats.paymentsPending -= 1;
  }
  pendingBankMatchQueue.shift();
  renderTable();
  updateButtons();
  skipBankMatchCloseHandler = true;
  els.bankMatchDialog.close();
  skipBankMatchCloseHandler = false;
  showNextBankMatchDialog();
  if (!pendingBankMatchQueue.length) scheduleWorkspaceSave("bank_match", "Rapprochement bancaire confirmé");
}

function applyBankToLines() {
  if (!state.bankTransactions.length || !state.lines.length) return;

  const result = applyBankStatement(state.bankTransactions, state.lines, {
    sourceFile: state.bankMeta.filename || "releve_bancaire",
    bankName: state.bankMeta.bankName || "BANQUE",
    bankIce: state.bankMeta.bankIce || "",
    bankIf: state.bankMeta.bankIf || "",
    supplierAliases: bankAliasLookup(currentClientIce()),
  });

  state.lines = result.lines;
  pendingBankMatchQueue = result.pendingMatches || [];
  lastBankApplyStats = { ...result.stats };
  renderTable();
  updateButtons();
  updateBankStatusMessage();

  if (pendingBankMatchQueue.length) showNextBankMatchDialog();
  else scheduleWorkspaceSave("bank_apply", "Rapprochement bancaire appliqué");
}

function deleteLineAt(index) {
  if (index < 0 || index >= state.lines.length) return;
  state.lines.splice(index, 1);
  if (state.selectedLineIndex === index) {
    state.selectedLineIndex = state.lines.length ? Math.min(index, state.lines.length - 1) : null;
    if (state.previewOpen) {
      if (state.selectedLineIndex != null) {
        showLinePreview(previewUi, state.lines[state.selectedLineIndex], state.selectedLineIndex);
      } else {
        closeLinePreview();
      }
    }
  } else if (state.selectedLineIndex != null && state.selectedLineIndex > index) {
    state.selectedLineIndex -= 1;
  }
  renderTable();
  updateButtons();
  scheduleWorkspaceSave("delete_line", "Ligne supprimée");
}

function removeDuplicates() {
  const duplicates = new Set(findDuplicateLineIndexes(state.lines));
  if (!duplicates.size) return;
  const confirmed = window.confirm(
    `Supprimer ${duplicates.size} ligne(s) en double ?\nLa première occurrence de chaque facture est conservée.`,
  );
  if (!confirmed) return;

  state.lines = state.lines.filter((_line, index) => !duplicates.has(index));
  if (state.selectedLineIndex != null && duplicates.has(state.selectedLineIndex)) {
    state.selectedLineIndex = state.lines.length ? 0 : null;
  }
  renderTable();
  updateButtons();
  if (state.previewOpen && state.selectedLineIndex != null) {
    showLinePreview(previewUi, state.lines[state.selectedLineIndex], state.selectedLineIndex);
  } else if (!state.lines.length) {
    closeLinePreview({ clearSelection: true });
  }

  els.extractionStatus.textContent = `${duplicates.size} doublon(s) supprimé(s).`;
  els.extractionStatus.classList.remove("error", "warn");
  els.extractionStatus.classList.add("success");
  scheduleWorkspaceSave("dedupe", `${duplicates.size} doublon(s) supprimé(s)`);
}

function clearAll() {
  state.files = [];
  state.lines = [];
  state.selectedLineIndex = null;
  state.previewOpen = false;
  clearSourceFiles();
  showLinePreview(previewUi, null);
  clearBankState();
  renderFileList();
  renderTable();
  els.extractionStatus.textContent = "";
  els.extractionStatus.className = "status";
  clearWarnings();
  els.fileInput.value = "";
  updateButtons();
  setStep(1);
  if (isDossierMode()) {
    persistWorkspaceNow("clear", "Dossier réinitialisé").catch(() => {});
  }
}

els.clientName.addEventListener("input", updateFilenamePreview);
els.clientIce.addEventListener("input", () => {
  els.clientIce.value = els.clientIce.value.replace(/\D/g, "").slice(0, 15);
});
els.clientIce.addEventListener("change", persistClientIce);
els.clientIce.addEventListener("blur", persistClientIce);
els.period.addEventListener("input", updateFilenamePreview);
els.apiServerUrl.addEventListener("change", persistApiSettings);
els.apiServerUrl.addEventListener("blur", persistApiSettings);
els.useAiServer.addEventListener("change", persistApiSettings);
els.testServerBtn.addEventListener("click", testServerConnection);
els.fileInput.addEventListener("change", (e) => addFiles(e.target.files));
els.extractBtn.addEventListener("click", extractFiles);
els.addLineBtn.addEventListener("click", () => {
  state.lines.push(emptyLine());
  renderTable();
  updateButtons();
  scheduleWorkspaceSave();
});
els.exportBtn.addEventListener("click", exportExcel);
els.exportReviewConfirm.addEventListener("click", (event) => {
  event.preventDefault();
  els.exportReviewDialog.close();
  downloadExcel();
});
els.removeDuplicatesBtn.addEventListener("click", removeDuplicates);
els.clearBtn.addEventListener("click", clearAll);
els.bankFileInput.addEventListener("change", (e) => loadBankFile(e.target.files?.[0]));
els.applyBankBtn.addEventListener("click", applyBankToLines);

["dragenter", "dragover"].forEach((eventName) => {
  els.bankDropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    els.bankDropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  els.bankDropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    els.bankDropZone.classList.remove("dragover");
    if (eventName === "drop") loadBankFile(e.dataTransfer.files?.[0]);
  });
});

["dragenter", "dragover"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    els.dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("dragover");
    if (eventName === "drop") addFiles(e.dataTransfer.files);
  });
});

loadApiSettings();
bindPreviewControls(previewUi);
els.previewCloseBtn?.addEventListener("click", () => closeLinePreview());
els.fieldBulkApplyAll?.addEventListener("click", () => {
  applyPendingFieldBulk();
  renderTable();
  updateButtons();
  if (state.previewOpen && state.selectedLineIndex != null) {
    showLinePreview(previewUi, state.lines[state.selectedLineIndex], state.selectedLineIndex);
  }
});
els.fieldBulkDialog?.addEventListener("close", () => {
  pendingFieldBulk = null;
});
els.bankMatchConfirm?.addEventListener("click", (event) => {
  event.preventDefault();
  confirmBankMatch();
});
els.bankMatchProposals?.addEventListener("change", (event) => {
  if (event.target?.name === "bankProposal") updateBankMatchInvoiceDetail();
});
els.bankMatchForm?.addEventListener("close", () => {
  if (skipBankMatchCloseHandler) return;
  if (pendingBankMatchQueue.length > 0) pendingBankMatchQueue.shift();
  showNextBankMatchDialog();
});
loadClientSettings();
updateFilenamePreview();
updateButtons();
setStep(1);
refreshEngineBadge();
renderHeroAuth();
initCabinetAccess();

async function renderHeroAuth() {
  const root = els.heroAuth;
  if (!root) return;
  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  if (!isSupabaseConfigured()) {
    root.innerHTML = `
      <a href="index.html" class="hero-auth-link">Accueil</a>
      <a href="login.html" class="hero-auth-link">Connexion</a>
    `;
    return;
  }
  try {
    const session = await getSession();
    if (!session?.user) {
      root.innerHTML = `
        <a href="index.html" class="hero-auth-link">Accueil</a>
        <a href="login.html" class="hero-auth-link">Connexion</a>
      `;
      return;
    }
    const admin = await isSuperAdmin(session.user.id);
    const membership = admin ? null : await getUserCabinetMembership();
    const email = escapeHtml(session.user.email || "");
    root.innerHTML = `
      <a href="index.html" class="hero-auth-link">Accueil</a>
      ${admin ? `<a href="admin.html" class="hero-auth-link">Admin cabinets</a>` : ""}
      ${membership ? `<a href="dossiers.html" class="hero-auth-link">Mes dossiers</a>` : ""}
      ${admin ? `<span class="hero-auth-role">Super-admin</span>` : ""}
      <span class="hero-auth-email" title="${email}">${email}</span>
      <button type="button" id="signOutBtn">Déconnexion</button>
    `;
    document.getElementById("signOutBtn")?.addEventListener("click", async () => {
      await signOut();
      window.location.reload();
    });
  } catch {
    root.innerHTML = `
      <a href="index.html" class="hero-auth-link">Accueil</a>
      <a href="login.html" class="hero-auth-link">Connexion</a>
    `;
  }
}
