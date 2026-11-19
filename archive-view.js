/**
 * Interface « Tous les documents » (cabinet, workspace.html) et « Archives »
 * (portail client, portail.html). Même composant, deux publics :
 *   - audience "cabinet" : documents écartés visibles sur demande ;
 *   - audience "portal"  : la société du client seulement (filtrée côté base).
 */
import {
  SALE_KIND_LABELS,
  UNREAD_GROUP_KEY,
  ZIP_LAYOUTS,
  ZIP_PART_BYTES,
  filterEntries,
  formatBytes,
  formatDateFr,
  groupByMonth,
  groupByParty,
  periodLabel,
  periodRangeLabel,
  planZipParts,
  zipPaths,
} from "./archive-core.js?v=arch1";
import { canStreamToDisk, downloadArchive, loadArchive, openEntry } from "./archive-client.js?v=arch1";

const ROWS_PER_GROUP = 8;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n) => (n == null ? "—" : money.format(n).replace(/[  ]/g, " "));
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

const ICONS = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 19h16"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
};

function badgeFor(entry) {
  if (entry.kind === "bank") return { code: "RB", cls: "bank" };
  if (entry.kind === "sale") {
    if (entry.saleKind === "credit_note") return { code: "AV", cls: "sale" };
    if (entry.saleKind === "quote") return { code: "DV", cls: "sale" };
    return { code: "VT", cls: "sale" };
  }
  return { code: "FA", cls: "buy" };
}

function stateFor(entry, audience) {
  if (entry.ignored) return { label: "Écartée", cls: "muted" };
  if (entry.kind === "purchase" && !entry.analyzed) return { label: audience === "portal" ? "En cours" : "Non lue", cls: "warn" };
  if (entry.kind === "sale") {
    if (entry.cancelled) return { label: entry.saleKind === "quote" ? "Refusé" : "Annulée", cls: "muted" };
    if (entry.saleKind === "quote") return { label: "Devis", cls: "info" };
    if (entry.saleKind === "credit_note") return { label: "Avoir", cls: "info" };
    return entry.paidOn ? { label: "Encaissée", cls: "ok" } : { label: "Émise", cls: "info" };
  }
  if (entry.kind === "bank") return { label: "Relevé", cls: "muted" };
  return entry.paidOn ? { label: "Payée", cls: "ok" } : { label: "Lue", cls: "ok" };
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.mountEl
 * @param {"cabinet"|"portal"} opts.audience
 * @param {() => {clientId:number, clientName:string}} opts.getContext
 * @param {(t:{title:string,message?:string,variant?:string}) => void} [opts.toast]
 */
export function createArchiveView({ mountEl, audience = "cabinet", getContext, toast }) {
  const state = {
    clientId: null,
    entries: [],
    loading: false,
    error: "",
    mode: "month",
    query: "",
    kinds: new Set(),
    from: "",
    to: "",
    unreadOnly: false,
    showIgnored: false,
    selected: new Set(),
    open: new Set(),          // groupes dépliés (mode tiers)
    showAll: new Set(),       // groupes affichés en entier
    dialog: null,             // { entries, title }
    running: null,            // AbortController pendant un téléchargement
    notice: null,             // message affiché quand la page n'a pas de notifications
  };
  const notify = (title, message = "", variant = "info") => {
    if (toast) {
      toast({ title, message, variant });
      return;
    }
    // Pas de système de notification sur la page (portail) : message en tête de la vue.
    state.notice = { title, message, variant };
    render();
  };

  const visibleEntries = () => filterEntries(state.entries, {
    query: state.query,
    kinds: state.kinds,
    from: state.from,
    to: state.to,
    unreadOnly: state.unreadOnly,
    showIgnored: state.showIgnored,
  });

  const byKey = () => new Map(state.entries.map((e) => [e.key, e]));

  async function load({ force = false } = {}) {
    const { clientId } = getContext() || {};
    if (!clientId) {
      mountEl.innerHTML = '<p class="ar-empty">Choisissez un client.</p>';
      return;
    }
    if (!force && clientId === state.clientId && state.entries.length) {
      render();
      return;
    }
    if (clientId !== state.clientId) {
      state.selected.clear();
      state.open.clear();
      state.showAll.clear();
      state.from = "";
      state.to = "";
    }
    state.clientId = clientId;
    state.loading = true;
    state.error = "";
    render();
    try {
      state.entries = await loadArchive(clientId);
    } catch (err) {
      state.error = err.message || "Chargement impossible.";
      state.entries = [];
    } finally {
      state.loading = false;
      render();
    }
  }

  // ---------- Rendu ----------
  function counts() {
    const c = { purchase: 0, bank: 0, sale: 0, unread: 0, ignored: 0 };
    for (const e of state.entries) {
      if (e.ignored) {
        c.ignored += 1;
        continue;
      }
      c[e.kind] += 1;
      if (e.kind === "purchase" && !e.analyzed) c.unread += 1;
    }
    return c;
  }

  function periodOptions() {
    return [...new Set(state.entries.map((e) => e.period).filter(Boolean))].sort();
  }

  function renderToolbar() {
    const c = counts();
    const periods = periodOptions();
    const hasSales = c.sale > 0;
    const chip = (kind, label, n) => (n
      ? `<button type="button" class="ar-chip${state.kinds.has(kind) ? " is-on" : ""}" data-kind="${kind}" aria-pressed="${state.kinds.has(kind)}">${label} <span>${n}</span></button>`
      : "");
    const opts = (value) => periods.map((p) => `<option value="${p}"${p === value ? " selected" : ""}>${esc(periodLabel(p))}</option>`).join("");
    return `
      <section class="ar-toolbar">
        <div class="ar-row">
          <label class="ar-search">
            ${ICONS.search}
            <span class="ar-sr">Rechercher</span>
            <input type="search" data-role="query" value="${esc(state.query)}" placeholder="${hasSales ? "Fournisseur, client, n°, montant…" : "Fournisseur, n° de facture, montant…"}" autocomplete="off" />
          </label>
          <div class="ar-seg" role="group" aria-label="Classer">
            <button type="button" data-mode="month" aria-pressed="${state.mode === "month"}">Par mois</button>
            <button type="button" data-mode="party" aria-pressed="${state.mode === "party"}">${hasSales ? "Par fournisseur / client" : "Par fournisseur"}</button>
          </div>
          ${periods.length > 1 ? `
            <div class="ar-range">
              <label>Du <select data-role="from"><option value="">début</option>${opts(state.from)}</select></label>
              <label>au <select data-role="to"><option value="">aujourd'hui</option>${opts(state.to)}</select></label>
            </div>` : ""}
        </div>
        <div class="ar-row ar-chips">
          ${chip("purchase", "Factures d'achat", c.purchase)}
          ${chip("bank", "Relevés bancaires", c.bank)}
          ${chip("sale", "Ventes", c.sale)}
          ${c.unread ? `<span class="ar-sep" aria-hidden="true"></span>
            <button type="button" class="ar-chip ar-chip-warn${state.unreadOnly ? " is-on" : ""}" data-role="unread" aria-pressed="${state.unreadOnly}">${audience === "portal" ? "En cours de traitement" : "Pas encore analysées"} <span>${c.unread}</span></button>` : ""}
          ${audience === "cabinet" && c.ignored ? `
            <button type="button" class="ar-chip${state.showIgnored ? " is-on" : ""}" data-role="ignored" aria-pressed="${state.showIgnored}">Écartées <span>${c.ignored}</span></button>` : ""}
          ${state.kinds.size || state.unreadOnly || state.query || state.from || state.to
            ? '<button type="button" class="ar-link" data-role="reset">Effacer les filtres</button>' : ""}
        </div>
      </section>`;
  }

  function renderBar(visible) {
    const map = byKey();
    const selected = [...state.selected].map((k) => map.get(k)).filter(Boolean);
    const bytes = selected.reduce((s, e) => s + (e.sizeBytes || 0), 0);
    if (!selected.length) {
      return `
        <div class="ar-bar is-idle">
          <span>${plural(visible.length, "document affiché", "documents affichés")}${visible.length ? ` · ${formatBytes(visible.reduce((s, e) => s + (e.sizeBytes || 0), 0))}` : ""}</span>
          <div class="ar-bar-actions">
            ${visible.length ? `<button type="button" class="ar-btn ar-btn-ghost" data-role="select-visible">Tout sélectionner</button>
            <button type="button" class="ar-btn ar-btn-primary" data-role="zip-visible">${ICONS.download} Tout télécharger (ZIP)</button>` : ""}
          </div>
        </div>`;
    }
    return `
      <div class="ar-bar">
        <span><strong>${plural(selected.length, "document sélectionné", "documents sélectionnés")}</strong> · ${formatBytes(bytes)}</span>
        <div class="ar-bar-actions">
          <button type="button" class="ar-btn ar-btn-ghost" data-role="clear">Tout désélectionner</button>
          <button type="button" class="ar-btn ar-btn-primary" data-role="zip-selected">${ICONS.download} Télécharger (ZIP)</button>
        </div>
      </div>`;
  }

  function groupCheckState(entries) {
    const n = entries.filter((e) => state.selected.has(e.key)).length;
    return n === 0 ? "none" : n === entries.length ? "all" : "some";
  }

  function rowHtml(entry, { showParty }) {
    const badge = badgeFor(entry);
    const st = stateFor(entry, audience);
    const checked = state.selected.has(entry.key);
    const title = showParty
      ? (entry.kind === "bank" ? "Relevé bancaire" : entry.analyzed ? entry.partyName : (audience === "portal" ? "Facture en cours de traitement" : "Pas encore analysée"))
      : periodLabel(entry.period);
    const kindLabel = entry.kind === "sale" ? (SALE_KIND_LABELS[entry.saleKind] || "Vente") : "";
    const negative = entry.saleKind === "credit_note";
    return `
      <tr class="${entry.ignored ? "is-ignored" : ""}">
        <td class="ar-c-check"><input type="checkbox" data-entry="${esc(entry.key)}" ${checked ? "checked" : ""} aria-label="Sélectionner ${esc(entry.filename)}" /></td>
        <td class="ar-c-main">
          <span class="ar-badge ar-badge-${badge.cls}" aria-hidden="true">${badge.code}</span>
          <span class="ar-main-text">
            <strong>${esc(title)}${kindLabel && !showParty ? ` · ${esc(kindLabel)}` : ""}</strong>
            <small title="${esc(entry.filename)}">${esc(entry.generated ? `${kindLabel} créée dans Recompta` : entry.filename)}</small>
          </span>
        </td>
        <td class="ar-c-num" data-label="N°">${esc(entry.number || "—")}</td>
        <td class="ar-c-date" data-label="Date">${esc(formatDateFr(entry.date) || "—")}</td>
        <td class="ar-c-amount${entry.ttc == null ? " is-empty" : ""}" data-label="TTC">${entry.ttc == null ? "—" : `${negative ? "−" : ""}${fmt(entry.ttc)}`}</td>
        <td class="ar-c-amount ar-c-tva" data-label="TVA">${entry.tva == null ? "—" : `${negative ? "−" : ""}${fmt(entry.tva)}`}</td>
        <td class="ar-c-state" data-label="État"><span class="ar-pill ar-pill-${st.cls}">${esc(st.label)}</span>${entry.paidOn ? `<small>${entry.kind === "sale" ? "encaissée" : "payée"} le ${esc(formatDateFr(entry.paidOn))}</small>` : ""}</td>
        <td class="ar-c-actions"><button type="button" class="ar-icon" data-open="${esc(entry.key)}" aria-label="Ouvrir ${esc(entry.filename)}" title="Ouvrir">${ICONS.open}</button></td>
      </tr>`;
  }

  function tableHtml(group, { showParty }) {
    const all = state.showAll.has(group.key);
    const rows = all ? group.entries : group.entries.slice(0, ROWS_PER_GROUP);
    const rest = group.entries.length - rows.length;
    const partyHead = showParty
      ? (group.entries.some((e) => e.kind === "sale") && group.entries.some((e) => e.kind !== "sale") ? "Fournisseur / client" : group.entries.every((e) => e.kind === "sale") ? "Client" : "Fournisseur")
      : "Période";
    return `
      <div class="ar-table-wrap">
        <table class="ar-table">
          <thead><tr>
            <th class="ar-c-check"><span class="ar-sr">Sélection</span></th>
            <th>${partyHead}</th><th>N°</th><th>Date</th>
            <th class="ar-c-amount">TTC</th><th class="ar-c-amount ar-c-tva">TVA</th><th>État</th>
            <th class="ar-c-actions"><span class="ar-sr">Ouvrir</span></th>
          </tr></thead>
          <tbody>${rows.map((e) => rowHtml(e, { showParty })).join("")}</tbody>
        </table>
      </div>
      ${rest > 0 ? `<div class="ar-more"><button type="button" class="ar-link" data-more="${esc(group.key)}">Voir les ${rest} autres documents</button></div>` : ""}`;
  }

  function totalsHtml(g) {
    if (!g.entries.some((e) => e.ttc != null)) return "";
    return `<span class="ar-totals">TTC ${fmt(g.ttc)} · TVA ${fmt(g.tva)}</span>`;
  }

  function monthGroupsHtml(visible) {
    return groupByMonth(visible).map((g) => {
      const unread = g.entries.filter((e) => e.kind === "purchase" && !e.analyzed).length;
      const check = groupCheckState(g.entries);
      const meta = [plural(g.count, "document", "documents"), unread ? `${unread} ${audience === "portal" ? "en cours" : "non lue" + (unread > 1 ? "s" : "")}` : "", formatBytes(g.bytes)].filter(Boolean).join(" · ");
      return `
        <section class="ar-group" data-group="${esc(g.key)}">
          <header class="ar-group-head">
            <input type="checkbox" data-group-check="${esc(g.key)}" ${check === "all" ? "checked" : ""} data-indeterminate="${check === "some"}" aria-label="Sélectionner ${esc(g.label)}" />
            <h3>${esc(g.label)}</h3>
            <span class="ar-meta">${meta}</span>
            <span class="ar-spacer"></span>
            ${totalsHtml(g)}
            <button type="button" class="ar-btn ar-btn-small" data-zip-group="${esc(g.key)}">${ICONS.download} Télécharger le mois</button>
          </header>
          ${tableHtml(g, { showParty: true })}
        </section>`;
    }).join("");
  }

  function partyGroupsHtml(visible) {
    return groupByParty(visible).map((g) => {
      const open = state.open.has(g.key) || state.query.trim().length > 1;
      const check = groupCheckState(g.entries);
      const special = g.partyKey === UNREAD_GROUP_KEY || g.kind === "bank";
      const kindTag = g.kind === "sale" ? '<span class="ar-tag ar-tag-sale">Client</span>' : special ? "" : '<span class="ar-tag">Fournisseur</span>';
      return `
        <section class="ar-group ar-group-party${open ? " is-open" : ""}" data-group="${esc(g.key)}">
          <header class="ar-group-head">
            <input type="checkbox" data-group-check="${esc(g.key)}" ${check === "all" ? "checked" : ""} data-indeterminate="${check === "some"}" aria-label="Sélectionner ${esc(g.label)}" />
            <button type="button" class="ar-toggle" data-toggle="${esc(g.key)}" aria-expanded="${open}">
              <span class="ar-chevron">${ICONS.chevron}</span>
              <span class="ar-toggle-text">
                <strong>${esc(g.partyKey === UNREAD_GROUP_KEY && audience === "portal" ? "En cours de traitement" : g.label)}</strong>
                <small>${kindTag}${plural(g.count, "document", "documents")} · ${esc(periodRangeLabel(g.firstPeriod, g.lastPeriod))}</small>
              </span>
            </button>
            <span class="ar-spacer"></span>
            ${totalsHtml(g)}
            <button type="button" class="ar-btn ar-btn-small" data-zip-group="${esc(g.key)}" aria-label="Télécharger ${esc(g.label)}">${ICONS.download} Télécharger</button>
          </header>
          ${open ? tableHtml(g, { showParty: false }) : ""}
        </section>`;
    }).join("");
  }

  function emptyHtml() {
    if (state.loading) return '<div class="ar-empty"><span class="ar-spinner" aria-hidden="true"></span> Chargement des documents de toutes les périodes…</div>';
    if (state.error) return `<div class="ar-empty ar-error">${esc(state.error)} <button type="button" class="ar-link" data-role="retry">Réessayer</button></div>`;
    if (!state.entries.length) {
      return `<div class="ar-empty">${audience === "portal"
        ? "Aucun document pour l'instant. Les factures que vous déposez apparaîtront ici, classées par mois et par fournisseur."
        : "Aucun document importé pour ce client. Les factures et relevés importés dans les périodes apparaîtront ici."}</div>`;
    }
    return '<div class="ar-empty">Aucun document ne correspond à ces filtres. <button type="button" class="ar-link" data-role="reset">Effacer les filtres</button></div>';
  }

  function render() {
    const focusedRole = document.activeElement?.dataset?.role;
    const caret = focusedRole === "query" ? document.activeElement.selectionStart : null;
    const visible = state.loading || state.error ? [] : visibleEntries();
    mountEl.innerHTML = `
      <div class="ar">
        ${state.notice ? `<div class="ar-notice ar-notice-${esc(state.notice.variant)}" role="status"><span><strong>${esc(state.notice.title)}</strong>${state.notice.message ? ` ${esc(state.notice.message)}` : ""}</span><button type="button" class="ar-icon" data-role="notice-close" aria-label="Fermer">×</button></div>` : ""}
        <div class="ar-body">
          ${state.entries.length ? renderToolbar() : ""}
          ${visible.length || state.selected.size ? renderBar(visible) : ""}
          ${visible.length ? `<div class="ar-groups">${state.mode === "month" ? monthGroupsHtml(visible) : partyGroupsHtml(visible)}</div>` : emptyHtml()}
        </div>
        ${state.dialog ? dialogHtml() : ""}
      </div>`;
    mountEl.querySelectorAll("[data-indeterminate='true']").forEach((el) => { el.indeterminate = true; });
    if (focusedRole === "query") {
      const input = mountEl.querySelector('[data-role="query"]');
      input?.focus();
      if (caret != null) input?.setSelectionRange(caret, caret);
    }
    if (state.dialog && !state.running) mountEl.querySelector(".ar-dialog [data-role='zip-start']")?.focus();
  }

  // ---------- Boîte de téléchargement ----------
  function dialogHtml() {
    const d = state.dialog;
    const bytes = d.entries.reduce((s, e) => s + (e.sizeBytes || 0), 0);
    const sample = zipPaths(d.entries, d.layout).find(({ entry }) => entry.analyzed && entry.kind !== "bank") || zipPaths(d.entries, d.layout)[0];
    const parts = planZipParts(d.entries.map((entry) => ({ entry })), ZIP_PART_BYTES).length;
    const stream = canStreamToDisk();
    const generated = d.entries.filter((e) => e.generated).length;
    const sizeNote = stream
      ? "Vous choisirez où enregistrer le fichier : il est écrit au fur et à mesure, en un seul ZIP."
      : parts > 1
        ? `Le téléchargement sera découpé en ${parts} fichiers ZIP de 300 Mo au plus, pour ne pas saturer ${audience === "portal" ? "votre téléphone ou navigateur" : "le navigateur"}.`
        : "Un seul fichier ZIP.";
    const progress = d.progress;
    return `
      <div class="ar-overlay" data-role="overlay">
        <div class="ar-dialog" role="dialog" aria-modal="true" aria-labelledby="arDialogTitle">
          <h3 id="arDialogTitle">Télécharger ${plural(d.entries.length, "document", "documents")}</h3>
          <p class="ar-dialog-sub">${esc(d.title)} · ${formatBytes(bytes)}</p>
          <fieldset class="ar-layouts" ${state.running ? "disabled" : ""}>
            <legend>Ranger les fichiers</legend>
            ${Object.entries(ZIP_LAYOUTS).map(([key, label]) => `
              <label class="ar-layout${d.layout === key ? " is-on" : ""}">
                <input type="radio" name="arLayout" value="${key}" ${d.layout === key ? "checked" : ""} />
                <span>${esc(label)}</span>
              </label>`).join("")}
          </fieldset>
          ${sample ? `<p class="ar-example">Exemple : <code>${esc(sample.path)}</code></p>` : ""}
          <label class="ar-check"><input type="checkbox" data-role="recap" ${d.recap ? "checked" : ""} ${state.running ? "disabled" : ""} /> Ajouter un récapitulatif Excel (fournisseur, n°, dates, TTC, TVA)</label>
          <p class="ar-note">${esc(sizeNote)}${generated ? ` ${plural(generated, "document créé dans Recompta sera converti", "documents créés dans Recompta seront convertis")} en PDF.` : ""}</p>
          ${progress ? `
            <div class="ar-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${progress.total}" aria-valuenow="${progress.done}">
              <span style="width:${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%"></span>
            </div>
            <p class="ar-progress-text">${progress.done} / ${progress.total} documents ajoutés</p>` : ""}
          <div class="ar-dialog-actions">
            <button type="button" class="ar-btn ar-btn-ghost-dark" data-role="zip-cancel">${state.running ? "Arrêter" : "Annuler"}</button>
            <button type="button" class="ar-btn ar-btn-primary" data-role="zip-start" ${state.running ? "disabled" : ""}>${ICONS.download} ${state.running ? "Préparation…" : "Télécharger"}</button>
          </div>
        </div>
      </div>`;
  }

  function openDialog(entries, title) {
    if (!entries.length) return;
    state.dialog = { entries, title, layout: state.mode === "party" ? "party" : "month", recap: true, progress: null };
    render();
  }

  function updateProgress(progress) {
    if (!state.dialog) return;
    state.dialog.progress = progress;
    const bar = mountEl.querySelector(".ar-progress span");
    const text = mountEl.querySelector(".ar-progress-text");
    if (bar && text) {
      bar.style.width = `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`;
      bar.parentElement.setAttribute("aria-valuenow", String(progress.done));
      text.textContent = `${progress.done} / ${progress.total} documents ajoutés`;
    } else {
      render();
    }
  }

  async function startDownload() {
    const d = state.dialog;
    if (!d || state.running) return;
    const controller = new AbortController();
    state.running = controller;
    d.progress = { done: 0, total: d.entries.length };
    render();
    try {
      const { clientName } = getContext() || {};
      const result = await downloadArchive({
        entries: d.entries,
        layout: d.layout,
        withRecap: d.recap,
        clientName: clientName || "Client",
        onProgress: updateProgress,
        signal: controller.signal,
      });
      state.running = null;
      if (result.cancelled) {
        state.dialog.progress = null;
        render();
        return;
      }
      state.dialog = null;
      render();
      if (result.failures.length) {
        notify("Téléchargement terminé avec des manques",
          `${plural(result.failures.length, "document n'a pas pu être ajouté", "documents n'ont pas pu être ajoutés")} : la liste est dans « A-LIRE-erreurs.txt » du ZIP.`, "warning");
      } else {
        notify("Téléchargement terminé", `${plural(result.files, "document", "documents")}${result.parts > 1 ? ` en ${result.parts} fichiers ZIP` : ""}.`, "success");
      }
    } catch (err) {
      state.running = null;
      if (err?.name === "AbortError") {
        state.dialog = null;
        render();
        notify("Téléchargement arrêté");
        return;
      }
      if (state.dialog) state.dialog.progress = null;
      render();
      notify("Téléchargement impossible", err.message || "Erreur inconnue.", "error");
    }
  }

  // ---------- Événements ----------
  function groupEntries(key) {
    const visible = visibleEntries();
    const groups = state.mode === "month" ? groupByMonth(visible) : groupByParty(visible);
    return groups.find((g) => g.key === key);
  }

  let queryTimer = null;
  mountEl.addEventListener("input", (event) => {
    const role = event.target.dataset.role;
    if (role === "query") {
      clearTimeout(queryTimer);
      const value = event.target.value;
      queryTimer = setTimeout(() => {
        state.query = value;
        render();
      }, 160);
    }
  });

  mountEl.addEventListener("change", (event) => {
    const t = event.target;
    if (t.dataset.role === "from" || t.dataset.role === "to") {
      state[t.dataset.role] = t.value;
      if (state.from && state.to && state.from > state.to) {
        if (t.dataset.role === "from") state.to = state.from;
        else state.from = state.to;
      }
      render();
    } else if (t.dataset.entry) {
      if (t.checked) state.selected.add(t.dataset.entry);
      else state.selected.delete(t.dataset.entry);
      render();
    } else if (t.dataset.groupCheck) {
      const g = groupEntries(t.dataset.groupCheck);
      if (!g) return;
      const all = g.entries.every((e) => state.selected.has(e.key));
      g.entries.forEach((e) => (all ? state.selected.delete(e.key) : state.selected.add(e.key)));
      render();
    } else if (t.name === "arLayout" && state.dialog) {
      state.dialog.layout = t.value;
      render();
    } else if (t.dataset.role === "recap" && state.dialog) {
      state.dialog.recap = t.checked;
    }
  });

  mountEl.addEventListener("click", async (event) => {
    const el = event.target.closest("button, [data-role='overlay']");
    if (!el) return;
    if (el.dataset.role === "overlay") {
      if (event.target === el && !state.running) {
        state.dialog = null;
        render();
      }
      return;
    }
    const role = el.dataset.role;
    if (el.dataset.mode) {
      state.mode = el.dataset.mode;
      state.showAll.clear();
      render();
    } else if (el.dataset.kind) {
      const k = el.dataset.kind;
      if (state.kinds.has(k)) state.kinds.delete(k);
      else state.kinds.add(k);
      render();
    } else if (role === "unread") {
      state.unreadOnly = !state.unreadOnly;
      render();
    } else if (role === "ignored") {
      state.showIgnored = !state.showIgnored;
      render();
    } else if (role === "reset") {
      Object.assign(state, { query: "", from: "", to: "", unreadOnly: false });
      state.kinds.clear();
      render();
    } else if (role === "notice-close") {
      state.notice = null;
      render();
    } else if (role === "retry") {
      load({ force: true });
    } else if (role === "clear") {
      state.selected.clear();
      render();
    } else if (role === "select-visible") {
      visibleEntries().forEach((e) => state.selected.add(e.key));
      render();
    } else if (role === "zip-visible") {
      openDialog(visibleEntries(), "Documents affichés");
    } else if (role === "zip-selected") {
      const map = byKey();
      openDialog([...state.selected].map((k) => map.get(k)).filter(Boolean), "Sélection");
    } else if (el.dataset.zipGroup) {
      const g = groupEntries(el.dataset.zipGroup);
      if (g) openDialog(g.entries, g.label);
    } else if (el.dataset.toggle) {
      const k = el.dataset.toggle;
      if (state.open.has(k)) state.open.delete(k);
      else state.open.add(k);
      render();
    } else if (el.dataset.more) {
      state.showAll.add(el.dataset.more);
      render();
    } else if (el.dataset.open) {
      const entry = byKey().get(el.dataset.open);
      if (!entry) return;
      try {
        await openEntry(entry);
      } catch (err) {
        notify("Ouverture impossible", err.message, "error");
      }
    } else if (role === "zip-start") {
      startDownload();
    } else if (role === "zip-cancel") {
      if (state.running) state.running.abort();
      else {
        state.dialog = null;
        render();
      }
    }
  });

  mountEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.dialog && !state.running) {
      state.dialog = null;
      render();
    }
  });

  return {
    load,
    reload: () => load({ force: true }),
    get entries() { return state.entries; },
  };
}
