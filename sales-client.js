/**
 * Registre des ventes du client (portail) — phase 1.
 * Droits appliqués en base : migration 20261118210000_sales_register_phase1.sql
 * (le portail ne voit que les ventes de SA société).
 */
import { getSupabase } from "./auth-client.js?v=auth10";

export const SALES_BUCKET = "sales-documents";
export const SALES_MAX_BYTES = 50 * 1024 * 1024;

export const PAYMENT_METHODS = {
  virement: "Virement",
  cheque: "Chèque",
  especes: "Espèces",
  carte: "Carte",
  effet: "Effet / traite",
  prelevement: "Prélèvement",
  compensation: "Compensation",
  autre: "Autre",
};

export const SALES_FILTERS = [
  { key: "all", label: "Toutes" },
  { key: "unpaid", label: "À encaisser" },
  { key: "overdue", label: "En retard" },
  { key: "paid", label: "Payées" },
  { key: "draft", label: "À valider" },
];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** « 1 200,50 » / « 1200.5 » / « 1.200,50 » → 1200.5 ; vide ou illisible → NaN. */
export function parseAmount(value) {
  let s = String(value ?? "").trim().replace(/[\s  ]/g, "").replace(/(MAD|DH|DHS)$/i, "");
  if (!s) return NaN;
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else {
    s = s.replace(",", ".");
  }
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

export const formatMad = (n) =>
  (Number(n) || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Complète HT / TVA / TTC à partir de deux valeurs connues (taux par défaut si seul le HT ou le TTC est donné). */
export function completeAmounts({ ht, vat, ttc }, defaultRate = 20) {
  const has = (x) => Number.isFinite(x);
  if (has(ht) && has(vat) && !has(ttc)) ttc = ht + vat;
  else if (has(ht) && has(ttc) && !has(vat)) vat = ttc - ht;
  else if (has(vat) && has(ttc) && !has(ht)) ht = ttc - vat;
  else if (has(ht) && !has(vat) && !has(ttc)) { vat = ht * defaultRate / 100; ttc = ht + vat; }
  else if (has(ttc) && !has(ht) && !has(vat)) { ht = ttc / (1 + defaultRate / 100); vat = ttc - ht; }
  return { ht: round2(ht), vat: round2(vat), ttc: round2(ttc) };
}

/** État affiché d'une vente (ligne de la vue sales_invoices). */
export function saleState(sale) {
  if (sale.status === "draft") return { key: "draft", label: "À valider", tone: "warn" };
  if (sale.status === "voided") return { key: "voided", label: "Annulée", tone: "muted" };
  if (sale.payment_status === "paid") return { key: "paid", label: "Payée", tone: "ok" };
  if (sale.is_overdue) {
    const d = Number(sale.days_overdue) || 0;
    return { key: "overdue", label: `En retard de ${d} jour${d > 1 ? "s" : ""}`, tone: "stop" };
  }
  if (sale.payment_status === "partial") return { key: "partial", label: "Partiellement payée", tone: "warn" };
  return { key: "unpaid", label: "À encaisser", tone: "brand" };
}

export function filterSales(sales, filter) {
  return sales.filter((s) => {
    const k = saleState(s).key;
    switch (filter) {
      case "unpaid": return k === "unpaid" || k === "partial" || k === "overdue";
      case "overdue": return k === "overdue";
      case "paid": return k === "paid";
      case "draft": return k === "draft";
      default: return true;
    }
  });
}

/** Encaissé sur le mois (paiements datés du mois), reste en retard, reste à encaisser. */
export function salesSummary(sales, payments, today = new Date()) {
  const ym = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const live = new Set(sales.filter((s) => s.status === "issued").map((s) => s.id));
  const collectedMonth = payments
    .filter((p) => live.has(p.invoice_id) && String(p.paid_on).slice(0, 7) === ym)
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const open = sales.filter((s) => s.status === "issued" && Number(s.balance) > 0.005);
  const overdue = open.filter((s) => s.is_overdue);
  return {
    collectedMonth: round2(collectedMonth),
    overdueAmount: round2(overdue.reduce((sum, s) => sum + Number(s.balance), 0)),
    overdueCount: overdue.length,
    openAmount: round2(open.reduce((sum, s) => sum + Number(s.balance), 0)),
    openCount: open.length,
    draftCount: sales.filter((s) => s.status === "draft").length,
  };
}

// ---------------------------------------------------------------------------
// Accès aux données
// ---------------------------------------------------------------------------

function db() {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Connexion au service impossible");
  return supabase;
}

function fail(error) {
  if (!error) return;
  const msg = String(error.message || error);
  if (/sales_invoices|client_customers|issuer_client_id/.test(msg) && /does not exist|schema cache|column/i.test(msg)) {
    throw new Error("Le registre des ventes n'est pas encore installé sur la base de données.");
  }
  if (/invoices_issuer_external_number_uidx|duplicate key/i.test(msg)) {
    throw new Error("Cette facture est déjà enregistrée (même numéro).");
  }
  if (/client_customers_issuer_ice_uidx/.test(msg)) throw new Error("Un client avec cet ICE existe déjà.");
  if (/client_customers_ice_check/.test(msg)) throw new Error("L'ICE doit contenir 15 chiffres.");
  throw new Error(msg.replace(/^.*?ERROR:\s*/i, ""));
}

export async function listCustomers() {
  const { data, error } = await db().from("client_customers").select("*").order("name");
  fail(error);
  return data || [];
}

export async function saveCustomer(clientId, customer) {
  const payload = {
    name: String(customer.name || "").trim(),
    ice: String(customer.ice || "").replace(/\s/g, "") || null,
    if_number: String(customer.if_number || "").trim() || null,
    address: String(customer.address || "").trim() || null,
    city: String(customer.city || "").trim() || null,
    email: String(customer.email || "").trim() || null,
    phone: String(customer.phone || "").trim() || null,
    payment_days: customer.payment_days === "" || customer.payment_days == null ? null : Number(customer.payment_days),
  };
  if (!payload.name) throw new Error("Indiquez le nom du client.");
  if (payload.ice && !/^\d{15}$/.test(payload.ice)) throw new Error("L'ICE doit contenir 15 chiffres.");
  const query = customer.id
    ? db().from("client_customers").update(payload).eq("id", customer.id)
    : db().from("client_customers").insert({ ...payload, issuer_client_id: clientId });
  const { data, error } = await query.select().single();
  fail(error);
  return data;
}

export async function listSales() {
  const [sales, payments] = await Promise.all([
    db().from("sales_invoices").select("*").order("issue_date", { ascending: false, nullsFirst: true }).order("id", { ascending: false }),
    db().from("invoice_payments").select("id, invoice_id, paid_on, amount, method, reference, created_at").not("issuer_client_id", "is", null).order("paid_on"),
  ]);
  fail(sales.error);
  fail(payments.error);
  return { sales: sales.data || [], payments: payments.data || [] };
}

function salePayload(sale) {
  const amounts = completeAmounts({ ht: parseAmount(sale.ht), vat: parseAmount(sale.vat), ttc: parseAmount(sale.ttc) });
  return {
    customer_id: Number(sale.customer_id) || null,
    external_number: String(sale.external_number || "").trim() || null,
    issue_date: sale.issue_date || null,
    due_date: sale.due_date || null,
    total_ht: Number.isFinite(amounts.ht) ? amounts.ht : 0,
    total_vat: Number.isFinite(amounts.vat) ? amounts.vat : 0,
    total_ttc: Number.isFinite(amounts.ttc) ? amounts.ttc : 0,
    notes: String(sale.notes || "").trim() || null,
  };
}

/** Crée ou met à jour un brouillon (facture faite ailleurs). */
export async function saveSaleDraft(clientId, sale) {
  const payload = salePayload(sale);
  if (!payload.customer_id) throw new Error("Choisissez le client.");
  if (sale.document_path !== undefined) payload.document_path = sale.document_path || null;
  const query = sale.id
    ? db().from("invoices").update(payload).eq("id", sale.id)
    : db().from("invoices").insert({ ...payload, issuer_client_id: clientId, origin: "uploaded" });
  const { data, error } = await query.select("id").single();
  fail(error);
  return data.id;
}

export async function validateSale(id) {
  const { error } = await db().rpc("sales_validate_invoice", { p_invoice_id: id });
  fail(error);
}

export async function voidSale(id, reason) {
  const { error } = await db().rpc("sales_void_invoice", { p_invoice_id: id, p_reason: reason });
  fail(error);
}

export async function deleteSaleDraft(sale) {
  const { error } = await db().from("invoices").delete().eq("id", sale.id);
  fail(error);
  if (sale.document_path) await db().storage.from(SALES_BUCKET).remove([sale.document_path]).catch(() => {});
}

export async function addPayment(invoiceId, { paid_on, amount, method, reference }) {
  const value = parseAmount(amount);
  if (!(value > 0)) throw new Error("Indiquez un montant positif.");
  if (!paid_on) throw new Error("Indiquez la date du paiement.");
  const { error } = await db().from("invoice_payments").insert({
    invoice_id: invoiceId,
    paid_on,
    amount: round2(value),
    method: method || "virement",
    reference: String(reference || "").trim() || null,
  });
  fail(error);
}

export async function deletePayment(id) {
  const { error } = await db().from("invoice_payments").delete().eq("id", id);
  fail(error);
}

function safeName(name) {
  const base = String(name || "facture").split(/[/\\]/).pop();
  const ascii = base.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return ascii.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 150) || "facture";
}

const ACCEPTED = /^(application\/pdf|image\/(png|jpe?g|webp|heic|heif))$/i;
const ACCEPTED_EXT = /\.(pdf|png|jpe?g|webp|heic|heif)$/i;

export function checkSaleFile(file) {
  if (!ACCEPTED.test(file.type || "") && !ACCEPTED_EXT.test(file.name || "")) return "Format non accepté : envoyez un PDF ou une photo.";
  if (file.size > SALES_MAX_BYTES) return "Fichier trop lourd (50 Mo maximum).";
  if (!file.size) return "Fichier vide.";
  return "";
}

/** Dépose la pièce dans le stockage des ventes (jamais dans les documents du dossier). */
export async function uploadSaleDocument(clientId, file) {
  const problem = checkSaleFile(file);
  if (problem) throw new Error(problem);
  const path = `client/${clientId}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}_${safeName(file.name)}`;
  const contentType = file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : "application/octet-stream");
  const { error } = await db().storage.from(SALES_BUCKET).upload(path, file, { contentType, upsert: false });
  if (error) throw new Error(/size|large/i.test(error.message || "") ? "Fichier trop lourd." : "Envoi interrompu : vérifiez votre connexion et réessayez.");
  return path;
}

export async function saleDocumentUrl(path) {
  const { data, error } = await db().storage.from(SALES_BUCKET).createSignedUrl(path, 600);
  fail(error);
  return data?.signedUrl;
}
