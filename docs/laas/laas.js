import {
  formatMad,
  fortnightLabel,
  mapExcelRows,
  parsePdfInvoice,
  reconcileMonth,
} from "./laas-core.js";

const state = {
  excelOrders: null,
  pdfs: { q1: null, q2: null },
  errors: [],
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setFileLabel(inputId, labelId, file) {
  const label = $(labelId);
  if (!label) return;
  label.textContent = file ? file.name : "";
}

function showError(message) {
  els.error.hidden = false;
  els.error.textContent = message;
}

function clearError() {
  els.error.hidden = true;
  els.error.textContent = "";
}

async function readExcelFile(file) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
  return mapExcelRows(rows);
}

async function readPdfFile(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const parts = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => item.str).join(" "));
    parts.push("\n");
  }
  return parsePdfInvoice(parts.join(""));
}

function assignPdf(invoice, fileName, forcedFortnight = null) {
  const key = forcedFortnight || invoice.inferredFortnight;
  if (!key) {
    state.errors.push(`Impossible de deviner la quinzaine pour ${fileName} (date de facture manquante).`);
    return;
  }
  if (state.pdfs[key] && state.pdfs[key].invoiceNumber !== invoice.invoiceNumber) {
    state.errors.push(`Deux factures pour la ${fortnightLabel(key)} : ${state.pdfs[key].invoiceNumber} et ${invoice.invoiceNumber}.`);
  }
  state.pdfs[key] = invoice;
}

async function handleExcel(file) {
  if (!file) return;
  clearError();
  state.errors = [];
  try {
    state.excelOrders = await readExcelFile(file);
    setFileLabel("excelInput", "excelName", file);
    render();
  } catch (error) {
    showError(`Lecture Excel impossible : ${error.message}`);
  }
}

async function handlePdf(file, forcedFortnight) {
  if (!file) return;
  clearError();
  try {
    const invoice = await readPdfFile(file);
    assignPdf(invoice, file.name, forcedFortnight);
    const slot = forcedFortnight === "q1" ? "pdfQ1Name" : "pdfQ2Name";
    setFileLabel(null, slot, file);
    render();
  } catch (error) {
    showError(`Lecture PDF impossible : ${error.message}`);
  }
}

function renderMetricSteps(metric) {
  return `
    <div class="metric-block ${metric.ok ? "metric-ok" : "metric-warn"}">
      <div class="metric-head">
        <strong>${escapeHtml(metric.label)}</strong>
        <span class="pill ${metric.ok ? "ok" : "warn"}">${metric.ok ? "OK" : "À vérifier"}</span>
      </div>
      <ol class="calc-steps">
        ${metric.steps.map((step) => `
          <li class="${step.highlight ? "step-adjust" : ""} ${step.result ? "step-result" : ""}">
            <span class="step-label">${escapeHtml(step.text)}</span>
            <span class="step-value">${escapeHtml(formatMad(step.value))}</span>
            ${step.note ? `<span class="step-note">${escapeHtml(step.note)}</span>` : ""}
          </li>
        `).join("")}
      </ol>
    </div>
  `;
}

function renderCauseLines(cause) {
  const lines = cause.lines || [];
  if (!lines.length) return "";

  const hasOrderId = lines.some((line) => line.orderId);
  const totalHt = lines.reduce((s, line) => s + (line.pdfFeeHt || 0), 0);

  if (!hasOrderId) {
    return `
      <table class="lines-table">
        <thead><tr><th>Ligne PDF</th><th class="num">HT</th><th class="num">TVA</th><th class="num">TTC</th></tr></thead>
        <tbody>
          ${lines.map((line) => `
            <tr>
              <td>${escapeHtml(line.label || line.pdfLine || "—")}</td>
              <td class="num">${escapeHtml(formatMad(line.pdfFeeHt))}</td>
              <td class="num">${escapeHtml(formatMad(line.pdfTva))}</td>
              <td class="num">${escapeHtml(formatMad(line.pdfTtc))}</td>
            </tr>
          `).join("")}
          <tr class="lines-total">
            <td><strong>Total</strong></td>
            <td class="num"><strong>${escapeHtml(formatMad(totalHt))}</strong></td>
            <td colspan="2"></td>
          </tr>
        </tbody>
      </table>
    `;
  }

  return `
    <table class="lines-table">
      <thead><tr><th>Order id</th><th>Date</th><th class="num">Frais HT (K)</th></tr></thead>
      <tbody>
        ${lines.map((line) => `
          <tr>
            <td><code>${escapeHtml(line.orderId)}</code></td>
            <td>${escapeHtml(line.serviceDate || "—")}</td>
            <td class="num">${escapeHtml(formatMad(line.pdfFeeHt))}</td>
          </tr>
        `).join("")}
        <tr class="lines-total">
          <td colspan="2"><strong>Total frais de ces commandes</strong></td>
          <td class="num"><strong>${escapeHtml(formatMad(totalHt))}</strong></td>
        </tr>
      </tbody>
    </table>
  `;
}

function renderCause(cause) {
  return `
    <article class="cause-card">
      <h4>${escapeHtml(cause.title)}</h4>
      <p>${escapeHtml(cause.subtitle)}</p>
      ${renderCauseLines(cause)}
    </article>
  `;
}

function renderVirement(virement) {
  return `
    <div class="virement-box ${virement.ok ? "metric-ok" : "metric-warn"}">
      <div class="metric-head">
        <strong>Virement reçu</strong>
        <span class="pill ${virement.match ? "ok" : "warn"}">${virement.match ? "Concordant" : "Écart"}</span>
      </div>
      <p class="virement-formula">${escapeHtml(virement.formula)}</p>
      <p class="virement-calc">${escapeHtml(virement.excelCalc)}</p>
      <p class="virement-pdf">Montant sur la facture PDF : <strong>${escapeHtml(formatMad(virement.pdfAmount))}</strong></p>
      ${virement.note ? `<p class="step-note">${escapeHtml(virement.note)}</p>` : ""}
    </div>
  `;
}

function renderPeriod(report, invoice) {
  const { presentation: p } = report;
  const statusClass = report.ok ? "ok" : "bad";
  const statusLabel = report.ok ? "Rapproché" : "À vérifier";

  return `
    <section class="period card">
      <div class="period-head">
        <div>
          <h3>${escapeHtml(fortnightLabel(report.fortnight))}</h3>
          <div class="status-bar">
            <span class="pill ${statusClass}">${statusLabel}</span>
            <span class="pill neutral">Facture ${escapeHtml(invoice.invoiceNumber || "—")}</span>
            <span class="pill neutral">${report.excel.orderCount} lignes Excel · ${report.pdf.serviceCount} lignes PDF</span>
          </div>
        </div>
      </div>

      <div class="headline ${report.ok ? "headline-ok" : "headline-warn"}">
        ${escapeHtml(p.headline)}
      </div>

      ${p.causes.length ? `
        <section class="causes-section">
          <h4 class="section-title">Pourquoi Excel et PDF diffèrent</h4>
          ${p.causes.map(renderCause).join("")}
        </section>
      ` : ""}

      <section class="metrics-section">
        <h4 class="section-title">Calcul pas à pas</h4>
        <p class="section-hint">Chaque bloc montre comment passer du total Excel au total facture PDF.</p>
        ${p.metrics.map(renderMetricSteps).join("")}
        ${renderVirement(p.virement)}
      </section>

      ${p.warnings.length ? `
        <section class="warnings-section">
          <h4 class="section-title">Points d’attention</h4>
          ${p.warnings.map((w) => `
            <article class="cause-card warn-card">
              <h4>${escapeHtml(w.title)}</h4>
              <p>${escapeHtml(w.detail)}</p>
            </article>
          `).join("")}
        </section>
      ` : ""}
    </section>
  `;
}

function render() {
  if (!state.excelOrders?.length) {
    els.results.innerHTML = `<div class="empty card">Importez l’export Excel <code>laasexport-…xls</code> pour commencer.</div>`;
    els.summary.hidden = true;
    return;
  }

  const { monthExcel, reports } = reconcileMonth(state.excelOrders, state.pdfs);

  els.summary.hidden = false;
  els.summary.innerHTML = `
    <h2>Résumé du mois (Excel)</h2>
    <div class="status-bar">
      <span class="pill neutral">${monthExcel.orderCount} commandes</span>
      <span class="pill neutral">${monthExcel.deliveredCount} livrées</span>
      <span class="pill neutral">Collecté ${escapeHtml(formatMad(monthExcel.collected))}</span>
      <span class="pill neutral">Frais HT ${escapeHtml(formatMad(monthExcel.feeHt))}</span>
    </div>
    <p class="summary-hint">
      Livrée → F + K · retour / annulée → K seulement · les refunds et certaines commandes n’apparaissent que sur le PDF.
    </p>
  `;

  if (!reports.length) {
    els.results.innerHTML = `
      <div class="empty card">
        Ajoutez une ou deux factures PDF (quinzaine du 15 et fin de mois) pour le rapprochement détaillé.
      </div>
    `;
    return;
  }

  els.results.innerHTML = reports
    .map((report) => renderPeriod(report, state.pdfs[report.fortnight]))
    .join("");

  if (state.errors.length) {
    showError(state.errors.join(" "));
  }
}

function bindDropzone(input, onFile) {
  const zone = input.closest(".dropzone");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) onFile(file);
  });
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("is-dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-dragover"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("is-dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
  zone.addEventListener("click", () => input.click());
}

function init() {
  els.results = $("results");
  els.summary = $("summary");
  els.error = $("error");

  bindDropzone($("excelInput"), handleExcel);
  bindDropzone($("pdfQ1Input"), (file) => handlePdf(file, "q1"));
  bindDropzone($("pdfQ2Input"), (file) => handlePdf(file, "q2"));

  render();
}

init();
