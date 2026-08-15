import {
  applyFieldValueBulk,
  applySupplierFieldValueBulk,
  BULK_EDIT_FIELDS,
  countLinesWithFieldValue,
  countSupplierFieldTargets,
  findDuplicateLineIndexes,
} from "./extract-client.js?v=dedupe2";
import { collectExportReview, exportDedTvaExcel } from "./export-client.js";
import {
  applyConfidenceToInput,
  countConfidenceIssues,
  refreshLinesFieldConfidence,
} from "./field-confidence.js";
import {
  createDebouncedSaver,
  loadDossierWorkspace,
  logDossierActivity,
  markDossierExported,
  saveDossierWorkspace,
} from "./dossier-persistence.js?v=persist1";
import { periodToMmaaaa } from "./dossiers-client.js?v=dash2";
import { escapeHtml } from "./dashboard-ui.js?v=portfolio1";

const DESIGNATIONS = [
  "MATIERES CONSOMMABLES",
  "PRESTATIONS",
  "TELEPHONIE",
  "FRAIS BANCAIRE",
];

export function createWorkspaceReview({ mountEl, getContext, onStateChange }) {
  let lines = [];
  let saver = null;
  let anomaliesOnly = false;
  let pendingFieldBulk = null;

  const els = {
    mount: mountEl,
    status: mountEl.querySelector("#reviewStatus"),
    lineCount: mountEl.querySelector("#reviewLineCount"),
    anomalyBadge: mountEl.querySelector("#reviewAnomalyBadge"),
    duplicateBadge: mountEl.querySelector("#reviewDuplicateBadge"),
    removeDuplicatesBtn: mountEl.querySelector("#reviewRemoveDuplicatesBtn"),
    anomaliesToggle: mountEl.querySelector("#reviewAnomaliesToggle"),
    tableBody: mountEl.querySelector("#reviewTableBody"),
    emptyState: mountEl.querySelector("#reviewEmptyState"),
    tableWrap: mountEl.querySelector("#reviewTableWrap"),
    exportBtn: mountEl.querySelector("#reviewExportBtn"),
    exportDialog: document.getElementById("reviewExportDialog"),
    exportIntro: document.getElementById("reviewExportIntro"),
    exportList: document.getElementById("reviewExportList"),
    exportConfirm: document.getElementById("reviewExportConfirm"),
    fieldBulkDialog: document.getElementById("reviewFieldBulkDialog"),
    fieldBulkTitle: document.getElementById("reviewFieldBulkTitle"),
    fieldBulkIntro: document.getElementById("reviewFieldBulkIntro"),
    fieldBulkApplyAll: document.getElementById("reviewFieldBulkApplyAll"),
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
      onStateChange?.();
    } catch (error) {
      setStatus(`Erreur : ${error.message}`, "error");
      throw error;
    }
  }

  function lineNeedsReview(line, isDuplicate) {
    if (isDuplicate) return true;
    const conf = line.field_confidence || {};
    return Object.values(conf).some((level) => level === "error" || level === "warn");
  }

  function maybeOfferFieldBulk(fieldKey, oldValue, newValue, lineIndex) {
    const line = lines[lineIndex];
    if (!line || oldValue === newValue) return;
    const targets = fieldKey === "lib_frss"
      ? countSupplierFieldTargets(lines, fieldKey, line.lib_frss, oldValue, lineIndex)
      : countLinesWithFieldValue(lines, fieldKey, oldValue, lineIndex);
    if (targets <= 0) return;

    pendingFieldBulk = { fieldKey, oldValue, newValue, supplierName: line.lib_frss, scope: fieldKey === "lib_frss" ? "supplier" : "field" };
    const label = BULK_EDIT_FIELDS[fieldKey] || fieldKey;
    els.fieldBulkTitle.textContent = `${label} modifié`;
    els.fieldBulkIntro.textContent = `Appliquer « ${newValue || "—"} » aux ${targets} autre(s) ligne(s) ?`;
    els.fieldBulkDialog?.showModal();
  }

  function applyPendingFieldBulk() {
    if (!pendingFieldBulk) return 0;
    const { fieldKey, oldValue, newValue, supplierName, scope } = pendingFieldBulk;
    const count = scope === "supplier"
      ? applySupplierFieldValueBulk(lines, fieldKey, supplierName, oldValue, newValue)
      : applyFieldValueBulk(lines, fieldKey, oldValue, newValue);
    pendingFieldBulk = null;
    return count;
  }

  function deleteLineAt(index) {
    if (index < 0 || index >= lines.length) return;
    lines.splice(index, 1);
    render();
    scheduleSave("delete_line", "Ligne supprimée");
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
    const { errors, warns } = countConfidenceIssues(lines);
    const anomalyCount = errors + warns;

    if (els.lineCount) els.lineCount.textContent = `${lines.length} ligne(s)`;
    if (els.anomalyBadge) {
      els.anomalyBadge.hidden = anomalyCount === 0;
      els.anomalyBadge.textContent = errors > 0
        ? `${errors} critique(s), ${warns} à relire`
        : `${warns} à relire`;
      els.anomalyBadge.className = errors > 0 ? "ws-review-badge danger" : "ws-review-badge warn";
    }
    if (els.duplicateBadge) {
      els.duplicateBadge.hidden = duplicates.length === 0;
      els.duplicateBadge.textContent = `${duplicates.length} doublon(s)`;
    }
    if (els.removeDuplicatesBtn) els.removeDuplicatesBtn.hidden = duplicates.length === 0;
    if (els.exportBtn) els.exportBtn.disabled = lines.length === 0;
    if (els.emptyState) els.emptyState.hidden = lines.length > 0;
    if (els.tableWrap) els.tableWrap.hidden = lines.length === 0;
  }

  function renderTable() {
    if (!els.tableBody) return;
    refreshConfidence();
    els.tableBody.innerHTML = "";
    const duplicates = new Set(findDuplicateLineIndexes(lines));

    lines.forEach((line, index) => {
      if (anomaliesOnly && !lineNeedsReview(line, duplicates.has(index))) return;

      const tr = document.createElement("tr");
      if (duplicates.has(index)) tr.classList.add("ws-review-dup");

      const fields = [
        { key: "source_file", type: "text", readonly: true },
        { key: "fact_num", type: "text" },
        { key: "lib_frss", type: "text" },
        { key: "ice_frs", type: "text" },
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
            } else if (field.key === "lib_frss") {
              oldValue = String(input.dataset.prevValue ?? "").trim();
              newValue = String(input.value ?? "").trim();
              line.lib_frss = newValue;
            } else {
              line[field.key] = input.value;
            }
            markFieldVerified(line, field.key);
            if (["m_ht", "taux"].includes(field.key)) recalcTva(line);
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
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "dash-btn dash-btn-sm ws-review-delete";
      deleteBtn.textContent = duplicates.has(index) ? "Doublon" : "Suppr.";
      deleteBtn.addEventListener("click", () => deleteLineAt(index));
      actionTd.appendChild(deleteBtn);
      tr.appendChild(actionTd);
      els.tableBody.appendChild(tr);
    });
  }

  function render() {
    renderTable();
    updateBadges();
  }

  async function load() {
    const { dossierId } = ctx();
    if (!dossierId) {
      lines = [];
      render();
      return;
    }
    setStatus("Chargement…");
    try {
      const data = await loadDossierWorkspace(dossierId);
      lines = [...(data?.lines || [])];
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
      markDossierExported(dossierId).catch(() => {});
      logDossierActivity(dossierId, "export", `Export Excel ${filename}`, {
        line_count: lines.length,
      }).catch(() => {});
    }
    setStatus(`Export ${filename} téléchargé`, "success");
    onStateChange?.();
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
  els.exportConfirm?.addEventListener("click", (event) => {
    event.preventDefault();
    els.exportDialog?.close();
    downloadExcel();
  });
  els.anomaliesToggle?.addEventListener("click", () => setAnomaliesOnly(!anomaliesOnly));
  els.fieldBulkApplyAll?.addEventListener("click", () => {
    applyPendingFieldBulk();
    render();
    scheduleSave("bulk_edit", "Correction appliquée en masse");
    els.fieldBulkDialog?.close();
  });
  els.fieldBulkDialog?.addEventListener("close", () => {
    pendingFieldBulk = null;
  });

  saver = createDebouncedSaver(async ({ eventType, summary }) => {
    await persistNow(eventType, summary, { line_count: lines.length });
  }, 1500);

  return {
    load,
    render,
    setAnomaliesOnly,
    getLineCount: () => lines.length,
  };
}
