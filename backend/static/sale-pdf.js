/**
 * PDF d'une facture, d'un devis ou d'un avoir créé dans Recompta, pour le
 * téléchargement groupé (vue Tous les documents / Archives). Même contenu que
 * vente.html (imprimable), dessiné directement avec jsPDF : pas de capture d'écran,
 * texte sélectionnable, quelques dizaines de Ko par document.
 */
import { getSupabase } from "./auth-client.js?v=auth10";
import { PAYMENT_METHODS, amountInWords, computeTotals, formatDate, formatMAD } from "./billing-client.js?v=bill2";
import { DOC_TITLES, loadDocument, loadSettings } from "./sales-client.js?v=sales3";

const JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js";
const METHODS = { ...PAYMENT_METHODS, prelevement: "Prélèvement", compensation: "Compensation", autre: "Autre" };

let jspdfPromise = null;
function loadJsPdf() {
  if (globalThis.jspdf?.jsPDF) return Promise.resolve(globalThis.jspdf.jsPDF);
  if (!jspdfPromise) {
    jspdfPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = JSPDF_URL;
      script.onload = () => (globalThis.jspdf?.jsPDF ? resolve(globalThis.jspdf.jsPDF) : reject(new Error("jsPDF indisponible")));
      script.onerror = () => {
        jspdfPromise = null;
        reject(new Error("Impossible de charger le générateur de PDF (connexion ?)."));
      };
      document.head.appendChild(script);
    });
  }
  return jspdfPromise;
}

/** Charge un document de vente avec vendeur, acheteur et logo (comme vente.html). */
export async function loadSaleForPrint(id) {
  const doc = await loadDocument(id);
  const db = getSupabase();
  let seller = doc.seller_snapshot;
  let client = doc.client_snapshot;
  const settings = await loadSettings(doc.issuer_client_id).catch(() => ({}));
  if (doc.status === "draft" || !seller || !client) {
    const [{ data: issuer }, { data: cust }] = await Promise.all([
      db.from("cabinet_clients").select("name, ice").eq("id", doc.issuer_client_id).maybeSingle(),
      db.from("client_customers").select("*").eq("id", doc.customer_id).maybeSingle(),
    ]);
    seller = { ...settings, legal_name: issuer?.name, ice: issuer?.ice };
    client = { name: cust?.name, ice: cust?.ice, if: cust?.if_number, address: cust?.address, city: cust?.city };
  }
  let original = null;
  if (doc.credits_invoice_id) {
    const { data } = await db.from("invoices").select("number, issue_date").eq("id", doc.credits_invoice_id).maybeSingle();
    original = data;
  }
  return { ...doc, seller: seller || {}, client: client || {}, logo: settings?.logo_data || null, original };
}

/** Le PDF n'accepte que les caractères Latin-1 avec les polices standard. */
const clean = (text) => String(text ?? "")
  .replace(/[  ]/g, " ")
  .replace(/[’‘]/g, "'")
  .replace(/[“”«»]/g, '"')
  .replace(/[–—]/g, "-")
  .replace(/[^\x20-\x7e -ÿ\n]/g, "");

/** Construit le PDF (Uint8Array) d'un document chargé par loadSaleForPrint. */
export async function renderSalePdf(doc) {
  const JsPDF = await loadJsPdf();
  const pdf = new JsPDF({ unit: "mm", format: "a4" });
  const W = 210;
  const M = 16;
  const kind = doc.kind || "invoice";
  const isDraft = doc.status === "draft";
  const isCredit = kind === "credit_note";
  const isQuote = kind === "quote";
  const title = DOC_TITLES[kind] || "Facture";
  const seller = doc.seller || {};
  const client = doc.client || {};
  const t = computeTotals(doc.lines);
  const ht = isDraft ? t.ht : Number(doc.total_ht);
  const vat = isDraft ? t.vat : Number(doc.total_vat);
  const ttc = isDraft ? t.ttc : Number(doc.total_ttc);
  const ink = [22, 35, 58];
  const muted = [100, 112, 130];

  pdf.setProperties({ title: clean(`${title} ${doc.number || ""}`), creator: "Recompta" });
  pdf.setTextColor(...ink);

  // Filigrane
  const watermark = isDraft ? "Brouillon"
    : doc.status === "cancelled" ? (isQuote ? "Refusé" : "Annulée")
    : doc.status === "voided" ? "Annulée" : "";
  if (watermark) {
    pdf.setFontSize(70);
    pdf.setTextColor(235, 225, 225);
    pdf.text(clean(watermark), W / 2, 160, { align: "center", angle: 30 });
    pdf.setTextColor(...ink);
  }

  // Vendeur
  let y = M;
  if (doc.logo && /^data:image\/(png|jpe?g);base64,/i.test(doc.logo)) {
    try {
      const props = pdf.getImageProperties(doc.logo);
      const h = 18;
      const w = Math.min(46, (props.width / props.height) * h);
      pdf.addImage(doc.logo, M, y, w, (w / props.width) * props.height);
      y += 22;
    } catch { /* logo illisible : ignoré */ }
  }
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(12);
  pdf.text(clean(seller.legal_name || ""), M, y + 4);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  let sy = y + 9;
  const sellerLines = [
    seller.legal_form ? `${seller.legal_form}${seller.capital ? ` au capital de ${seller.capital}` : ""}` : "",
    seller.address, seller.city,
    seller.ice ? `ICE ${seller.ice}` : "",
    seller.phone ? `Tél. ${seller.phone}` : "",
    seller.email,
  ].filter(Boolean);
  for (const l of sellerLines) {
    pdf.text(clean(l), M, sy);
    sy += 4.4;
  }

  // Titre, numéro, dates
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(20);
  pdf.text(clean(title), W - M, M + 6, { align: "right" });
  pdf.setFontSize(10);
  pdf.text(clean(`N° ${doc.number || "Brouillon"}`), W - M, M + 13, { align: "right" });
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  let ty = M + 19;
  const meta = [
    ["Date", formatDate(doc.issue_date)],
    !isCredit && doc.due_date ? [isQuote ? "Valable jusqu'au" : "Échéance", formatDate(doc.due_date)] : null,
    doc.original ? ["Facture annulée", `${doc.original.number} du ${formatDate(doc.original.issue_date)}`] : null,
  ].filter(Boolean);
  for (const [k, v] of meta) {
    pdf.setTextColor(...muted);
    pdf.text(clean(k), W - M - 42, ty, { align: "right" });
    pdf.setTextColor(...ink);
    pdf.text(clean(v), W - M, ty, { align: "right" });
    ty += 5;
  }

  // Acheteur
  y = Math.max(sy, ty) + 6;
  const boxX = W / 2;
  const clientLines = [client.address, client.city, client.ice ? `ICE ${client.ice}` : "", client.if ? `IF ${client.if}` : ""].filter(Boolean);
  const boxH = 12 + clientLines.length * 4.4;
  pdf.setDrawColor(210, 216, 225);
  pdf.roundedRect(boxX, y, W - M - boxX, boxH, 1.5, 1.5);
  pdf.setTextColor(...muted);
  pdf.setFontSize(8);
  pdf.text(isQuote ? "Destinataire" : "Facturé à", boxX + 4, y + 5);
  pdf.setTextColor(...ink);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10);
  pdf.text(clean(client.name || ""), boxX + 4, y + 10);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  clientLines.forEach((l, i) => pdf.text(clean(l), boxX + 4, y + 14.5 + i * 4.4));
  y += boxH + 8;

  if (isCredit && doc.reason) {
    pdf.text(clean(`Motif : ${doc.reason}`), M, y);
    y += 7;
  }

  // Lignes
  const cols = [
    { label: "Désignation", x: M, align: "left" },
    { label: "Qté", x: 118, align: "right" },
    { label: "Prix unitaire HT", x: 148, align: "right" },
    { label: "TVA", x: 163, align: "right" },
    { label: "Total HT", x: W - M, align: "right" },
  ];
  const header = () => {
    pdf.setFillColor(243, 245, 248);
    pdf.rect(M, y - 4.5, W - 2 * M, 7, "F");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8.5);
    for (const c of cols) pdf.text(c.label, c.x + (c.align === "left" ? 2 : 0), y, { align: c.align });
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    y += 7;
  };
  header();
  for (const l of doc.lines || []) {
    const label = pdf.splitTextToSize(clean(l.label), 92);
    const rowH = Math.max(1, label.length) * 4.4 + 1.6;
    if (y + rowH > 270) {
      pdf.addPage();
      y = M + 6;
      header();
    }
    pdf.text(label, M + 2, y);
    const lineHt = l.total_ht ?? Number(l.quantity) * Number(l.unit_price_ht);
    pdf.text(clean(Number(l.quantity).toLocaleString("fr-FR")), cols[1].x, y, { align: "right" });
    pdf.text(clean(formatMAD(l.unit_price_ht)), cols[2].x, y, { align: "right" });
    pdf.text(`${Number(l.vat_rate)} %`, cols[3].x, y, { align: "right" });
    pdf.text(clean(formatMAD(lineHt)), cols[4].x, y, { align: "right" });
    y += rowH;
    pdf.setDrawColor(230, 233, 238);
    pdf.line(M, y - 3.6, W - M, y - 3.6);
  }

  // Totaux
  if (y > 225) {
    pdf.addPage();
    y = M + 6;
  }
  y += 4;
  const rates = Object.entries(t.byRate).filter(([, v]) => v.ht !== 0).sort((a, b) => Number(b[0]) - Number(a[0]));
  const totals = [["Total HT", formatMAD(ht)]];
  if (rates.length) rates.forEach(([r, v]) => totals.push([`TVA ${r} %`, formatMAD(v.vat)]));
  else totals.push(["TVA", formatMAD(vat)]);
  let totY = y;
  for (const [k, v] of totals) {
    pdf.text(clean(k), 150, totY, { align: "right" });
    pdf.text(clean(v), W - M, totY, { align: "right" });
    totY += 5;
  }
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10.5);
  pdf.text("Total TTC", 150, totY + 1.5, { align: "right" });
  pdf.text(clean(formatMAD(ttc)), W - M, totY + 1.5, { align: "right" });
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);

  const words = pdf.splitTextToSize(clean(`${amountInWords(ttc)} TTC${ttc < 0 ? " (en faveur du client)" : ""}`), 95);
  pdf.text(isQuote ? "Arrêté le présent devis à la somme de :" : isCredit ? "Arrêté le présent avoir à la somme de :" : "Arrêtée la présente facture à la somme de :", M, y);
  pdf.setFont("helvetica", "bold");
  pdf.text(words, M, y + 5);
  pdf.setFont("helvetica", "normal");
  let wy = y + 5 + words.length * 4.4 + 2;
  if (!isCredit) {
    const pay = [
      doc.payment_method ? `Mode de règlement : ${METHODS[doc.payment_method] || doc.payment_method}` : "",
      seller.bank_name ? `Banque : ${seller.bank_name}` : "",
      seller.rib ? `RIB : ${String(seller.rib).replace(/(\d{3})(\d{3})(\d{16})(\d{2})/, "$1 $2 $3 $4")}` : "",
    ].filter(Boolean);
    for (const p of pay) {
      pdf.text(clean(p), M, wy);
      wy += 4.4;
    }
  }
  y = Math.max(wy, totY + 6) + 4;
  if (doc.notes) {
    const notes = pdf.splitTextToSize(clean(doc.notes), W - 2 * M);
    pdf.text(notes, M, y);
  }

  // Pied de page : mentions légales
  const rc = seller.rc_number ? `${seller.rc_number}${seller.rc_city ? ` (${seller.rc_city})` : ""}` : "";
  const legal = [
    seller.legal_name,
    seller.legal_form && seller.capital ? `${seller.legal_form} au capital de ${seller.capital}` : seller.legal_form,
    seller.ice && `ICE ${seller.ice}`,
    seller.if_number && `IF ${seller.if_number}`,
    seller.tp_number && `TP ${seller.tp_number}`,
    rc && `RC ${rc}`,
  ].filter(Boolean).join(" - ");
  const pages = pdf.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    pdf.setPage(p);
    pdf.setFontSize(7.5);
    pdf.setTextColor(...muted);
    const foot = pdf.splitTextToSize(clean([seller.footer_note, legal].filter(Boolean).join("\n")), W - 2 * M);
    pdf.text(foot, W / 2, 287 - foot.length * 3.4, { align: "center" });
    if (pages > 1) pdf.text(`${p} / ${pages}`, W - M, 290, { align: "right" });
  }

  return new Uint8Array(pdf.output("arraybuffer"));
}

/** Raccourci : PDF d'un document de vente à partir de son id. */
export async function salePdfBytes(id) {
  return renderSalePdf(await loadSaleForPrint(id));
}
