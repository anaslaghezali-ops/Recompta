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

function deltaClass(value) {
  return nearlyZero(value) ? "delta-ok" : "delta-bad";
}

function renderComparisonRow(label, excelValue, pdfValue, delta) {
  return `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td class="num">${escapeHtml(formatMad(excelValue))}</td>
      <td class="num">${pdfValue == null ? "—" : escapeHtml(formatMad(pdfValue))}</td>
      <td class="num ${deltaClass(delta)}">${escapeHtml(formatMad(delta))}</td>
    </tr>
  `;
}

function renderExplanation(explanation) {
  const items = explanation.items?.length
    ? `<ul>${explanation.items.slice(0, 12).map((item) => {
      if (item.orderId && item.pdfFeeHt != null) {
        return `<li><code>${escapeHtml(item.orderId)}</code> — frais PDF ${escapeHtml(formatMad(item.pdfFeeHt))}${item.serviceDate ? ` (${escapeHtml(item.serviceDate)})` : ""}</li>`;
      }
      if (item.orderId && item.deliveryFee != null) {
        return `<li><code>${escapeHtml(item.orderId)}</code> — ${escapeHtml(item.status)} · K ${escapeHtml(formatMad(item.deliveryFee))} · F ${escapeHtml(formatMad(item.orderAmount || 0))}</li>`;
      }
      if (item.orderId && item.delta != null) {
        return `<li><code>${escapeHtml(item.orderId)}</code> — Excel K ${escapeHtml(formatMad(item.excelK))} vs PDF ${escapeHtml(formatMad(item.pdfHt))} (Δ ${escapeHtml(formatMad(item.delta))})</li>`;
      }
      return `<li>${escapeHtml(JSON.stringify(item))}</li>`;
    }).join("")}${explanation.items.length > 12 ? `<li>… et ${explanation.items.length - 12} autre(s)</li>` : ""}</ul>`
    : "";

  return `
    <article class="explain">
      <h4>${escapeHtml(explanation.title)}</h4>
      <p>${escapeHtml(explanation.detail)}</p>
      ${items}
    </article>
  `;
}

function renderPeriod(report, invoice) {
  const statusClass = report.ok ? "ok" : (report.explanations.some((e) => e.kind.includes("unexplained")) ? "bad" : "warn");
  const statusLabel = report.ok ? "OK" : "Écarts à lire";

  return `
    <section class="period card">
      <div class="period-head">
        <div>
          <h3>${escapeHtml(fortnightLabel(report.fortnight))}</h3>
          <div class="status-bar">
            <span class="pill ${statusClass}">${statusLabel}</span>
            <span class="pill neutral">Facture ${escapeHtml(invoice.invoiceNumber || "—")}</span>
            <span class="pill neutral">${report.excel.orderCount} lignes Excel · ${report.pdf.serviceCount} lignes PDF</span>
            ${report.pdf.refundCount ? `<span class="pill warn">${report.pdf.refundCount} refund(s)</span>` : ""}
          </div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Indicateur</th>
            <th class="num">Calcul Excel</th>
            <th class="num">Facture PDF</th>
            <th class="num">Écart</th>
          </tr>
        </thead>
        <tbody>
          ${renderComparisonRow("Montant collecté (F des livrées)", report.excel.collected, report.pdf.collected, report.deltas.collected)}
          ${renderComparisonRow("Frais livraison HT (K + refunds)", report.excel.feeHt, report.pdf.feeHt, report.deltas.feeHt)}
          ${renderComparisonRow("Facture TTC", report.excel.invoiceTtcFromFees, report.pdf.invoiceTtc, round2((report.pdf.invoiceTtc || 0) - report.excel.invoiceTtcFromFees))}
          ${renderComparisonRow("Virement attendu (collecté − TTC)", report.payoutExcel, report.pdf.payout, report.deltas.payout)}
        </tbody>
      </table>

      <div class="explain-list">
        ${report.explanations.length ? report.explanations.map(renderExplanation).join("") : `<p class="empty">Aucun écart particulier — les totaux concordent.</p>`}
      </div>
    </section>
  `;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
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
    <p style="color:var(--muted); font-size:0.9rem; margin:0.75rem 0 0;">
      Règle : livrée → F + K · retour / annulée → seulement K (F ignoré) · K = 0 → pas de ligne facture.
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
