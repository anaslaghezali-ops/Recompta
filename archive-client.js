/**
 * Vue « Tous les documents » / « Archives » : données et téléchargements.
 * - loadArchive(clientId) : documents de toutes les périodes + ventes
 * - openEntry(entry) : ouvre un document dans un nouvel onglet
 * - downloadArchive(...) : ZIP fabriqué dans le navigateur (client-zip, sans
 *   compression : les PDF et images sont déjà compressés).
 *   Sur ordinateur (Chrome, Edge) : écrit au fil de l'eau dans le fichier choisi,
 *   un seul ZIP quelle que soit la taille. Ailleurs : en mémoire, découpé en
 *   parties d'au plus 300 Mo pour ne pas saturer le navigateur.
 */
import { getSupabase } from "./auth-client.js?v=auth10";
import {
  RECAP_HEADERS,
  ZIP_PART_BYTES,
  buildArchiveEntries,
  planZipParts,
  recapRows,
  zipFilename,
  zipPaths,
} from "./archive-core.js?v=arch1";

const CLIENT_ZIP_URL = "https://cdn.jsdelivr.net/npm/client-zip@2.5.1/index.js";
const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
const FETCH_CONCURRENCY = 4;

const db = () => {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Connexion indisponible.");
  return supabase;
};

export async function loadArchive(clientId) {
  const [overview, sales] = await Promise.all([
    db().rpc("archive_overview", { p_client_id: clientId }),
    db().from("sales_invoices")
      .select("id, status, origin, kind, number, external_number, issue_date, customer_name, total_ttc, total_vat, last_paid_on, document_path, created_at")
      .eq("issuer_client_id", clientId)
      .neq("status", "draft"),
  ]);
  if (overview.error) {
    if (/archive_overview|function|schema cache/i.test(overview.error.message || "")) {
      throw new Error("Mise à jour de la base requise (migration « Tous les documents »).");
    }
    throw overview.error;
  }
  // Les ventes sont facultatives : si la lecture échoue, on montre quand même les achats.
  const data = overview.data || {};
  return buildArchiveEntries({
    documents: data.documents || [],
    lines: data.lines || [],
    sales: sales.error ? [] : sales.data || [],
  });
}

async function signedUrl(entry, expiresIn = 900) {
  const { data, error } = await db().storage.from(entry.bucket).createSignedUrl(entry.storagePath, expiresIn);
  if (error || !data?.signedUrl) throw new Error(`Lien indisponible pour ${entry.filename}.`);
  return data.signedUrl;
}

/** Ouvre un document (PDF généré pour une vente créée). */
export async function openEntry(entry) {
  if (entry.generated) {
    window.open(`vente.html?id=${encodeURIComponent(entry.id)}`, "_blank", "noopener");
    return;
  }
  const win = window.open("", "_blank");
  try {
    const url = await signedUrl(entry);
    if (win) win.location.href = url;
    else window.location.href = url;
  } catch (err) {
    win?.close();
    throw err;
  }
}

async function entryBytes(entry, signal) {
  if (entry.generated) {
    const { salePdfBytes } = await import("./sale-pdf.js?v=spdf1");
    return salePdfBytes(entry.id);
  }
  const url = await signedUrl(entry);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Téléchargement impossible : ${entry.filename}`);
  return new Uint8Array(await res.arrayBuffer());
}

let clientZipPromise = null;
const loadClientZip = () => (clientZipPromise ||= import(CLIENT_ZIP_URL).catch((err) => {
  clientZipPromise = null;
  throw new Error(`Impossible de charger l'outil ZIP (connexion ?) : ${err.message}`);
}));

function loadXlsx() {
  if (globalThis.XLSX) return Promise.resolve(globalThis.XLSX);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = XLSX_URL;
    script.onload = () => resolve(globalThis.XLSX);
    script.onerror = () => reject(new Error("Impossible de charger l'outil Excel."));
    document.head.appendChild(script);
  });
}

async function recapWorkbook(pathItems, clientName) {
  const XLSX = await loadXlsx();
  const rows = [RECAP_HEADERS, ...recapRows(pathItems)];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [14, 16, 32, 18, 12, 14, 12, 12, 60].map((wch) => ({ wch }));
  for (let c = 0; c < RECAP_HEADERS.length; c += 1) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    if (cell) cell.s = { font: { bold: true }, fill: { fgColor: { rgb: "E8EEF6" } } };
  }
  for (let r = 1; r < rows.length; r += 1) {
    for (const c of [5, 6]) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === "number") cell.z = "#,##0.00";
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Documents");
  wb.Props = { Title: `Documents — ${clientName}` };
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

/**
 * Fichiers d'une partie, lus 4 par 4 en avance, rendus dans l'ordre.
 * Un fichier illisible n'arrête pas le ZIP : il est listé dans « A-LIRE-erreurs.txt ».
 */
async function* zipInputs(items, { onFile, signal, extra = [], failures }) {
  for (const file of extra) yield file;
  const pending = [];
  let next = 0;
  const start = () => {
    while (pending.length < FETCH_CONCURRENCY && next < items.length) {
      const item = items[next++];
      pending.push(entryBytes(item.entry, signal).then(
        (bytes) => ({ item, bytes }),
        (error) => ({ item, error }),
      ));
    }
  };
  start();
  while (pending.length) {
    const { item, bytes, error } = await pending.shift();
    if (signal?.aborted) throw new DOMException("Annulé", "AbortError");
    start();
    if (error) {
      failures.push(`${item.path} : ${error.message}`);
    } else {
      yield { name: item.path, input: bytes, lastModified: item.entry.createdAt ? new Date(item.entry.createdAt) : new Date() };
    }
    onFile?.(item);
  }
  if (failures.length) {
    yield {
      name: "A-LIRE-erreurs.txt",
      input: `Ces documents n'ont pas pu être ajoutés au ZIP :\r\n\r\n${failures.join("\r\n")}\r\n`,
    };
  }
}

export function canStreamToDisk() {
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Télécharge les entrées choisies en ZIP.
 * @returns {{ files: number, parts: number, failures: string[] }}
 */
export async function downloadArchive({ entries, layout = "month", withRecap = true, clientName = "Client", onProgress, signal } = {}) {
  if (!entries?.length) throw new Error("Aucun document sélectionné.");
  const { downloadZip } = await loadClientZip();
  const items = zipPaths(entries, layout);
  const total = items.length;
  let done = 0;
  const onFile = () => {
    done += 1;
    onProgress?.({ done, total });
  };
  const failures = [];
  const recap = withRecap
    ? [{ name: "Recapitulatif.xlsx", input: await recapWorkbook(items, clientName), lastModified: new Date() }]
    : [];

  // Ordinateur : un seul fichier, écrit au fil de l'eau.
  if (canStreamToDisk()) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: zipFilename(clientName),
        types: [{ description: "Archive ZIP", accept: { "application/zip": [".zip"] } }],
      });
    } catch (err) {
      if (err?.name === "AbortError") return { cancelled: true, files: 0, parts: 0, failures };
      handle = null; // sélecteur refusé (iframe, droits) : on bascule en mémoire
    }
    if (handle) {
      const writable = await handle.createWritable();
      try {
        await downloadZip(zipInputs(items, { onFile, signal, extra: recap, failures })).body.pipeTo(writable, { signal });
      } catch (err) {
        await writable.abort?.().catch(() => {});
        throw err;
      }
      return { files: total - failures.length, parts: 1, failures };
    }
  }

  // Ailleurs : en mémoire, par parties.
  const parts = planZipParts(items, ZIP_PART_BYTES);
  for (let p = 0; p < parts.length; p += 1) {
    const partFailures = [];
    const blob = await downloadZip(zipInputs(parts[p], { onFile, signal, extra: p === 0 ? recap : [], failures: partFailures })).blob();
    failures.push(...partFailures);
    if (signal?.aborted) throw new DOMException("Annulé", "AbortError");
    saveBlob(blob, zipFilename(clientName, { part: p, parts: parts.length }));
  }
  return { files: total - failures.length, parts: parts.length, failures };
}
