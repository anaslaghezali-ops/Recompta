function supplierNameKey(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.'’]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((token) => token && !["SARL", "SA"].includes(token))
    .join("");
}

function normalizeIceDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 15 ? digits : "";
}

function lineIfValue(line) {
  return String(line?.if || line?.if_fournisseur || "").replace(/\D/g, "");
}

function supplierIdentityKey(line) {
  const ice = normalizeIceDigits(line?.ice_frs);
  if (ice) return `ice:${ice}`;
  const fiscal = lineIfValue(line);
  if (fiscal) return `if:${fiscal}`;
  const nameKey = supplierNameKey(line?.lib_frss);
  return nameKey ? `name:${nameKey}` : "name:inconnu";
}

function officialNameForLine(line, entries) {
  const ice = normalizeIceDigits(line?.ice_frs);
  const fiscal = lineIfValue(line);
  const byIce = new Map();
  const byIf = new Map();
  for (const entry of entries || []) {
    const name = String(entry?.official_name || "").trim();
    if (!name) continue;
    const entryIce = normalizeIceDigits(entry.ice);
    const entryIf = String(entry.if_number || "").replace(/\D/g, "");
    if (entryIce) byIce.set(entryIce, name);
    if (entryIf) byIf.set(entryIf, name);
  }
  if (ice && byIce.get(ice)) return byIce.get(ice);
  if (fiscal && byIf.get(fiscal)) return byIf.get(fiscal);
  return "";
}

function aggregateByIdentity(lines) {
  const map = new Map();
  for (const line of lines) {
    const key = supplierIdentityKey(line);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(line);
  }
  return map;
}

const ice = "123456789000001";
const month1 = { lib_frss: "Achibest", ice_frs: ice };
const month2 = { lib_frss: "Achibest ERT", ice_frs: ice };
const grouped = aggregateByIdentity([month1, month2]);
if (grouped.size !== 1) throw new Error("same ICE must be one supplier");
if (!grouped.has(`ice:${ice}`)) throw new Error("ice key missing");

const split = aggregateByIdentity([
  { lib_frss: "Achibest", ice_frs: "" },
  { lib_frss: "Achibest ERT", ice_frs: "" },
]);
if (split.size !== 2) throw new Error("different names without ICE stay split");

const entries = [{ ice, official_name: "Achibest" }];
if (officialNameForLine(month2, entries) !== "Achibest") {
  throw new Error("notebook must override AI name");
}

console.log("test-supplier-notebook: ok");
