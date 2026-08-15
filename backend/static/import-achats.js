import {
  completeSupplierIdentifiers,
  expandUploadedFiles,
  extractInvoice,
  findDuplicateLineIndexes,
  normalizeExtractionResults,
  setExtractionContext,
} from "./extract-client.js";
import {
  assignSourceIds,
  cacheSourceFiles,
  parseSourceFilename,
  tagSourceFilename,
} from "./document-preview.js?v=preview8";
import {
  extractViaServer,
  ensureImportWorkerRunning,
  fetchServerHealth,
  getApiUrl,
  saveApiUrl,
} from "./api-client.js?v=api2";
import { loadDossierWorkspace } from "./dossier-persistence.js?v=persist1";
import {
  countConfidenceIssues,
  refreshLinesFieldConfidence,
} from "./field-confidence.js";
import { escapeHtml, initLucide } from "./dashboard-ui.js?v=portfolio1";
import {
  JOB_STATUS_LABELS,
  aggregateActiveImportJobs,
  jobProgressPercent,
  listImportJobs,
  startImportJobPolling,
  startInvoiceImportUpload,
} from "./import-jobs-client.js?v=jobs12";
import {
  createWorkspaceSaver,
  formatFileSize,
  initDossierImportPage,
  persistWorkspaceNow,
  renderImportContextBar,
  shortFilename,
  workspaceBackHref,
} from "./import-dossier.js?v=imp1";
import { uploadDossierDocument } from "./dossier-documents.js?v=doc4";

const els = {};
let session = null;
let saver = null;
let pendingFiles = [];
let extracting = false;
let stopJobPolling = null;

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

function setStatus(text, tone = "muted") {
  if (!els.saveStatus) return;
  els.saveStatus.textContent = text || "";
  els.saveStatus.dataset.tone = tone;
}

function setWorkerHint(message = "", tone = "muted") {
  if (!els.workerHint) return;
  els.workerHint.hidden = !message;
  els.workerHint.textContent = message || "";
  els.workerHint.dataset.tone = tone;
}

async function triggerWorkerProcessing() {
  const apiUrl = resolvedApiUrl();
  try {
    const result = await ensureImportWorkerRunning(apiUrl, { limit: 2 });
    if (!result.ok) {
      setWorkerHint(result.message, "error");
      return false;
    }
    setWorkerHint(result.message, "success");
    return true;
  } catch (error) {
    setWorkerHint(error.message, "error");
    return false;
  }
}

function resolvedApiUrl() {
  const typed = els.apiUrl?.value?.trim().replace(/\/$/, "") || "";
  return typed || getApiUrl();
}

function persistApiSettings() {
  if (els.apiUrl) saveApiUrl(els.apiUrl.value);
  if (els.useAi) localStorage.setItem("recompta_use_ai", els.useAi.checked ? "true" : "false");
}

function loadApiSettings() {
  if (els.apiUrl) els.apiUrl.value = localStorage.getItem("recompta_api_url") || "";
  if (els.useAi) els.useAi.checked = localStorage.getItem("recompta_use_ai") !== "false";
}

async function refreshEngineBadge() {
  const apiUrl = resolvedApiUrl();
  const wantAi = els.useAi?.checked;
  if (!els.engineBadge) return;

  if (wantAi && apiUrl) {
    try {
      const health = await fetchServerHealth(apiUrl);
      if (health.ai_verified) {
        els.engineBadge.textContent = "IA Vision active";
        els.engineBadge.className = "imp-engine-badge is-ok";
        return;
      }
      els.engineBadge.textContent = health.ai_message || "Clé OpenAI invalide";
      els.engineBadge.className = "imp-engine-badge is-warn";
      return;
    } catch {
      els.engineBadge.textContent = "Serveur IA injoignable";
      els.engineBadge.className = "imp-engine-badge is-warn";
      return;
    }
  }
  els.engineBadge.textContent = "Mode local — PDF texte uniquement";
  els.engineBadge.className = "imp-engine-badge";
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

async function runExtraction(expanded, onProgress) {
  setExtractionContext({ clientIce: session.context.clientIce });
  const apiUrl = resolvedApiUrl();
  const wantAi = els.useAi?.checked;

  if (wantAi && !apiUrl) {
    throw new Error("Indiquez l'URL du serveur IA (Codespace port 8000).");
  }

  if (wantAi && apiUrl) {
    const health = await fetchServerHealth(apiUrl);
    if (!health.ai_verified) {
      throw new Error(health.ai_message || "Serveur IA non configuré.");
    }
    const serverFiles = expanded.map(
      (item) => new File([item.content], item.filename, { type: item.mime }),
    );
    return extractViaServer(serverFiles, apiUrl, {
      clientIce: session.context.clientIce,
      onProgress: (_c, _t, label) => onProgress?.(label),
    });
  }

  return extractFromExpanded(expanded, (current, total, name) => {
    onProgress?.(`Fichier ${current}/${total} — ${shortFilename(name)}…`);
  });
}

function refreshLineConfidence() {
  refreshLinesFieldConfidence(session.lines, {
    clientIce: session.context.clientIce,
    duplicateIndexes: findDuplicateLineIndexes(session.lines),
  });
}

function renderFileQueue() {
  if (!pendingFiles.length) {
    els.fileQueue.hidden = true;
    els.fileQueue.innerHTML = "";
    els.queueBtn.disabled = true;
    els.extractBtn.disabled = true;
    return;
  }
  els.fileQueue.hidden = false;
  els.queueBtn.disabled = extracting;
  els.extractBtn.disabled = extracting;
  els.fileQueue.innerHTML = pendingFiles.map((file, index) => `
    <div class="imp-file-row">
      <span class="imp-file-icon">${file.name.toLowerCase().endsWith(".zip") ? "🗜️" : "📄"}</span>
      <div class="imp-file-meta">
        <strong>${escapeHtml(file.name)}</strong>
        <span>${formatFileSize(file.size)}</span>
      </div>
      <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-remove-file="${index}" aria-label="Retirer">✕</button>
    </div>
  `).join("");

  els.fileQueue.querySelectorAll("[data-remove-file]").forEach((btn) => {
    btn.addEventListener("click", () => {
      pendingFiles.splice(Number(btn.dataset.removeFile), 1);
      renderFileQueue();
    });
  });
}

function confidenceTone(line) {
  const conf = line.field_confidence || {};
  if (Object.values(conf).includes("error")) return "danger";
  if (Object.values(conf).includes("warn")) return "warn";
  return "ok";
}

function renderLinesTable() {
  refreshLineConfidence();
  const duplicates = new Set(findDuplicateLineIndexes(session.lines));
  const { errors, warns } = countConfidenceIssues(session.lines);

  els.lineCount.textContent = String(session.lines.length);
  els.anomalyCount.textContent = String(errors + warns);
  els.fileCount.textContent = String(new Set(session.lines.map((l) => l.source_file).filter(Boolean)).size);
  els.duplicateCount.textContent = String(duplicates.size);

  if (!session.lines.length) {
    els.linesPanel.hidden = true;
    return;
  }

  els.linesPanel.hidden = false;
  els.linesBody.innerHTML = session.lines.map((line, index) => {
    const tone = confidenceTone(line);
    const dup = duplicates.has(index);
    return `
      <tr class="imp-line-row ${dup ? "is-duplicate" : ""}">
        <td class="imp-line-source" title="${escapeHtml(line.source_file || "")}">${escapeHtml(shortFilename(line.source_file || ""))}</td>
        <td>${escapeHtml(line.lib_frss || "—")}</td>
        <td class="imp-mono">${escapeHtml(line.ice_frs || "—")}</td>
        <td class="imp-num">${Number(line.m_ttc || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2 })}</td>
        <td><span class="imp-conf-badge imp-conf-${tone}">${tone === "ok" ? "OK" : tone === "warn" ? "À relire" : "Erreur"}</span></td>
      </tr>
    `;
  }).join("");
}

function addFiles(fileList) {
  for (const file of fileList || []) {
    if (!pendingFiles.some((f) => f.name === file.name && f.size === file.size)) {
      pendingFiles.push(file);
    }
  }
  renderFileQueue();
}

async function runQueue() {
  if (!pendingFiles.length || extracting) return;
  extracting = true;
  els.queueBtn.disabled = true;
  els.extractBtn.disabled = true;
  els.progressPanel.hidden = false;
  els.progressText.textContent = "Envoi des documents…";
  els.progressBar.style.width = "5%";

  const filesToSend = [...pendingFiles];
  pendingFiles = [];
  renderFileQueue();

  let uploaded = 0;
  let reused = 0;
  const failures = [];

  for (let index = 0; index < filesToSend.length; index += 1) {
    const file = filesToSend[index];
    const percent = 8 + Math.round(((index + 1) / filesToSend.length) * 88);
    els.progressText.textContent = `Envoi ${index + 1}/${filesToSend.length} — ${file.name}`;
    els.progressBar.style.width = `${percent}%`;
    try {
      const saved = await uploadDossierDocument({
        dossierId: session.dossierId,
        file,
        docType: "invoice",
      });
      if (saved?.reused) reused += 1;
      else uploaded += 1;
    } catch (error) {
      failures.push({ name: file.name, message: error.message });
    }
  }

  els.progressBar.style.width = "100%";
  const stored = uploaded + reused;
  if (failures.length) {
    els.progressText.textContent = `${stored}/${filesToSend.length} reçu(s), ${failures.length} erreur(s).`;
    setStatus(`${uploaded} nouveau(x), ${reused} déjà présent(s), ${failures.length} échec(s)`, "warn");
  } else {
    els.progressText.textContent = `${stored} fichier(s) reçu(s) sur ${filesToSend.length}. Lancez l'analyse IA depuis le workspace.`;
    setStatus(
      reused
        ? `${uploaded} importé(s), ${reused} ignoré(s) (même nom et taille déjà présents)`
        : `${uploaded} document(s) importé(s) — lancez l'analyse depuis le workspace`,
      reused ? "warn" : "success",
    );
  }

  extracting = false;
  els.queueBtn.disabled = !pendingFiles.length;
  els.extractBtn.disabled = !pendingFiles.length;
  initLucide();
}

function formatJobDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderJobRow(job) {
  const progress = jobProgressPercent(job);
  const statusLabel = JOB_STATUS_LABELS[job.status] || job.status;
  const tone = job.status === "failed" ? "danger"
    : job.status === "completed" ? "success"
      : job.status === "processing" ? "accent" : "muted";

  return `
    <div class="imp-job-row">
      <div class="imp-job-main">
        <strong>Import factures — ${formatJobDate(job.created_at)}</strong>
        <span>${escapeHtml(statusLabel)} · ${job.processed_files}/${job.total_files} traités${job.failed_files ? ` · ${job.failed_files} erreur(s)` : ""}</span>
      </div>
      <div class="imp-job-progress">
        <div class="imp-progress-track"><div class="imp-progress-fill imp-job-fill-${tone}" style="width:${progress}%"></div></div>
        <span>${progress}%</span>
      </div>
    </div>
  `;
}

async function renderJobsPanel() {
  const jobs = await listImportJobs(session.dossierId, { limit: 8 });
  const active = jobs.filter((job) => ["uploading", "queued", "processing"].includes(job.status));
  const display = active.length ? active : jobs.slice(0, 3);

  if (!display.length) {
    els.jobsPanel.hidden = true;
    els.jobsList.innerHTML = "";
    return;
  }

  els.jobsPanel.hidden = false;
  els.jobsList.innerHTML = display.map(renderJobRow).join("");
  initLucide();
}

function startJobsPolling() {
  stopJobPolling?.();
  let kickCounter = 0;
  stopJobPolling = startImportJobPolling(session.dossierId, async (jobs) => {
    if (!jobs.length) {
      setWorkerHint("");
      await reloadSessionLines();
      await renderJobsPanel();
      return;
    }
    if (jobs.some((job) => job.status === "queued")) {
      kickCounter += 1;
      if (kickCounter === 1 || kickCounter % 4 === 0) {
        await triggerWorkerProcessing();
      }
    }
    els.jobsPanel.hidden = false;
    els.jobsList.innerHTML = jobs.map(renderJobRow).join("");
    initLucide();
  });
}

async function reloadSessionLines() {
  const workspace = await loadDossierWorkspace(session.dossierId);
  session.lines = workspace?.lines || [];
  session.updatedAt = workspace?.updated_at || session.updatedAt;
  renderLinesTable();
  if (session.lines.length) {
    setStatus(`Dernière sauvegarde : ${new Date(session.updatedAt || Date.now()).toLocaleString("fr-FR")}`, "success");
  }
}

async function runExtract() {
  if (!pendingFiles.length || extracting) return;
  extracting = true;
  els.extractBtn.disabled = true;
  els.progressPanel.hidden = false;
  els.progressText.textContent = "Préparation des fichiers…";
  els.progressBar.style.width = "8%";

  try {
    const expanded = await expandUploadedFiles(pendingFiles);
    els.progressBar.style.width = "20%";
    const sourceRecords = cacheSourceFiles(expanded);
    const tagged = expanded.map((item, index) => ({
      ...item,
      filename: tagSourceFilename(item.filename, sourceRecords[index].id),
    }));

    const results = normalizeExtractionResults(
      await runExtraction(tagged, (msg) => {
        els.progressText.textContent = msg;
        els.progressBar.style.width = "55%";
      }),
    );

    const sourceIds = assignSourceIds(sourceRecords, results);
    let newLines = 0;

    results.forEach((result, resultIndex) => {
      const parsed = parseSourceFilename(result.filename);
      const sourceId = result.source_id || parsed.sourceId || sourceIds[resultIndex] || "";
      const displayName = parsed.filename || result.filename;
      if (!result.lines?.length) return;
      result.lines.forEach((line) => {
        session.lines.push({
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
    });

    completeSupplierIdentifiers(session.lines);

    const uploadTasks = tagged.map((item, index) =>
      uploadDossierDocumentFromBlob({
        dossierId: session.dossierId,
        filename: parseSourceFilename(item.filename).filename || item.filename,
        content: item.content,
        mime: item.mime,
        docType: "invoice",
        sourceId: sourceRecords[index]?.id || sourceIds[index] || null,
      }).catch(() => null),
    );
    await Promise.all(uploadTasks);

    pendingFiles = [];
    renderFileQueue();
    renderLinesTable();

    els.progressBar.style.width = "100%";
    els.progressText.textContent = `${newLines} ligne(s) extraite(s) et enregistrée(s).`;
    await persistWorkspaceNow(
      session,
      setStatus,
      "extraction",
      `${newLines} ligne(s) extraite(s)`,
      { new_lines: newLines },
    );
  } catch (error) {
    els.progressText.textContent = `Erreur : ${error.message}`;
    els.progressBar.style.width = "0%";
  } finally {
    extracting = false;
    els.queueBtn.disabled = !pendingFiles.length;
    els.extractBtn.disabled = !pendingFiles.length;
    initLucide();
  }
}

function bindDropZone(zone, input) {
  zone.addEventListener("click", () => input.click());
  ["dragenter", "dragover"].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove("is-dragover");
      if (ev === "drop") addFiles(e.dataTransfer.files);
    });
  });
  input.addEventListener("change", (e) => {
    addFiles(e.target.files);
    input.value = "";
  });
}

export async function bootImportAchats() {
  [
    "contextBar", "saveStatus", "backLink", "dropZone", "fileInput", "fileQueue",
    "queueBtn", "extractBtn", "queueHint", "jobsPanel", "jobsList", "workerHint",
    "progressPanel", "progressText", "progressBar", "linesPanel",
    "linesBody", "lineCount", "anomalyCount", "fileCount", "duplicateCount",
    "apiUrl", "useAi", "engineBadge", "testApiBtn",
  ].forEach((id) => { els[id] = document.getElementById(id); });

  session = await initDossierImportPage();
  if (!session) return;

  document.title = `Recompta — Import achats · ${session.context.clientName}`;
  renderImportContextBar(session, els.contextBar);
  els.backLink.href = workspaceBackHref(session.context);

  saver = createWorkspaceSaver(session, setStatus);
  loadApiSettings();
  await refreshEngineBadge();
  renderLinesTable();

  if (session.updatedAt) {
    setStatus(`Dernière sauvegarde : ${new Date(session.updatedAt).toLocaleString("fr-FR")}`, "success");
  }

  bindDropZone(els.dropZone, els.fileInput);
  els.queueBtn.addEventListener("click", runQueue);
  els.extractBtn.addEventListener("click", runExtract);
  await renderJobsPanel();
  const activeJobs = await listImportJobs(session.dossierId, { limit: 1, activeOnly: true });
  if (activeJobs.some((job) => job.status === "queued")) {
    await triggerWorkerProcessing();
  }
  startJobsPolling();
  els.apiUrl?.addEventListener("change", () => { persistApiSettings(); refreshEngineBadge(); });
  els.useAi?.addEventListener("change", () => { persistApiSettings(); refreshEngineBadge(); });
  els.testApiBtn?.addEventListener("click", async () => {
    els.testApiBtn.disabled = true;
    try {
      await fetchServerHealth(resolvedApiUrl(), { refresh: true });
      persistApiSettings();
      await refreshEngineBadge();
    } catch (error) {
      alert(`Connexion impossible : ${error.message}`);
    } finally {
      els.testApiBtn.disabled = false;
    }
  });

  initLucide();
}

bootImportAchats();
