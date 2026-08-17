import {
  applyFieldValueBulk,
  applySupplierFieldValueBulk,
  BULK_EDIT_FIELDS,
  countLinesWithFieldValue,
  countSupplierFieldTargets,
  fieldValuesMatch,
  findDuplicateLineIndexes,
} from "./extract-client.js?v=ifdot1";
import { collectExportReview, exportDedTvaExcel } from "./export-client.js";
import {
  applyConfidenceToInput,
  countConfidenceIssues,
  isLineReviewVerified,
  lineHasActionableAnomaly,
  lineIssueSummary,
  lineNeedsReview,
  refreshLinesFieldConfidence,
  unverifyReviewLine,
  verifyReviewLine,
} from "./field-confidence.js";
import {
  createDebouncedSaver,
  loadDossierWorkspace,
  logDossierActivity,
  markDossierExported,
  saveDossierWorkspace,
} from "./dossier-persistence.js?v=persist1";
import {
  findDocumentForLine,
  fetchDossierDocumentBytes,
  listDossierDocuments,
} from "./dossier-documents.js?v=doc15";
import {
  bindPreviewControls,
  clearSourceFiles,
  hasSourceFile,
  registerSourceFile,
  showLinePreview,
} from "./document-preview.js?v=preview9";
import { periodToMmaaaa } from "./dossiers-client.js?v=dash2";
import { escapeHtml } from "./dashboard-ui.js?v=portfolio1";

const DESIGNATIONS = [
  "MATIERES CONSOMMABLES",
  "PRESTATIONS",
  "TELEPHONIE",
  "FRAIS BANCAIRE",
];

const SUPPLIER_SCOPED_BULK_FIELDS = new Set(["ice_frs", "if"]);

export function createWorkspaceReview({
  mountEl,
  getContext,
  onStateChange,
  onWorkspaceSaved,
  onPeriodDeclared,
}) {
  const notifyWorkspaceSaved = onWorkspaceSaved || onStateChange;
  let lines = [];
  let saver = null;
  let anomaliesOnly = false;
  let pendingFieldBulk = null;
  let previewOpen = false;
  let selectedLineIndex = null;
  let documentsCache = [];
  const documentFetchInFlight = new Map();

  const els = {
    mount: mountEl,
    status: mountEl.querySelector("#reviewStatus"),
    lineCount: mountEl.querySelector("#reviewLineCount"),
    anomalyBadge: mountEl.querySelector("#reviewAnomalyBadge"),
    duplicateBadge: mountEl.querySelector("#reviewDuplicateBadge"),
    removeDuplicatesBtn: mountEl.querySelector("#reviewRemoveDuplicatesBtn"),
    anomaliesToggle: mountEl.querySelector("#reviewAnomaliesToggle"),
    tableBody: mountEl.querySelector("#reviewTableBody"),
    validateAllBtn: mountEl.querySelector("#reviewValidateAllBtn"),
    emptyState: mountEl.querySelector("#reviewEmptyState"),
    reviewLayout: mountEl.querySelector("#reviewLayout"),
    tableWrap: mountEl.querySelector("#reviewTableWrap"),
    exportBtn: mountEl.querySelector("#reviewExportBtn"),
    declaredBadge: mountEl.querySelector("#reviewDeclaredBadge"),
    exportDialog: document.getElementById("reviewExportDialog"),
    exportIntro: document.getElementById("reviewExportIntro"),
    exportList: document.getElementById("reviewExportList"),
    exportConfirm: document.getElementById("reviewExportConfirm"),
    declareDialog: document.getElementById("reviewDeclareDialog"),
    declareIntro: document.getElementById("reviewDeclareIntro"),
    declareWarnings: document.getElementById("reviewDeclareWarnings"),
    declareConfirm: document.getElementById("reviewDeclareConfirm"),
    fieldBulkDialog: document.getElementById("reviewFieldBulkDialog"),
    fieldBulkTitle: document.getElementById("reviewFieldBulkTitle"),
    fieldBulkIntro: document.getElementById("reviewFieldBulkIntro"),
    fieldBulkApplyAll: document.getElementById("reviewFieldBulkApplyAll"),
    detailOverlay: document.getElementById("reviewDetailOverlay"),
    detailBack: document.getElementById("reviewDetailBack"),
    detailHeading: document.getElementById("reviewDetailHeading"),
    detailSubheading: document.getElementById("reviewDetailSubheading"),
    detailCounter: document.getElementById("reviewDetailCounter"),
    detailPrev: document.getElementById("reviewDetailPrev"),
    detailNext: document.getElementById("reviewDetailNext"),
    detailFormMount: document.getElementById("reviewDetailFormMount"),
    detailIssues: document.getElementById("reviewDetailIssues"),
    detailValidate: document.getElementById("reviewDetailValidate"),
    detailDelete: document.getElementById("reviewDetailDelete"),
    previewNav: document.getElementById("previewNav"),
    previewPrevPage: document.getElementById("previewPrevPage"),
    previewNextPage: document.getElementById("previewNextPage"),
    previewPageInfo: document.getElementById("previewPageInfo"),
    previewZoom: document.getElementById("previewZoom"),
    previewZoomIn: document.getElementById("previewZoomIn"),
    previewZoomOut: document.getElementById("previewZoomOut"),
    previewZoomReset: document.getElementById("previewZoomReset"),
    previewZoomLabel: document.getElementById("previewZoomLabel"),
    previewMissing: document.getElementById("previewMissing"),
    previewCanvasWrap: document.getElementById("previewCanvasWrap"),
    previewCanvas: document.getElementById("previewCanvas"),
    previewImage: document.getElementById("previewImage"),
  };

  const previewUi = {
    panel: els.detailOverlay,
    title: els.detailHeading,
    subtitle: els.detailSubheading,
    nav: els.previewNav,
    prevBtn: els.previewPrevPage,
    nextBtn: els.previewNextPage,
    pageInfo: els.previewPageInfo,
    zoom: els.previewZoom,
    zoomInBtn: els.previewZoomIn,
    zoomOutBtn: els.previewZoomOut,
    zoomResetBtn: els.previewZoomReset,
    zoomLabel: els.previewZoomLabel,
    missing: els.previewMissing,
    canvasWrap: els.previewCanvasWrap,
    canvas: els.previewCanvas,
    image: els.previewImage,
    missingMessage: "Document introuvable dans le dossier. Vérifiez l'onglet Documents ou réimportez la facture.",
  };

  function ctx() {
    return getContext() || {};
  }

  function setStatus(text, tone = "muted") {
    if (!els.status) return;
    els.status.textContent = text || "";
    els.status.dataset.tone = tone;
  }

  function refreshConfidence() {
    refreshLinesFieldConfidence(lines, {
      clientIce: ctx().clientIce || "",
      duplicateIndexes: findDuplicateLineIndexes(lines),
    });
  }

  function markFieldVerified(line, fieldKey) {
    unverifyReviewLine(line);
    if (!line.user_verified_fields) line.user_verified_fields = [];
    if (!line.user_verified_fields.includes(fieldKey)) {
      line.user_verified_fields.push(fieldKey);
    }
    if (fieldKey === "ice_frs") line.ice_inferred = false;
    if (fieldKey === "if") line.if_inferred = false;
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

  function getVisibleLineIndices() {
    refreshConfidence();
    const duplicates = new Set(findDuplicateLineIndexes(lines));
    return lines.reduce((indices, line, index) => {
      if (!anomaliesOnly || lineHasActionableAnomaly(line, { isDuplicate: duplicates.has(index) })) {
        indices.push(index);
      }
      return indices;
    }, []);
  }

  function syncDetailVisibility() {
    const open = lines.length > 0 && previewOpen;
    if (els.detailOverlay) els.detailOverlay.hidden = !open;
    document.body.classList.toggle("ws-review-detail-open", open);
  }

  function closeLinePreview({ clearSelection = false } = {}) {
    previewOpen = false;
    if (clearSelection) selectedLineIndex = null;
    showLinePreview(previewUi, null);
    syncDetailVisibility();
    if (lines.length > 0) renderTable();
  }

  function navigateDetail(delta) {
    const visible = getVisibleLineIndices();
    const pos = visible.indexOf(selectedLineIndex);
    if (pos < 0) return;
    const nextPos = pos + delta;
    if (nextPos < 0 || nextPos >= visible.length) return;
    openLinePreview(visible[nextPos]);
  }

  function applyLineFieldChange(line, index, field, input) {
    let oldValue = "";
    let newValue = "";
    if (field.type === "number") {
      line[field.key] = Number(input.value) || 0;
    } else if (field.key === "taux") {
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
    if (["m_ht", "taux"].includes(field.key)) recalcTva(line);
    return { oldValue, newValue };
  }

  function createDetailField(line, index, field) {
    const wrap = document.createElement("label");
    wrap.className = "ws-review-detail-field";

    const label = document.createElement("span");
    label.className = "ws-review-detail-label";
    label.textContent = field.label;
    wrap.appendChild(label);

    let input;
    if (field.type === "select") {
      input = document.createElement("select");
      const options = [...(field.options || [])];
      const current = String(line[field.key] ?? "");
      if (current && !options.includes(current)) options.unshift(current);
      options.forEach((opt) => {
        const option = document.createElement("option");
        option.value = opt;
        option.textContent = field.key === "taux" ? `${Number(opt) * 100}%` : opt;
        input.appendChild(option);
      });
      input.value = current;
    } else {
      input = document.createElement("input");
      input.type = field.type;
      if (field.step) input.step = field.step;
      if (field.readonly) input.readOnly = true;
      const display = field.key === "source_file"
        ? shortFilename(line[field.key])
        : (line[field.key] ?? "");
      input.value = display;
      if (field.key === "source_file" && line[field.key]) input.title = line[field.key];
    }

    input.className = "ws-review-detail-input";
    if (field.key !== "source_file") applyConfidenceToInput(input, field.key, line);

    if (!field.readonly) {
      if (field.key in BULK_EDIT_FIELDS) {
        input.addEventListener("focus", () => {
          input.dataset.prevValue = line[field.key] ?? "";
        });
      }
      input.addEventListener("change", () => {
        const { oldValue, newValue } = applyLineFieldChange(line, index, field, input);
        renderDetailForm(index);
        if (previewOpen && selectedLineIndex === index) {
          showLinePreview(previewUi, line, index);
        }
        updateBadges();
        scheduleSave();
        if (field.key in BULK_EDIT_FIELDS) {
          maybeOfferFieldBulk(field.key, oldValue, newValue, index);
        }
      });
    }

    wrap.appendChild(input);
    return wrap;
  }

  function renderDetailIssues(line, index) {
    if (!els.detailIssues) return;
    const duplicates = new Set(findDuplicateLineIndexes(lines));
    const issues = lineIssueSummary(line, { isDuplicate: duplicates.has(index) });
    if (!issues.length) {
      els.detailIssues.hidden = true;
      els.detailIssues.innerHTML = "";
      return;
    }
    els.detailIssues.hidden = false;
    els.detailIssues.innerHTML = issues
      .map((issue) => `<span class="ws-review-issue ${issue.level}" title="${escapeHtml(issue.reason)}">${escapeHtml(issue.label)}</span>`)
      .join("");
  }

  function updateDetailNav() {
    const visible = getVisibleLineIndices();
    const pos = visible.indexOf(selectedLineIndex);
    if (els.detailCounter) {
      els.detailCounter.textContent = visible.length && pos >= 0 ? `${pos + 1} / ${visible.length}` : "";
    }
    if (els.detailPrev) els.detailPrev.disabled = pos <= 0;
    if (els.detailNext) els.detailNext.disabled = pos < 0 || pos >= visible.length - 1;
  }

  function renderDetailForm(index) {
    if (!els.detailFormMount || index == null || index < 0 || index >= lines.length) return;
    const line = lines[index];
    if (!line) return;

    renderDetailIssues(line, index);

    const duplicates = new Set(findDuplicateLineIndexes(lines));
    const isDuplicate = duplicates.has(index);
    const verified = isLineReviewVerified(line);

    if (els.detailValidate) {
      els.detailValidate.hidden = false;
      els.detailValidate.textContent = verified ? "Ligne validée" : "Valider la ligne";
      els.detailValidate.classList.toggle("is-verified", verified);
    }
    if (els.detailDelete) {
      els.detailDelete.textContent = isDuplicate ? "Supprimer le doublon" : "Supprimer la ligne";
    }

    const sections = [
      {
        title: "Fournisseur",
        fields: [
          { key: "lib_frss", label: "Nom", type: "text" },
          { key: "ice_frs", label: "Identifiant légal (ICE)", type: "text" },
          { key: "if", label: "Identifiant fiscal (IF)", type: "text" },
        ],
      },
      {
        title: "Informations facture",
        fields: [
          { key: "fact_num", label: "N° facture", type: "text" },
          { key: "date_fac", label: "Date facture", type: "date" },
          { key: "date_paie", label: "Date échéance / paiement", type: "date" },
          { key: "designation", label: "Désignation", type: "select", options: DESIGNATIONS },
          { key: "taux", label: "Taux TVA", type: "select", options: ["0", "0.1", "0.2"] },
          { key: "source_file", label: "Fichier source", type: "text", readonly: true },
        ],
      },
      {
        title: "Montants totaux",
        fields: [
          { key: "m_ht", label: "Total HT", type: "number", step: "0.01" },
          { key: "tva", label: "Total TVA", type: "number", step: "0.01", readonly: true },
          { key: "m_ttc", label: "Net à payer (TTC)", type: "number", step: "0.01", readonly: true },
        ],
      },
    ];

    els.detailFormMount.innerHTML = "";
    sections.forEach((section) => {
      const card = document.createElement("section");
      card.className = "ws-review-detail-card";
      const heading = document.createElement("h3");
      heading.textContent = section.title;
      card.appendChild(heading);
      const grid = document.createElement("div");
      grid.className = "ws-review-detail-grid";
      section.fields.forEach((field) => grid.appendChild(createDetailField(line, index, field)));
      card.appendChild(grid);
      els.detailFormMount.appendChild(card);
    });

    updateDetailNav();
  }

  async function ensureLineDocumentCached(line) {
    if (hasSourceFile(line)) return true;

    const { dossierId } = ctx();
    if (!dossierId || !line) return false;

    if (!documentsCache.length) {
      documentsCache = await listDossierDocuments(dossierId);
    }

    const doc = findDocumentForLine(line, documentsCache);
    if (!doc) return false;

    const cacheKey = line.source_id || doc.source_id || String(doc.id);
    if (documentFetchInFlight.has(cacheKey)) {
      await documentFetchInFlight.get(cacheKey);
      return hasSourceFile(line);
    }

    const promise = (async () => {
      const { content, mime, filename } = await fetchDossierDocumentBytes(doc);
      const id = line.source_id || doc.source_id;
      if (!id) return;
      registerSourceFile({ id, filename, content, mime });
    })();

    documentFetchInFlight.set(cacheKey, promise);
    try {
      await promise;
    } finally {
      documentFetchInFlight.delete(cacheKey);
    }
    return hasSourceFile(line);
  }

  async function openLinePreview(index) {
    if (index == null || index < 0 || index >= lines.length) {
      closeLinePreview({ clearSelection: true });
      return;
    }

    previewOpen = true;
    selectedLineIndex = index;
    syncDetailVisibility();
    renderTable();
    renderDetailForm(index);

    const line = lines[index];
    if (els.previewMissing) {
      els.previewMissing.hidden = false;
      els.previewMissing.textContent = "Chargement du document…";
    }
    if (els.previewCanvasWrap) els.previewCanvasWrap.hidden = true;

    try {
      await ensureLineDocumentCached(line);
    } catch (error) {
      if (els.previewMissing) {
        els.previewMissing.hidden = false;
        els.previewMissing.textContent = `Impossible de charger le document : ${error.message}`;
      }
      return;
    }

    await showLinePreview(previewUi, line, index);
  }

  function refreshOpenPreview() {
    if (!previewOpen || selectedLineIndex == null) return;
    if (selectedLineIndex < 0 || selectedLineIndex >= lines.length) {
      closeLinePreview({ clearSelection: true });
      return;
    }
    if (anomaliesOnly) {
      const visible = getVisibleLineIndices();
      if (!visible.includes(selectedLineIndex)) {
        if (visible.length) {
          const nextIndex = visible[Math.min(selectedLineIndex, visible.length - 1)];
          selectedLineIndex = nextIndex;
        } else {
          closeLinePreview({ clearSelection: true });
          return;
        }
      }
    }
    renderDetailForm(selectedLineIndex);
    showLinePreview(previewUi, lines[selectedLineIndex], selectedLineIndex);
  }

  function scheduleSave(eventType = "save", summary = "Modifications enregistrées") {
    setStatus("Enregistrement en attente…");
    saver?.schedule({ eventType, summary });
  }

  async function persistNow(eventType, summary, meta = {}) {
    const { dossierId } = ctx();
    if (!dossierId) return;
    setStatus("Enregistrement…");
    try {
      const workspace = await loadDossierWorkspace(dossierId);
      await saveDossierWorkspace(dossierId, {
        lines,
        bankTransactions: workspace?.bank_transactions || [],
        bankMeta: workspace?.bank_meta || {},
      });
      if (eventType) await logDossierActivity(dossierId, eventType, summary, meta);
      setStatus("Enregistré", "success");
      notifyWorkspaceSaved?.();
    } catch (error) {
      setStatus(`Erreur : ${error.message}`, "error");
      throw error;
    }
  }

  function openFieldBulkDialog(fieldKey, oldValue, newValue, otherCount, { supplierName = "", scope = "value" } = {}) {
    const label = BULK_EDIT_FIELDS[fieldKey] || fieldKey;
    pendingFieldBulk = { fieldKey, oldValue, newValue, supplierName, scope };
    if (els.fieldBulkTitle) els.fieldBulkTitle.textContent = `${label} modifié`;
    if (els.fieldBulkIntro) {
      els.fieldBulkIntro.textContent = scope === "supplier" && supplierName
        ? `Appliquer l'${label} « ${newValue} » aux ${otherCount} autre(s) facture(s) de « ${supplierName} » sans ${label} ?`
        : `Remplacer « ${oldValue || "—"} » par « ${newValue || "—"} » pour le champ ${label} sur ${otherCount} autre(s) ligne(s) ?`;
    }
    els.fieldBulkDialog?.showModal();
  }

  function maybeOfferFieldBulk(fieldKey, oldValue, newValue, lineIndex) {
    if (!newValue || fieldValuesMatch(fieldKey, oldValue, newValue)) return;

    const line = lines[lineIndex];
    const supplierName = String(line?.lib_frss || "").trim();
    const emptyOldValue = !String(oldValue || "").trim();

    if (emptyOldValue && SUPPLIER_SCOPED_BULK_FIELDS.has(fieldKey) && supplierName) {
      const others = countSupplierFieldTargets(lines, fieldKey, supplierName, oldValue, lineIndex);
      if (others > 0) {
        openFieldBulkDialog(fieldKey, oldValue, newValue, others, {
          supplierName,
          scope: "supplier",
        });
      }
      return;
    }

    if (emptyOldValue) return;

    const others = countLinesWithFieldValue(lines, fieldKey, oldValue, lineIndex);
    if (others > 0) openFieldBulkDialog(fieldKey, oldValue, newValue, others);
  }

  function applyPendingFieldBulk() {
    if (!pendingFieldBulk) return 0;
    const { fieldKey, oldValue, newValue, supplierName, scope } = pendingFieldBulk;
    const updated = scope === "supplier"
      ? applySupplierFieldValueBulk(lines, fieldKey, supplierName, oldValue, newValue)
      : applyFieldValueBulk(lines, fieldKey, oldValue, newValue);
    pendingFieldBulk = null;
    return updated.length;
  }

  function deleteLineAt(index) {
    if (index < 0 || index >= lines.length) return;
    lines.splice(index, 1);

    if (selectedLineIndex === index) {
      selectedLineIndex = lines.length ? Math.min(index, lines.length - 1) : null;
      if (previewOpen) {
        if (selectedLineIndex != null) {
          openLinePreview(selectedLineIndex);
        } else {
          closeLinePreview({ clearSelection: true });
        }
      }
    } else if (selectedLineIndex != null && selectedLineIndex > index) {
      selectedLineIndex -= 1;
    }

    render();
    scheduleSave("delete_line", "Ligne supprimée");
  }

  function toggleLineValidation(index) {
    const line = lines[index];
    if (!line) return;
    const duplicates = new Set(findDuplicateLineIndexes(lines));
    const isDuplicate = duplicates.has(index);
    if (isLineReviewVerified(line)) {
      unverifyReviewLine(line);
      setStatus("Validation de la ligne annulée", "muted");
    } else {
      verifyReviewLine(line, { isDuplicate });
      setStatus("Ligne validée — elle n'apparaît plus dans les anomalies", "success");
    }
    render();
    scheduleSave("verify_line", isLineReviewVerified(line) ? "Ligne validée" : "Validation annulée");
  }

  function countLinesToValidate() {
    return lines.reduce((count, line) => (
      isLineReviewVerified(line) ? count : count + 1
    ), 0);
  }

  function validateAllLines() {
    const duplicates = new Set(findDuplicateLineIndexes(lines));
    let count = 0;
    lines.forEach((line, index) => {
      if (isLineReviewVerified(line)) return;
      verifyReviewLine(line, { isDuplicate: duplicates.has(index) });
      count += 1;
    });
    if (!count) {
      setStatus("Aucune ligne à valider", "muted");
      return;
    }
    render();
    scheduleSave("verify_all", `${count} ligne(s) validée(s)`);
    setStatus(`${count} ligne(s) validée(s)`, "success");
  }

  function removeDuplicates() {
    const duplicates = new Set(findDuplicateLineIndexes(lines));
    if (!duplicates.size) return;
    if (!window.confirm(`Supprimer ${duplicates.size} doublon(s) ? La première occurrence est conservée.`)) return;
    lines = lines.filter((_line, index) => !duplicates.has(index));
    setStatus(`${duplicates.size} doublon(s) supprimé(s).`, "success");
    render();
    scheduleSave("dedupe", `${duplicates.size} doublon(s) supprimé(s)`);
  }

  function updateBadges() {
    refreshConfidence();
    const duplicates = findDuplicateLineIndexes(lines);
    const duplicateSet = new Set(duplicates);
    const actionableLines = lines.filter((line, index) =>
      lineHasActionableAnomaly(line, { isDuplicate: duplicateSet.has(index) }),
    ).length;
    const softReminderLines = lines.filter((line, index) =>
      lineNeedsReview(line, { isDuplicate: duplicateSet.has(index) })
      && !lineHasActionableAnomaly(line, { isDuplicate: duplicateSet.has(index) }),
    ).length;
    const { errors } = countConfidenceIssues(lines);

    if (els.lineCount) els.lineCount.textContent = `${lines.length} ligne(s)`;
    if (els.anomalyBadge) {
      if (actionableLines > 0) {
        els.anomalyBadge.hidden = false;
        els.anomalyBadge.textContent = actionableLines === 1
          ? "1 ligne à corriger"
          : `${actionableLines} lignes à corriger`;
        els.anomalyBadge.className = errors > 0 ? "ws-review-badge danger" : "ws-review-badge warn";
      } else if (softReminderLines > 0) {
        els.anomalyBadge.hidden = false;
        els.anomalyBadge.textContent = softReminderLines === 1
          ? "1 rappel (date paie / IF)"
          : `${softReminderLines} rappels (dates paie / IF)`;
        els.anomalyBadge.className = "ws-review-badge muted";
      } else {
        els.anomalyBadge.hidden = true;
      }
    }
    if (els.duplicateBadge) {
      els.duplicateBadge.hidden = duplicates.length === 0;
      els.duplicateBadge.textContent = `${duplicates.length} doublon(s)`;
    }
    if (els.removeDuplicatesBtn) els.removeDuplicatesBtn.hidden = duplicates.length === 0;
    if (els.exportBtn) els.exportBtn.disabled = lines.length === 0;
    if (els.validateAllBtn) {
      const pending = countLinesToValidate();
      els.validateAllBtn.disabled = pending === 0;
      els.validateAllBtn.title = pending
        ? `Valider les ${pending} ligne(s) en attente`
        : "Toutes les lignes sont déjà validées";
    }
    updateDeclareUi();
  }

  function updateDeclareUi() {
    const { periodStatus, periodLabel } = ctx();
    const isDeclared = periodStatus === "exported";
    if (els.declaredBadge) {
      els.declaredBadge.hidden = !isDeclared;
      if (isDeclared && periodLabel) {
        els.declaredBadge.textContent = `${periodLabel} — déclarée`;
      }
    }
  }

  function openDeclareDialog() {
    if (!lines.length) return;
    const { periodLabel } = ctx();
    refreshConfidence();
    const issues = collectExportReview(lines, {
      clientIce: ctx().clientIce || "",
      duplicateIndexes: findDuplicateLineIndexes(lines),
    });
    if (els.declareIntro) {
      els.declareIntro.textContent = periodLabel
        ? `Confirmez que la déclaration TVA de ${periodLabel} a bien été effectuée (télédéclaration ou dépôt validé).`
        : "Confirmez que la déclaration TVA de cette période a bien été effectuée.";
    }
    if (els.declareWarnings) {
      if (issues.length) {
        els.declareWarnings.hidden = false;
        els.declareWarnings.innerHTML = issues
          .map((issue) => `<li class="review-${issue.level}">${escapeHtml(issue.text)}</li>`)
          .join("");
      } else {
        els.declareWarnings.hidden = true;
        els.declareWarnings.innerHTML = "";
      }
    }
    els.declareDialog?.showModal();
  }

  async function confirmDeclarePeriod() {
    const { dossierId, periodLabel } = ctx();
    if (!dossierId) return;
    try {
      saver?.cancel?.();
      await markDossierExported(dossierId);
      await logDossierActivity(
        dossierId,
        "declare",
        periodLabel ? `Période ${periodLabel} marquée comme déclarée` : "Période marquée comme déclarée",
        { line_count: lines.length },
      );
      els.declareDialog?.close();
      setStatus(periodLabel ? `${periodLabel} — période déclarée` : "Période déclarée", "success");
      if (onPeriodDeclared) {
        await onPeriodDeclared();
      } else {
        notifyWorkspaceSaved?.();
      }
      updateDeclareUi();
    } catch (error) {
      setStatus(`Erreur : ${error.message}`, "error");
    }
  }

  function renderIssueCell(line, isDuplicate) {
    const td = document.createElement("td");
    td.className = "ws-review-issues-cell";
    const issues = lineIssueSummary(line, { isDuplicate });
    if (!issues.length) {
      td.textContent = "—";
      return td;
    }
    const wrap = document.createElement("div");
    wrap.className = "ws-review-issues";
    issues.forEach((issue) => {
      const chip = document.createElement("span");
      chip.className = `ws-review-issue ${issue.level}`;
      chip.textContent = issue.label;
      chip.title = issue.reason;
      wrap.appendChild(chip);
    });
    td.appendChild(wrap);
    return td;
  }

  function renderTable() {
    if (!els.tableBody) return;
    refreshConfidence();
    els.tableBody.innerHTML = "";
    const duplicates = new Set(findDuplicateLineIndexes(lines));
    let visibleRows = 0;

    lines.forEach((line, index) => {
      const isDuplicate = duplicates.has(index);
      const hasActionable = lineHasActionableAnomaly(line, { isDuplicate });
      if (anomaliesOnly && !hasActionable) return;
      visibleRows += 1;

      const tr = document.createElement("tr");
      if (isDuplicate) tr.classList.add("ws-review-dup");
      else if (hasActionable) tr.classList.add("ws-review-anomaly");
      if (lineIssueSummary(line, { isDuplicate }).some((item) => item.level === "error")) {
        tr.classList.add("ws-review-anomaly-error");
      }
      if (previewOpen && selectedLineIndex === index) {
        tr.classList.add("selected-row");
      }

      tr.addEventListener("click", (event) => {
        if (event.target.closest("button, input, select, a, label")) return;
        openLinePreview(index);
      });

      tr.appendChild(renderIssueCell(line, isDuplicate));

      const fields = [
        { key: "source_file", type: "text", readonly: true },
        { key: "fact_num", type: "text" },
        { key: "lib_frss", type: "text" },
        { key: "ice_frs", type: "text" },
        { key: "if", type: "text" },
        { key: "m_ht", type: "number", step: "0.01" },
        { key: "tva", type: "number", step: "0.01", readonly: true },
        { key: "m_ttc", type: "number", step: "0.01", readonly: true },
        { key: "taux", type: "select", options: ["0", "0.1", "0.2"] },
        { key: "date_fac", type: "date" },
        { key: "date_paie", type: "date" },
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
          const display = field.key === "source_file"
            ? shortFilename(line[field.key])
            : (line[field.key] ?? "");
          input.value = display;
          if (field.key === "source_file" && line[field.key]) input.title = line[field.key];
        }

        if (field.key !== "source_file") {
          applyConfidenceToInput(input, field.key, line);
        }

        if (!field.readonly) {
          if (field.key in BULK_EDIT_FIELDS) {
            input.addEventListener("focus", () => {
              input.dataset.prevValue = line[field.key] ?? "";
            });
          }
          input.addEventListener("change", () => {
            const { oldValue, newValue } = applyLineFieldChange(line, index, field, input);
            render();
            scheduleSave();
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
      viewBtn.textContent = "Ouvrir";
      viewBtn.title = "Ouvrir la facture en grand pour vérifier les champs";
      viewBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openLinePreview(index);
      });
      actionTd.appendChild(viewBtn);

      const validateBtn = document.createElement("button");
      validateBtn.type = "button";
      validateBtn.className = "dash-btn dash-btn-sm ws-review-validate";
      const verified = isLineReviewVerified(line);
      validateBtn.textContent = verified ? "Validée" : "Valider";
      validateBtn.title = verified
        ? "Ligne validée — recliquez pour annuler"
        : "Confirmer que cette ligne est correcte";
      validateBtn.classList.toggle("is-verified", verified);
      validateBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleLineValidation(index);
      });
      actionTd.appendChild(validateBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "dash-btn dash-btn-sm ws-review-delete";
      deleteBtn.textContent = duplicates.has(index) ? "Doublon" : "Suppr.";
      deleteBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteLineAt(index);
      });
      actionTd.appendChild(deleteBtn);
      tr.appendChild(actionTd);
      els.tableBody.appendChild(tr);
    });

    if (els.emptyState) {
      const showEmpty = lines.length === 0;
      els.emptyState.hidden = !showEmpty;
      if (showEmpty) {
        els.emptyState.querySelector("h3").textContent = "Aucune ligne extraite";
        els.emptyState.querySelector("p").textContent =
          "Ajoutez des factures ci-dessus, puis lancez l'extraction depuis l'onglet Période active.";
      } else if (anomaliesOnly && visibleRows === 0) {
        els.emptyState.hidden = false;
        els.emptyState.querySelector("h3").textContent = "Aucune anomalie bloquante";
        els.emptyState.querySelector("p").textContent =
          "Les champs en orange clair (date de paiement, IF) se complètent via le rapprochement bancaire ou à la demande.";
      }
    }
    if (els.reviewLayout) els.reviewLayout.hidden = lines.length === 0;
    if (els.tableWrap) els.tableWrap.hidden = lines.length === 0 || (anomaliesOnly && visibleRows === 0);
    if (lines.length === 0) {
      if (previewOpen || selectedLineIndex != null) {
        previewOpen = false;
        selectedLineIndex = null;
        showLinePreview(previewUi, null);
        syncDetailVisibility();
      }
    } else {
      refreshOpenPreview();
    }
  }

  function render() {
    renderTable();
    updateBadges();
  }

  async function load() {
    const { dossierId } = ctx();
    if (!dossierId) {
      lines = [];
      documentsCache = [];
      clearSourceFiles();
      closeLinePreview({ clearSelection: true });
      render();
      return;
    }
    setStatus("Chargement…");
    try {
      const data = await loadDossierWorkspace(dossierId);
      lines = [...(data?.lines || [])];
      documentsCache = [];
      clearSourceFiles();
      closeLinePreview({ clearSelection: true });
      render();
      setStatus(lines.length ? `${lines.length} ligne(s) chargée(s)` : "Aucune ligne — lancez l'extraction", "muted");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  function downloadExcel() {
    const { clientName, periodYear, periodMonth, dossierId } = ctx();
    const period = periodToMmaaaa(periodYear, periodMonth);
    const filename = exportDedTvaExcel({
      clientName: clientName || "CLIENT",
      period,
      lines,
    });
    if (dossierId) {
      logDossierActivity(dossierId, "export", `Export Excel ${filename}`, {
        line_count: lines.length,
      }).catch(() => {});
    }
    setStatus(`Export ${filename} téléchargé — la période n'est pas clôturée tant que vous n'avez pas confirmé la déclaration`, "success");
  }

  function exportExcel() {
    if (!lines.length) return;
    refreshConfidence();
    const issues = collectExportReview(lines, {
      clientIce: ctx().clientIce || "",
      duplicateIndexes: findDuplicateLineIndexes(lines),
    });
    if (!issues.length) {
      downloadExcel();
      return;
    }
    const errors = issues.filter((i) => i.level === "error").length;
    const warns = issues.filter((i) => i.level === "warn").length;
    els.exportIntro.textContent = errors
      ? `${errors} point(s) critique(s) et ${warns} à relire.`
      : `${warns} champ(s) à relire.`;
    els.exportList.innerHTML = issues
      .map((issue) => `<li class="review-${issue.level}">${escapeHtml(issue.text)}</li>`)
      .join("");
    els.exportDialog?.showModal();
  }

  function setAnomaliesOnly(value) {
    anomaliesOnly = Boolean(value);
    if (els.anomaliesToggle) els.anomaliesToggle.classList.toggle("active", anomaliesOnly);
    renderTable();
  }

  els.removeDuplicatesBtn?.addEventListener("click", removeDuplicates);
  els.exportBtn?.addEventListener("click", exportExcel);
  els.declareConfirm?.addEventListener("click", (event) => {
    event.preventDefault();
    confirmDeclarePeriod();
  });
  els.exportConfirm?.addEventListener("click", (event) => {
    event.preventDefault();
    els.exportDialog?.close();
    downloadExcel();
  });
  els.anomaliesToggle?.addEventListener("click", () => setAnomaliesOnly(!anomaliesOnly));
  els.validateAllBtn?.addEventListener("click", () => validateAllLines());
  els.fieldBulkApplyAll?.addEventListener("click", () => {
    const count = applyPendingFieldBulk();
    render();
    scheduleSave("bulk_edit", count > 1 ? `Correction appliquée sur ${count} lignes` : "Correction appliquée");
    els.fieldBulkDialog?.close();
  });
  els.fieldBulkDialog?.addEventListener("close", () => {
    pendingFieldBulk = null;
  });

  bindPreviewControls(previewUi);
  els.detailBack?.addEventListener("click", () => closeLinePreview());
  els.detailPrev?.addEventListener("click", () => navigateDetail(-1));
  els.detailNext?.addEventListener("click", () => navigateDetail(1));
  els.detailValidate?.addEventListener("click", () => {
    if (selectedLineIndex != null) toggleLineValidation(selectedLineIndex);
  });
  els.detailDelete?.addEventListener("click", () => {
    if (selectedLineIndex != null) deleteLineAt(selectedLineIndex);
  });
  document.addEventListener("keydown", (event) => {
    if (!previewOpen || els.detailOverlay?.hidden) return;
    if (event.target.closest("input, textarea, select")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeLinePreview();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      navigateDetail(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      navigateDetail(1);
    }
  });

  saver = createDebouncedSaver(async ({ eventType, summary }) => {
    await persistNow(eventType, summary, { line_count: lines.length });
  }, 1500);

  return {
    load,
    render,
    setAnomaliesOnly,
    getLineCount: () => lines.length,
    openLineAt: (index) => openLinePreview(index),
    openDeclareDialog,
  };
}
