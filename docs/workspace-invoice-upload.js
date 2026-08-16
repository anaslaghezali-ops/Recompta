import { uploadDossierFileForImport } from "./dossier-documents.js?v=doc11";
import { escapeHtml, initLucide } from "./dashboard-ui.js?v=portfolio1";
import { formatFileSize } from "./import-dossier.js?v=imp1";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.zip,application/pdf,image/*,application/zip";

export function createWorkspaceInvoiceUpload({
  getDossierId,
  getCanImport = () => true,
  onUploaded,
  showToast,
  onRequestExtraction,
}) {
  let uploading = false;
  const zones = new Map();

  function isUploading() {
    return uploading;
  }

  function getZone(inputEl) {
    return zones.get(inputEl) || null;
  }

  function canImportNow() {
    return getCanImport() !== false;
  }

  function notifyBlockedImport() {
    showToast?.({
      title: "Import impossible",
      message: "Cette période est déclarée. Rouvrez-la ou passez sur une période en cours pour importer.",
      variant: "warn",
    });
  }

  function setDropzoneBusy(dropzoneEl, busy) {
    if (!dropzoneEl) return;
    dropzoneEl.classList.toggle("is-uploading", busy);
    dropzoneEl.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function renderDropzoneProgress(dropzoneEl, { label = "", percent = 0 } = {}) {
    if (!dropzoneEl) return;
    let panel = dropzoneEl.querySelector(".ws-docs-upload-progress");
    if (!label) {
      panel?.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "ws-docs-upload-progress";
      panel.innerHTML = `
        <p class="ws-docs-upload-progress-label"></p>
        <div class="ws-docs-upload-progress-track" aria-hidden="true">
          <div class="ws-docs-upload-progress-fill"></div>
        </div>
      `;
      dropzoneEl.appendChild(panel);
    }
    panel.querySelector(".ws-docs-upload-progress-label").textContent = label;
    panel.querySelector(".ws-docs-upload-progress-fill").style.width = `${percent}%`;
  }

  function renderFileQueue(zone) {
    const { queueEl, queueBtn, extractBtn, pendingFiles = [] } = zone;
    if (!queueEl) return;

    const hasFiles = pendingFiles.length > 0;
    queueEl.hidden = !hasFiles;
    if (zone.actionsEl) zone.actionsEl.hidden = !hasFiles;

    if (!hasFiles) {
      queueEl.innerHTML = "";
      if (queueBtn) queueBtn.disabled = true;
      if (extractBtn) extractBtn.disabled = true;
      return;
    }

    queueEl.innerHTML = pendingFiles.map((file, index) => `
      <div class="imp-file-row">
        <span class="imp-file-icon">${file.name.toLowerCase().endsWith(".zip") ? "🗜️" : "📄"}</span>
        <div class="imp-file-meta">
          <strong>${escapeHtml(file.name)}</strong>
          <span>${formatFileSize(file.size)}</span>
        </div>
        <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-remove-file="${index}" aria-label="Retirer">✕</button>
      </div>
    `).join("");

    queueEl.querySelectorAll("[data-remove-file]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const removeIndex = Number(btn.dataset.removeFile);
        zone.pendingFiles.splice(removeIndex, 1);
        renderFileQueue(zone);
      });
    });

    const disabled = uploading || !canImportNow();
    if (queueBtn) queueBtn.disabled = disabled;
    if (extractBtn) extractBtn.disabled = disabled;
    initLucide();
  }

  function clearAllQueues() {
    for (const zone of zones.values()) {
      zone.pendingFiles = [];
      renderFileQueue(zone);
    }
  }

  function addFilesToQueue(inputEl, fileList) {
    const zone = getZone(inputEl);
    if (!zone) return false;

    if (!canImportNow()) {
      notifyBlockedImport();
      return false;
    }

    const dossierId = getDossierId();
    const files = [...(fileList || [])].filter(Boolean);
    if (!files.length) return false;

    if (!dossierId) {
      showToast?.({
        title: "Période requise",
        message: "Créez ou sélectionnez une période TVA avant d'importer des factures.",
        variant: "warn",
      });
      return false;
    }

    for (const file of files) {
      if (!zone.pendingFiles.some((item) => item.name === file.name && item.size === file.size)) {
        zone.pendingFiles.push(file);
      }
    }
    renderFileQueue(zone);
    return true;
  }

  function bindDropzone({
    dropzoneEl,
    inputEl,
    queueEl = null,
    actionsEl = null,
    queueBtn = null,
    extractBtn = null,
  }) {
    if (!dropzoneEl || !inputEl || zones.has(inputEl)) return;

    const zone = {
      dropzoneEl,
      inputEl,
      queueEl,
      actionsEl,
      queueBtn,
      extractBtn,
      pendingFiles: [],
    };
    zones.set(inputEl, zone);

    inputEl.accept = ACCEPT;
    inputEl.multiple = true;

    dropzoneEl.addEventListener("click", (event) => {
      if (uploading || !canImportNow()) {
        if (!canImportNow()) notifyBlockedImport();
        return;
      }
      if (event.target.closest("button, a, input")) return;
      inputEl.click();
    });

    dropzoneEl.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!uploading && canImportNow()) dropzoneEl.classList.add("is-dragover");
    });

    dropzoneEl.addEventListener("dragleave", () => {
      dropzoneEl.classList.remove("is-dragover");
    });

    dropzoneEl.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzoneEl.classList.remove("is-dragover");
      if (uploading || !canImportNow()) {
        if (!canImportNow()) notifyBlockedImport();
        return;
      }
      const dropped = [...(event.dataTransfer?.files || [])];
      if (!dropped.length) return;
      addFilesToQueue(inputEl, dropped);
      runQueue(zone).catch((error) => {
        showToast?.({
          title: "Import impossible",
          message: error?.message || "Impossible d'importer les fichiers sélectionnés.",
          variant: "error",
        });
      });
    });

    inputEl.addEventListener("change", () => {
      const files = [...(inputEl.files || [])];
      inputEl.value = "";
      if (!files.length) return;
      addFilesToQueue(inputEl, files);
      runQueue(zone).catch((error) => {
        showToast?.({
          title: "Import impossible",
          message: error?.message || "Impossible d'importer les fichiers sélectionnés.",
          variant: "error",
        });
      });
    });

    queueBtn?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runQueue(zone).catch((error) => {
        showToast?.({
          title: "Import impossible",
          message: error?.message || "Impossible d'importer les fichiers sélectionnés.",
          variant: "error",
        });
      });
    });

    extractBtn?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runExtract(zone).catch((error) => {
        showToast?.({
          title: "Extraction impossible",
          message: error?.message || "Impossible de lancer l'extraction.",
          variant: "error",
        });
      });
    });

    renderFileQueue(zone);
  }

  function openFilePicker(inputEl) {
    if (uploading || !inputEl) return;
    if (!canImportNow()) {
      notifyBlockedImport();
      return;
    }
    inputEl.click();
  }

  async function uploadFiles(fileList, { dropzoneEl = null, notify = true } = {}) {
    const dossierId = getDossierId();
    const files = [...(fileList || [])].filter(Boolean);
    if (!files.length || uploading) {
      return { uploaded: 0, reused: 0, expanded: 0, failures: [], invoiceCount: 0 };
    }
    if (!canImportNow()) {
      notifyBlockedImport();
      return { uploaded: 0, reused: 0, expanded: 0, failures: [], invoiceCount: 0 };
    }
    if (!dossierId) {
      showToast?.({
        title: "Période requise",
        message: "Créez ou sélectionnez une période TVA avant d'importer des factures.",
        variant: "warn",
      });
      return { uploaded: 0, reused: 0, expanded: 0, failures: [], invoiceCount: 0 };
    }

    uploading = true;
    setDropzoneBusy(dropzoneEl, true);
    for (const zone of zones.values()) renderFileQueue(zone);

    let uploaded = 0;
    let reused = 0;
    let expanded = 0;
    const failures = [];

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const percent = Math.round(((index + 1) / files.length) * 100);
        const label = `Envoi ${index + 1}/${files.length} — ${file.name}`;
        renderDropzoneProgress(dropzoneEl, { label, percent });

        try {
          const saved = await uploadDossierFileForImport({
            dossierId,
            file,
            skipIfSameNameAndSize: true,
          });
          if (saved?.reused) reused += 1;
          else uploaded += 1;
          expanded += saved?.children?.length || 0;
        } catch (error) {
          failures.push({ name: file.name, message: error.message || "Échec de l'import" });
        }
      }
    } finally {
      uploading = false;
      setDropzoneBusy(dropzoneEl, false);
      renderDropzoneProgress(dropzoneEl);
      for (const zone of zones.values()) renderFileQueue(zone);
    }

    const stored = uploaded + reused;
    const invoiceCount = expanded || stored;
    const summary = failures.length
      ? `${invoiceCount} document(s) reçu(s), ${failures.length} erreur(s).`
      : expanded
        ? `${expanded} facture(s) importée(s) depuis ${stored} archive(s).`
        : reused && !uploaded
          ? `${reused} fichier(s) déjà présent(s).`
          : `${uploaded} facture(s) importée(s).`;

    if (notify && showToast) {
      const variant = failures.length ? "warn" : stored ? "success" : "info";
      showToast({
        title: failures.length ? "Import partiel" : stored ? "Factures importées" : "Aucun nouveau fichier",
        message: stored
          ? `${summary} Lancez l'extraction depuis Période active quand vous êtes prêt.`
          : summary,
        variant,
      });
    }

    if (onUploaded) {
      await onUploaded({ uploaded, reused, expanded, failures, invoiceCount });
    }

    initLucide();
    return { uploaded, reused, expanded, failures, invoiceCount };
  }

  async function runQueue(zone) {
    if (!zone?.pendingFiles.length || uploading) return;
    if (!canImportNow()) {
      notifyBlockedImport();
      return;
    }
    const files = [...zone.pendingFiles];
    zone.pendingFiles = [];
    renderFileQueue(zone);
    await uploadFiles(files, { dropzoneEl: zone.dropzoneEl, notify: true });
  }

  async function runExtract(zone) {
    if (!zone?.pendingFiles.length || uploading) return;
    if (!canImportNow()) {
      notifyBlockedImport();
      return;
    }
    const files = [...zone.pendingFiles];
    zone.pendingFiles = [];
    renderFileQueue(zone);

    const result = await uploadFiles(files, { dropzoneEl: zone.dropzoneEl, notify: false });
    const { invoiceCount = 0, failures = [], uploaded = 0, reused = 0, expanded = 0 } = result;
    const stored = uploaded + reused;

    if (showToast) {
      if (failures.length) {
        showToast({
          title: "Import partiel",
          message: `${invoiceCount} document(s) reçu(s), ${failures.length} erreur(s). L'extraction n'a pas été lancée.`,
          variant: "warn",
        });
        return;
      }
      if (!stored) {
        showToast({
          title: "Aucun nouveau fichier",
          message: "Les fichiers sélectionnés sont déjà importés.",
          variant: "info",
        });
        return;
      }
      showToast({
        title: "Extraction lancée",
        message: expanded
          ? `${expanded} facture(s) importée(s) — analyse IA en cours.`
          : `${stored} facture(s) importée(s) — analyse IA en cours.`,
        variant: "success",
      });
    }

    if (invoiceCount > 0 && !failures.length && onRequestExtraction) {
      await onRequestExtraction();
    }
  }

  return {
    bindDropzone,
    openFilePicker,
    addFilesToQueue,
    clearAllQueues,
    uploadFiles,
    isUploading,
    formatFileSize,
    escapeHtml,
  };
}
