function supplierNamesMatch(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function iceValuesMatch(a, b) {
  const da = String(a || "").replace(/\D/g, "");
  const db = String(b || "").replace(/\D/g, "");
  return da === db && da.length > 0;
}

function ifValuesMatch(a, b) {
  const left = String(a || "").trim().toUpperCase();
  const right = String(b || "").trim().toUpperCase();
  return left.length > 0 && left === right;
}

function fieldValuesMatch(fieldKey, a, b) {
  if (fieldKey === "lib_frss") return supplierNamesMatch(a, b);
  if (fieldKey === "ice_frs") return iceValuesMatch(a, b);
  if (fieldKey === "if") return ifValuesMatch(a, b);
  return String(a || "").trim() === String(b || "").trim();
}

function countLinesWithFieldValue(lines, fieldKey, value, excludeIndex = -1) {
  return lines.filter(
    (line, index) => index !== excludeIndex && fieldValuesMatch(fieldKey, line[fieldKey], value),
  ).length;
}

function applyFieldValueBulk(lines, fieldKey, oldValue, newValue) {
  const updated = [];
  for (const line of lines) {
    if (!fieldValuesMatch(fieldKey, line[fieldKey], oldValue)) continue;
    if (fieldKey === "lib_frss") {
      line.lib_frss = newValue;
      line.supplier_from_folder = false;
    } else if (fieldKey === "ice_frs") {
      line.ice_frs = newValue;
      line.ice_inferred = false;
    } else if (fieldKey === "if") {
      line.if = newValue;
      line.if_inferred = false;
    }
    updated.push(line);
  }
  return updated;
}

const supplierLines = [
  { lib_frss: "Achi" },
  { lib_frss: "ACHI" },
  { lib_frss: "Orange" },
];
if (countLinesWithFieldValue(supplierLines, "lib_frss", "Achi", 0) !== 1) {
  throw new Error("supplier count failed");
}
const renamed = applyFieldValueBulk(supplierLines, "lib_frss", "Achi", "Achibest");
if (renamed.length !== 2 || supplierLines[2].lib_frss !== "Orange") {
  throw new Error("supplier rename failed");
}

const iceLines = [
  { ice_frs: "002540001234567" },
  { ice_frs: "002540001234567" },
  { ice_frs: "003641228000030" },
];
const iceUpdated = applyFieldValueBulk(iceLines, "ice_frs", "002540001234567", "002540009999999");
if (iceUpdated.length !== 2 || iceLines[2].ice_frs !== "003641228000030") {
  throw new Error("ice bulk failed");
}

const ifLines = [{ if: "123456" }, { if: "123456" }, { if: "999999" }];
const ifUpdated = applyFieldValueBulk(ifLines, "if", "123456", "654321");
if (ifUpdated.length !== 2 || ifLines[2].if !== "999999") {
  throw new Error("if bulk failed");
}

console.log("bulk-field-update tests ok");
