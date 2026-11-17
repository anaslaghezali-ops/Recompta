/**
 * Facturation des honoraires du cabinet : accès aux données et règles métier.
 * Les contrôles (numérotation, immutabilité, droits) sont faits en base
 * (migration 20261117200000_billing.sql) ; ce module ne fait que les appeler.
 */
import { getSupabase } from "./auth-client.js?v=auth10";

function db() {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");
  return supabase;
}

function fail(error) {
  if (!error) return;
  const msg = String(error.message || error);
  if (/relation .*invoices|does not exist|schema cache/i.test(msg)) {
    throw new Error("La facturation n'est pas encore installée sur la base de données.");
  }
  throw new Error(msg.replace(/^.*?ERROR:\s*/i, ""));
}

// ---------------------------------------------------------------------------
// Formatage
// ---------------------------------------------------------------------------

const madFormat = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatMAD = (value) => `${madFormat.format(Number(value) || 0).replace(/ | /g, " ")} DH`;
export const formatDate = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString("fr-FR") : "—");
export const todayIso = () => new Date().toISOString().slice(0, 10);
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const PAYMENT_METHODS = {
  virement: "Virement",
  cheque: "Chèque",
  especes: "Espèces",
  effet: "Effet / LCN",
  carte: "Carte bancaire",
};

const UNITS = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix",
  "onze", "douze", "treize", "quatorze", "quinze", "seize"];
const TENS = { 20: "vingt", 30: "trente", 40: "quarante", 50: "cinquante", 60: "soixante" };

function under100(n) {
  if (n <= 16) return UNITS[n];
  if (n < 20) return `dix-${UNITS[n - 10]}`;
  if (n < 70) {
    const t = Math.floor(n / 10) * 10;
    const u = n % 10;
    if (!u) return TENS[t];
    return u === 1 ? `${TENS[t]} et un` : `${TENS[t]}-${UNITS[u]}`;
  }
  if (n < 80) return n === 71 ? "soixante et onze" : `soixante-${under100(n - 60)}`;
  if (n === 80) return "quatre-vingts";
  return `quatre-vingt-${under100(n - 80)}`;
}

function under1000(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  let out = "";
  if (h === 1) out = "cent";
  else if (h > 1) out = `${UNITS[h]} cent${rest === 0 ? "s" : ""}`;
  if (rest) out = out ? `${out} ${under100(rest)}` : under100(rest);
  return out || "zéro";
}

function integerToWords(n) {
  if (n === 0) return "zéro";
  const parts = [];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  if (millions) parts.push(`${under1000(millions)} million${millions > 1 ? "s" : ""}`);
  if (thousands) parts.push(thousands === 1 ? "mille" : `${under1000(thousands).replace(/cents$/, "cent").replace(/vingts$/, "vingt")} mille`);
  if (rest) parts.push(under1000(rest));
  return parts.join(" ");
}

/** « Arrêtée la présente facture à la somme de : … dirhams et … centimes » */
export function amountInWords(value) {
  const abs = Math.abs(round2(value));
  const dh = Math.floor(abs);
  const cts = Math.round((abs - dh) * 100);
  let text = `${integerToWords(dh)} dirham${dh > 1 ? "s" : ""}`;
  if (cts) text += ` et ${integerToWords(cts)} centime${cts > 1 ? "s" : ""}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Statuts
// ---------------------------------------------------------------------------

/** Statut affiché : brouillon, envoyée, partielle, payée, en retard, annulée, avoir. */
export function invoiceState(invoice, payments = []) {
  const paid = round2(payments.reduce((s, p) => s + Number(p.amount || 0), 0));
  const total = round2(invoice.total_ttc);
  const remaining = round2(Math.max(total - paid, 0));
  let key;
  if (invoice.kind === "credit_note") key = "credit";
  else if (invoice.status === "draft") key = "draft";
  else if (invoice.status === "cancelled") key = "cancelled";
  else if (remaining <= 0.009) key = "paid";
  else if (invoice.due_date && invoice.due_date < todayIso()) key = "late";
  else if (paid > 0) key = "partial";
  else if (invoice.sent_at) key = "sent";
  else key = "issued";
  const labels = {
    draft: "Brouillon",
    issued: "À envoyer",
    sent: "Envoyée",
    partial: "Partiellement payée",
    paid: "Payée",
    late: "En retard",
    cancelled: "Annulée",
    credit: "Avoir",
  };
  const tones = { draft: "muted", issued: "info", sent: "info", partial: "warn", paid: "ok", late: "stop", cancelled: "muted", credit: "muted" };
  const due = invoice.due_date ? Math.round((new Date(`${invoice.due_date}T00:00:00`) - new Date(`${todayIso()}T00:00:00`)) / 86400000) : null;
  return { key, label: labels[key], tone: tones[key], paid, remaining: key === "cancelled" || key === "credit" || key === "draft" ? 0 : remaining, daysToDue: due };
}

// ---------------------------------------------------------------------------
// Réglages du cabinet et catalogue
// ---------------------------------------------------------------------------

export async function loadBillingSettings(cabinetId) {
  const { data, error } = await db().from("cabinet_billing_settings").select("*").eq("cabinet_id", cabinetId).maybeSingle();
  fail(error);
  return data || { cabinet_id: cabinetId, invoice_prefix: "FAC", credit_prefix: "AV", default_payment_days: 30, default_vat_rate: 20 };
}

export async function saveBillingSettings(cabinetId, values) {
  const payload = { ...values, cabinet_id: cabinetId, updated_at: new Date().toISOString() };
  const { data, error } = await db().from("cabinet_billing_settings").upsert(payload, { onConflict: "cabinet_id" }).select().maybeSingle();
  fail(error);
  return data;
}

/** Champs obligatoires (art. 145 CGI) encore vides. */
export function missingLegalFields(settings) {
  const required = [["legal_name", "raison sociale"], ["address", "adresse du siège"], ["ice", "ICE"], ["if_number", "IF"],
    ["tp_number", "taxe professionnelle"], ["rc_number", "RC"]];
  return required.filter(([k]) => !String(settings?.[k] || "").trim()).map(([, label]) => label);
}

export async function listServices(cabinetId) {
  const { data, error } = await db().from("billing_services").select("*").eq("cabinet_id", cabinetId).order("label");
  fail(error);
  return data || [];
}

export async function saveService(cabinetId, service) {
  const payload = {
    cabinet_id: cabinetId,
    label: String(service.label || "").trim(),
    unit_price_ht: round2(service.unit_price_ht),
    vat_rate: Number(service.vat_rate ?? 20),
    is_active: service.is_active !== false,
  };
  const query = service.id
    ? db().from("billing_services").update(payload).eq("id", service.id)
    : db().from("billing_services").insert(payload);
  const { error } = await query;
  fail(error);
}

export async function deleteService(id) {
  const { error } = await db().from("billing_services").delete().eq("id", id);
  fail(error);
}

// ---------------------------------------------------------------------------
// Clients (coordonnées de facturation)
// ---------------------------------------------------------------------------

export async function listBillingClients(cabinetId) {
  const { data, error } = await db()
    .from("cabinet_clients")
    .select("id, name, ice, billing_address, billing_city, billing_email, billing_phone, billing_if")
    .eq("cabinet_id", cabinetId)
    .order("name");
  fail(error);
  return data || [];
}

export async function saveClientBillingInfo(clientId, info) {
  const payload = {};
  for (const k of ["billing_address", "billing_city", "billing_email", "billing_phone", "billing_if"]) {
    if (k in info) payload[k] = String(info[k] || "").trim() || null;
  }
  const { error } = await db().from("cabinet_clients").update(payload).eq("id", clientId);
  fail(error);
}

// ---------------------------------------------------------------------------
// Factures
// ---------------------------------------------------------------------------

/** Factures (+ lignes et paiements) du cabinet, éventuellement d'un client. */
export async function listInvoices(cabinetId, { clientId = null } = {}) {
  let query = db().from("invoices").select("*").eq("cabinet_id", cabinetId).order("created_at", { ascending: false });
  if (clientId) query = query.eq("client_id", clientId);
  const { data: invoices, error } = await query;
  fail(error);
  const ids = (invoices || []).map((i) => i.id);
  let payments = [];
  if (ids.length) {
    const res = await db().from("invoice_payments").select("*").in("invoice_id", ids).order("paid_on", { ascending: true });
    fail(res.error);
    payments = res.data || [];
  }
  const byInvoice = {};
  for (const p of payments) (byInvoice[p.invoice_id] ||= []).push(p);
  return (invoices || []).map((inv) => {
    const pays = byInvoice[inv.id] || [];
    return { ...inv, payments: pays, state: invoiceState(inv, pays) };
  });
}

export async function loadInvoice(id) {
  const { data: invoice, error } = await db().from("invoices").select("*").eq("id", id).maybeSingle();
  fail(error);
  if (!invoice) throw new Error("Facture introuvable");
  const [lines, payments] = await Promise.all([
    db().from("invoice_lines").select("*").eq("invoice_id", id).order("position"),
    db().from("invoice_payments").select("*").eq("invoice_id", id).order("paid_on"),
  ]);
  fail(lines.error);
  fail(payments.error);
  return { ...invoice, lines: lines.data || [], payments: payments.data || [], state: invoiceState(invoice, payments.data || []) };
}

/** Crée ou met à jour un brouillon et remplace ses lignes. */
export async function saveDraft({ id = null, cabinetId, clientId, issueDate, dueDate, paymentMethod, notes, lines }) {
  const header = {
    client_id: clientId,
    issue_date: issueDate || null,
    due_date: dueDate || null,
    payment_method: paymentMethod || null,
    notes: String(notes || "").trim() || null,
  };
  let invoiceId = id;
  if (invoiceId) {
    const { error } = await db().from("invoices").update(header).eq("id", invoiceId);
    fail(error);
    const del = await db().from("invoice_lines").delete().eq("invoice_id", invoiceId);
    fail(del.error);
  } else {
    const { data, error } = await db().from("invoices").insert({ ...header, cabinet_id: cabinetId }).select("id").single();
    fail(error);
    invoiceId = data.id;
  }
  const rows = (lines || [])
    .filter((l) => String(l.label || "").trim() || Number(l.unit_price_ht))
    .map((l, i) => ({
      invoice_id: invoiceId,
      position: i + 1,
      label: String(l.label || "").trim(),
      quantity: Number(l.quantity) || 0,
      unit_price_ht: round2(l.unit_price_ht),
      vat_rate: Number(l.vat_rate ?? 20),
    }));
  if (rows.length) {
    const { error } = await db().from("invoice_lines").insert(rows);
    fail(error);
  }
  return invoiceId;
}

export async function deleteDraft(id) {
  const { error } = await db().from("invoices").delete().eq("id", id);
  fail(error);
}

export async function issueInvoice(id) {
  const { data, error } = await db().rpc("billing_issue_invoice", { p_invoice_id: id });
  fail(error);
  return data;
}

export async function cancelInvoice(id, reason) {
  const { data, error } = await db().rpc("billing_cancel_invoice", { p_invoice_id: id, p_reason: reason });
  fail(error);
  return data;
}

export async function markInvoiceSent(id) {
  const { error } = await db().from("invoices").update({ sent_at: new Date().toISOString() }).eq("id", id);
  fail(error);
}

export async function addPayment({ invoiceId, cabinetId, amount, paidOn, method, reference }) {
  const { error } = await db().from("invoice_payments").insert({
    invoice_id: invoiceId,
    cabinet_id: cabinetId,
    amount: round2(amount),
    paid_on: paidOn || todayIso(),
    method: method || "virement",
    reference: String(reference || "").trim() || null,
  });
  fail(error);
}

export async function deletePayment(id) {
  const { error } = await db().from("invoice_payments").delete().eq("id", id);
  fail(error);
}

/** Totaux d'une liste de lignes (calcul identique à la base). */
export function computeTotals(lines) {
  let ht = 0;
  let vat = 0;
  const byRate = {};
  for (const l of lines || []) {
    const lineHt = round2((Number(l.quantity) || 0) * (Number(l.unit_price_ht) || 0));
    const rate = Number(l.vat_rate ?? 20);
    const lineVat = round2((lineHt * rate) / 100);
    ht += lineHt;
    vat += lineVat;
    byRate[rate] = byRate[rate] || { ht: 0, vat: 0 };
    byRate[rate].ht = round2(byRate[rate].ht + lineHt);
    byRate[rate].vat = round2(byRate[rate].vat + lineVat);
  }
  return { ht: round2(ht), vat: round2(vat), ttc: round2(ht + vat), byRate };
}

/** Synthèse « qui me doit quoi » : par client, montants dus par ancienneté. */
export function receivablesByClient(invoices) {
  const map = {};
  for (const inv of invoices) {
    if (inv.kind !== "invoice" || inv.status !== "issued" || inv.state.remaining <= 0) continue;
    const row = (map[inv.client_id] ||= { client_id: inv.client_id, total: 0, late: 0, b30: 0, b60: 0, b60p: 0, count: 0, oldestDue: null });
    const rem = inv.state.remaining;
    row.total = round2(row.total + rem);
    row.count += 1;
    const overdue = inv.state.daysToDue !== null && inv.state.daysToDue < 0 ? -inv.state.daysToDue : 0;
    if (overdue > 0) row.late = round2(row.late + rem);
    if (overdue <= 30) row.b30 = round2(row.b30 + rem);
    else if (overdue <= 60) row.b60 = round2(row.b60 + rem);
    else row.b60p = round2(row.b60p + rem);
    if (!row.oldestDue || (inv.due_date && inv.due_date < row.oldestDue)) row.oldestDue = inv.due_date;
  }
  return Object.values(map).sort((a, b) => b.late - a.late || b.total - a.total);
}
