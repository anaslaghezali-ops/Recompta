/**
 * Aperçu document (PDF / image) pour la revue côte à côte.
 */

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

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

function normalizePath(filename) {
  return String(filename || "").replace(/\\/g, "/");
}

function pdfBytes(content) {
  if (content instanceof ArrayBuffer) return new Uint8Array(content.slice(0));
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  return content;
}

export function addSourceFiles(items) {
  const idsByFilename = new Map();
  for (const item of items || []) {
    const filename = normalizePath(item.filename);
    const id = `src-${++sourceSeq}`;
    sourceFiles.set(id, {
      id,
      filename,
      content: item.content,
      mime: item.mime || "application/octet-stream",
    });
    idsByFilename.set(filename, id);
  }
  return idsByFilename;
}

/** Conserve les documents déjà extraits ; ajoute le lot courant. */
export function cacheSourceFiles(items) {
  return addSourceFiles(items);
}

export function resolveSourceId(idsByFilename, filename) {
  const key = normalizePath(filename);
  if (!key || !idsByFilename?.size) return "";
  if (idsByFilename.has(key)) return idsByFilename.get(key);
  const base = key.split("/").pop();
  const matches = [];
  for (const [name, id] of idsByFilename) {
    if (name === key || name.endsWith(`/${key}`) || name.split("/").pop() === base) {
      matches.push(id);
    }
  }
  return matches[0] || "";
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

  const filename =
    typeof lineOrFilename === "object" ? lineOrFilename?.source_file : lineOrFilename;
  const key = normalizePath(filename);
  if (!key) return null;

  let found = null;
  for (const value of sourceFiles.values()) {
    if (value.filename === key) found = value;
  }
  if (found) return found;

  const base = key.split("/").pop();
  for (const value of sourceFiles.values()) {
    if (value.filename.split("/").pop() === base) found = value;
  }
  return found;
}

async function openPdfDoc(sourceFile) {
  const cacheKey = sourceFile.id || sourceFile.filename;
  if (pdfDocs.has(cacheKey)) return pdfDocs.get(cacheKey);
  const doc = await pdfjsLib.getDocument({ data: pdfBytes(sourceFile.content) }).promise;
  pdfDocs.set(cacheKey, doc);
  return doc;
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
    return;
  }

  if (ui.empty) ui.empty.hidden = true;

  const label = line.fact_num
    ? `Facture ${line.fact_num}${line.lib_frss ? ` — ${line.lib_frss}` : ""}`
    : shortName(line.source_file);
  if (ui.title) ui.title.textContent = label;
  if (ui.subtitle) {
    ui.subtitle.textContent = line.source_file ? shortName(line.source_file) : "";
  }
  if (ui.issues) renderLineIssues(ui.issues, line);

  const source = getSourceFile(line);
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

  ui._previewState = ui._previewState || { page: 1, filename: "", sourceId: "", zoom: ZOOM_DEFAULT };
  if (ui._previewState.zoom == null) ui._previewState.zoom = ZOOM_DEFAULT;
  const sourceId = source.id || source.filename;
  if (ui._previewState.sourceId !== sourceId) {
    ui._previewState.sourceId = sourceId;
    ui._previewState.filename = source.filename;
    ui._previewState.page = 1;
    ui._previewState.pdf = null;
    ui._previewState.pageCount = 1;
  }
  applyDocumentZoom(ui);
  if (ui.zoom) ui.zoom.hidden = false;

  try {
    if (isPdf(source)) {
      ui._previewState.pdf = await openPdfDoc(source);
      ui._previewState.pageCount = ui._previewState.pdf.numPages;
      if (ui._previewState.page > ui._previewState.pageCount) ui._previewState.page = 1;
      await renderPdfPage(ui, ui._previewState.pdf, ui._previewState.page);
      if (ui.nav) ui.nav.hidden = ui._previewState.pageCount <= 1;
      updatePageInfo(ui);
    } else if (isImage(source)) {
      if (ui.nav) ui.nav.hidden = true;
      await renderImage(ui, source);
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

async function renderPdfPage(ui, pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
  const canvas = ui.canvas;
  const ctx = canvas.getContext("2d");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.hidden = false;
  if (ui.image) ui.image.hidden = true;
  await page.render({ canvasContext: ctx, viewport }).promise;
}

async function renderImage(ui, source) {
  const blob = new Blob([source.content], { type: source.mime });
  const url = URL.createObjectURL(blob);
  try {
    if (ui.image) {
      ui.image.src = url;
      ui.image.hidden = false;
    }
    if (ui.canvas) ui.canvas.hidden = true;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export async function changePreviewPage(ui, delta) {
  if (!ui?._previewState?.pdf) return;
  const next = ui._previewState.page + delta;
  if (next < 1 || next > ui._previewState.pageCount) return;
  ui._previewState.page = next;
  await renderPdfPage(ui, ui._previewState.pdf, next);
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
