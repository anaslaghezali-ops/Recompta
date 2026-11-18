/**
 * Registre des ventes du client (portail) — phase 1.
 * Droits appliqués en base : migration 20261118210000_sales_register_phase1.sql
 * (le portail ne voit que les ventes de SA société).
 */
import { getSupabase } from "./auth-client.js?v=auth10";
import { amountInWords, computeTotals } from "./billing-client.js?v=bill2";

export { amountInWords, computeTotals };

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
  { key: "all", label: "Factures" },
  { key: "unpaid", label: "À encaisser" },
  { key: "overdue", label: "En retard" },
  { key: "paid", label: "Payées" },
  { key: "draft", label: "Brouillons" },
  { key: "quotes", label: "Devis" },
];

export const VAT_RATES = [20, 14, 10, 7, 0];
const kindOf = (s) => s.kind || "invoice";

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
  const kind = kindOf(sale);
  if (kind === "quote") {
    if (sale.status === "draft") return { key: "draft", label: "Devis en brouillon", tone: "muted" };
    if (sale.status === "cancelled") return { key: "refused", label: "Devis refusé", tone: "muted" };
    if (sale.converted_invoice_id) return { key: "converted", label: "Devis accepté", tone: "ok" };
    if (sale.due_date && sale.due_date < new Date().toISOString().slice(0, 10)) return { key: "expired", label: "Devis expiré", tone: "warn" };
    return { key: "quote", label: "Devis envoyé", tone: "brand" };
  }
  if (kind === "credit_note") return { key: "credit", label: "Avoir", tone: "muted" };
  if (sale.status === "draft") {
    return sale.origin === "uploaded"
      ? { key: "draft", label: "À valider", tone: "warn" }
      : { key: "draft", label: "Brouillon", tone: "warn" };
  }
  if (sale.status === "voided") return { key: "voided", label: "Annulée", tone: "muted" };
  if (sale.status === "cancelled") return { key: "cancelled", label: "Annulée par avoir", tone: "muted" };
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
    const kind = kindOf(s);
    if (filter === "quotes") return kind === "quote";
    if (kind === "quote") return false;
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
  const invoices = sales.filter((s) => kindOf(s) === "invoice");
  const live = new Set(invoices.filter((s) => s.status === "issued").map((s) => s.id));
  const collectedMonth = payments
    .filter((p) => live.has(p.invoice_id) && String(p.paid_on).slice(0, 7) === ym)
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const open = invoices.filter((s) => s.status === "issued" && Number(s.balance) > 0.005);
  const overdue = open.filter((s) => s.is_overdue);
  return {
    collectedMonth: round2(collectedMonth),
    overdueAmount: round2(overdue.reduce((sum, s) => sum + Number(s.balance), 0)),
    overdueCount: overdue.length,
    openAmount: round2(open.reduce((sum, s) => sum + Number(s.balance), 0)),
    openCount: open.length,
    draftCount: invoices.filter((s) => s.status === "draft").length,
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

// ---------------------------------------------------------------------------
// Phase 2 : factures et devis créés dans Recompta, avoirs, réglages, catalogue
// ---------------------------------------------------------------------------

export async function loadSettings(clientId) {
  const { data, error } = await db().from("client_billing_settings").select("*").eq("client_id", clientId).maybeSingle();
  fail(error);
  return data || { client_id: clientId, invoice_prefix: "FAC", credit_prefix: "AV", quote_prefix: "DEV", default_payment_days: 30, default_vat_rate: 20, quote_validity_days: 30 };
}

const SETTINGS_FIELDS = ["legal_form", "capital", "address", "city", "if_number", "tp_number", "rc_number", "rc_city", "phone", "email",
  "bank_name", "rib", "invoice_prefix", "credit_prefix", "quote_prefix", "default_payment_days", "default_vat_rate", "quote_validity_days",
  "footer_note", "logo_data"];

export async function saveSettings(clientId, values) {
  const payload = { client_id: clientId, updated_at: new Date().toISOString() };
  for (const k of SETTINGS_FIELDS) {
    if (!(k in values)) continue;
    let v = values[k];
    if (typeof v === "string") v = v.trim();
    if (["default_payment_days", "quote_validity_days", "default_vat_rate"].includes(k)) v = v === "" || v == null ? undefined : Number(v);
    if (k === "rib" && v) v = String(v).replace(/\s/g, "");
    if (["invoice_prefix", "credit_prefix", "quote_prefix"].includes(k)) v = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "") || undefined;
    if (v === undefined) continue;
    payload[k] = v === "" ? null : v;
  }
  if (payload.rib && !/^\d{24}$/.test(payload.rib)) throw new Error("Le RIB doit contenir 24 chiffres.");
  const { data, error } = await db().from("client_billing_settings").upsert(payload, { onConflict: "client_id" }).select().single();
  fail(error);
  return data;
}

/** Mentions manquantes pour émettre une facture (même règle que la base). */
export function missingIssuerFields(client, settings) {
  const out = [];
  if (!/^\d{15}$/.test(String(client?.ice || ""))) out.push("ICE (fiche tenue par votre cabinet)");
  if (!String(settings?.address || "").trim()) out.push("adresse");
  if (!String(settings?.if_number || "").trim()) out.push("IF");
  if (!String(settings?.rc_number || "").trim()) out.push("RC");
  if (!String(settings?.tp_number || "").trim()) out.push("patente (TP)");
  return out;
}

export async function listCounters() {
  const { data, error } = await db().from("billing_counters").select("kind, year, last_seq").not("issuer_client_id", "is", null);
  fail(error);
  return data || [];
}

export async function setLastNumber(year, lastSeq) {
  const { error } = await db().rpc("sales_set_last_number", { p_year: Number(year), p_last_seq: Number(lastSeq) });
  fail(error);
}

export async function listItems() {
  const { data, error } = await db().from("client_items").select("*").eq("is_active", true).order("label");
  fail(error);
  return data || [];
}

export async function saveItem(clientId, item) {
  const payload = {
    label: String(item.label || "").trim(),
    unit: String(item.unit || "").trim() || null,
    unit_price_ht: round2(parseAmount(item.unit_price_ht) || 0),
    vat_rate: Number(item.vat_rate ?? 20),
  };
  if (!payload.label) throw new Error("Indiquez la désignation.");
  const query = item.id
    ? db().from("client_items").update(payload).eq("id", item.id)
    : db().from("client_items").insert({ ...payload, issuer_client_id: clientId });
  const { error } = await query;
  fail(error);
}

export async function archiveItem(id) {
  const { error } = await db().from("client_items").update({ is_active: false }).eq("id", id);
  fail(error);
}

export async function loadDocument(id) {
  const [inv, lines] = await Promise.all([
    db().from("invoices").select("*").eq("id", id).maybeSingle(),
    db().from("invoice_lines").select("*").eq("invoice_id", id).order("position").order("id"),
  ]);
  fail(inv.error);
  fail(lines.error);
  if (!inv.data) throw new Error("Document introuvable");
  return { ...inv.data, lines: lines.data || [] };
}

/** Enregistre un brouillon de facture ou de devis (lignes remplacées). */
export async function saveCreatedDraft(clientId, doc) {
  const lines = (doc.lines || [])
    .map((l, i) => ({
      position: i + 1,
      label: String(l.label || "").trim(),
      quantity: Number(parseAmount(l.quantity)) || 0,
      unit_price_ht: round2(parseAmount(l.unit_price_ht) || 0),
      vat_rate: Number(l.vat_rate ?? 20),
    }))
    .filter((l) => l.label || l.unit_price_ht);
  if (!Number(doc.customer_id)) throw new Error("Choisissez le client.");
  if (lines.some((l) => !l.label)) throw new Error("Chaque ligne doit avoir une désignation.");
  const header = {
    customer_id: Number(doc.customer_id),
    issue_date: doc.issue_date || null,
    due_date: doc.due_date || null,
    payment_method: doc.payment_method || null,
    notes: String(doc.notes || "").trim() || null,
  };
  let id = doc.id;
  if (id) {
    const { error } = await db().from("invoices").update(header).eq("id", id);
    fail(error);
    const del = await db().from("invoice_lines").delete().eq("invoice_id", id);
    fail(del.error);
  } else {
    const { data, error } = await db().from("invoices")
      .insert({ ...header, issuer_client_id: clientId, origin: "created", kind: doc.kind === "quote" ? "quote" : "invoice" })
      .select("id").single();
    fail(error);
    id = data.id;
  }
  if (lines.length) {
    const { error } = await db().from("invoice_lines").insert(lines.map((l) => ({ ...l, invoice_id: id })));
    fail(error);
  }
  return id;
}

export async function deleteCreatedDraft(id) {
  const { error } = await db().from("invoices").delete().eq("id", id);
  fail(error);
}

export async function issueDocument(id) {
  const { data, error } = await db().rpc("sales_issue_invoice", { p_invoice_id: id });
  fail(error);
  return data;
}

export async function creditInvoice(id, reason) {
  const { data, error } = await db().rpc("sales_credit_invoice", { p_invoice_id: id, p_reason: reason });
  fail(error);
  return data;
}

export async function convertQuote(id) {
  const { data, error } = await db().rpc("sales_convert_quote", { p_quote_id: id });
  fail(error);
  return data;
}

export async function refuseQuote(id) {
  const { error } = await db().rpc("sales_refuse_quote", { p_quote_id: id });
  fail(error);
}

export function documentUrl({ id = null, token = null } = {}) {
  const base = new URL("vente.html", window.location.href).href.split("#")[0].split("?")[0];
  return token ? `${base}#t=${token}` : `${base}?id=${id}`;
}

export async function shareLink(id) {
  const { data, error } = await db().rpc("sales_share_token", { p_invoice_id: id });
  fail(error);
  return documentUrl({ token: data });
}

export async function publicDocument(token) {
  const { data, error } = await db().rpc("sales_public_document", { p_token: token });
  fail(error);
  return data;
}

export const DOC_TITLES = { invoice: "Facture", credit_note: "Avoir", quote: "Devis" };

/** Message prêt à envoyer (email) avec le lien du document. */
export function mailtoLink({ to = "", kind = "invoice", number = "", total = 0, dueDate = null, sellerName = "", url = "" }) {
  const title = DOC_TITLES[kind] || "Facture";
  const subject = `${title} ${number} — ${sellerName}`.trim();
  const lines = [
    "Bonjour,",
    "",
    `Veuillez trouver ${kind === "quote" ? "notre devis" : kind === "credit_note" ? "notre avoir" : "notre facture"} n° ${number} d'un montant de ${formatMad(Math.abs(total))} MAD TTC${dueDate && kind === "invoice" ? `, à régler avant le ${new Date(`${dueDate}T12:00:00`).toLocaleDateString("fr-FR")}` : ""}.`,
    "",
    `Consulter et imprimer le document : ${url}`,
    "",
    "Cordialement,",
    sellerName,
  ];
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
}

/** Réduit un logo (fichier image) en data URL de 400 px de large au plus. */
export function readLogo(file, maxWidth = 400) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type || "")) return reject(new Error("Logo : PNG, JPEG ou WebP."));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      let data = canvas.toDataURL("image/png");
      if (data.length > 380000) data = canvas.toDataURL("image/jpeg", 0.85);
      if (data.length > 380000) return reject(new Error("Logo trop lourd, choisissez une image plus simple."));
      resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image illisible.")); };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Phase 3 : relances
// ---------------------------------------------------------------------------

export const REMINDER_LEVELS = {
  1: "Rappel courtois",
  2: "Relance",
  3: "Dernière relance avant recouvrement",
};
export const REMINDER_CHANNELS = { email: "Email", copie: "Message copié", telephone: "Téléphone", courrier: "Courrier" };

const frDate = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString("fr-FR") : "");

/** Message de relance prérempli, ton courtois qui se raffermit avec le niveau. */
export function reminderMessage({ level = 1, sellerName = "", customerName = "", number = "", issueDate = null, total = 0, balance = 0, dueDate = null, daysOverdue = 0, url = "" }) {
  const amount = `${formatMad(balance)} MAD`;
  const ref = `notre facture n° ${number}${issueDate ? ` du ${frDate(issueDate)}` : ""} (${formatMad(total)} MAD TTC)`;
  const late = daysOverdue > 0 ? `, échue depuis le ${frDate(dueDate)} (${daysOverdue} jour${daysOverdue > 1 ? "s" : ""})` : dueDate ? `, à échéance du ${frDate(dueDate)}` : "";
  const body = {
    1: [
      `Sauf erreur de notre part, ${ref} reste à régler${late}. Le montant restant dû est de ${amount}.`,
      "Il s'agit peut-être d'un simple oubli : pourriez-vous nous indiquer la date de règlement prévue ?",
      "Si le paiement a déjà été effectué, merci de ne pas tenir compte de ce message.",
    ],
    2: [
      `Malgré notre précédent rappel, ${ref} reste impayée${late}. Le montant restant dû est de ${amount}.`,
      "Nous vous remercions de procéder au règlement dans les meilleurs délais, ou de nous contacter si un point bloque le paiement.",
    ],
    3: [
      `Nos précédentes relances concernant ${ref} sont restées sans effet${late}. Le montant restant dû est de ${amount}.`,
      "Sans règlement sous 8 jours, nous serons contraints d'engager une procédure de recouvrement.",
      "Nous restons à votre disposition pour trouver une solution amiable d'ici là.",
    ],
  }[level] || [];
  return [
    `Bonjour${customerName ? ` ${customerName}` : ""},`,
    "",
    ...body,
    ...(url ? ["", `Facture consultable ici : ${url}`] : []),
    "",
    "Cordialement,",
    sellerName,
  ].join("\n");
}

export function reminderMailto({ to = "", level = 1, number = "", sellerName = "", message = "" }) {
  const subject = `${REMINDER_LEVELS[level] || "Relance"} — facture ${number} — ${sellerName}`;
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
}

export async function listReminders(invoiceId) {
  const { data, error } = await db().from("sales_reminders").select("*").eq("invoice_id", invoiceId).order("sent_at", { ascending: false });
  fail(error);
  return data || [];
}

export async function addReminder({ invoiceId, level, channel, message, note = null }) {
  const { error } = await db().from("sales_reminders").insert({ invoice_id: invoiceId, level: Number(level), channel, message, note });
  fail(error);
}

/** Factures à relancer : en retard, triées par ancienneté du retard. */
export function toRemind(sales) {
  return sales
    .filter((s) => (s.kind || "invoice") === "invoice" && s.is_overdue)
    .sort((a, b) => (Number(b.days_overdue) || 0) - (Number(a.days_overdue) || 0));
}

/** Niveau conseillé : 1 au premier rappel, puis +1 (au plus 3). */
export const nextReminderLevel = (sale) => Math.min(3, (Number(sale.reminder_count) || 0) + 1);
