/**
 * Onglet « Portail client » de l'espace client (côté cabinet).
 * Accès du client, pièces demandées par période, documents déposés.
 */
import { escapeHtml, initLucide } from "./dashboard-ui.js?v=bill1";
import {
  PORTAL_DOC_TYPES,
  countUnseenUploads,
  createRequest,
  deleteRequest,
  listPortalUploads,
  listRequests,
  markUploadsSeen,
  periodLabel,
  periodLabelCap,
  portalInvite,
  portalNewLink,
  portalRevoke,
  portalStatus,
  portalUpdateContact,
  portalUrl,
  rejectUpload,
  setRequestStatus,
  uploadPreviewUrl,
  whatsappUrl,
} from "./portal-client.js?v=portal1";

const esc = (v) => escapeHtml(v ?? "");
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "—");
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

const REQUEST_STATUS = {
  open: { label: "Demandée", tone: "warn" },
  received: { label: "Reçue", tone: "ok" },
  closed: { label: "Clôturée", tone: "muted" },
};

export function createWorkspacePortal({ mountEl, tabButton, getContext, toast }) {
  const state = { access: null, requests: [], uploads: [], dossierId: null, link: null, loaded: false };
  const ctx = () => getContext();

  function setBadge(n) {
    if (!tabButton) return;
    tabButton.querySelector(".rc-tab-badge")?.remove();
    if (n > 0) tabButton.insertAdjacentHTML("beforeend", ` <span class="rc-tab-badge" title="Nouveaux documents déposés par le client">${n}</span>`);
  }

  async function refreshBadge() {
    const { clientId } = ctx();
    if (!clientId) return;
    const counts = await countUnseenUploads([clientId]).catch(() => ({}));
    setBadge(counts[clientId] || 0);
  }

  function dossierOptions(selected) {
    const dossiers = [...(ctx().dossiers || [])].sort((a, b) => (b.period_year * 12 + b.period_month) - (a.period_year * 12 + a.period_month));
    return dossiers.map((d) => `<option value="${d.id}" ${d.id === selected ? "selected" : ""}>${esc(periodLabelCap(d.period_year, d.period_month))}</option>`).join("");
  }
  const dossierById = (id) => (ctx().dossiers || []).find((d) => d.id === Number(id));
  const dossierName = (id) => {
    const d = dossierById(id);
    return d ? periodLabelCap(d.period_year, d.period_month) : "Période";
  };

  // ---------- Rendu ----------
  function accessCard() {
    const a = state.access;
    const { clientName } = ctx();
    if (!a) {
      return `
        <section class="rc-panel rc-portal-access">
          <header class="rc-panel-head"><div>
            <h2>Accès du client</h2>
            <p>${esc(clientName)} n'a pas encore d'espace. Une fois créé, vous lui envoyez un lien personnel (par WhatsApp ou email) : il dépose ses factures et relevés sans mot de passe, directement dans ses périodes.</p>
          </div></header>
          <form class="rc-form rc-portal-invite" data-form="invite" novalidate>
            <label class="rc-field"><span>Nom du contact</span><input name="contact_name" type="text" autocomplete="off" placeholder="Prénom Nom" /></label>
            <label class="rc-field"><span>Téléphone WhatsApp</span><input name="contact_phone" type="tel" autocomplete="off" placeholder="06 12 34 56 78" /></label>
            <label class="rc-field"><span>Email</span><input name="contact_email" type="email" autocomplete="off" placeholder="facultatif" /></label>
            <div class="rc-portal-invite-actions"><button type="submit" class="dash-btn dash-btn-primary" data-act="invite"><i data-lucide="user-plus"></i> Créer l'accès du client</button></div>
          </form>
        </section>`;
    }
    const status = a.is_active
      ? '<span class="rc-bill-status is-ok">Actif</span>'
      : '<span class="rc-bill-status is-muted">Accès coupé</span>';
    const contact = [a.contact_name, a.contact_phone, a.contact_email].filter(Boolean).map(esc).join(" · ") || "Aucun contact renseigné";
    return `
      <section class="rc-panel rc-portal-access">
        <header class="rc-panel-head">
          <div>
            <h2>Accès du client ${status}</h2>
            <p>${contact} · <button type="button" class="rc-link" data-act="edit-contact">Modifier</button></p>
            <p class="rc-portal-meta">Dernière visite : ${a.last_used_at ? fmtDateTime(a.last_used_at) : "jamais"} · lien créé le ${fmtDate(a.link_created_at)}</p>
          </div>
          <div class="rc-panel-tools">
            ${a.is_active ? '<button type="button" class="dash-btn dash-btn-sm danger" data-act="revoke">Couper l\'accès</button>' : ""}
            <button type="button" class="dash-btn dash-btn-sm ${a.is_active ? "" : "dash-btn-primary"}" data-act="new-link">${a.is_active ? "Nouveau lien" : "Réactiver avec un nouveau lien"}</button>
          </div>
        </header>
        ${state.link ? linkBox(state.link) : ""}
        <form class="rc-form rc-portal-invite" data-form="contact" hidden novalidate>
          <label class="rc-field"><span>Nom du contact</span><input name="contact_name" type="text" value="${esc(a.contact_name)}" /></label>
          <label class="rc-field"><span>Téléphone WhatsApp</span><input name="contact_phone" type="tel" value="${esc(a.contact_phone)}" /></label>
          <label class="rc-field"><span>Email</span><input name="contact_email" type="email" value="${esc(a.contact_email)}" /></label>
          <div class="rc-portal-invite-actions"><button type="submit" class="dash-btn dash-btn-primary">Enregistrer</button></div>
        </form>
      </section>`;
  }

  function linkBox(link) {
    return `
      <div class="rc-portal-link">
        <p><strong>Lien personnel du client</strong> — affiché une seule fois. Envoyez-le maintenant ; en cas de perte, générez-en un nouveau (l'ancien cessera de fonctionner).</p>
        <div class="rc-portal-link-row">
          <input type="text" readonly value="${esc(link)}" aria-label="Lien personnel du client" />
          <button type="button" class="dash-btn dash-btn-sm" data-act="copy-link"><i data-lucide="copy"></i> Copier</button>
          <a class="dash-btn dash-btn-sm dash-btn-primary" data-act="wa-link" target="_blank" rel="noopener"><i data-lucide="message-circle"></i> Envoyer par WhatsApp</a>
        </div>
      </div>`;
  }

  function requestsCard() {
    const d = state.dossierId;
    const rows = state.requests.filter((r) => r.dossier_id === d);
    const openCount = state.requests.filter((r) => r.status === "open").length;
    const list = rows.length
      ? `<ul class="rc-portal-requests">${rows.map((r) => {
        const st = REQUEST_STATUS[r.status];
        const received = state.uploads.filter((u) => u.request_id === r.id && u.status === "received").length;
        return `
          <li class="is-${r.status}">
            <i data-lucide="${PORTAL_DOC_TYPES[r.doc_type]?.icon || "file"}"></i>
            <div><strong>${esc(r.label)}</strong>${r.note ? `<small>${esc(r.note)}</small>` : ""}
              ${received ? `<small>${received} document${received > 1 ? "s" : ""} reçu${received > 1 ? "s" : ""}</small>` : ""}</div>
            <span class="rc-bill-status is-${st.tone}">${st.label}</span>
            <span class="rc-portal-req-actions">
              ${r.status !== "closed" ? `<button type="button" class="rc-link" data-close="${r.id}">Clôturer</button>` : `<button type="button" class="rc-link" data-reopen="${r.id}">Rouvrir</button>`}
              <button type="button" class="rc-link rc-link-danger" data-del-req="${r.id}">Supprimer</button>
            </span>
          </li>`;
      }).join("")}</ul>`
      : '<p class="rc-portal-empty">Aucune pièce demandée pour cette période.</p>';
    return `
      <section class="rc-panel">
        <header class="rc-panel-head">
          <div>
            <h2>Pièces demandées</h2>
            <p>Le client voit cette liste dans son espace et dépose les documents en face de chaque demande.</p>
          </div>
          <div class="rc-panel-tools">
            <select data-act="period" aria-label="Période">${dossierOptions(d)}</select>
          </div>
        </header>
        ${list}
        <div class="rc-portal-req-add">
          <button type="button" class="dash-btn dash-btn-sm" data-act="default-requests"><i data-lucide="list-checks"></i> Demander les pièces habituelles</button>
          <form data-form="request" class="rc-portal-req-form" novalidate>
            <select name="doc_type" aria-label="Type de pièce">
              <option value="invoice">Factures</option><option value="bank">Relevé</option><option value="other">Autre</option>
            </select>
            <input name="label" type="text" placeholder="Autre demande : ex. contrat de bail, facture Lydec…" aria-label="Pièce demandée" />
            <button type="submit" class="dash-btn dash-btn-sm">Ajouter</button>
          </form>
          ${state.access?.is_active && openCount ? `<a class="dash-btn dash-btn-sm rc-portal-wa" data-act="wa-remind" target="_blank" rel="noopener"><i data-lucide="message-circle"></i> Relancer par WhatsApp</a>` : ""}
        </div>
      </section>`;
  }

  function uploadsCard() {
    if (!state.uploads.length) {
      return `
        <section class="rc-panel">
          <header class="rc-panel-head"><div><h2>Documents déposés par le client</h2>
          <p>Rien pour l'instant. Les factures et relevés déposés rejoignent les documents de la période : vous lancez l'extraction quand vous le décidez.</p></div></header>
        </section>`;
    }
    return `
      <section class="rc-panel">
        <header class="rc-panel-head"><div><h2>Documents déposés par le client</h2>
        <p>Les factures et relevés sont déjà dans les documents de leur période, prêts à extraire. Marquez « À renvoyer » un document illisible ou erroné : le client est prévenu dans son espace.</p></div></header>
        <div class="rc-team-table-wrap">
          <table class="rc-team-table rc-portal-table">
            <thead><tr><th>Reçu le</th><th>Période</th><th>Type</th><th>Fichier</th><th>Statut</th><th><span class="rc-sr">Actions</span></th></tr></thead>
            <tbody>${state.uploads.map((u) => `
              <tr class="${u.seen_at ? "" : "is-new"}">
                <td>${fmtDateTime(u.created_at)}${u.seen_at ? "" : ' <span class="rc-tab-badge">Nouveau</span>'}</td>
                <td>${esc(dossierName(u.dossier_id))}</td>
                <td>${esc(PORTAL_DOC_TYPES[u.doc_type]?.short || u.doc_type)}</td>
                <td class="rc-portal-file">${u.status === "received" ? `<button type="button" class="rc-link" data-preview="${u.id}">${esc(u.original_filename)}</button>` : esc(u.original_filename)}</td>
                <td>${u.status === "received" ? '<span class="rc-bill-status is-ok">Reçu</span>' : `<span class="rc-bill-status is-stop" title="${esc(u.reject_reason)}">À renvoyer</span><small class="rc-portal-reason">${esc(u.reject_reason)}</small>`}</td>
                <td class="rc-team-actions">${u.status === "received" ? `<button type="button" class="dash-btn dash-btn-sm" data-reject="${u.id}">À renvoyer</button>` : ""}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>
      </section>`;
  }

  function render() {
    mountEl.innerHTML = accessCard() + requestsCard() + uploadsCard();
    const wa = mountEl.querySelector('[data-act="wa-link"]');
    if (wa) wa.href = whatsappUrl(state.access?.contact_phone, inviteMessage(state.link));
    const remind = mountEl.querySelector('[data-act="wa-remind"]');
    if (remind) remind.href = whatsappUrl(state.access?.contact_phone, reminderMessage());
    initLucide();
  }

  function inviteMessage(link) {
    const { cabinetName, clientName } = ctx();
    return `Bonjour${state.access?.contact_name ? ` ${state.access.contact_name}` : ""},\n\n${cabinetName} vous ouvre un espace sécurisé pour nous transmettre les factures et relevés de ${clientName}.\n\nVotre lien personnel (à garder pour vous) :\n${link}\n\nAucun mot de passe : il suffit de l'ouvrir, puis de prendre vos documents en photo ou de choisir les fichiers.`;
  }

  function reminderMessage() {
    const { cabinetName } = ctx();
    const open = state.requests.filter((r) => r.status === "open");
    const lines = open.map((r) => `- ${r.label} (${dossierName(r.dossier_id).toLowerCase()})`).join("\n");
    return `Bonjour${state.access?.contact_name ? ` ${state.access.contact_name}` : ""},\n\nPour avancer sur votre déclaration, il nous manque encore :\n${lines}\n\nVous pouvez les déposer dans votre espace : ${portalUrl()}\n(ouvrez votre lien personnel si l'espace vous demande de vous reconnecter)\n\nMerci,\n${cabinetName}`;
  }

  // ---------- Chargement ----------
  async function load() {
    const { clientId, selectedDossierId } = ctx();
    if (!clientId) return;
    if (!state.dossierId || !dossierById(state.dossierId)) state.dossierId = selectedDossierId || ctx().dossiers?.[0]?.id || null;
    mountEl.innerHTML = '<p class="rc-portal-empty">Chargement…</p>';
    try {
      const [status, requests, uploads] = await Promise.all([portalStatus(clientId), listRequests(clientId), listPortalUploads(clientId)]);
      Object.assign(state, { access: status.access, requests, uploads, loaded: true });
      render();
      if (uploads.some((u) => !u.seen_at)) {
        await markUploadsSeen(clientId).catch(() => {});
        setBadge(0);
      }
    } catch (err) {
      mountEl.innerHTML = `<div class="adm-note rc-team-note">${esc(err.message)}</div>`;
    }
  }

  async function reloadLists() {
    const { clientId } = ctx();
    [state.requests, state.uploads] = await Promise.all([listRequests(clientId), listPortalUploads(clientId)]);
    render();
  }

  async function run(button, fn) {
    if (button) button.disabled = true;
    try { await fn(); } catch (err) { toast({ title: "Action impossible", message: err.message, variant: "error" }); } finally { if (button) button.disabled = false; }
  }

  function formValues(form) {
    return Object.fromEntries([...form.elements].filter((e) => e.name).map((e) => [e.name, e.value.trim()]));
  }

  // ---------- Événements ----------
  mountEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    const { clientId, cabinetId } = ctx();
    if (form.dataset.form === "invite") {
      await run(button, async () => {
        const res = await portalInvite(clientId, formValues(form));
        state.access = res.access;
        state.link = res.link;
        render();
        toast({ title: "Accès créé", message: "Envoyez maintenant le lien au client.", variant: "success" });
      });
    } else if (form.dataset.form === "contact") {
      await run(button, async () => {
        const res = await portalUpdateContact(clientId, formValues(form));
        state.access = res.access;
        render();
      });
    } else if (form.dataset.form === "request") {
      const { label, doc_type: docType } = formValues(form);
      if (!label) return form.elements.label.focus();
      if (!state.dossierId) return toast({ title: "Aucune période", message: "Créez d'abord une période pour ce client.", variant: "error" });
      await run(button, async () => {
        await createRequest({ cabinetId, clientId, dossierId: state.dossierId, docType, label });
        await reloadLists();
      });
    }
  });

  mountEl.addEventListener("change", (event) => {
    if (event.target.matches('[data-act="period"]')) {
      state.dossierId = Number(event.target.value);
      render();
    }
  });

  mountEl.addEventListener("click", async (event) => {
    const el = event.target.closest("button, a");
    if (!el) return;
    const { clientId, cabinetId } = ctx();
    const act = el.dataset.act;

    if (act === "copy-link") {
      try { await navigator.clipboard.writeText(state.link); toast({ title: "Lien copié", message: "Collez-le dans WhatsApp ou un email.", variant: "success", durationMs: 4000 }); }
      catch { mountEl.querySelector(".rc-portal-link input")?.select(); }
    } else if (act === "edit-contact") {
      const form = mountEl.querySelector('[data-form="contact"]');
      form.hidden = !form.hidden;
    } else if (act === "new-link") {
      if (state.access?.is_active && !window.confirm("Générer un nouveau lien ? L'ancien lien ne fonctionnera plus.")) return;
      await run(el, async () => {
        const res = await portalNewLink(clientId);
        state.access = res.access;
        state.link = res.link;
        render();
      });
    } else if (act === "revoke") {
      if (!window.confirm("Couper l'accès du client ? Son lien et ses connexions ne fonctionneront plus. Les documents déjà déposés sont conservés.")) return;
      await run(el, async () => {
        const res = await portalRevoke(clientId);
        state.access = res.access;
        state.link = null;
        render();
        toast({ title: "Accès coupé", message: "Le client ne peut plus se connecter.", variant: "success" });
      });
    } else if (act === "default-requests") {
      if (!state.dossierId) return toast({ title: "Aucune période", message: "Créez d'abord une période pour ce client.", variant: "error" });
      const d = dossierById(state.dossierId);
      const label = periodLabel(d.period_year, d.period_month);
      const wanted = [
        { docType: "bank", label: `Relevé bancaire de ${label}` },
        { docType: "invoice", label: `Factures d'achat de ${label}` },
      ].filter((w) => !state.requests.some((r) => r.dossier_id === d.id && r.doc_type === w.docType && r.status !== "closed"));
      if (!wanted.length) return toast({ title: "Déjà demandées", message: "Le relevé et les factures de cette période sont déjà demandés.", variant: "info", durationMs: 5000 });
      await run(el, async () => {
        for (const w of wanted) await createRequest({ cabinetId, clientId, dossierId: d.id, ...w });
        await reloadLists();
      });
    } else if (el.dataset.close || el.dataset.reopen) {
      await run(el, async () => {
        await setRequestStatus(Number(el.dataset.close || el.dataset.reopen), el.dataset.close ? "closed" : "open");
        await reloadLists();
      });
    } else if (el.dataset.delReq) {
      if (!window.confirm("Supprimer cette demande ? Les documents déjà reçus sont conservés.")) return;
      await run(el, async () => { await deleteRequest(Number(el.dataset.delReq)); await reloadLists(); });
    } else if (el.dataset.preview) {
      const up = state.uploads.find((u) => u.id === Number(el.dataset.preview));
      const win = window.open("", "_blank");
      try {
        const url = await uploadPreviewUrl(up.storage_path);
        if (win) win.location.href = url; else window.location.href = url;
      } catch (err) {
        win?.close();
        toast({ title: "Aperçu impossible", message: err.message, variant: "error" });
      }
    } else if (el.dataset.reject) {
      const up = state.uploads.find((u) => u.id === Number(el.dataset.reject));
      const reason = window.prompt(`Pourquoi le client doit-il renvoyer « ${up.original_filename} » ?\nCe message lui sera affiché.`, "Document illisible, merci de le reprendre en photo");
      if (reason === null) return;
      if (!reason.trim()) return toast({ title: "Motif requis", message: "Indiquez au client ce qui ne va pas.", variant: "error" });
      await run(el, async () => {
        await rejectUpload(up, reason.trim());
        await reloadLists();
        toast({ title: "Document à renvoyer", message: "Il a été retiré des documents de la période ; le client le voit dans son espace.", variant: "success" });
      });
    }
  });

  return { load, refreshBadge };
}
