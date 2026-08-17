function documentIdentityKeys(filename) {
  const name = String(filename || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = name.split("/").filter(Boolean);
  const keys = new Set();
  if (parts.length >= 2) {
    keys.add(`${parts[parts.length - 2].toLowerCase()}/${parts[parts.length - 1].toLowerCase()}`);
  }
  if (parts.length) keys.add(parts[parts.length - 1].toLowerCase());
  if (!keys.size) keys.add("document");
  return keys;
}

async function mapPool(items, concurrency, worker) {
  const list = items || [];
  const results = new Array(list.length);
  let next = 0;
  async function run() {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await worker(list[index], index);
    }
  }
  const n = Math.max(1, Math.min(concurrency || 4, list.length || 1));
  await Promise.all(Array.from({ length: list.length ? n : 0 }, () => run()));
  return results;
}

function indexDocumentsByIdentity(docs) {
  const index = new Map();
  for (const doc of docs || []) {
    for (const key of documentIdentityKeys(doc.original_filename || "")) {
      const rows = index.get(key) || [];
      rows.push(doc);
      index.set(key, rows);
    }
  }
  return index;
}

function findIndexedDocument(index, filename, fileSize = null) {
  if (!index) return null;
  for (const key of documentIdentityKeys(filename)) {
    const rows = index.get(key) || [];
    const match = fileSize == null
      ? rows[0]
      : rows.find((row) => Number(row.size_bytes || 0) === Number(fileSize));
    if (match) return match;
  }
  return null;
}

function countPendingAnalysis(documents, workspace) {
  const lines = workspace?.lineRefs || workspace?.lines || [];
  const bankCount = workspace?.bankCount ?? workspace?.bank_transactions?.length ?? 0;
  const processed = new Set(lines.map((line) => line.source_id).filter(Boolean));
  let invoicePending = 0;
  let bankPending = 0;
  for (const doc of documents || []) {
    if (doc.doc_type === "invoice" && !processed.has(doc.source_id)) invoicePending += 1;
    if (doc.doc_type === "bank" && bankCount === 0) bankPending += 1;
  }
  return { invoicePending, bankPending, total: invoicePending + bankPending };
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: got ${a}, expected ${e}`);
}

const started = [];
const finished = [];
const results = await mapPool([10, 20, 30, 40], 2, async (value, index) => {
  started.push(index);
  await new Promise((resolve) => setTimeout(resolve, 5));
  finished.push(index);
  return value * 2;
});
assertEqual(results, [20, 40, 60, 80], "mapPool keeps order");
if (started.length !== 4 || finished.length !== 4) {
  throw new Error("mapPool must visit every item");
}

const empty = await mapPool([], 4, async () => 1);
assertEqual(empty, [], "mapPool empty");

const index = indexDocumentsByIdentity([
  { original_filename: "Probun/FAC1.pdf", size_bytes: 100, source_id: "src-1" },
  { original_filename: "Orange/FAC1.pdf", size_bytes: 200, source_id: "src-2" },
]);
const hit = findIndexedDocument(index, "Probun/FAC1.pdf", 100);
if (hit?.source_id !== "src-1") throw new Error("index should match folder/name + size");
const miss = findIndexedDocument(index, "Probun/FAC1.pdf", 999);
if (miss) throw new Error("same name different size must not match");

const pending = countPendingAnalysis(
  [
    { doc_type: "invoice", source_id: "src-1" },
    { doc_type: "invoice", source_id: "src-2" },
    { doc_type: "bank", source_id: "bank-1" },
  ],
  {
    lineRefs: [{ source_id: "src-1", source_file: "Probun/FAC1.pdf" }],
    bankCount: 0,
  },
);
assertEqual(pending, { invoicePending: 1, bankPending: 1, total: 2 }, "lineRefs drive pending");

console.log("test-upload-pool: ok");
