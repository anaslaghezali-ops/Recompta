/**
 * Aperçu document (PDF / image) pour la revue côte à côte.
 */

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import {
  assignSourceIds,
  normalizePath,
  parseSourceFilename,
  tagSourceFilename,
} from "./source-id.js?v=preview6";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

export { assignSourceIds, parseSourceFilename, tagSourceFilename };

const FIELD_LABELS = {
  fact_num: "N° facture",
  lib_frss: "Fournisseur",
  ice_frs: "ICE",
  if: "IF",
  designation: "Désignation / CODE TVA",
  m_ht: "HT",
  tva: "TVA",
  m_ttc: "TTC",
  taux: "Taux",
  date_fac: "Date facture",
  date_paie: "Date paiement",
};

const sourceFiles = new Map();
const pdfDocs = new Map();
let sourceSeq = 0;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
const ZOOM_DEFAULT = 1;
const PDF_RENDER_SCALE = 2;

function clampZoom(value) {
  const rounded = Math.round(value / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(rounded.toFixed(2))));
}

function currentZoom(ui) {
  return ui._previewState?.zoom ?? ZOOM_DEFAULT;
}

function applyDocumentZoom(ui) {
  const zoom = currentZoom(ui);
  if (ui.canvasWrap) ui.canvasWrap.style.setProperty("--preview-zoom", String(zoom));
  if (ui.zoomLabel) ui.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  if (ui.zoomOutBtn) ui.zoomOutBtn.disabled = zoom <= ZOOM_MIN;
  if (ui.zoomInBtn) ui.zoomInBtn.disabled = zoom >= ZOOM_MAX;
}

export async function setPreviewZoom(ui, zoom) {
  ui._previewState = ui._previewState || { page: 1, filename: "", zoom: ZOOM_DEFAULT };
  ui._previewState.zoom = clampZoom(zoom);
  applyDocumentZoom(ui);
}

export async function changePreviewZoom(ui, delta) {
  return setPreviewZoom(ui, currentZoom(ui) + delta);
}

function pdfBytes(content) {
  if (content instanceof ArrayBuffer) return new Uint8Array(content.slice(0));
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  return content;
}

export function addSourceFiles(items) {
  const records = [];
  for (const item of items || []) {
    const filename = normalizePath(item.filename);
    const id = `src-${++sourceSeq}`;
    const rec = {
      id,
      filename,
      content: item.content,
      mime: item.mime || "application/octet-stream",
    };
    sourceFiles.set(id, rec);
    records.push(rec);
  }
  return records;
}

/** Conserve les documents déjà extraits ; ajoute le lot courant. */
export function cacheSourceFiles(items) {
  return addSourceFiles(items);
}

export function resolveSourceId(recordsOrMap, filename, _resultIndex = -1) {
  const parsed = parseSourceFilename(filename);
  if (Array.isArray(recordsOrMap)) {
    return (
      assignSourceIds(recordsOrMap, [{ filename, source_id: parsed.sourceId }])[0] || ""
    );
  }
  if (parsed.sourceId && sourceFiles.has(parsed.sourceId)) return parsed.sourceId;
  return "";
}

export function clearSourceFiles() {
  sourceFiles.clear();
  pdfDocs.clear();
  sourceSeq = 0;
}

export function hasSourceFile(lineOrFilename, sourceId = "") {
  return Boolean(getSourceFile(lineOrFilename, sourceId));
}

export function getSourceFile(lineOrFilename, sourceId = "") {
  const id =
    (typeof lineOrFilename === "object" && lineOrFilename ? lineOrFilename.source_id : "") || sourceId;
  if (id && sourceFiles.has(id)) return sourceFiles.get(id);
  return null;
}

async function openPdfDoc(sourceFile) {
  const cacheKey = sourceFile.id;
  if (cacheKey && pdfDocs.has(cacheKey)) return pdfDocs.get(cacheKey);
  const doc = await pdfjsLib.getDocument({ data: pdfBytes(sourceFile.content) }).promise;
  if (cacheKey) pdfDocs.set(cacheKey, doc);
  return doc;
}

function cancelPreviewRender(ui) {
  if (ui._renderTask) {
    try {
      ui._renderTask.cancel();
    } catch {
      /* déjà terminé */
    }
    ui._renderTask = null;
  }
}

function clearPreviewImage(ui) {
  if (ui._imageUrl) {
    URL.revokeObjectURL(ui._imageUrl);
    ui._imageUrl = "";
  }
  if (ui.image) {
    ui.image.removeAttribute("src");
    ui.image.hidden = true;
  }
}

/** Un seul canvas dans le panneau — évite l'ancienne facture qui reste en dessous. */
function resetPreviewSurface(ui) {
  if (!ui.canvasWrap) return;
  cancelPreviewRender(ui);
  clearPreviewImage(ui);
  ui.canvasWrap.querySelectorAll("canvas").forEach((node) => node.remove());
  const canvas = document.createElement("canvas");
  canvas.hidden = true;
  if (ui.image) ui.canvasWrap.insertBefore(canvas, ui.image);
  else ui.canvasWrap.appendChild(canvas);
  ui.canvas = canvas;
  ui.canvasWrap.scrollTop = 0;
  ui.canvasWrap.scrollLeft = 0;
}

function isPdf(sourceFile) {
  return (
    sourceFile.mime === "application/pdf" || normalizePath(sourceFile.filename).toLowerCase().endsWith(".pdf")
  );
}

function isImage(sourceFile) {
  return sourceFile.mime.startsWith("image/");
}

function renderLineIssues(container, line) {
  const issues = Object.entries(line.field_confidence || {})
    .filter(([, conf]) => conf.level !== "ok")
    .map(([field, conf]) => ({
      field,
      level: conf.level,
      text: `${FIELD_LABELS[field] || field} — ${conf.reason}`,
    }));

  if (!issues.length) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }

  issues.sort((a, b) => (a.level === "error" ? 0 : 1) - (b.level === "error" ? 0 : 1));
  container.hidden = false;
  container.innerHTML = `<p class="preview-issues-title">Champs à relire sur cette ligne</p><ul>${issues
    .map((issue) => `<li class="preview-issue preview-${issue.level}">${issue.text}</li>`)
    .join("")}</ul>`;
}

/**
 * @param {object} ui - éléments DOM du panneau preview
 * @param {object|null} line - ligne sélectionnée
 * @param {number|null} lineIndex
 */
export async function showLinePreview(ui, line, lineIndex = null) {
  if (!ui?.panel) return;

  if (!line) {
    if (ui.title) ui.title.textContent = "Document";
    if (ui.subtitle) ui.subtitle.textContent = "";
    if (ui.empty) ui.empty.hidden = false;
    if (ui.missing) ui.missing.hidden = true;
    if (ui.canvasWrap) ui.canvasWrap.hidden = true;
    if (ui.issues) ui.issues.hidden = true;
    if (ui.nav) ui.nav.hidden = true;
    if (ui.zoom) ui.zoom.hidden = true;
    clearPreviewImage(ui);
    return;
  }

  if (ui.empty) ui.empty.hidden = true;

  const label = line.fact_num
    ? `Facture ${line.fact_num}${line.lib_frss ? ` — ${line.lib_frss}` : ""}`
    : shortName(line.source_file);
  if (ui.title) ui.title.textContent = label;
  if (ui.issues) renderLineIssues(ui.issues, line);

  const source = getSourceFile(line);
  if (ui.subtitle) {
    ui.subtitle.textContent = source
      ? shortName(source.filename)
      : line.source_file
        ? shortName(line.source_file)
        : "";
  }
  if (!source) {
    if (ui.missing) {
      ui.missing.hidden = false;
      ui.missing.textContent =
        "Document non disponible en local. Réimportez le ZIP pour afficher l'aperçu.";
    }
    if (ui.canvasWrap) ui.canvasWrap.hidden = true;
    if (ui.nav) ui.nav.hidden = true;
    if (ui.zoom) ui.zoom.hidden = true;
    return;
  }

  if (ui.missing) ui.missing.hidden = true;
  if (ui.canvasWrap) ui.canvasWrap.hidden = false;

  ui._previewToken = (ui._previewToken || 0) + 1;
  const token = ui._previewToken;

  ui._previewState = ui._previewState || { page: 1, filename: "", sourceId: "", zoom: ZOOM_DEFAULT };
  if (ui._previewState.zoom == null) ui._previewState.zoom = ZOOM_DEFAULT;
  const sourceId = source.id;
  ui._previewState.sourceId = sourceId;
  ui._previewState.filename = source.filename;
  ui._previewState.page = 1;
  ui._previewState.pdf = null;
  ui._previewState.pageCount = 1;
  applyDocumentZoom(ui);
  if (ui.zoom) ui.zoom.hidden = false;
  resetPreviewSurface(ui);

  try {
    if (isPdf(source)) {
      const pdf = await openPdfDoc(source);
      if (token !== ui._previewToken) return;
      ui._previewState.pdf = pdf;
      ui._previewState.pageCount = pdf.numPages;
      ui._previewState.page = 1;
      await renderPdfPage(ui, pdf, 1, token);
      if (token !== ui._previewToken) return;
      if (ui.nav) ui.nav.hidden = ui._previewState.pageCount <= 1;
      updatePageInfo(ui);
    } else if (isImage(source)) {
      if (ui.nav) ui.nav.hidden = true;
      await renderImage(ui, source);
      if (token !== ui._previewToken) return;
    } else {
      if (ui.missing) {
        ui.missing.hidden = false;
        ui.missing.textContent = "Format non prévisualisable (PDF ou image attendu).";
      }
      if (ui.canvasWrap) ui.canvasWrap.hidden = true;
      if (ui.zoom) ui.zoom.hidden = true;
    }
  } catch (error) {
    if (ui.missing) {
      ui.missing.hidden = false;
      ui.missing.textContent = `Impossible d'afficher le document : ${error.message}`;
    }
    if (ui.canvasWrap) ui.canvasWrap.hidden = true;
    if (ui.zoom) ui.zoom.hidden = true;
  }

  if (lineIndex != null && ui.panel.dataset) {
    ui.panel.dataset.lineIndex = String(lineIndex);
  }
}

function shortName(path) {
  const parts = normalizePath(path).split("/");
  return parts.length > 1 ? parts.slice(-2).join("/") : path;
}

function updatePageInfo(ui) {
  if (!ui.pageInfo || !ui._previewState) return;
  ui.pageInfo.textContent = `${ui._previewState.page} / ${ui._previewState.pageCount}`;
  if (ui.prevBtn) ui.prevBtn.disabled = ui._previewState.page <= 1;
  if (ui.nextBtn) ui.nextBtn.disabled = ui._previewState.page >= ui._previewState.pageCount;
}

async function renderPdfPage(ui, pdf, pageNumber, token = null) {
  cancelPreviewRender(ui);
  const canvas = ui.canvas;
  const page = await pdf.getPage(pageNumber);
  if (token != null && token !== ui._previewToken) return;
  if (!canvas || ui.canvas !== canvas) return;
  const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
  const ctx = canvas.getContext("2d");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.hidden = false;
  if (ui.image) ui.image.hidden = true;
  ui._renderTask = page.render({ canvasContext: ctx, viewport });
  try {
    await ui._renderTask.promise;
  } catch (error) {
    if (error?.name === "RenderingCancelledException") return;
    throw error;
  } finally {
    if (ui._renderTask) ui._renderTask = null;
  }
}

async function renderImage(ui, source) {
  clearPreviewImage(ui);
  if (ui.canvas) ui.canvas.hidden = true;
  const blob = new Blob([source.content], { type: source.mime });
  const url = URL.createObjectURL(blob);
  ui._imageUrl = url;
  if (ui.image) {
    ui.image.src = url;
    ui.image.hidden = false;
  }
}

export async function changePreviewPage(ui, delta) {
  if (!ui?._previewState?.pdf) return;
  const next = ui._previewState.page + delta;
  if (next < 1 || next > ui._previewState.pageCount) return;
  ui._previewState.page = next;
  await renderPdfPage(ui, ui._previewState.pdf, next, ui._previewToken);
  updatePageInfo(ui);
}

export function bindPreviewControls(ui, onPageChange) {
  if (ui.prevBtn) {
    ui.prevBtn.addEventListener("click", () => {
      changePreviewPage(ui, -1).then(onPageChange);
    });
  }
  if (ui.nextBtn) {
    ui.nextBtn.addEventListener("click", () => {
      changePreviewPage(ui, 1).then(onPageChange);
    });
  }
  if (ui.zoomInBtn) {
    ui.zoomInBtn.addEventListener("click", () => changePreviewZoom(ui, ZOOM_STEP));
  }
  if (ui.zoomOutBtn) {
    ui.zoomOutBtn.addEventListener("click", () => changePreviewZoom(ui, -ZOOM_STEP));
  }
  if (ui.zoomResetBtn) {
    ui.zoomResetBtn.addEventListener("click", () => setPreviewZoom(ui, ZOOM_DEFAULT));
  }
  if (!ui.canvasWrap) return;

  ui.canvasWrap.addEventListener(
    "wheel",
    (event) => {
      // Molette / trackpad : défilement natif. Zoom uniquement avec Ctrl ou Cmd (pinch).
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      changePreviewZoom(ui, delta);
    },
    { passive: false },
  );

  let drag = null;
  ui.canvasWrap.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = {
      x: event.clientX,
      y: event.clientY,
      left: ui.canvasWrap.scrollLeft,
      top: ui.canvasWrap.scrollTop,
    };
    ui.canvasWrap.classList.add("is-panning");
    ui.canvasWrap.setPointerCapture(event.pointerId);
  });
  ui.canvasWrap.addEventListener("pointermove", (event) => {
    if (!drag) return;
    ui.canvasWrap.scrollLeft = drag.left - (event.clientX - drag.x);
    ui.canvasWrap.scrollTop = drag.top - (event.clientY - drag.y);
  });
  const endPan = () => {
    drag = null;
    ui.canvasWrap.classList.remove("is-panning");
  };
  ui.canvasWrap.addEventListener("pointerup", endPan);
  ui.canvasWrap.addEventListener("pointercancel", endPan);
}

export function findFirstReviewLineIndex(lines) {
  for (let i = 0; i < (lines || []).length; i += 1) {
    const conf = lines[i].field_confidence || {};
    if (Object.values(conf).some((entry) => entry.level !== "ok")) return i;
  }
  return lines?.length ? 0 : null;
}
