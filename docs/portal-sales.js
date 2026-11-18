/**
 * Onglet « Ventes » du portail client : registre des factures de vente,
 * clients de l'entreprise, paiements. Données : sales-client.js.
 */
import {
  DOC_TITLES,
  PAYMENT_METHODS,
  REMINDER_CHANNELS,
  REMINDER_LEVELS,
  SALES_FILTERS,
  addReminder,
  listReminders,
  nextReminderLevel,
  reminderMailto,
  reminderMessage,
  toRemind,
  VAT_RATES,
  addPayment,
  archiveItem,
  computeTotals,
  convertQuote,
  creditInvoice,
  deleteCreatedDraft,
  documentUrl,
  issueDocument,
  listCounters,
  listItems,
  loadDocument,
  loadSettings,
  mailtoLink,
  missingIssuerFields,
  readLogo,
  refuseQuote,
  saveCreatedDraft,
  saveItem,
  saveSettings,
  setLastNumber,
  shareLink,
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
} from "./sales-client.js?v=sales3";

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icons = () => window.lucide?.createIcons?.();
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const today = () => new Date().toISOString().slice(0, 10);
const fmtDay = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "—");

const state = {
  clientId: null, client: null, sales: [], payments: [], customers: [], items: [], settings: {}, counters: [],
  filter: "all", loaded: false, current: null, editing: null,
};

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
          <span class="pt-sale-who"><strong>${esc(s.customer_name || "Client")}</strong><span>${s.kind && s.kind !== "invoice" ? `${esc(DOC_TITLES[s.kind])} ` : ""}N° ${esc(s.number || s.external_number || "brouillon")} · ${fmtDay(s.issue_date)}</span></span>
          <span class="pt-sale-amount"><strong>${formatMad(s.status === "draft" && s.origin === "created" ? s.total_ttc : s.total_ttc)}</strong><span>MAD TTC</span>${paid}</span>
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

function renderRemind() {
  const list = toRemind(state.sales);
  $("slRemindBox").hidden = !list.length;
  $("slRemindTitle").textContent = `À relancer (${list.length})`;
  $("slRemindList").innerHTML = list.slice(0, 8).map((s) => `
    <li>
      <i data-lucide="bell-ring"></i>
      <div>
        <strong>${esc(s.customer_name)} · ${formatMad(s.balance)} MAD</strong>
        <span>N° ${esc(s.number || s.external_number || "")} · en retard de ${Number(s.days_overdue) || 0} j${s.last_reminder_at ? ` · dernière relance le ${fmtDay(String(s.last_reminder_at).slice(0, 10))}` : " · jamais relancée"}</span>
      </div>
      <button type="button" class="pt-btn" data-remind="${s.id}">Relancer</button>
    </li>`).join("");
}

function render() {
  renderRemind();
  renderSummary();
  renderFilters();
  renderList();
  renderCustomers();
  icons();
}

export async function refreshSales() {
  const [{ sales, payments }, customers, items, settings, counters] = await Promise.all([
    listSales(), listCustomers(), listItems().catch(() => []), loadSettings(state.clientId).catch(() => ({})), listCounters().catch(() => []),
  ]);
  Object.assign(state, { sales, payments, customers, items, settings, counters, loaded: true });
  render();
  renderSettings();
  renderCatalogue();
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
  if (sale.status === "draft") {
    if (sale.origin === "created") return openEditor(sale.kind, sale.id);
    return openSaleForm(sale);
  }
  state.current = sale;
  const st = saleState(sale);
  const kind = sale.kind || "invoice";
  const created = sale.origin === "created";
  const pays = state.payments.filter((p) => p.invoice_id === sale.id);
  $("slDetailTitle").textContent = `${DOC_TITLES[kind]} ${sale.number || sale.external_number || ""}`;
  $("slDetailBody").innerHTML = `
    <p class="pt-badge is-${st.tone}">${esc(st.label)}</p>
    <dl class="pt-facts">
      <div><dt>Client</dt><dd>${esc(sale.customer_name)}</dd></div>
      <div><dt>Date</dt><dd>${fmtDay(sale.issue_date)}</dd></div>
      ${kind !== "credit_note" ? `<div><dt>${kind === "quote" ? "Valable jusqu'au" : "Échéance"}</dt><dd>${fmtDay(sale.due_date)}</dd></div>` : ""}
      <div><dt>HT</dt><dd>${formatMad(sale.total_ht)} MAD</dd></div>
      <div><dt>TVA</dt><dd>${formatMad(sale.total_vat)} MAD</dd></div>
      <div><dt>TTC</dt><dd><strong>${formatMad(sale.total_ttc)} MAD</strong></dd></div>
      ${kind === "invoice" ? `<div><dt>Reste à payer</dt><dd><strong>${formatMad(sale.balance)} MAD</strong></dd></div>` : ""}
    </dl>
    ${sale.status === "voided" ? `<p class="pt-closed-note">Enregistrement annulé : ${esc(sale.void_reason || "")}</p>` : ""}
    ${kind === "credit_note" && sale.reason ? `<p class="pt-closed-note">Motif de l'avoir : ${esc(sale.reason)}</p>` : ""}
    ${kind === "invoice" ? `
    <h3 class="pt-subhead">Paiements</h3>
    <ul class="pt-payments">${pays.length ? pays.map((p) => `
      <li><div><strong>${formatMad(p.amount)} MAD</strong><span>${fmtDay(p.paid_on)} · ${esc(PAYMENT_METHODS[p.method] || p.method)}${p.reference ? ` · ${esc(p.reference)}` : ""}</span></div>
      ${sale.status === "issued" ? `<button type="button" class="pt-link" data-del-payment="${p.id}">Supprimer</button>` : ""}</li>`).join("")
      : '<li class="pt-empty">Aucun paiement enregistré.</li>'}</ul>` : ""}`;
  const canPay = kind === "invoice" && sale.status === "issued" && Number(sale.balance) > 0.005;
  $("slPayForm").hidden = !canPay;
  if (canPay) {
    $("slPayForm").reset();
    $("slPayForm").elements.paid_on.value = today();
    $("slPayForm").elements.amount.value = formatMad(sale.balance);
  }
  $("slDocBtn").hidden = !sale.document_path;
  $("slVoidBtn").hidden = !(sale.origin === "uploaded" && sale.status === "issued");
  $("slViewBtn").hidden = !created;
  $("slShareBtn").hidden = !created;
  $("slMailBtn").hidden = !created;
  $("slCreditBtn").hidden = !(created && kind === "invoice" && sale.status === "issued");
  $("slConvertBtn").hidden = !(kind === "quote" && sale.status === "issued" && !sale.converted_invoice_id);
  $("slRemindBtn").hidden = !(kind === "invoice" && sale.status === "issued" && Number(sale.balance) > 0.005);
  $("slReminderHistory").innerHTML = "";
  if (kind === "invoice" && sale.status === "issued") {
    listReminders(sale.id).then((rows) => {
      if (state.current?.id !== sale.id) return;
      $("slReminderHistory").innerHTML = rows.length ? `
        <h3 class="pt-subhead">Relances</h3>
        <ul class="pt-payments">${rows.map((r) => `
          <li><div><strong>${esc(REMINDER_LEVELS[r.level] || "Relance")}</strong>
          <span>${new Date(r.sent_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })} · ${esc(REMINDER_CHANNELS[r.channel] || r.channel)}</span></div></li>`).join("")}</ul>` : "";
    }).catch(() => {});
  }
  $("slRefuseBtn").hidden = !(kind === "quote" && sale.status === "issued" && !sale.converted_invoice_id);
  setMsg("slPayMsg", "");
  if (!$("slDetailDialog").open) $("slDetailDialog").showModal();
  icons();
}

async function copyShareLink() {
  try {
    const url = await shareLink(state.current.id);
    await navigator.clipboard?.writeText(url).catch(() => {});
    setMsg("slPayMsg", `Lien copié : ${url}`, true);
    await refreshSales();
  } catch (err) {
    setMsg("slPayMsg", err.message);
  }
}

async function sendByMail() {
  try {
    const sale = state.current;
    const url = await shareLink(sale.id);
    window.location.href = mailtoLink({
      to: sale.customer_email || "", kind: sale.kind, number: sale.number, total: sale.total_ttc,
      dueDate: sale.due_date, sellerName: state.client?.name || "", url,
    });
    refreshSales().catch(() => {});
  } catch (err) {
    setMsg("slPayMsg", err.message);
  }
}

async function creditCurrent() {
  const reason = window.prompt("Motif de l'avoir (il figurera sur le document) :");
  if (reason === null) return;
  try {
    const credit = await creditInvoice(state.current.id, reason);
    await refreshSales();
    openDetail(credit.id);
  } catch (err) {
    setMsg("slPayMsg", err.message);
  }
}

async function convertCurrent() {
  try {
    const id = await convertQuote(state.current.id);
    $("slDetailDialog").close();
    await refreshSales();
    openEditor("invoice", id);
  } catch (err) {
    setMsg("slPayMsg", err.message);
  }
}

async function refuseCurrent() {
  if (!window.confirm("Marquer ce devis comme refusé ?")) return;
  try {
    await refuseQuote(state.current.id);
    await refreshSales();
    openDetail(state.current.id);
  } catch (err) {
    setMsg("slPayMsg", err.message);
  }
}

// ---------------------------------------------------------------------------
// Relances
// ---------------------------------------------------------------------------
async function openReminder(id) {
  const sale = state.sales.find((s) => s.id === id);
  if (!sale) return;
  state.reminding = { sale, url: "" };
  if (sale.origin === "created") state.reminding.url = await shareLink(sale.id).catch(() => "");
  const f = $("slRemindForm");
  f.reset();
  f.elements.level.value = String(nextReminderLevel(sale));
  $("slRemindFor").textContent = `${sale.customer_name} · facture ${sale.number || sale.external_number} · reste ${formatMad(sale.balance)} MAD${sale.reminder_count ? ` · déjà relancée ${sale.reminder_count} fois` : ""}`;
  fillReminder();
  setMsg("slRemindMsg", "");
  if ($("slDetailDialog").open) $("slDetailDialog").close();
  $("slRemindDialog").showModal();
}

function fillReminder() {
  const { sale, url } = state.reminding;
  const level = Number($("slRemindForm").elements.level.value);
  $("slRemindForm").elements.message.value = reminderMessage({
    level, sellerName: state.client?.name || "", customerName: sale.customer_name, number: sale.number || sale.external_number,
    issueDate: sale.issue_date, total: sale.total_ttc, balance: sale.balance, dueDate: sale.due_date,
    daysOverdue: Number(sale.days_overdue) || 0, url,
  });
}

async function recordReminder(channel) {
  const f = $("slRemindForm");
  const { sale } = state.reminding;
  const level = Number(f.elements.level.value);
  const message = f.elements.message.value;
  try {
    if (channel === "copie") await navigator.clipboard?.writeText(message).catch(() => {});
    if (channel === "email") {
      window.location.href = reminderMailto({ to: sale.customer_email || "", level, number: sale.number || sale.external_number, sellerName: state.client?.name || "", message });
    }
    await addReminder({ invoiceId: sale.id, level, channel, message });
    setMsg("slRemindMsg", channel === "copie" ? "Message copié et relance enregistrée." : "Relance enregistrée.", true);
    await refreshSales();
    setTimeout(() => { if ($("slRemindDialog").open) $("slRemindDialog").close(); }, 900);
  } catch (err) {
    setMsg("slRemindMsg", err.message);
  }
}

// ---------------------------------------------------------------------------
// Éditeur de facture / devis (créés dans Recompta)
// ---------------------------------------------------------------------------
const lineRow = (l = {}) => `
  <div class="pt-line" role="group" aria-label="Ligne">
    <label class="pt-field pt-line-label"><span>Désignation</span><input name="label" list="slItemList" value="${esc(l.label || "")}" autocomplete="off" /></label>
    <label class="pt-field"><span>Qté</span><input name="quantity" inputmode="decimal" value="${esc(l.quantity ?? 1)}" /></label>
    <label class="pt-field"><span>Prix unitaire HT</span><input name="unit_price_ht" inputmode="decimal" value="${l.unit_price_ht != null ? esc(formatMad(l.unit_price_ht)) : ""}" /></label>
    <label class="pt-field"><span>TVA</span><select name="vat_rate">${VAT_RATES.map((r) => `<option value="${r}" ${Number(l.vat_rate ?? state.settings.default_vat_rate ?? 20) === r ? "selected" : ""}>${r} %</option>`).join("")}</select></label>
    <output class="pt-line-total">—</output>
    <button type="button" class="pt-link pt-danger" data-remove-line aria-label="Retirer la ligne">Retirer</button>
  </div>`;

function readLines() {
  return [...$("slDocLines").querySelectorAll(".pt-line")].map((row) => ({
    label: row.querySelector("[name=label]").value,
    quantity: row.querySelector("[name=quantity]").value,
    unit_price_ht: row.querySelector("[name=unit_price_ht]").value,
    vat_rate: Number(row.querySelector("[name=vat_rate]").value),
  }));
}

function updateTotals() {
  const lines = readLines().map((l) => ({ quantity: parseAmount(l.quantity) || 0, unit_price_ht: parseAmount(l.unit_price_ht) || 0, vat_rate: l.vat_rate }));
  $("slDocLines").querySelectorAll(".pt-line").forEach((row, i) => {
    row.querySelector(".pt-line-total").textContent = formatMad(lines[i].quantity * lines[i].unit_price_ht);
  });
  const t = computeTotals(lines);
  const rates = Object.entries(t.byRate).filter(([, v]) => v.ht !== 0).sort((a, b) => Number(b[0]) - Number(a[0]));
  $("slDocTotals").innerHTML = `
    <div><dt>Total HT</dt><dd>${formatMad(t.ht)}</dd></div>
    ${rates.map(([r, v]) => `<div><dt>TVA ${r} %</dt><dd>${formatMad(v.vat)}</dd></div>`).join("")}
    <div class="is-total"><dt>Total TTC</dt><dd>${formatMad(t.ttc)} MAD</dd></div>`;
}

function applyCatalogue(input) {
  const item = state.items.find((i) => i.label === input.value);
  if (!item) return;
  const row = input.closest(".pt-line");
  row.querySelector("[name=unit_price_ht]").value = formatMad(item.unit_price_ht);
  row.querySelector("[name=vat_rate]").value = String(Number(item.vat_rate));
}

async function openEditor(kind = "invoice", id = null) {
  const f = $("slDocForm");
  f.reset();
  setMsg("slDocMsg", "");
  let doc = { kind, lines: [{}] };
  if (id) doc = await loadDocument(id);
  state.editing = { id: doc.id || null, kind: doc.kind || kind };
  const isQuote = state.editing.kind === "quote";
  $("slDocTitle").textContent = doc.id
    ? (isQuote ? "Modifier le devis" : "Modifier la facture")
    : (isQuote ? "Nouveau devis" : "Nouvelle facture");
  f.elements.customer_id.innerHTML = customerOptions(doc.customer_id);
  f.elements.issue_date.value = doc.issue_date || today();
  f.elements.due_date.value = doc.due_date || "";
  $("slDocDueLabel").textContent = isQuote ? "Valable jusqu'au (facultatif)" : "Échéance (facultatif)";
  f.elements.payment_method.value = doc.payment_method || "virement";
  f.elements.notes.value = doc.notes || "";
  $("slDocLines").innerHTML = (doc.lines?.length ? doc.lines : [{}]).map(lineRow).join("");
  $("slItemList").innerHTML = state.items.map((i) => `<option value="${esc(i.label)}"></option>`).join("");
  $("slDocDelete").hidden = !doc.id;
  $("slDocIssue").textContent = isQuote ? "Émettre le devis" : "Émettre la facture";
  const missing = missingIssuerFields(state.client, state.settings);
  $("slDocMissing").hidden = !missing.length || isQuote;
  $("slDocMissing").textContent = missing.length ? `Avant d'émettre une facture, complétez vos réglages de facturation : ${missing.join(", ")}.` : "";
  updateTotals();
  if (!$("slDocDialog").open) $("slDocDialog").showModal();
}

async function submitDoc(event) {
  event.preventDefault();
  const action = event.submitter?.value || "draft";
  const f = $("slDocForm");
  const data = Object.fromEntries(new FormData(f));
  f.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  try {
    const id = await saveCreatedDraft(state.clientId, { ...data, id: state.editing.id, kind: state.editing.kind, lines: readLines() });
    state.editing.id = id;
    if (action === "preview") {
      window.open(documentUrl({ id }), "_blank", "noopener");
      await refreshSales();
      return;
    }
    if (action === "issue") await issueDocument(id);
    $("slDocDialog").close();
    await refreshSales();
    if (action === "issue") openDetail(id);
  } catch (err) {
    setMsg("slDocMsg", err.message);
    refreshSales().catch(() => {});
  } finally {
    f.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  }
}

async function removeCreatedDraft() {
  if (!state.editing?.id || !window.confirm("Supprimer ce brouillon ?")) return;
  try {
    await deleteCreatedDraft(state.editing.id);
    $("slDocDialog").close();
    await refreshSales();
  } catch (err) {
    setMsg("slDocMsg", err.message);
  }
}

// ---------------------------------------------------------------------------
// Réglages de facturation et numérotation
// ---------------------------------------------------------------------------
const SETTINGS_INPUTS = ["legal_form", "capital", "address", "city", "if_number", "rc_number", "rc_city", "tp_number", "phone", "email",
  "bank_name", "rib", "invoice_prefix", "credit_prefix", "quote_prefix", "default_payment_days", "quote_validity_days", "default_vat_rate", "footer_note"];

function renderSettings() {
  const f = $("slSettingsForm");
  if (!f || f.contains(document.activeElement)) return;
  for (const k of SETTINGS_INPUTS) if (f.elements[k]) f.elements[k].value = state.settings[k] ?? "";
  $("slIdentity").textContent = `${state.client?.name || ""} · ICE ${state.client?.ice || "non renseigné"}`;
  const logo = state.settings.logo_data;
  $("slLogoPreview").hidden = !logo;
  if (logo) $("slLogoPreview").src = logo;
  $("slLogoRemove").hidden = !logo;
  const year = new Date().getFullYear();
  const c = state.counters.find((x) => x.kind === "invoice" && x.year === year);
  const prefix = state.settings.invoice_prefix || "FAC";
  $("slNextNumber").textContent = `Prochaine facture : ${prefix}-${year}-${String((c?.last_seq || 0) + 1).padStart(4, "0")}`;
  $("slSeriesForm").elements.year.value = year;
  const missing = missingIssuerFields(state.client, state.settings);
  $("slSettingsMissing").hidden = !missing.length;
  $("slSettingsMissing").textContent = missing.length ? `À compléter pour émettre des factures : ${missing.join(", ")}.` : "";
}

async function submitSettings(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  delete data.logo;
  $("slSettingsSave").disabled = true;
  try {
    state.settings = await saveSettings(state.clientId, data);
    setMsg("slSettingsMsg", "Réglages enregistrés.", true);
    document.activeElement?.blur();
    renderSettings();
  } catch (err) {
    setMsg("slSettingsMsg", err.message);
  } finally {
    $("slSettingsSave").disabled = false;
  }
}

async function changeLogo(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const logo = await readLogo(file);
    state.settings = await saveSettings(state.clientId, { logo_data: logo });
    setMsg("slSettingsMsg", "Logo enregistré.", true);
  } catch (err) {
    setMsg("slSettingsMsg", err.message);
  }
  event.target.value = "";
  renderSettings();
}

async function removeLogo() {
  try {
    state.settings = await saveSettings(state.clientId, { logo_data: "" });
    renderSettings();
  } catch (err) {
    setMsg("slSettingsMsg", err.message);
  }
}

async function submitSeries(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await setLastNumber(data.year, data.last_seq);
    state.counters = await listCounters();
    setMsg("slSeriesMsg", "Série reprise : la prochaine facture suivra ce numéro.", true);
    renderSettings();
  } catch (err) {
    setMsg("slSeriesMsg", err.message);
  }
}

// ---------------------------------------------------------------------------
// Catalogue d'articles
// ---------------------------------------------------------------------------
function renderCatalogue() {
  if (!$("slItems")) return;
  $("slItemCount").textContent = state.items.length ? `(${state.items.length})` : "";
  $("slItems").innerHTML = state.items.length ? state.items.map((i) => `
    <li>
      <i data-lucide="package"></i>
      <div><strong>${esc(i.label)}</strong><span>${formatMad(i.unit_price_ht)} MAD HT${i.unit ? ` / ${esc(i.unit)}` : ""} · TVA ${Number(i.vat_rate)} %</span></div>
      <button type="button" class="pt-btn is-ghost" data-item="${i.id}">Modifier</button>
    </li>`).join("") : '<li class="pt-empty">Aucun article. Ajoutez vos produits ou prestations habituels pour les reprendre en un clic.</li>';
  icons();
}

function openItem(item = null) {
  const f = $("slItemForm");
  f.reset();
  f.dataset.id = item?.id || "";
  $("slItemTitle").textContent = item ? "Modifier l'article" : "Nouvel article";
  f.elements.label.value = item?.label || "";
  f.elements.unit.value = item?.unit || "";
  f.elements.unit_price_ht.value = item ? formatMad(item.unit_price_ht) : "";
  f.elements.vat_rate.value = String(Number(item?.vat_rate ?? state.settings.default_vat_rate ?? 20));
  $("slItemArchive").hidden = !item;
  setMsg("slItemMsg", "");
  $("slItemDialog").showModal();
}

async function submitItem(event) {
  event.preventDefault();
  const f = event.currentTarget;
  try {
    await saveItem(state.clientId, { ...Object.fromEntries(new FormData(f)), id: f.dataset.id ? Number(f.dataset.id) : null });
    $("slItemDialog").close();
    await refreshSales();
  } catch (err) {
    setMsg("slItemMsg", err.message);
  }
}

async function archiveCurrentItem() {
  const id = Number($("slItemForm").dataset.id);
  if (!id || !window.confirm("Retirer cet article du catalogue ?")) return;
  await archiveItem(id).catch((err) => setMsg("slItemMsg", err.message));
  $("slItemDialog").close();
  await refreshSales();
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
  state.client = ctx.client;
  $("slNewInvoice").addEventListener("click", () => {
    if (!state.customers.length) return openCustomer(null, { onSaved: () => openEditor("invoice") });
    return openEditor("invoice");
  });
  $("slNewQuote").addEventListener("click", () => {
    if (!state.customers.length) return openCustomer(null, { onSaved: () => openEditor("quote") });
    return openEditor("quote");
  });
  $("slDocForm").addEventListener("submit", submitDoc);
  $("slRemindList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-remind]");
    if (b) openReminder(Number(b.dataset.remind));
  });
  $("slRemindBtn").addEventListener("click", () => openReminder(state.current.id));
  $("slRemindForm").elements.level.addEventListener("change", fillReminder);
  $("slRemindCopy").addEventListener("click", () => recordReminder("copie"));
  $("slRemindMail").addEventListener("click", () => recordReminder("email"));
  $("slRemindCall").addEventListener("click", () => recordReminder("telephone"));
  $("slDocForm").addEventListener("input", (e) => {
    if (e.target.name === "label") applyCatalogue(e.target);
    updateTotals();
  });
  $("slDocForm").addEventListener("change", updateTotals);
  $("slAddLine").addEventListener("click", () => {
    $("slDocLines").insertAdjacentHTML("beforeend", lineRow());
    updateTotals();
    $("slDocLines").lastElementChild.querySelector("[name=label]").focus();
  });
  $("slDocLines").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove-line]");
    if (!rm) return;
    const rows = $("slDocLines").querySelectorAll(".pt-line");
    if (rows.length > 1) rm.closest(".pt-line").remove();
    updateTotals();
  });
  $("slDocDelete").addEventListener("click", removeCreatedDraft);
  $("slDocNewCustomer").addEventListener("click", () => {
    const keep = { lines: readLines() };
    $("slDocDialog").close();
    openCustomer(null, {
      onSaved: (c) => {
        $("slDocDialog").showModal();
        $("slDocForm").elements.customer_id.innerHTML = customerOptions(c.id);
        if (keep.lines.length) { $("slDocLines").innerHTML = keep.lines.map(lineRow).join(""); updateTotals(); }
      },
    });
  });
  $("slViewBtn").addEventListener("click", () => window.open(documentUrl({ id: state.current.id }), "_blank", "noopener"));
  $("slShareBtn").addEventListener("click", copyShareLink);
  $("slMailBtn").addEventListener("click", sendByMail);
  $("slCreditBtn").addEventListener("click", creditCurrent);
  $("slConvertBtn").addEventListener("click", convertCurrent);
  $("slRefuseBtn").addEventListener("click", refuseCurrent);
  $("slSettingsForm").addEventListener("submit", submitSettings);
  $("slLogoInput").addEventListener("change", changeLogo);
  $("slLogoRemove").addEventListener("click", removeLogo);
  $("slSeriesForm").addEventListener("submit", submitSeries);
  $("slAddItem").addEventListener("click", () => openItem());
  $("slItems").addEventListener("click", (e) => {
    const b = e.target.closest("[data-item]");
    if (b) openItem(state.items.find((i) => i.id === Number(b.dataset.item)));
  });
  $("slItemForm").addEventListener("submit", submitItem);
  $("slItemArchive").addEventListener("click", archiveCurrentItem);
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
