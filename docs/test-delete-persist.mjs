function parseDeletedIds(data) {
  const rows = Array.isArray(data) ? data : data != null ? [data] : [];
  return [...new Set(
    rows
      .map((row) => Number(row?.id ?? row))
      .filter((id) => Number.isFinite(id) && id > 0),
  )];
}

function isRecreatedDeletedDocument(row, deletedDocs) {
  return (deletedDocs || []).some((doc) => {
    if (!row || !doc) return false;
    if (row.id != null && doc.id != null && Number(row.id) === Number(doc.id)) return true;
    if (row.storage_path && doc.storage_path && row.storage_path === doc.storage_path) return true;
    if (row.source_id && doc.source_id && String(row.source_id) === String(doc.source_id)) return true;
    if (
      row.original_filename
      && doc.original_filename
      && String(row.original_filename) === String(doc.original_filename)
    ) {
      return true;
    }
    return false;
  });
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: got ${a}, expected ${e}`);
}

assertEqual(parseDeletedIds([1, "2", 3]), [1, 2, 3], "bigint[] style");
assertEqual(parseDeletedIds([{ id: 11 }, { id: "12" }]), [11, 12], "table rows");
assertEqual(parseDeletedIds({ id: 7 }), [7], "single row");
assertEqual(parseDeletedIds([{ id: 1 }, 1, { id: "1" }]), [1], "dedupes");
assertEqual(parseDeletedIds([{ id: "x" }, null, {}]), [], "ignores junk");

const deleted = [{
  id: 10,
  original_filename: "Probun/FAC1.pdf",
  source_id: "src-abc",
  storage_path: "dossier/1/old.pdf",
}];

if (!isRecreatedDeletedDocument({ id: 10 }, deleted)) {
  throw new Error("same id should match");
}
if (!isRecreatedDeletedDocument({ id: 99, source_id: "src-abc" }, deleted)) {
  throw new Error("worker re-insert with same source_id should match");
}
if (!isRecreatedDeletedDocument({ id: 99, original_filename: "Probun/FAC1.pdf" }, deleted)) {
  throw new Error("worker re-insert with same filename should match");
}
if (isRecreatedDeletedDocument({ id: 99, original_filename: "Orange/FAC1.pdf" }, deleted)) {
  throw new Error("other supplier file must not match");
}

console.log("test-delete-persist: ok");
