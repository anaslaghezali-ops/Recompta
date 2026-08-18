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

function nearlyZero(value, tolerance = 0.02) {
  return Math.abs(Number(value) || 0) <= tolerance;
}

function renderCalcLine(label, value, { minus = false, strong = false } = {}) {
  const prefix = minus ? "−" : "+";
  const cls = strong ? "calc-line calc-result" : "calc-line";
  return `
    <div class="${cls}">
      <span>${escapeHtml(label)}</span>
      <span class="calc-amount">${minus ? `${prefix} ` : ""}${escapeHtml(formatMad(value))}</span>
    </div>
  `;
}

function renderPayoutSide(side, { isPdf = false } = {}) {
  const payoutLabel = isPdf ? "Montant à payer au partenaire" : "Virement attendu";
  const payoutNote = isPdf && side.payoutRaw != null && side.payoutRaw < 0
    ? `<p class="pdf-raw">Sur la facture : ${escapeHtml(formatMad(side.payoutRaw))} (négatif = virement reçu)</p>`
    : "";

  return `
    <div class="payout-side ${isPdf ? "payout-pdf" : "payout-excel"}">
      <h4>${escapeHtml(side.title)}</h4>
      <div class="calc-block">
        ${renderCalcLine("Montant collecté (F des livrées)", side.collected)}
        ${renderCalcLine(`Facture Glovo TTC (frais K HT × 1,20${isPdf ? "" : ""})`, side.feeTtc, { minus: true })}
        <p class="calc-hint">Frais HT : ${escapeHtml(formatMad(side.feeHt))}</p>
        ${renderCalcLine(payoutLabel, side.payout, { strong: true })}
        ${payoutNote}
      </div>
    </div>
  `;
}

function renderGap(p) {
  const gap = p.payoutDelta;
  const gapClass = p.gapExplained ? "gap-ok" : "gap-bad";
  const gapSign = gap > 0 ? "+" : "";

  return `
    <div class="gap-box ${gapClass}">
      <div class="gap-amount">
        <span>Écart virement</span>
        <strong>${gapSign}${escapeHtml(formatMad(gap))}</strong>
      </div>
      <p>${escapeHtml(p.gapReason)}</p>
    </div>
  `;
}

function renderDetailLines(detail) {
  const lines = detail.lines || [];
  if (!lines.length) return "";

  if (detail.type === "refunds") {
    return `
      <table class="lines-table">
        <thead><tr><th>Ligne PDF</th><th class="num">HT</th><th class="num">TTC</th></tr></thead>
        <tbody>
          ${lines.map((line) => `
            <tr>
              <td>${escapeHtml(line.label || "Refunds. On Demand")}</td>
              <td class="num">${escapeHtml(formatMad(line.pdfFeeHt))}</td>
              <td class="num">${escapeHtml(formatMad(line.pdfTtc))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  const totalHt = lines.reduce((s, line) => s + (line.pdfFeeHt || 0), 0);
  return `
    <table class="lines-table">
      <thead><tr><th>Order id</th><th>Date</th><th class="num">Frais K HT</th><th class="num">TTC (×1,20)</th></tr></thead>
      <tbody>
        ${lines.map((line) => `
          <tr>
            <td><code>${escapeHtml(line.orderId)}</code></td>
            <td>${escapeHtml(line.serviceDate || "—")}</td>
            <td class="num">${escapeHtml(formatMad(line.pdfFeeHt))}</td>
            <td class="num">${escapeHtml(formatMad(line.pdfTtc))}</td>
          </tr>
        `).join("")}
        <tr class="lines-total">
          <td colspan="2"><strong>Total</strong></td>
          <td class="num"><strong>${escapeHtml(formatMad(totalHt))}</strong></td>
          <td class="num"><strong>${escapeHtml(formatMad(lines.reduce((s, l) => s + (l.pdfTtc || 0), 0)))}</strong></td>
        </tr>
      </tbody>
    </table>
  `;
}

function renderPeriod(report, invoice) {
  const p = report.presentation;
  const statusClass = report.ok ? "ok" : "bad";
  const statusLabel = report.ok ? "OK" : "À vérifier";

  return `
    <section class="period card">
      <div class="period-head">
        <h3>${escapeHtml(fortnightLabel(report.fortnight))}</h3>
        <div class="status-bar">
          <span class="pill ${statusClass}">${statusLabel}</span>
          <span class="pill neutral">Facture ${escapeHtml(invoice.invoiceNumber || "—")}</span>
        </div>
      </div>

      <p class="formula-banner">Virement = montant collecté − facture Glovo TTC</p>

      <div class="payout-compare">
        ${renderPayoutSide(p.excelSide)}
        <div class="payout-vs">vs</div>
        ${renderPayoutSide(p.pdfSide, { isPdf: true })}
      </div>

      ${!nearlyZero(p.payoutDelta) || !p.gapExplained ? renderGap(p) : `
        <div class="gap-box gap-ok">
          <p>Le virement calculé depuis l’Excel correspond au montant indiqué en bas de la facture PDF.</p>
        </div>
      `}

      ${p.details.length ? `
        <details class="details-block">
          <summary>Détail des lignes PDF absentes de l’Excel (${p.details.length})</summary>
          ${p.details.map((detail) => `
            <div class="detail-section">
              <h5>${escapeHtml(detail.title)}</h5>
              ${renderDetailLines(detail)}
            </div>
          `).join("")}
        </details>
      ` : ""}

      ${p.warnings.length ? `
        <div class="warnings-section">
          ${p.warnings.map((w) => `
            <article class="warn-card">
              <strong>${escapeHtml(w.title)}</strong>
              <p>${escapeHtml(w.detail)}</p>
            </article>
          `).join("")}
        </div>
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
  `;

  if (!reports.length) {
    els.results.innerHTML = `
      <div class="empty card">
        Ajoutez une ou deux factures PDF pour comparer le virement attendu (Excel) au virement réel (PDF).
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
