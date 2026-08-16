function isZipDocument(docOrFilename) {
  const name = typeof docOrFilename === "object"
    ? docOrFilename?.original_filename
    : docOrFilename;
  const base = String(name || "").replace(/\\/g, "/").split("/").pop() || "";
  return /\.zip$/i.test(base);
}

function getZipExtractedChildren(zipDoc, docs) {
  if (!zipDoc || !isZipDocument(zipDoc)) return [];
  const stem = String(zipDoc.original_filename || "").replace(/\.zip$/i, "").toLowerCase();
  return (docs || []).filter((doc) => {
    if (!doc || doc.id === zipDoc.id || isZipDocument(doc)) return false;
    const folder = String(doc.original_filename || "").replace(/\\/g, "/").split("/")[0].toLowerCase();
    return stem.startsWith(folder) || folder === stem;
  });
}

function collectDocumentsForDeletion(docs, allDocs, options = {}) {
  const {
    includeZipChildren = false,
    includeEmptyParentZips = false,
  } = options;
  const all = allDocs || [];
  const byId = new Map();
  for (const doc of docs || []) {
    if (doc?.id) byId.set(doc.id, doc);
  }

  if (includeZipChildren) {
    for (const doc of [...byId.values()]) {
      if (!isZipDocument(doc)) continue;
      for (const child of getZipExtractedChildren(doc, all)) {
        byId.set(child.id, child);
      }
    }
  }

  if (includeEmptyParentZips) {
    const selectedIds = new Set(byId.keys());
    for (const zip of all.filter((row) => row && isZipDocument(row))) {
      const children = getZipExtractedChildren(zip, all);
      if (!children.length) continue;
      if (children.every((child) => selectedIds.has(child.id))) {
        byId.set(zip.id, zip);
      }
    }
  }

  return [...byId.values()];
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: got ${a}, expected ${e}`);
}

const zip = { id: "zip-1", original_filename: "Probun-drive.zip" };
const a = { id: "a", original_filename: "Probun/FAC1.pdf" };
const b = { id: "b", original_filename: "Probun/FAC2.pdf" };
const other = { id: "c", original_filename: "Orange/FAC3.pdf" };
const all = [zip, a, b, other];

assertEqual(
  collectDocumentsForDeletion([a], all).map((d) => d.id).sort(),
  ["a"],
  "single file stays single file",
);

assertEqual(
  collectDocumentsForDeletion([a, b], all, { includeEmptyParentZips: true })
    .map((d) => d.id)
    .sort(),
  ["a", "b", "zip-1"],
  "folder of all zip children also drops the empty parent zip",
);

assertEqual(
  collectDocumentsForDeletion([a], all, { includeEmptyParentZips: true })
    .map((d) => d.id)
    .sort(),
  ["a"],
  "partial folder does not delete parent zip",
);

assertEqual(
  collectDocumentsForDeletion([zip], all, { includeZipChildren: true })
    .map((d) => d.id)
    .sort(),
  ["a", "b", "zip-1"],
  "zip + children when requested",
);

console.log("test-delete-folder: ok");
