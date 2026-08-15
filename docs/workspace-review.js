import {
  applyFieldValueBulk,
  applySupplierFieldValueBulk,
  BULK_EDIT_FIELDS,
  countLinesWithFieldValue,
  countSupplierFieldTargets,
  fieldValuesMatch,
  findDuplicateLineIndexes,
} from "./extract-client.js?v=dedupe2";
import { collectExportReview, exportDedTvaExcel } from "./export-client.js";
import {
  applyConfidenceToInput,
  countConfidenceIssues,
  lineHasActionableAnomaly,
  lineIssueSummary,
  lineNeedsReview,
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

const SUPPLIER_SCOPED_BULK_FIELDS = new Set(["ice_frs", "if"]);

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

    if (els.emptyState) {
      const showEmpty = lines.length === 0;
      els.emptyState.hidden = !showEmpty;
      if (showEmpty) {
        els.emptyState.querySelector("h3").textContent = "Aucune ligne extraite";
        els.emptyState.querySelector("p").textContent =
          "Importez des factures puis lancez l'extraction depuis l'onglet Période active.";
      } else if (anomaliesOnly && visibleRows === 0) {
        els.emptyState.hidden = false;
        els.emptyState.querySelector("h3").textContent = "Aucune anomalie bloquante";
        els.emptyState.querySelector("p").textContent =
          "Les champs en orange clair (date de paiement, IF) se complètent via le rapprochement bancaire ou à la demande.";
      }
    }
    if (els.tableWrap) els.tableWrap.hidden = lines.length === 0 || (anomaliesOnly && visibleRows === 0);
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
    const count = applyPendingFieldBulk();
    render();
    scheduleSave("bulk_edit", count > 1 ? `Correction appliquée sur ${count} lignes` : "Correction appliquée");
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
