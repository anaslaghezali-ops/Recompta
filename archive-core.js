/**
 * Vue « Tous les documents » (cabinet) / « Archives » (portail) : logique pure.
 * Aucune dépendance (testable sous Node) : construction des entrées à partir des
 * documents de toutes les périodes, filtres, regroupements par mois ou par tiers,
 * noms de fichiers dans le ZIP, découpage en parties, récapitulatif.
 */

const MONTHS = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
];

export const ENTRY_KINDS = {
  purchase: "Achats",
  bank: "Relevés",
  sale: "Ventes",
};

export const SALE_KIND_LABELS = { invoice: "Facture", credit_note: "Avoir", quote: "Devis" };

export const ZIP_LAYOUTS = {
  month: "Un dossier par mois",
  party: "Un dossier par fournisseur / client",
  flat: "Tout dans un seul dossier",
};

/** Taille maximale d'une partie quand le ZIP est fabriqué en mémoire. */
export const ZIP_PART_BYTES = 300 * 1024 * 1024;

export const UNREAD_GROUP_KEY = "__unread__";
export const BANK_GROUP_KEY = "__bank__";

const pad2 = (n) => String(n).padStart(2, "0");

export const periodKey = (year, month) => `${year}-${pad2(month)}`;

export function periodLabel(key) {
  const [y, m] = String(key || "").split("-").map(Number);
  if (!y || !m) return "Sans date";
  return `${MONTHS[m - 1]} ${y}`;
}

function isoDate(value) {
  const m = String(value || "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function formatDateFr(value) {
  const iso = isoDate(value);
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const round2 = (n) => Math.round(n * 100) / 100;

function basename(path) {
  const parts = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "document";
}

function extensionOf(name, fallback = "pdf") {
  const m = basename(name).match(/\.([a-z0-9]{1,5})$/i);
  return m ? m[1].toLowerCase() : fallback;
}

function stripAccents(text) {
  return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Nom lisible et sûr pour un fichier ou un dossier du ZIP. */
export function safeName(text, fallback = "document") {
  const cleaned = stripAccents(text)
    .replace(/[\\/:*?"<>|#%{}^~[\]`]+/g, " ")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

const LEGAL_FORMS = /\b(sarlau|sarl|sas|sa|snc|au|ste|societe|ets|etablissements?)\b/g;

/** Clé de regroupement d'un nom : sans accents, ponctuation ni forme juridique. */
export function normalizePartyName(name) {
  return stripAccents(name)
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[-_'’,&()/]/g, " ")
    .replace(LEGAL_FORMS, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeIce(ice) {
  const digits = String(ice || "").replace(/\D/g, "");
  return /^\d{15}$/.test(digits) ? digits : "";
}

function identityKeys(filename) {
  const parts = String(filename || "").replace(/\\/g, "/").split("/").filter(Boolean)
    .map((p) => p.toLowerCase());
  const keys = new Set();
  if (parts.length >= 2) keys.add(`${parts[parts.length - 2]}/${parts[parts.length - 1]}`);
  if (parts.length) keys.add(parts[parts.length - 1]);
  return keys;
}

function sameFile(a, b) {
  const ka = identityKeys(a);
  for (const k of identityKeys(b)) if (ka.has(k)) return true;
  return false;
}

function isZip(doc) {
  return doc?.doc_type === "archive" || /\.zip$/i.test(basename(doc?.original_filename));
}

/**
 * Lignes extraites qui proviennent d'un document. Le source_id n'est unique
 * qu'au sein d'une période : la correspondance se fait toujours dans le même dossier.
 */
export function linesForDocument(doc, linesByDossier) {
  const lines = linesByDossier.get(doc.dossier_id) || [];
  return lines.filter((line) => {
    if (line.from_bank) return false;
    if (doc.source_id && line.source_id) return String(doc.source_id) === String(line.source_id);
    return Boolean(line.source_file) && sameFile(doc.original_filename, line.source_file);
  });
}

function groupLinesByDossier(lines) {
  const map = new Map();
  for (const line of lines || []) {
    if (!line || line.dossier_id == null) continue;
    if (!map.has(line.dossier_id)) map.set(line.dossier_id, []);
    map.get(line.dossier_id).push(line);
  }
  return map;
}

function partyFromLines(lines) {
  for (const line of lines) {
    const name = String(line.lib_frss || "").trim();
    if (name) return { name, ice: normalizeIce(line.ice_frs) };
  }
  return null;
}

function maxDate(values) {
  return values.map(isoDate).filter(Boolean).sort().pop() || null;
}

function minDate(values) {
  return values.map(isoDate).filter(Boolean).sort()[0] || null;
}

/**
 * Construit la liste unique des entrées (achats, relevés, ventes).
 * @param {object} data
 * @param {Array} data.documents  documents de toutes les périodes (archive_overview)
 * @param {Array} data.lines      lignes réduites (archive_overview)
 * @param {Array} data.sales      lignes de la vue sales_invoices (facultatif)
 */
export function buildArchiveEntries({ documents = [], lines = [], sales = [] } = {}) {
  const linesByDossier = groupLinesByDossier(lines);
  const entries = [];
  const seen = new Set();

  for (const doc of documents) {
    if (!doc || seen.has(doc.id)) continue;
    seen.add(doc.id);
    if (isZip(doc)) continue;
    const period = periodKey(doc.period_year, doc.period_month);
    const filename = basename(doc.original_filename);
    const base = {
      key: `doc:${doc.id}`,
      id: doc.id,
      dossierId: doc.dossier_id,
      period,
      filename,
      extension: extensionOf(filename),
      storagePath: doc.storage_path,
      bucket: "dossier-documents",
      sizeBytes: num(doc.size_bytes),
      createdAt: doc.created_at || null,
      ignored: doc.extraction_status === "ignored",
      generated: false,
    };

    if (doc.doc_type === "bank") {
      entries.push({
        ...base,
        kind: "bank",
        partyKey: BANK_GROUP_KEY,
        partyName: "Relevés bancaires",
        analyzed: true,
        number: "",
        date: null, // date d'import, pas celle du relevé : on n'affiche rien
        ttc: null,
        tva: null,
        paidOn: null,
      });
      continue;
    }

    const docLines = linesForDocument(doc, linesByDossier);
    const party = partyFromLines(docLines);
    const analyzed = Boolean(party);
    entries.push({
      ...base,
      kind: "purchase",
      analyzed,
      partyKey: analyzed ? (party.ice ? `ice:${party.ice}` : `name:${normalizePartyName(party.name)}`) : UNREAD_GROUP_KEY,
      partyName: analyzed ? party.name : "Pas encore analysées",
      number: analyzed ? String(docLines.find((l) => l.fact_num)?.fact_num || "").trim() : "",
      date: analyzed ? minDate(docLines.map((l) => l.date_fac)) : null,
      ttc: analyzed ? round2(docLines.reduce((s, l) => s + num(l.m_ttc), 0)) : null,
      tva: analyzed ? round2(docLines.reduce((s, l) => s + num(l.tva), 0)) : null,
      paidOn: analyzed ? maxDate(docLines.map((l) => l.date_paie)) : null,
    });
  }

  for (const sale of sales) {
    if (!sale || sale.status === "draft") continue;
    const date = isoDate(sale.issue_date);
    const created = sale.origin === "created";
    const name = String(sale.customer_name || "").trim() || "Client non renseigné";
    const number = String(sale.number || sale.external_number || "").trim();
    const kindLabel = SALE_KIND_LABELS[sale.kind || "invoice"] || "Facture";
    if (!created && !sale.document_path) continue; // facture importée sans fichier : rien à télécharger
    const filename = created
      ? `${kindLabel} ${number || sale.id}.pdf`
      : basename(sale.document_path);
    entries.push({
      key: `sale:${sale.id}`,
      id: sale.id,
      kind: "sale",
      saleKind: sale.kind || "invoice",
      saleStatus: sale.status,
      dossierId: null,
      period: date ? date.slice(0, 7) : "",
      filename,
      extension: created ? "pdf" : extensionOf(filename),
      storagePath: created ? null : sale.document_path,
      bucket: created ? null : "sales-documents",
      sizeBytes: created ? 60 * 1024 : num(sale.size_bytes),
      createdAt: sale.created_at || null,
      ignored: false,
      generated: created,
      analyzed: true,
      partyKey: `name:${normalizePartyName(name)}`,
      partyName: name,
      number,
      date,
      ttc: round2(num(sale.total_ttc)),
      tva: round2(num(sale.total_vat)),
      paidOn: isoDate(sale.last_paid_on),
      cancelled: sale.status === "voided" || sale.status === "cancelled",
    });
  }

  // Même fournisseur lu une fois avec ICE, une fois sans : on rattache au groupe ICE.
  const iceByName = new Map();
  for (const e of entries) {
    if (e.kind === "purchase" && e.partyKey.startsWith("ice:")) {
      iceByName.set(normalizePartyName(e.partyName), e.partyKey);
    }
  }
  for (const e of entries) {
    if (e.kind === "purchase" && e.partyKey.startsWith("name:")) {
      const name = e.partyKey.slice(5);
      let iceKey = iceByName.get(name);
      if (!iceKey && name.length >= 6) {
        // « Achibest » et « ACHI-BEST FOOD » : un nom qui commence l'autre (6 caractères minimum).
        const candidates = [...iceByName.entries()]
          .filter(([other]) => other.length >= 6 && (other.startsWith(name) || name.startsWith(other)));
        if (new Set(candidates.map(([, key]) => key)).size === 1) iceKey = candidates[0][1];
      }
      if (iceKey) e.partyKey = iceKey;
    }
  }

  return entries.sort(compareEntries);
}

function compareEntries(a, b) {
  if (a.period !== b.period) return a.period < b.period ? 1 : -1;
  const da = a.date || "";
  const db = b.date || "";
  if (da !== db) return da < db ? 1 : -1;
  return String(a.key).localeCompare(String(b.key));
}

/**
 * Filtre les entrées.
 * @param {object} f
 * @param {string} f.query    recherche libre (tiers, n°, nom de fichier, montant)
 * @param {Set|Array} f.kinds types gardés (purchase, bank, sale) ; vide = tous
 * @param {string} f.from     période minimale « AAAA-MM »
 * @param {string} f.to       période maximale « AAAA-MM »
 * @param {boolean} f.unreadOnly seulement les factures pas encore analysées
 * @param {boolean} f.showIgnored inclure les documents écartés
 */
export function filterEntries(entries, { query = "", kinds = null, from = "", to = "", unreadOnly = false, showIgnored = false } = {}) {
  const kindSet = kinds ? new Set(kinds) : null;
  const terms = stripAccents(query).toLowerCase().split(/\s+/).filter(Boolean);
  return (entries || []).filter((e) => {
    if (kindSet && kindSet.size && !kindSet.has(e.kind)) return false;
    if (!showIgnored && e.ignored) return false;
    if (unreadOnly && (e.kind !== "purchase" || e.analyzed)) return false;
    if (from && e.period && e.period < from) return false;
    if (to && e.period && e.period > to) return false;
    if (!terms.length) return true;
    const amounts = [e.ttc, e.tva].filter((v) => v != null)
      .flatMap((v) => [v.toFixed(2), v.toFixed(2).replace(".", ","), String(Math.round(v))]);
    const hay = stripAccents([e.partyName, e.number, e.filename, formatDateFr(e.date), ...amounts].join(" ")).toLowerCase();
    const compact = hay.replace(/[\s.\-_]/g, "");
    return terms.every((t) => hay.includes(t) || compact.includes(t.replace(/[\s.\-_]/g, "")));
  });
}

function totalsOf(entries) {
  let ttc = 0;
  let tva = 0;
  let bytes = 0;
  for (const e of entries) {
    if (!e.cancelled) {
      const sign = e.saleKind === "credit_note" ? -1 : 1;
      if (e.saleKind !== "quote") {
        ttc += sign * num(e.ttc);
        tva += sign * num(e.tva);
      }
    }
    bytes += num(e.sizeBytes);
  }
  return { count: entries.length, ttc: round2(ttc), tva: round2(tva), bytes };
}

/** Groupes par période (mois de la déclaration ; date d'émission pour les ventes), du plus récent au plus ancien. */
export function groupByMonth(entries) {
  const map = new Map();
  for (const e of entries || []) {
    const key = e.period || "";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([key, list]) => ({ key, label: periodLabel(key), entries: list, ...totalsOf(list) }));
}

/** Groupes par fournisseur ou client acheteur ; non analysées et relevés à la fin. */
export function groupByParty(entries) {
  const map = new Map();
  for (const e of entries || []) {
    const key = `${e.kind === "sale" ? "sale" : "buy"}|${e.partyKey}`;
    if (!map.has(key)) map.set(key, { key, partyKey: e.partyKey, kind: e.kind, names: new Map(), entries: [] });
    const g = map.get(key);
    g.entries.push(e);
    g.names.set(e.partyName, (g.names.get(e.partyName) || 0) + 1);
  }
  const rank = (g) => (g.partyKey === UNREAD_GROUP_KEY ? 3 : g.partyKey === BANK_GROUP_KEY ? 2 : g.kind === "sale" ? 1 : 0);
  return [...map.values()]
    .map((g) => {
      // Libellé : le nom le plus fréquent (puis le plus long à égalité).
      const label = [...g.names.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
      const periods = g.entries.map((e) => e.period).filter(Boolean).sort();
      return {
        key: g.key,
        partyKey: g.partyKey,
        kind: g.kind,
        label,
        entries: g.entries,
        firstPeriod: periods[0] || "",
        lastPeriod: periods[periods.length - 1] || "",
        ...totalsOf(g.entries),
      };
    })
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, "fr", { sensitivity: "base" }));
}

export function periodRangeLabel(first, last) {
  if (!first) return "";
  if (first === last) return periodLabel(first);
  return `${periodLabel(first)} → ${periodLabel(last)}`;
}

/** Nom lisible d'un document dans le ZIP : Fournisseur_N°_JJ-MM-AAAA.ext */
export function readableFilename(entry) {
  if (entry.kind === "bank" || (entry.kind === "purchase" && !entry.analyzed)) {
    return safeName(entry.filename);
  }
  const parts = [safeName(entry.partyName, "Tiers")];
  if (entry.kind === "sale" && entry.saleKind && entry.saleKind !== "invoice") {
    parts.unshift(SALE_KIND_LABELS[entry.saleKind]);
  }
  if (entry.number) parts.push(safeName(entry.number));
  const fr = formatDateFr(entry.date);
  if (fr) parts.push(fr.replace(/\//g, "-"));
  return `${parts.join("_").replace(/ /g, "-")}.${entry.extension || "pdf"}`;
}

function kindFolder(kind) {
  return ENTRY_KINDS[kind] || "Documents";
}

/**
 * Chemins dans le ZIP, sans doublon (« (2) » ajouté si deux fichiers ont le même nom).
 * Quand plusieurs types sont présents, un dossier Achats / Ventes / Relevés est ajouté en tête.
 */
export function zipPaths(entries, layout = "month") {
  const kinds = new Set((entries || []).map((e) => e.kind));
  const splitKinds = kinds.size > 1;
  const used = new Set();
  return (entries || []).map((entry) => {
    const name = readableFilename(entry);
    const folders = [];
    if (splitKinds) folders.push(kindFolder(entry.kind));
    if (layout === "month") folders.push(entry.period || "Sans-date");
    else if (layout === "party") folders.push(safeName(entry.partyName, "Tiers"));
    let path = [...folders, name].join("/");
    if (used.has(path.toLowerCase())) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let i = 2;
      do {
        path = [...folders, `${stem} (${i})${ext}`].join("/");
        i += 1;
      } while (used.has(path.toLowerCase()));
    }
    used.add(path.toLowerCase());
    return { entry, path };
  });
}

/** Découpe une liste de fichiers en parties d'au plus maxBytes (un fichier n'est jamais coupé). */
export function planZipParts(items, maxBytes = ZIP_PART_BYTES) {
  const parts = [];
  let current = [];
  let size = 0;
  for (const item of items || []) {
    const bytes = num(item.entry ? item.entry.sizeBytes : item.sizeBytes);
    if (current.length && size + bytes > maxBytes) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += bytes;
  }
  if (current.length) parts.push(current);
  return parts;
}

export const RECAP_HEADERS = ["Type", "Période", "Fournisseur / client", "N°", "Date", "TTC", "TVA", "Payée le", "Fichier dans le ZIP"];

/** Lignes du récapitulatif Excel (une par fichier du ZIP). */
export function recapRows(pathItems) {
  return (pathItems || []).map(({ entry, path }) => [
    entry.kind === "sale" ? (SALE_KIND_LABELS[entry.saleKind] ? `Vente — ${SALE_KIND_LABELS[entry.saleKind].toLowerCase()}` : "Vente")
      : entry.kind === "bank" ? "Relevé" : "Achat",
    periodLabel(entry.period),
    entry.kind === "bank" ? "" : (entry.analyzed ? entry.partyName : "Pas encore analysée"),
    entry.number || "",
    formatDateFr(entry.date),
    entry.ttc ?? "",
    entry.tva ?? "",
    formatDateFr(entry.paidOn),
    path,
  ]);
}

/** Nom du fichier ZIP téléchargé. */
export function zipFilename(clientName, { part = 0, parts = 1, today = new Date() } = {}) {
  const stamp = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  const base = `${safeName(clientName, "Client").replace(/ /g, "-")}_documents_${stamp}`;
  return parts > 1 ? `${base}_partie-${part + 1}-sur-${parts}.zip` : `${base}.zip`;
}

export function formatBytes(bytes) {
  const n = num(bytes);
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1).replace(".", ",")} Go`;
  if (n >= 1024 * 1024) return `${Math.max(1, Math.round(n / 1024 / 1024))} Mo`;
  return `${Math.max(1, Math.round(n / 1024))} Ko`;
}
