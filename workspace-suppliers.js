import { loadClientSupplierNotebook } from "./suppliers-client.js?v=sup2";
import { escapeHtml } from "./dashboard-ui.js?v=portfolio1";

function formatAmount(value) {
  return Number(value || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("fr-FR");
}

export function createWorkspaceSuppliers({ mountEl, getContext, onOpenInvoice }) {
  let suppliers = [];
  let selectedKey = null;
  let selectedYear = null;
  let searchQuery = "";

  const els = {
    status: mountEl.querySelector("#suppliersStatus"),
    search: mountEl.querySelector("#suppliersSearch"),
    empty: mountEl.querySelector("#suppliersEmpty"),
    layout: mountEl.querySelector("#suppliersLayout"),
    list: mountEl.querySelector("#suppliersList"),
    detailEmpty: mountEl.querySelector("#suppliersDetailEmpty"),
    detail: mountEl.querySelector("#suppliersDetail"),
    detailName: mountEl.querySelector("#supplierDetailName"),
    detailIce: mountEl.querySelector("#supplierDetailIce"),
    detailIf: mountEl.querySelector("#supplierDetailIf"),
    detailCount: mountEl.querySelector("#supplierDetailCount"),
    detailTotal: mountEl.querySelector("#supplierDetailTotal"),
    yearTabs: mountEl.querySelector("#supplierYearTabs"),
    monthsMount: mountEl.querySelector("#supplierMonthsMount"),
  };

  function ctx() {
    return getContext() || {};
  }

  function setStatus(text, tone = "muted") {
    if (!els.status) return;
    els.status.textContent = text || "";
    els.status.dataset.tone = tone;
  }

  function filteredSuppliers() {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter((supplier) => {
      const haystack = `${supplier.name} ${supplier.ice} ${supplier.if}`.toLowerCase();
      return haystack.includes(q);
    });
  }

  function selectedSupplier() {
    return suppliers.find((supplier) => supplier.key === selectedKey) || null;
  }

  function renderSupplierList() {
    if (!els.list) return;
    const items = filteredSuppliers();
    if (!items.length) {
      els.list.innerHTML = `<p class="hint ws-suppliers-list-empty">Aucun fournisseur ne correspond à votre recherche.</p>`;
      return;
    }

    els.list.innerHTML = items.map((supplier) => {
      const active = supplier.key === selectedKey ? " is-active" : "";
      return `
        <button type="button" class="ws-suppliers-list-item${active}" data-supplier-key="${escapeHtml(supplier.key)}">
          <span class="ws-suppliers-list-name">${escapeHtml(supplier.name)}</span>
          <span class="ws-suppliers-list-meta">
            ${supplier.ice ? `ICE ${escapeHtml(supplier.ice)}` : "ICE —"}
            · ${supplier.invoiceCount} facture(s)
          </span>
          <span class="ws-suppliers-list-total">${formatAmount(supplier.totalTtc)} MAD</span>
        </button>
      `;
    }).join("");
  }

  function renderYearTabs(supplier) {
    if (!els.yearTabs) return;
    if (!supplier?.years?.length) {
      els.yearTabs.innerHTML = "";
      return;
    }
    if (!supplier.years.includes(selectedYear)) {
      selectedYear = supplier.years[0];
    }
    els.yearTabs.innerHTML = supplier.years.map((year) => `
      <button type="button" class="dash-year-tab${year === selectedYear ? " active" : ""}" data-year="${year}">
        ${year}
      </button>
    `).join("");
  }

  function renderMonths(supplier) {
    if (!els.monthsMount) return;
    const months = supplier?.byYear?.[selectedYear] || {};
    const monthKeys = Object.keys(months).map(Number).sort((a, b) => b - a);
    if (!monthKeys.length) {
      els.monthsMount.innerHTML = `<p class="hint">Aucune facture pour ${selectedYear}.</p>`;
      return;
    }

    els.monthsMount.innerHTML = monthKeys.map((month) => {
      const invoices = months[month] || [];
      const periodLabel = invoices[0]?.periodLabel || `Mois ${month}`;
      const rows = invoices.map((invoice) => `
        <tr>
          <td>${escapeHtml(invoice.line.fact_num || "—")}</td>
          <td>${escapeHtml(formatDate(invoice.line.date_fac))}</td>
          <td class="ws-suppliers-num">${formatAmount(invoice.line.m_ht)}</td>
          <td class="ws-suppliers-num">${formatAmount(invoice.line.tva)}</td>
          <td class="ws-suppliers-num">${formatAmount(invoice.line.m_ttc)}</td>
          <td class="ws-suppliers-actions">
            <button type="button" class="dash-btn dash-btn-sm ws-suppliers-open"
              data-dossier-id="${escapeHtml(String(invoice.dossierId))}"
              data-line-index="${invoice.lineIndex}">
              Ouvrir
            </button>
          </td>
        </tr>
      `).join("");

      return `
        <section class="ws-suppliers-month">
          <header class="ws-suppliers-month-head">
            <h4>${escapeHtml(periodLabel)}</h4>
            <span class="hint">${invoices.length} facture(s)</span>
          </header>
          <div class="ws-suppliers-table-wrap">
            <table class="ws-suppliers-table">
              <thead>
                <tr>
                  <th>N° facture</th>
                  <th>Date</th>
                  <th>HT</th>
                  <th>TVA</th>
                  <th>TTC</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </section>
      `;
    }).join("");
  }

  function renderDetail() {
    const supplier = selectedSupplier();
    const hasSuppliers = suppliers.length > 0;

    if (els.layout) els.layout.hidden = !hasSuppliers;
    if (els.empty) els.empty.hidden = hasSuppliers;

    renderSupplierList();

    if (!supplier) {
      if (els.detail) els.detail.hidden = true;
      if (els.detailEmpty) els.detailEmpty.hidden = !hasSuppliers;
      return;
    }

    if (els.detailEmpty) els.detailEmpty.hidden = true;
    if (els.detail) els.detail.hidden = false;
    if (els.detailName) els.detailName.textContent = supplier.name;
    if (els.detailIce) els.detailIce.textContent = supplier.ice ? `ICE : ${supplier.ice}` : "ICE : —";
    if (els.detailIf) els.detailIf.textContent = supplier.if ? `IF : ${supplier.if}` : "IF : —";
    if (els.detailCount) els.detailCount.textContent = `${supplier.invoiceCount} facture(s)`;
    if (els.detailTotal) els.detailTotal.textContent = `${formatAmount(supplier.totalTtc)} MAD TTC`;

    renderYearTabs(supplier);
    renderMonths(supplier);
  }

  function render() {
    renderDetail();
  }

  async function load() {
    const { clientId, cabinetId } = ctx();
    if (!clientId || !cabinetId) {
      suppliers = [];
      selectedKey = null;
      render();
      setStatus("Client non sélectionné");
      return;
    }

    setStatus("Chargement du carnet fournisseurs…");
    try {
      const notebook = await loadClientSupplierNotebook(clientId, cabinetId);
      suppliers = notebook.suppliers || [];
      if (!suppliers.some((supplier) => supplier.key === selectedKey)) {
        selectedKey = suppliers[0]?.key || null;
        selectedYear = suppliers[0]?.years?.[0] || new Date().getFullYear();
      }
      render();
      setStatus(
        suppliers.length
          ? `${suppliers.length} fournisseur(s) · ${suppliers.reduce((sum, s) => sum + s.invoiceCount, 0)} facture(s)`
          : "Aucune facture enregistrée pour ce client",
        suppliers.length ? "success" : "muted",
      );
    } catch (error) {
      suppliers = [];
      selectedKey = null;
      render();
      setStatus(`Erreur : ${error.message}`, "error");
    }
  }

  els.search?.addEventListener("input", () => {
    searchQuery = els.search.value || "";
    renderSupplierList();
  });

  els.list?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-supplier-key]");
    if (!btn) return;
    selectedKey = btn.dataset.supplierKey;
    const supplier = selectedSupplier();
    selectedYear = supplier?.years?.[0] || new Date().getFullYear();
    renderDetail();
  });

  els.yearTabs?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-year]");
    if (!btn) return;
    selectedYear = Number(btn.dataset.year);
    renderDetail();
  });

  els.monthsMount?.addEventListener("click", (event) => {
    const btn = event.target.closest(".ws-suppliers-open");
    if (!btn) return;
    onOpenInvoice?.({
      dossierId: Number(btn.dataset.dossierId),
      lineIndex: Number(btn.dataset.lineIndex),
    });
  });

  return { load, render };
}
