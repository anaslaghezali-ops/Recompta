import { measurePerformance } from "./performance-metrics.js?v=perf1";
/**
 * Onglet « Ventes » de l'espace client (cabinet) — phases 4 et 5.
 *  - TVA collectée du mois selon le régime du client (encaissement / débit),
 *    détail exportable ;
 *  - encaissements depuis le relevé déjà importé pour la période ;
 *  - ventes émises et encaissements du mois.
 * Lecture des ventes : droits RLS du cabinet (responsables + collaborateurs attribués).
 * Écriture : uniquement les paiements « relevé » (source = bank) et le régime de TVA.
 */
import { escapeHtml, initLucide } from "./dashboard-ui.js?v=bill1";
import { getSupabase } from "./auth-client.js?v=auth10";
import { loadDossierWorkspace } from "./dossier-persistence.js?v=persist6";
import { collectedByRate, collectedCsv, matchSalesReceipts, paymentRows } from "./bank-sales-match.js?v=bsm1";

const esc = (v) => escapeHtml(v ?? "");
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const mad = (n) => `${(Number(n) || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString("fr-FR") : "—");
const METHODS = { virement: "Virement", cheque: "Chèque", especes: "Espèces", carte: "Carte", effet: "Effet", prelevement: "Prélèvement", compensation: "Compensation", autre: "Autre" };

function db() {
  const s = getSupabase();
  if (!s) throw new Error("Connexion au service impossible");
  return s;
}
function fail(error) {
  if (!error) return;
  const msg = String(error.message || error);
  if (/sales_invoices|sales_collected_detail|bank_ref/.test(msg) && /does not exist|schema cache|function/i.test(msg)) {
    throw new Error("Le registre des ventes n'est pas encore installé sur la base de données.");
  }
  throw new Error(msg.replace(/^.*?ERROR:\s*/i, ""));
}

export function createWorkspaceSales({ mountEl, getContext, toast }) {
  const state = { loading: false, regime: "encaissement", sales: [], payments: [], detail: [], bank: [], match: null, error: null };
  const ctx = () => getContext();
  const period = () => {
    const { dossiers = [], selectedDossierId } = ctx();
    return dossiers.find((d) => d.id === selectedDossierId) || null;
  };
  const periodName = (p) => (p ? `${MONTHS[p.period_month - 1]} ${p.period_year}` : "");

  async function load() {
    const { clientId, selectedDossierId } = ctx();
    const p = period();
    if (!clientId || !p) {
      mountEl.innerHTML = '<section class="rc-panel"><p class="rc-portal-empty">Choisissez une période pour voir les ventes du mois.</p></section>';
      return;
    }
    state.loading = true;
    render();
    try {
      const [client, sales, payments, detail, ws] = await measurePerformance("sales.load", () => Promise.all([
        db().from("cabinet_clients").select("vat_regime").eq("id", clientId).maybeSingle(),
        db().from("sales_invoices").select("*").eq("issuer_client_id", clientId),
        db().from("invoice_payments").select("*").eq("issuer_client_id", clientId).order("paid_on"),
        db().rpc("sales_collected_detail", { p_client_id: clientId, p_year: p.period_year, p_month: p.period_month }),
        loadDossierWorkspace(selectedDossierId).catch(() => ({ bank_transactions: [] })),
      ]), { queryCount: 5 });
      fail(client.error); fail(sales.error); fail(payments.error); fail(detail.error);
      Object.assign(state, {
        regime: client.data?.vat_regime || "encaissement",
        sales: sales.data || [],
        payments: payments.data || [],
        detail: detail.data || [],
        bank: ws.bank_transactions || [],
        error: null,
      });
      state.match = state.bank.length ? matchSalesReceipts({ transactions: state.bank, invoices: state.sales, payments: state.payments }) : null;
    } catch (err) {
      state.error = err.message;
    }
    state.loading = false;
    render();
  }

  function monthRange() {
    const p = period();
    const d0 = `${p.period_year}-${String(p.period_month).padStart(2, "0")}-01`;
    const next = new Date(p.period_year, p.period_month, 1);
    const d1 = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
    return { d0, d1, inMonth: (iso) => iso && iso >= d0 && iso < d1 };
  }

  function vatPanel() {
    const p = period();
    const { list, total } = collectedByRate(state.detail);
    return `
      <section class="rc-panel">
        <header class="rc-panel-head">
          <div>
            <h2>TVA collectée — ${esc(periodName(p))}</h2>
            <p>${state.regime === "debit"
              ? "Régime des débits : la TVA est due sur les factures émises dans le mois (avoirs déduits)."
              : "Régime de l'encaissement : la TVA est due sur les paiements reçus dans le mois, au prorata (paiement partiel = TVA partielle)."}</p>
          </div>
          <div class="rc-panel-tools">
            <label class="rc-field"><span>Régime de TVA du client</span>
              <select data-sales="regime">
                <option value="encaissement" ${state.regime === "encaissement" ? "selected" : ""}>Encaissement</option>
                <option value="debit" ${state.regime === "debit" ? "selected" : ""}>Débits</option>
              </select></label>
          </div>
        </header>
        ${list.length ? `
        <div class="rc-team-table-wrap">
          <table class="rc-team-table rc-sales-table">
            <thead><tr><th>Taux</th><th class="num">Base HT</th><th class="num">TVA collectée</th><th class="num">TTC</th></tr></thead>
            <tbody>
              ${list.map((r) => `<tr><td>${r.rate} %</td><td class="num">${mad(r.base)}</td><td class="num">${mad(r.vat)}</td><td class="num">${mad(r.ttc)}</td></tr>`).join("")}
              <tr class="rc-sales-total"><td>Total</td><td class="num">${mad(total.base)}</td><td class="num">${mad(total.vat)}</td><td class="num">${mad(total.ttc)}</td></tr>
            </tbody>
          </table>
        </div>
        <div class="rc-sales-actions">
          <button type="button" class="dash-btn dash-btn-sm" data-sales="export"><i data-lucide="download"></i> Exporter le détail (${state.detail.length} ligne${state.detail.length > 1 ? "s" : ""})</button>
        </div>` : `<p class="rc-portal-empty">Aucune TVA collectée sur ${esc(periodName(p))} d'après le registre des ventes du client.</p>`}
      </section>`;
  }

  function bankPanel() {
    const { selectedDossierId } = ctx();
    const m = state.match;
    const fromBank = state.payments.filter((x) => x.source === "bank" && x.bank_dossier_id === selectedDossierId);
    const invById = new Map(state.sales.map((s) => [s.id, s]));
    const invLabel = (inv) => `${esc(inv.customer_name || "")} · ${esc(inv.number || inv.external_number || "")}`;
    if (!state.bank.length) {
      return `
        <section class="rc-panel">
          <header class="rc-panel-head"><div><h2>Encaissements depuis le relevé</h2>
          <p>Importez d'abord le relevé bancaire de la période : les crédits seront rapprochés des factures de vente impayées.</p></div></header>
        </section>`;
    }
    return `
      <section class="rc-panel">
        <header class="rc-panel-head">
          <div><h2>Encaissements depuis le relevé</h2>
          <p>Automatique seulement si le montant est exact, que le nom du client figure dans le libellé et qu'une seule facture correspond. Le reste est proposé à confirmer.</p></div>
          <div class="rc-panel-tools">
            ${m?.auto.length ? `<button type="button" class="dash-btn dash-btn-primary" data-sales="apply-auto"><i data-lucide="check-check"></i> Enregistrer ${m.auto.length} encaissement${m.auto.length > 1 ? "s" : ""} certain${m.auto.length > 1 ? "s" : ""}</button>` : ""}
          </div>
        </header>
        ${m?.auto.length ? `
          <h3 class="rc-sales-sub">Rapprochements certains</h3>
          <ul class="rc-sales-list">${m.auto.map((c) => `
            <li><div><strong>${mad(c.amount)} MAD · ${day(c.txn.date)}</strong><span>${esc(c.txn.label)}</span></div>
            <span class="rc-sales-arrow">→ ${invLabel(c.allocations[0].invoice)}</span></li>`).join("")}</ul>` : ""}
        ${m?.suggestions.length ? `
          <h3 class="rc-sales-sub">À confirmer (${m.suggestions.length})</h3>
          <ul class="rc-sales-list">${m.suggestions.map((c, i) => `
            <li class="is-suggest">
              <div><strong>${mad(c.amount)} MAD · ${day(c.txn.date)}</strong><span>${esc(c.txn.label)}</span></div>
              <div class="rc-sales-options">${c.proposals.map((p, j) => `
                <button type="button" class="dash-btn dash-btn-sm" data-sales="confirm" data-i="${i}" data-j="${j}">
                  ${esc(p.label)} : ${p.allocations.map((a) => `${invLabel(a.invoice)}${p.kind === "partial" ? ` (${mad(a.amount)} sur ${mad(a.invoice.balance)})` : ""}`).join(" + ")}
                </button>`).join("")}</div>
            </li>`).join("")}</ul>` : ""}
        ${m?.unmatched.length ? `
          <h3 class="rc-sales-sub">Crédits sans facture correspondante (${m.unmatched.length})</h3>
          <p class="rc-sales-note">Dépôts d'espèces, encaissements carte, ou ventes peut-être non facturées : à vérifier avec le client.</p>
          <ul class="rc-sales-list">${m.unmatched.map((c) => `
            <li class="is-muted"><div><strong>${mad(c.amount)} MAD · ${day(c.txn.date)}</strong><span>${esc(c.txn.label)}</span></div>
            <span class="rc-sales-chip">${esc(c.category)}</span></li>`).join("")}</ul>` : ""}
        ${m && !m.auto.length && !m.suggestions.length && !m.unmatched.length ? '<p class="rc-portal-empty">Tous les crédits du relevé sont déjà rapprochés.</p>' : ""}
        ${fromBank.length ? `
          <h3 class="rc-sales-sub">Encaissements enregistrés depuis ce relevé (${fromBank.length})</h3>
          <ul class="rc-sales-list">${fromBank.map((x) => {
            const inv = invById.get(x.invoice_id);
            return `<li><div><strong>${mad(x.amount)} MAD · ${day(x.paid_on)}</strong><span>${inv ? invLabel(inv) : ""} · ${esc(x.bank_label || "")}</span></div>
            <button type="button" class="rc-link rc-link-danger" data-sales="undo" data-id="${x.id}">Annuler</button></li>`;
          }).join("")}</ul>` : ""}
      </section>`;
  }

  function monthPanel() {
    const { inMonth } = monthRange();
    const issued = state.sales.filter((s) => (s.kind || "invoice") !== "quote" && s.status !== "draft" && inMonth(s.issue_date));
    const received = state.payments.filter((x) => inMonth(x.paid_on));
    const invById = new Map(state.sales.map((s) => [s.id, s]));
    const totalIssued = issued.filter((s) => s.status !== "voided").reduce((t, s) => t + Number(s.total_ttc), 0);
    const totalReceived = received.reduce((t, x) => t + Number(x.amount), 0);
    return `
      <section class="rc-panel">
        <header class="rc-panel-head"><div><h2>Ventes du mois</h2>
        <p>${issued.length} document${issued.length > 1 ? "s" : ""} émis ou validés (${mad(totalIssued)} MAD TTC) · ${received.length} encaissement${received.length > 1 ? "s" : ""} (${mad(totalReceived)} MAD).</p></div></header>
        ${issued.length ? `
        <div class="rc-team-table-wrap">
          <table class="rc-team-table rc-sales-table">
            <thead><tr><th>N°</th><th>Client</th><th>Date</th><th class="num">TTC</th><th class="num">Reste dû</th><th>État</th></tr></thead>
            <tbody>${issued.map((s) => `
              <tr><td>${esc(s.number || s.external_number || "")}${s.kind === "credit_note" ? " (avoir)" : ""}</td><td>${esc(s.customer_name)}</td><td>${day(s.issue_date)}</td>
              <td class="num">${mad(s.total_ttc)}</td><td class="num">${s.kind === "invoice" ? mad(s.balance) : "—"}</td>
              <td>${s.status === "voided" ? "Annulée" : s.status === "cancelled" ? "Annulée par avoir" : s.kind === "credit_note" ? "Avoir" : s.payment_status === "paid" ? "Payée" : s.is_overdue ? `En retard (${s.days_overdue} j)` : s.payment_status === "partial" ? "Partielle" : "À encaisser"}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>` : ""}
        ${received.length ? `
          <h3 class="rc-sales-sub">Encaissements reçus dans le mois</h3>
          <ul class="rc-sales-list">${received.map((x) => {
            const inv = invById.get(x.invoice_id);
            return `<li><div><strong>${mad(x.amount)} MAD · ${day(x.paid_on)}</strong><span>${inv ? `${esc(inv.customer_name)} · ${esc(inv.number || inv.external_number || "")}` : ""} · ${esc(METHODS[x.method] || x.method)}${x.source === "bank" ? " · depuis le relevé" : " · saisi par le client"}</span></div></li>`;
          }).join("")}</ul>` : ""}
      </section>`;
  }

  function render() {
    if (state.loading) {
      mountEl.innerHTML = '<section class="rc-panel"><p class="rc-portal-empty">Chargement des ventes…</p></section>';
      return;
    }
    if (state.error) {
      mountEl.innerHTML = `<section class="rc-panel"><p class="rc-portal-empty">${esc(state.error)}</p></section>`;
      return;
    }
    const empty = !state.sales.length;
    mountEl.innerHTML = `
      ${empty ? `<section class="rc-panel"><p class="rc-portal-empty">${esc(ctx().clientName || "Ce client")} n'a encore aucune vente dans son registre. Il les saisit depuis son portail (onglet « Mes ventes »).</p></section>` : ""}
      ${vatPanel()}
      ${bankPanel()}
      ${monthPanel()}`;
    initLucide();
  }

  async function createPayments(credit, allocations) {
    const rows = paymentRows({ credit, allocations, dossierId: ctx().selectedDossierId });
    for (const row of rows) {
      const { error } = await db().from("invoice_payments").insert(row);
      if (error && !/duplicate key|invoice_payments_bank_ref_uidx/.test(error.message || "")) fail(error);
    }
  }

  mountEl.addEventListener("change", async (event) => {
    const sel = event.target.closest('[data-sales="regime"]');
    if (!sel) return;
    try {
      const { error } = await db().from("cabinet_clients").update({ vat_regime: sel.value }).eq("id", ctx().clientId);
      fail(error);
      toast?.({ title: "Régime de TVA enregistré", message: sel.value === "debit" ? "Débits" : "Encaissement", variant: "success" });
      await load();
    } catch (err) {
      toast?.({ title: "Modification impossible", message: err.message, variant: "error" });
    }
  });

  mountEl.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-sales]");
    if (!btn) return;
    const action = btn.dataset.sales;
    try {
      if (action === "export") {
        const p = period();
        const blob = new Blob([collectedCsv(state.detail)], { type: "text/csv;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `TVA-collectee-${(ctx().clientName || "client").replace(/[^\w-]+/g, "_")}-${p.period_year}-${String(p.period_month).padStart(2, "0")}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        return;
      }
      btn.disabled = true;
      if (action === "apply-auto") {
        for (const c of state.match.auto) await createPayments(c, c.allocations);
        toast?.({ title: "Encaissements enregistrés", message: `${state.match.auto.length} paiement(s) créé(s) depuis le relevé.`, variant: "success" });
      }
      if (action === "confirm") {
        const c = state.match.suggestions[Number(btn.dataset.i)];
        const p = c.proposals[Number(btn.dataset.j)];
        await createPayments(c, p.allocations);
        toast?.({ title: "Encaissement enregistré", message: `${p.allocations.length} facture(s) mise(s) à jour.`, variant: "success" });
      }
      if (action === "undo") {
        if (!window.confirm("Annuler cet encaissement issu du relevé ? La facture redeviendra à encaisser.")) { btn.disabled = false; return; }
        const { error } = await db().from("invoice_payments").delete().eq("id", Number(btn.dataset.id)).eq("source", "bank");
        fail(error);
      }
      await load();
    } catch (err) {
      btn.disabled = false;
      toast?.({ title: "Action impossible", message: err.message, variant: "error" });
    }
  });

  return { load };
}
