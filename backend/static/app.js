import {
  completeSupplierIdentifiers,
  expandUploadedFiles,
  extractInvoice,
  findDuplicateLineIndexes,
  normalizeExtractionResults,
  setExtractionContext,
} from "./extract-client.js";
import { collectExportReview, exportDedTvaExcel } from "./export-client.js";
import {
  applyConfidenceToInput,
  countConfidenceIssues,
  refreshLinesFieldConfidence,
} from "./field-confidence.js";
import {
  applyBankStatement,
  normalizeBankTransactions,
  parseBankFile,
} from "./bank-statement-client.js";
import {
  bindPreviewControls,
  cacheSourceFiles,
  clearSourceFiles,
  findFirstReviewLineIndex,
  resolveSourceId,
  showLinePreview,
} from "./document-preview.js";
import {
  extractViaServer,
  fetchServerHealth,
  getApiUrl,
  parseBankStatementViaServer,
  saveApiUrl,
} from "./api-client.js";

const state = {
  files: [],
  lines: [],
  selectedLineIndex: null,
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
};

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

function selectLine(index) {
  if (index == null || index < 0 || index >= state.lines.length) {
    state.selectedLineIndex = null;
    showLinePreview(previewUi, null);
    renderTable();
    return;
  }
  state.selectedLineIndex = index;
  showLinePreview(previewUi, state.lines[index], index);
  renderTable();
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
  els.emptyState.hidden = hasLines;
  els.reviewLayout.hidden = !hasLines;
  els.previewPanel.hidden = !hasLines;
  if (!hasLines) {
    state.selectedLineIndex = null;
    showLinePreview(previewUi, null);
  }

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

function renderTable() {
  refreshAllFieldConfidence();
  els.linesTableBody.innerHTML = "";
  const duplicates = new Set(findDuplicateLineIndexes(state.lines));

  state.lines.forEach((line, index) => {
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
        input.addEventListener("change", () => {
          if (field.type === "number") {
            line[field.key] = Number(input.value) || 0;
          } else if (field.key === "taux" || field.key === "id_paie") {
            line[field.key] = Number(input.value);
          } else if (field.key === "ice_frs") {
            const digits = input.value.replace(/\D/g, "").slice(0, 15);
            line.ice_frs = digits.length === 15 ? digits : "";
            input.value = line.ice_frs;
          } else if (field.key === "if") {
            line.if = input.value;
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
          return;
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
    viewBtn.textContent = "Voir";
    viewBtn.title = "Afficher la facture à côté pour revue";
    viewBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      selectLine(index);
    });
    actionTd.appendChild(viewBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "✕";
    deleteBtn.className = "delete-btn";
    deleteBtn.title = "Supprimer cette ligne";
    deleteBtn.addEventListener("click", () => {
      state.lines.splice(index, 1);
      if (state.selectedLineIndex === index) {
        state.selectedLineIndex = state.lines.length ? Math.min(index, state.lines.length - 1) : null;
      } else if (state.selectedLineIndex != null && state.selectedLineIndex > index) {
        state.selectedLineIndex -= 1;
      }
      renderTable();
      updateButtons();
      if (state.selectedLineIndex != null) {
        showLinePreview(previewUi, state.lines[state.selectedLineIndex], state.selectedLineIndex);
      } else {
        showLinePreview(previewUi, null);
      }
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
  const savedIce = localStorage.getItem("recompta_client_ice");
  if (savedIce) els.clientIce.value = savedIce;
}

function persistClientIce() {
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
        els.extractionStatus.textContent = "Préparation des fichiers…";
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

  setLoading(true);
  clearWarnings();
  els.extractionStatus.textContent = "Extraction en cours…";
  els.extractionStatus.classList.remove("error", "success", "warn");

  const filesToProcess = [...state.files];

  try {
    const expanded = await expandUploadedFiles(filesToProcess);
    const idsByFilename = cacheSourceFiles(expanded);
    const results = normalizeExtractionResults(await runExtraction(expanded));
    const firstNewIndex = state.lines.length;

    let newLines = 0;
    let okFiles = 0;
    let warnFiles = 0;
    const warnings = [];

    results.forEach((result) => {
      if (result.lines?.length) {
        okFiles += 1;
        const sourceId = resolveSourceId(idsByFilename, result.filename);
        result.lines.forEach((line) => {
          state.lines.push({
            ...emptyLine(result.filename),
            ...line,
            source_file: result.filename,
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
        warnings.push(`[${eng}] ${shortFilename(result.filename)}: ${result.warnings.join(", ")}`);
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
    if (state.selectedLineIndex != null) {
      await showLinePreview(previewUi, state.lines[state.selectedLineIndex], state.selectedLineIndex);
    }

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
  } catch (error) {
    els.extractionStatus.textContent = `Erreur : ${error.message}`;
    els.extractionStatus.classList.add("error");
  } finally {
    setLoading(false);
  }
}

function downloadExcel() {
  setStep(4);
  els.exportBtn.disabled = true;
  els.exportBtn.textContent = "Génération…";

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
  } catch (error) {
    alert(`Export impossible : ${error.message}`);
  } finally {
    els.exportBtn.textContent = "Télécharger Excel";
    updateButtons();
  }
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
  } catch (error) {
    clearBankState();
    els.bankStatus.textContent = `Erreur relevé : ${error.message}`;
    els.bankStatus.classList.add("error");
    updateButtons();
  }
}

function applyBankToLines() {
  if (!state.bankTransactions.length || !state.lines.length) return;

  const result = applyBankStatement(state.bankTransactions, state.lines, {
    sourceFile: state.bankMeta.filename || "releve_bancaire",
    bankName: state.bankMeta.bankName || "BANQUE",
    bankIce: state.bankMeta.bankIce || "",
    bankIf: state.bankMeta.bankIf || "",
  });

  state.lines = result.lines;
  renderTable();
  updateButtons();

  const { paymentsMatched, paymentsUnmatched, feesAdded } = result.stats;
  let msg = `${paymentsMatched} paiement(s) rapproché(s), ${feesAdded} ligne(s) frais bancaire ajoutée(s).`;
  if (paymentsUnmatched) msg += ` ${paymentsUnmatched} débit(s) sans facture correspondante.`;

  els.bankStatus.textContent = msg;
  els.bankStatus.classList.remove("error", "warn");
  if (paymentsUnmatched) els.bankStatus.classList.add("warn");
  else els.bankStatus.classList.add("success");
}

function removeDuplicates() {
  const duplicates = new Set(findDuplicateLineIndexes(state.lines));
  if (!duplicates.size) return;

  state.lines = state.lines.filter((_line, index) => !duplicates.has(index));
  if (state.selectedLineIndex != null && duplicates.has(state.selectedLineIndex)) {
    state.selectedLineIndex = state.lines.length ? 0 : null;
  }
  renderTable();
  updateButtons();
  if (state.selectedLineIndex != null) {
    showLinePreview(previewUi, state.lines[state.selectedLineIndex], state.selectedLineIndex);
  }

  els.extractionStatus.textContent = `${duplicates.size} doublon(s) supprimé(s).`;
  els.extractionStatus.classList.remove("error", "warn");
  els.extractionStatus.classList.add("success");
}

function clearAll() {
  state.files = [];
  state.lines = [];
  state.selectedLineIndex = null;
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
loadClientSettings();
updateFilenamePreview();
updateButtons();
setStep(1);
refreshEngineBadge();
