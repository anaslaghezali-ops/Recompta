function supplierNamesMatch(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function countLinesWithSupplier(lines, name, excludeIndex = -1) {
  return lines.filter(
    (line, index) => index !== excludeIndex && supplierNamesMatch(line.lib_frss, name),
  ).length;
}

function applySupplierRename(lines, oldName, newName) {
  const updated = [];
  for (const line of lines) {
    if (!supplierNamesMatch(line.lib_frss, oldName)) continue;
    line.lib_frss = newName;
    line.supplier_from_folder = false;
    updated.push(line);
  }
  return updated;
}

const lines = [
  { lib_frss: "Achi" },
  { lib_frss: "ACHI" },
  { lib_frss: "Orange" },
  { lib_frss: " Achi " },
];

if (countLinesWithSupplier(lines, "Achi", 0) !== 2) throw new Error("count failed");
const updated = applySupplierRename(lines, "Achi", "Achibest");
if (updated.length !== 3 || lines[2].lib_frss !== "Orange") throw new Error("rename failed");
console.log("supplier-rename tests ok");
