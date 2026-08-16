import { uploadDossierFileForImport } from "./dossier-documents.js?v=doc11";
import { escapeHtml, initLucide } from "./dashboard-ui.js?v=portfolio1";
import { formatFileSize } from "./import-dossier.js?v=imp1";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.zip,application/pdf,image/*,application/zip";

function copyFiles(fileList) {
  return [...(fileList || [])].filter(Boolean);
}

export function createWorkspaceInvoiceUpload({
  getDossierId,
  getCanImport = () => true,
  onUploaded,
  showToast,
  onRequestExtraction,
}) {
  let uploading = false;
  const boundInputs = new Set();

  function isUploading() {
    return uploading;
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

  function bindDropzone({ dropzoneEl, inputEl }) {
    if (!dropzoneEl || !inputEl || boundInputs.has(inputEl)) return;
    boundInputs.add(inputEl);

    inputEl.accept = ACCEPT;
    inputEl.multiple = true;

    dropzoneEl.addEventListener("click", (event) => {
      if (event.target.closest("button, a, input")) return;
      if (uploading || !canImportNow()) {
        if (!canImportNow()) notifyBlockedImport();
        return;
      }
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
      uploadFiles(copyFiles(event.dataTransfer?.files), { dropzoneEl }).catch(() => {});
    });

    inputEl.addEventListener("change", () => {
      const files = copyFiles(inputEl.files);
      inputEl.value = "";
      if (!files.length) return;
      uploadFiles(files, { dropzoneEl }).catch(() => {});
    });
  }

  function openFilePicker(inputEl) {
    if (uploading || !inputEl) return;
    if (!canImportNow()) {
      notifyBlockedImport();
      return;
    }
    inputEl.click();
  }

  async function uploadFiles(fileList, { dropzoneEl = null } = {}) {
    const dossierId = getDossierId();
    const files = copyFiles(fileList);
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

    let uploaded = 0;
    let reused = 0;
    let expanded = 0;
    const failures = [];

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const percent = Math.round(((index + 1) / files.length) * 100);
        renderDropzoneProgress(dropzoneEl, {
          label: `Envoi ${index + 1}/${files.length} — ${file.name}`,
          percent,
        });

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

    if (showToast) {
      const canExtract = invoiceCount > 0 && !failures.length;
      showToast({
        title: failures.length ? "Import partiel" : stored ? "Factures importées" : "Aucun nouveau fichier",
        message: summary,
        variant: failures.length ? "warn" : stored ? "success" : "info",
        actionLabel: canExtract ? "Lancer l'extraction" : null,
        onAction: canExtract ? onRequestExtraction : null,
      });
    }

    if (onUploaded) {
      await onUploaded({ uploaded, reused, expanded, failures, invoiceCount });
    }

    initLucide();
    return { uploaded, reused, expanded, failures, invoiceCount };
  }

  return {
    bindDropzone,
    openFilePicker,
    uploadFiles,
    isUploading,
    formatFileSize,
    escapeHtml,
  };
}
