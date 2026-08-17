import { getSupabase } from "./auth-client.js?v=auth6";
import {
  lineIfValue,
  normalizeIceDigits,
  normalizeIfDigits,
  officialNameForLine,
  supplierIdentityKey,
  supplierNameKey,
} from "./extract-client.js?v=notebook1";
import { formatMonthLabel, getClientWithDossiers } from "./dossiers-client.js?v=dash2";

function pickCanonicalName(names) {
  const counts = new Map();
  for (const raw of names) {
    const name = String(raw || "").trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount || (count === bestCount && name.length > best.length)) {
      best = name;
      bestCount = count;
    }
  }
  return best || "Fournisseur inconnu";
}

function pickIdentifier(lines, field) {
  for (const line of lines) {
    const value = field === "if"
      ? lineIfValue(line)
      : String(line?.[field] || "").trim();
    if (value) return value;
  }
  return "";
}

function officialNameForSupplier(lines, notebook) {
  for (const line of lines || []) {
    const name = officialNameForLine(line, notebook);
    if (name) return name;
  }
  return "";
}

/**
 * @param {Array} dossiers
 * @param {Record<string, object[]>} workspacesByDossier
 * @param {Array} notebook
 */
export function aggregateClientSuppliers(dossiers, workspacesByDossier, notebook = []) {
  const supplierMap = new Map();

  for (const dossier of dossiers || []) {
    const lines = workspacesByDossier[dossier.id] || [];
    lines.forEach((line, lineIndex) => {
      const displayName = String(line.lib_frss || "").trim();
      const key = supplierIdentityKey(line);

      if (!supplierMap.has(key)) {
        supplierMap.set(key, {
          key,
          names: [],
          lines: [],
          invoices: [],
          invoiceCount: 0,
          totalTtc: 0,
          byYear: {},
        });
      }

      const supplier = supplierMap.get(key);
      if (displayName) supplier.names.push(displayName);

      const year = dossier.period_year;
      const month = dossier.period_month;
      const invoice = {
        line,
        lineIndex,
        dossierId: dossier.id,
        periodYear: year,
        periodMonth: month,
        periodLabel: `${formatMonthLabel(month)} ${year}`,
        dossierStatus: dossier.status,
      };

      supplier.lines.push(line);
      supplier.invoices.push(invoice);
      supplier.invoiceCount += 1;
      supplier.totalTtc += Number(line.m_ttc) || 0;

      if (!supplier.byYear[year]) supplier.byYear[year] = {};
      if (!supplier.byYear[year][month]) supplier.byYear[year][month] = [];
      supplier.byYear[year][month].push(invoice);
    });
  }

  return Array.from(supplierMap.values())
    .map((supplier) => {
      const years = Object.keys(supplier.byYear).map(Number).sort((a, b) => b - a);
      for (const year of years) {
        const months = Object.keys(supplier.byYear[year]).map(Number).sort((a, b) => b - a);
        supplier.byYear[year] = Object.fromEntries(
          months.map((month) => [month, supplier.byYear[year][month]]),
        );
      }
      return {
        key: supplier.key,
        name: officialNameForSupplier(supplier.lines, notebook) || pickCanonicalName(supplier.names),
        ice: pickIdentifier(supplier.lines, "ice_frs"),
        if: pickIdentifier(supplier.lines, "if"),
        invoiceCount: supplier.invoiceCount,
        totalTtc: Math.round(supplier.totalTtc * 100) / 100,
        years,
        byYear: supplier.byYear,
        invoices: supplier.invoices.sort((a, b) => {
          if (a.periodYear !== b.periodYear) return b.periodYear - a.periodYear;
          if (a.periodMonth !== b.periodMonth) return b.periodMonth - a.periodMonth;
          return String(a.line.fact_num || "").localeCompare(String(b.line.fact_num || ""), "fr");
        }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

export async function listClientSupplierEntries(clientId) {
  if (!clientId) return [];
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("client_suppliers")
    .select("id, ice, if_number, official_name, accounting_code")
    .eq("client_id", clientId)
    .limit(2000);
  if (error) {
    if (/client_suppliers|schema cache|does not exist|PGRST/i.test(`${error.code || ""} ${error.message || ""}`)) {
      return [];
    }
    throw error;
  }
  return data || [];
}

export async function upsertClientSupplier({ clientId, ice, ifNumber, officialName }) {
  const supabase = getSupabase();
  const name = String(officialName || "").trim();
  const iceNorm = normalizeIceDigits(ice);
  const ifNorm = normalizeIfDigits(ifNumber);
  if (!supabase || !clientId || !name || (!iceNorm && !ifNorm)) return null;

  let existing = null;
  if (iceNorm) {
    const { data, error } = await supabase
      .from("client_suppliers")
      .select("id, ice, if_number, official_name, accounting_code")
      .eq("client_id", clientId)
      .eq("ice", iceNorm)
      .maybeSingle();
    if (error && error.code !== "PGRST116") throw error;
    existing = data;
  }
  if (!existing && ifNorm) {
    const { data, error } = await supabase
      .from("client_suppliers")
      .select("id, ice, if_number, official_name, accounting_code")
      .eq("client_id", clientId)
      .eq("if_number", ifNorm)
      .maybeSingle();
    if (error && error.code !== "PGRST116") throw error;
    existing = data;
  }

  const payload = {
    client_id: clientId,
    official_name: name,
    ice: iceNorm || existing?.ice || null,
    if_number: ifNorm || existing?.if_number || null,
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { data, error } = await supabase
      .from("client_suppliers")
      .update(payload)
      .eq("id", existing.id)
      .select("id, ice, if_number, official_name, accounting_code")
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from("client_suppliers")
    .insert(payload)
    .select("id, ice, if_number, official_name, accounting_code")
    .single();
  if (error) throw error;
  return data;
}

export async function rememberOfficialSupplierName({ clientId, line, lines = [], officialName }) {
  const nameKey = supplierNameKey(officialName || line?.lib_frss);
  const iceOfLine = normalizeIceDigits(line?.ice_frs);
  const ifOfLine = lineIfValue(line);
  const related = (lines || []).filter((row) => {
    if (!row) return false;
    if (row === line) return true;
    if (iceOfLine && normalizeIceDigits(row.ice_frs) === iceOfLine) return true;
    if (ifOfLine && lineIfValue(row) === ifOfLine) return true;
    if (nameKey && supplierNameKey(row.lib_frss) === nameKey) return true;
    return false;
  });
  let ice = iceOfLine;
  let ifNumber = ifOfLine;
  for (const row of related) {
    if (!ice) ice = normalizeIceDigits(row.ice_frs);
    if (!ifNumber) ifNumber = lineIfValue(row);
    if (ice && ifNumber) break;
  }
  return upsertClientSupplier({
    clientId,
    ice,
    ifNumber,
    officialName,
  });
}

export async function loadClientSupplierNotebook(clientId, cabinetId) {
  const client = await getClientWithDossiers(clientId, cabinetId);
  if (!client) return { dossiers: [], suppliers: [] };

  const dossiers = client.dossiers || [];
  const dossierIds = dossiers.map((d) => d.id).filter(Boolean);
  if (!dossierIds.length) return { dossiers, suppliers: [] };

  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");

  const [{ data, error }, notebook] = await Promise.all([
    supabase.from("dossier_workspaces").select("dossier_id, lines").in("dossier_id", dossierIds),
    listClientSupplierEntries(clientId),
  ]);
  if (error) throw error;

  const workspacesByDossier = Object.fromEntries(
    (data || []).map((ws) => [ws.dossier_id, Array.isArray(ws.lines) ? ws.lines : []]),
  );

  return {
    dossiers,
    suppliers: aggregateClientSuppliers(dossiers, workspacesByDossier, notebook),
  };
}
