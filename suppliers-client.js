import { getSupabase } from "./auth-client.js?v=auth6";
import { supplierNameKey } from "./extract-client.js?v=dedupe3";
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
    const value = String(line?.[field] || "").trim();
    if (value) return value;
  }
  return "";
}

/**
 * @param {Array} dossiers
 * @param {Record<string, object[]>} workspacesByDossier
 */
export function aggregateClientSuppliers(dossiers, workspacesByDossier) {
  const supplierMap = new Map();

  for (const dossier of dossiers || []) {
    const lines = workspacesByDossier[dossier.id] || [];
    lines.forEach((line, lineIndex) => {
      const displayName = String(line.lib_frss || "").trim();
      const key = supplierNameKey(displayName) || `unknown:${displayName.toLowerCase() || "inconnu"}`;

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
        name: pickCanonicalName(supplier.names),
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

export async function loadClientSupplierNotebook(clientId, cabinetId) {
  const client = await getClientWithDossiers(clientId, cabinetId);
  if (!client) return { dossiers: [], suppliers: [] };

  const dossiers = client.dossiers || [];
  const dossierIds = dossiers.map((d) => d.id).filter(Boolean);
  if (!dossierIds.length) return { dossiers, suppliers: [] };

  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("dossier_workspaces")
    .select("dossier_id, lines")
    .in("dossier_id", dossierIds);
  if (error) throw error;

  const workspacesByDossier = Object.fromEntries(
    (data || []).map((ws) => [ws.dossier_id, Array.isArray(ws.lines) ? ws.lines : []]),
  );

  return {
    dossiers,
    suppliers: aggregateClientSuppliers(dossiers, workspacesByDossier),
  };
}
