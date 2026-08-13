/**
 * Alias bancaire appris par dossier client (libellé relevé ≠ nom facture).
 * Ex. MPro sur le relevé → Mode Food sur les factures.
 */

const STORAGE_PREFIX = "recompta_bank_aliases_";

export function normalizeBankAliasToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function storageKey(clientIce) {
  const ice = String(clientIce || "").replace(/\D/g, "");
  return `${STORAGE_PREFIX}${ice || "default"}`;
}

/** @returns {Record<string, { supplierKey: string, lib_frss: string }>} */
export function loadBankAliases(clientIce) {
  try {
    const raw = localStorage.getItem(storageKey(clientIce));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveBankAlias(clientIce, bankToken, supplierKey, libFrss) {
  const token = normalizeBankAliasToken(bankToken);
  if (!token || !supplierKey) return;
  const aliases = loadBankAliases(clientIce);
  aliases[token] = { supplierKey, lib_frss: libFrss || "" };
  localStorage.setItem(storageKey(clientIce), JSON.stringify(aliases));
}

export function removeBankAlias(clientIce, bankToken) {
  const token = normalizeBankAliasToken(bankToken);
  const aliases = loadBankAliases(clientIce);
  if (!aliases[token]) return;
  delete aliases[token];
  localStorage.setItem(storageKey(clientIce), JSON.stringify(aliases));
}

/** Map token → supplierKey pour le moteur de rapprochement. */
export function bankAliasLookup(clientIce) {
  const lookup = {};
  for (const [token, entry] of Object.entries(loadBankAliases(clientIce))) {
    if (entry?.supplierKey) lookup[token] = entry.supplierKey;
  }
  return lookup;
}

export function listBankAliases(clientIce) {
  return Object.entries(loadBankAliases(clientIce)).map(([token, entry]) => ({
    bankToken: token,
    supplierKey: entry.supplierKey,
    lib_frss: entry.lib_frss || "",
  }));
}
