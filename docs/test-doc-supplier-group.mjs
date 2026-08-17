function documentsShareIdentity(a, b) {
  const keysA = new Set(String(a || "").replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean));
  const keysB = new Set(String(b || "").replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean));
  for (const key of keysA) {
    if (keysB.has(key)) return true;
  }
  return false;
}

function normalizeIceDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 15 ? digits : "";
}

function supplierIdentityKey(line) {
  const ice = normalizeIceDigits(line?.ice_frs);
  if (ice) return `ice:${ice}`;
  const name = String(line?.lib_frss || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return name ? `name:${name}` : "name:inconnu";
}

function officialNameForLine(line, entries) {
  const ice = normalizeIceDigits(line?.ice_frs);
  for (const entry of entries || []) {
    if (ice && normalizeIceDigits(entry.ice) === ice) return String(entry.official_name || "").trim();
  }
  return "";
}

function findLinesForDocument(doc, lines = []) {
  return (lines || []).filter((line) => {
    if (doc.source_id && line.source_id && String(doc.source_id) === String(line.source_id)) return true;
    if (line.source_file && documentsShareIdentity(doc.original_filename, line.source_file)) return true;
    return false;
  });
}

function looksLikeDriveExportFolder(name) {
  return /-\d{8}T\d{6}Z(?:-\d+)*$/i.test(String(name || "").trim());
}

function pathSupplierFallback(doc) {
  const parts = String(doc?.original_filename || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length >= 2 && looksLikeDriveExportFolder(parts[0]) && parts[1]) return parts[1].trim();
  if (parts.length >= 2) return parts[0].trim();
  return "";
}

function documentSupplierGroup(doc, { lines = [], notebook = [] } = {}) {
  const matchedLine = findLinesForDocument(doc, lines)[0];
  if (matchedLine) {
    const official = officialNameForLine(matchedLine, notebook) || String(matchedLine.lib_frss || "").trim();
    if (official) {
      return { key: supplierIdentityKey(matchedLine), label: official, kind: "supplier" };
    }
  }
  const folderSupplier = pathSupplierFallback(doc);
  if (folderSupplier) return { key: `supplier:${folderSupplier.toLowerCase()}`, label: folderSupplier, kind: "supplier" };
  return { key: "__other__", label: "Autres documents", kind: "other" };
}

const zipDumpDoc = {
  original_filename: "Probun-20260816T102702Z-1-001/Probun/FACTURE.pdf",
  source_id: "src-1",
};
const otherDoc = {
  original_filename: "Probun-20260816T102702Z-1-001/Probun/FACTURE2.pdf",
  source_id: "src-2",
};
const unmatched = {
  original_filename: "Mose food-20260812T221131Z-1-001/Mose Food/scan.pdf",
};
const lines = [
  { source_id: "src-1", lib_frss: "Probun SA", ice_frs: "111111111111111" },
  { source_id: "src-2", lib_frss: "Probun SA", ice_frs: "111111111111111" },
];

const byLine = documentSupplierGroup(zipDumpDoc, { lines });
if (byLine.label !== "Probun SA") throw new Error(`expected Probun SA, got ${byLine.label}`);
if (byLine.key !== "ice:111111111111111") throw new Error(byLine.key);

const unmatchedGroup = documentSupplierGroup(unmatched, { lines: [] });
if (unmatchedGroup.label !== "Mose Food") {
  throw new Error(`fallback should skip zip dump name, got ${unmatchedGroup.label}`);
}

const notebook = [{ ice: "111111111111111", official_name: "Probun SA" }];
const renamed = documentSupplierGroup(
  { original_filename: "x.pdf", source_id: "src-1" },
  {
    lines: [{ source_id: "src-1", lib_frss: "Probun-20260816T102702Z-1-001", ice_frs: "111111111111111" }],
    notebook,
  },
);
if (renamed.label !== "Probun SA") throw new Error(`notebook name, got ${renamed.label}`);

if (documentSupplierGroup(otherDoc, { lines }).key !== byLine.key) {
  throw new Error("same ICE invoices should share group key");
}

console.log("test-doc-supplier-group: ok");
