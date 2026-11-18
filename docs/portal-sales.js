/**
 * Onglet « Ventes » du portail client : registre des factures de vente,
 * clients de l'entreprise, paiements. Données : sales-client.js.
 */
import {
  PAYMENT_METHODS,
  SALES_FILTERS,
  addPayment,
  checkSaleFile,
  completeAmounts,
  deletePayment,
  deleteSaleDraft,
  filterSales,
  formatMad,
  listCustomers,
  listSales,
  parseAmount,
  saleDocumentUrl,
  saleState,
  salesSummary,
  saveCustomer,
  saveSaleDraft,
  uploadSaleDocument,
  validateSale,
  voidSale,
} from "./sales-client.js?v=sales1";

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icons = () => window.lucide?.createIcons?.();
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const today = () => new Date().toISOString().slice(0, 10);
const fmtDay = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "—");

const state = { clientId: null, sales: [], payments: [], customers: [], filter: "all", loaded: false, current: null };

function setMsg(id, text, ok = false) {
  const el = $(id);
  el.hidden = !text;
  el.className = `pt-form-msg ${ok ? "is-ok" : "is-error"}`;
  el.textContent = text || "";
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
function renderSummary() {
  const s = salesSummary(state.sales, state.payments);
  const now = new Date();
  $("slCollectedLabel").textContent = `Encaissé en ${MONTHS[now.getMonth()]}`;
  $("slCollected").textContent = `${formatMad(s.collectedMonth)} MAD`;
  $("slOverdue").textContent = `${formatMad(s.overdueAmount)} MAD`;
  $("slOverdueNote").textContent = s.overdueCount ? `${s.overdueCount} facture${s.overdueCount > 1 ? "s" : ""}` : "Aucune";
  $("slOverdueStat").classList.toggle("is-alert", s.overdueCount > 0);
  $("slOpen").textContent = `${formatMad(s.openAmount)} MAD`;
  $("slOpenNote").textContent = s.openCount ? `${s.openCount} facture${s.openCount > 1 ? "s" : ""}` : "Tout est encaissé";
  const badge = $("salesTabBadge");
  badge.hidden = !s.overdueCount;
  badge.textContent = String(s.overdueCount);
}

function renderFilters() {
  $("slFilters").innerHTML = SALES_FILTERS.map((f) => {
    const n = filterSales(state.sales, f.key).length;
    return `<button type="button" class="pt-chip ${state.filter === f.key ? "is-active" : ""}" data-sales-filter="${f.key}" aria-pressed="${state.filter === f.key}">${esc(f.label)} <span>${n}</span></button>`;
  }).join("");
}

function renderList() {
  const rows = filterSales(state.sales, state.filter);
  if (!state.customers.length && !state.sales.length) {
    $("slList").innerHTML = '<li class="pt-empty">Commencez par ajouter un client dans « Mes clients », puis enregistrez vos factures de vente.</li>';
    return;
  }
  $("slList").innerHTML = rows.length ? rows.map((s) => {
    const st = saleState(s);
    const paid = Number(s.paid_amount) > 0 && s.status === "issued" && st.key !== "paid"
      ? `<span>payé ${formatMad(s.paid_amount)}</span>` : "";
    return `
      <li class="pt-sale is-${st.tone}">
        <button type="button" class="pt-sale-main" data-sale="${s.id}">
          <span class="pt-sale-who"><strong>${esc(s.customer_name || "Client")}</strong><span>N° ${esc(s.external_number || s.number || "—")} · ${fmtDay(s.issue_date)}</span></span>
          <span class="pt-sale-amount"><strong>${formatMad(s.total_ttc)}</strong><span>MAD TTC</span>${paid}</span>
          <span class="pt-badge is-${st.tone}">${esc(st.label)}</span>
        </button>
      </li>`;
  }).join("") : '<li class="pt-empty">Aucune facture dans ce filtre.</li>';
}

function renderCustomers() {
  $("slCustomerCount").textContent = state.customers.length ? `(${state.customers.length})` : "";
  $("slCustomers").innerHTML = state.customers.length ? state.customers.map((c) => `
    <li>
      <i data-lucide="building-2"></i>
      <div><strong>${esc(c.name)}</strong><span>${c.ice ? `ICE ${esc(c.ice)}` : "ICE non renseigné"}${c.payment_days != null ? ` · paiement à ${c.payment_days} j` : ""}</span></div>
      <button type="button" class="pt-btn is-ghost" data-customer="${c.id}">Modifier</button>
    </li>`).join("") : '<li class="pt-empty">Aucun client pour l\'instant.</li>';
}

function render() {
  renderSummary();
  renderFilters();
  renderList();
  renderCustomers();
  icons();
}

export async function refreshSales() {
  const [{ sales, payments }, customers] = await Promise.all([listSales(), listCustomers()]);
  Object.assign(state, { sales, payments, customers, loaded: true });
  render();
}

// ---------------------------------------------------------------------------
// Client (fiche)
// ---------------------------------------------------------------------------
let customerReturn = null;
function openCustomer(customer = null, { onSaved = null } = {}) {
  customerReturn = onSaved;
  const f = $("slCustomerForm");
  f.reset();
  f.dataset.id = customer?.id || "";
  $("slCustomerTitle").textContent = customer ? "Modifier le client" : "Nouveau client";
  for (const k of ["name", "ice", "if_number", "address", "city", "email", "phone", "payment_days"]) {
    f.elements[k].value = customer?.[k] ?? "";
  }
  setMsg("slCustomerMsg", "");
  $("slCustomerDialog").showModal();
  f.elements.name.focus();
}

async function submitCustomer(event) {
  event.preventDefault();
  const f = event.currentTarget;
  const data = Object.fromEntries(new FormData(f));
  $("slCustomerSave").disabled = true;
  try {
    const saved = await saveCustomer(state.clientId, { ...data, id: f.dataset.id ? Number(f.dataset.id) : null });
    $("slCustomerDialog").close();
    await refreshSales();
    if (customerReturn) customerReturn(saved);
  } catch (err) {
    setMsg("slCustomerMsg", err.message);
  } finally {
    $("slCustomerSave").disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Facture (saisie rapide + pièce)
// ---------------------------------------------------------------------------
function customerOptions(selected) {
  return `<option value="">Choisir…</option>${state.customers.map((c) => `<option value="${c.id}" ${Number(selected) === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}`;
}

function openSaleForm(sale = null) {
  const f = $("slSaleForm");
  f.reset();
  f.dataset.id = sale?.id || "";
  f.dataset.documentPath = sale?.document_path || "";
  $("slSaleTitle").textContent = sale ? "Compléter la facture" : "Ajouter une facture de vente";
  f.elements.customer_id.innerHTML = customerOptions(sale?.customer_id);
  f.elements.external_number.value = sale?.external_number || "";
  f.elements.issue_date.value = sale?.issue_date || today();
  f.elements.due_date.value = sale?.due_date || "";
  f.elements.ht.value = sale ? formatMad(sale.total_ht) : "";
  f.elements.vat.value = sale ? formatMad(sale.total_vat) : "";
  f.elements.ttc.value = sale ? formatMad(sale.total_ttc) : "";
  $("slSaleFileName").textContent = sale?.document_path ? "Pièce jointe enregistrée" : "Aucune pièce jointe";
  $("slSaleDelete").hidden = !sale;
  setMsg("slSaleMsg", "");
  $("slSaleDialog").showModal();
}

function fillMissingAmount(event) {
  const f = $("slSaleForm");
  const changed = event?.target?.name;
  const v = { ht: parseAmount(f.elements.ht.value), vat: parseAmount(f.elements.vat.value), ttc: parseAmount(f.elements.ttc.value) };
  const known = Object.values(v).filter(Number.isFinite).length;
  if (known !== 2) return;
  const done = completeAmounts(v);
  for (const k of ["ht", "vat", "ttc"]) {
    if (!Number.isFinite(v[k]) && k !== changed) f.elements[k].value = formatMad(done[k]);
  }
}

async function submitSale(event) {
  event.preventDefault();
  const f = $("slSaleForm");
  const validate = event.submitter?.value === "validate";
  const data = Object.fromEntries(new FormData(f));
  const file = f.elements.document.files[0];
  $("slSaleForm").querySelectorAll("button").forEach((b) => { b.disabled = true; });
  try {
    if (file) {
      const problem = checkSaleFile(file);
      if (problem) throw new Error(problem);
    }
    let documentPath = f.dataset.documentPath || null;
    if (file) {
      documentPath = await uploadSaleDocument(state.clientId, file);
      f.elements.document.value = "";
    }
    const id = await saveSaleDraft(state.clientId, {
      ...data,
      id: f.dataset.id ? Number(f.dataset.id) : null,
      document_path: documentPath,
    });
    f.dataset.id = id;
    f.dataset.documentPath = documentPath || "";
    if (validate) await validateSale(id);
    $("slSaleDialog").close();
    await refreshSales();
  } catch (err) {
    setMsg("slSaleMsg", err.message);
    await refreshSales().catch(() => {});
  } finally {
    $("slSaleForm").querySelectorAll("button").forEach((b) => { b.disabled = false; });
  }
}

async function removeDraft() {
  const f = $("slSaleForm");
  const sale = state.sales.find((s) => s.id === Number(f.dataset.id));
  if (!sale || !window.confirm("Supprimer ce brouillon ?")) return;
  try {
    await deleteSaleDraft(sale);
    $("slSaleDialog").close();
    await refreshSales();
  } catch (err) {
    setMsg("slSaleMsg", err.message);
  }
}

// ---------------------------------------------------------------------------
// Détail d'une facture validée : paiements, pièce, annulation
// ---------------------------------------------------------------------------
function openDetail(id) {
  const sale = state.sales.find((s) => s.id === id);
  if (!sale) return;
  if (sale.status === "draft") return openSaleForm(sale);
  state.current = sale;
  const st = saleState(sale);
  const pays = state.payments.filter((p) => p.invoice_id === sale.id);
  $("slDetailTitle").textContent = `Facture ${sale.external_number || sale.number || ""}`;
  $("slDetailBody").innerHTML = `
    <p class="pt-badge is-${st.tone}">${esc(st.label)}</p>
    <dl class="pt-facts">
      <div><dt>Client</dt><dd>${esc(sale.customer_name)}</dd></div>
      <div><dt>Date</dt><dd>${fmtDay(sale.issue_date)}</dd></div>
      <div><dt>Échéance</dt><dd>${fmtDay(sale.due_date)}</dd></div>
      <div><dt>HT</dt><dd>${formatMad(sale.total_ht)} MAD</dd></div>
      <div><dt>TVA</dt><dd>${formatMad(sale.total_vat)} MAD</dd></div>
      <div><dt>TTC</dt><dd><strong>${formatMad(sale.total_ttc)} MAD</strong></dd></div>
      <div><dt>Reste à payer</dt><dd><strong>${formatMad(sale.balance)} MAD</strong></dd></div>
    </dl>
    ${sale.status === "voided" ? `<p class="pt-closed-note">Enregistrement annulé : ${esc(sale.void_reason || "")}</p>` : ""}
    <h3 class="pt-subhead">Paiements</h3>
    <ul class="pt-payments">${pays.length ? pays.map((p) => `
      <li><div><strong>${formatMad(p.amount)} MAD</strong><span>${fmtDay(p.paid_on)} · ${esc(PAYMENT_METHODS[p.method] || p.method)}${p.reference ? ` · ${esc(p.reference)}` : ""}</span></div>
      ${sale.status === "issued" ? `<button type="button" class="pt-link" data-del-payment="${p.id}">Supprimer</button>` : ""}</li>`).join("")
      : '<li class="pt-empty">Aucun paiement enregistré.</li>'}</ul>`;
  const canPay = sale.status === "issued" && Number(sale.balance) > 0.005;
  $("slPayForm").hidden = !canPay;
  if (canPay) {
    $("slPayForm").reset();
    $("slPayForm").elements.paid_on.value = today();
    $("slPayForm").elements.amount.value = formatMad(sale.balance);
  }
  $("slDocBtn").hidden = !sale.document_path;
  $("slVoidBtn").hidden = sale.status !== "issued";
  setMsg("slPayMsg", "");
  $("slDetailDialog").showModal();
  icons();
}

async function submitPayment(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  $("slPaySave").disabled = true;
  try {
    await addPayment(state.current.id, data);
    await refreshSales();
    openDetail(state.current.id);
  } catch (err) {
    setMsg("slPayMsg", err.message);
  } finally {
    $("slPaySave").disabled = false;
  }
}

async function removePayment(id) {
  if (!window.confirm("Supprimer ce paiement ?")) return;
  try {
    await deletePayment(id);
    await refreshSales();
    openDetail(state.current.id);
  } catch (err) {
    setMsg("slPayMsg", err.message);
  }
}

async function voidCurrent() {
  const reason = window.prompt("Motif de l'annulation (il restera visible) :");
  if (reason === null) return;
  try {
    await voidSale(state.current.id, reason);
    await refreshSales();
    openDetail(state.current.id);
  } catch (err) {
    setMsg("slPayMsg", err.message);
  }
}

async function openDocument() {
  try {
    const url = await saleDocumentUrl(state.current.document_path);
    if (url) window.open(url, "_blank", "noopener");
  } catch (err) {
    setMsg("slPayMsg", err.message);
  }
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
export function initSalesView(ctx) {
  state.clientId = ctx.client.id;
  $("slFilters").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-sales-filter]");
    if (!chip) return;
    state.filter = chip.dataset.salesFilter;
    renderFilters();
    renderList();
  });
  $("slList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-sale]");
    if (row) openDetail(Number(row.dataset.sale));
  });
  $("slAddSale").addEventListener("click", () => {
    if (!state.customers.length) return openCustomer(null, { onSaved: () => openSaleForm() });
    return openSaleForm();
  });
  $("slAddCustomer").addEventListener("click", () => openCustomer());
  $("slCustomers").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-customer]");
    if (btn) openCustomer(state.customers.find((c) => c.id === Number(btn.dataset.customer)));
  });
  $("slSaleNewCustomer").addEventListener("click", () => {
    $("slSaleDialog").close();
    openCustomer(null, {
      onSaved: (c) => {
        $("slSaleDialog").showModal();
        $("slSaleForm").elements.customer_id.innerHTML = customerOptions(c.id);
      },
    });
  });
  $("slCustomerForm").addEventListener("submit", submitCustomer);
  $("slSaleForm").addEventListener("submit", submitSale);
  $("slSaleForm").addEventListener("change", fillMissingAmount);
  $("slSaleForm").elements.document.addEventListener("change", (e) => {
    const file = e.target.files[0];
    $("slSaleFileName").textContent = file ? file.name : "Aucune pièce jointe";
  });
  $("slSaleDelete").addEventListener("click", removeDraft);
  $("slPayForm").addEventListener("submit", submitPayment);
  $("slDetailBody").addEventListener("click", (event) => {
    const del = event.target.closest("[data-del-payment]");
    if (del) removePayment(Number(del.dataset.delPayment));
  });
  $("slVoidBtn").addEventListener("click", voidCurrent);
  $("slDocBtn").addEventListener("click", openDocument);
  document.querySelectorAll("[data-close-dialog]").forEach((btn) => {
    btn.addEventListener("click", () => btn.closest("dialog").close());
  });
}

export const salesLoaded = () => state.loaded;
