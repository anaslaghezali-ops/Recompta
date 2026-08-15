import {
  getSession,
  getSupabase,
  isSuperAdmin,
} from "./auth-client.js?v=auth6";

const MONTH_LABELS = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
];

export { MONTH_LABELS };

export function periodToMmaaaa(year, month) {
  return `${String(month).padStart(2, "0")}${year}`;
}

export function mmaaaaToPeriod(mmaaaa) {
  const raw = String(mmaaaa || "").replace(/\D/g, "");
  if (raw.length !== 6) return null;
  const month = Number(raw.slice(0, 2));
  const year = Number(raw.slice(2));
  if (month < 1 || month > 12) return null;
  return { year, month };
}

export function formatMonthLabel(month) {
  return MONTH_LABELS[month - 1] || `Mois ${month}`;
}

export const STATUS_META = {
  draft: { label: "Brouillon", tone: "neutral", icon: "circle-dashed" },
  in_review: { label: "En revue", tone: "warn", icon: "clock-3" },
  exported: { label: "Déclaré", tone: "success", icon: "check-circle-2" },
};

export function formatRelativeTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "À l'instant";
  if (mins < 60) return `Il y a ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Il y a ${days} j`;
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

export function computeClientStats(client) {
  const dossiers = client.dossiers || [];
  const openCount = dossiers.filter((d) => d.status !== "exported").length;
  const lastDossier = dossiers.reduce((latest, d) => {
    if (!latest) return d;
    const latestTs = new Date(latest.updated_at || latest.created_at || 0).getTime();
    const currentTs = new Date(d.updated_at || d.created_at || 0).getTime();
    return currentTs > latestTs ? d : latest;
  }, null);

  let statusKey = "draft";
  let statusLabel = "Nouveau";
  if (lastDossier) {
    statusKey = lastDossier.status;
    statusLabel = STATUS_META[lastDossier.status]?.label || "En cours";
  } else if (dossiers.length > 0) {
    statusKey = dossiers[0].status;
    statusLabel = STATUS_META[statusKey]?.label || "En cours";
  }

  return {
    periodCount: dossiers.length,
    openCount,
    lastActivity: lastDossier?.updated_at || lastDossier?.created_at || client.created_at,
    statusKey,
    statusLabel,
    lastPeriod: lastDossier
      ? `${formatMonthLabel(lastDossier.period_month)} ${lastDossier.period_year}`
      : null,
  };
}

export async function getClientWithDossiers(clientId, cabinetId) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");

  const { data: client, error: clientError } = await supabase
    .from("cabinet_clients")
    .select("id, name, ice, created_at, cabinet_id")
    .eq("id", clientId)
    .eq("cabinet_id", cabinetId)
    .maybeSingle();
  if (clientError) throw clientError;
  if (!client) return null;

  const { data: dossiers, error: dossierError } = await supabase
    .from("client_dossiers")
    .select("id, client_id, period_year, period_month, status, updated_at, created_at")
    .eq("client_id", clientId)
    .order("period_year", { ascending: false })
    .order("period_month", { ascending: false });
  if (dossierError) throw dossierError;

  return { ...client, dossiers: dossiers || [] };
}

const MONTH_SHORT = [
  "JAN", "FÉV", "MAR", "AVR", "MAI", "JUN", "JUL", "AOÛ", "SEP", "OCT", "NOV", "DÉC",
];

export function buildYearGrid(year, dossiers) {
  const byMonth = Object.fromEntries(
    (dossiers || [])
      .filter((d) => d.period_year === year)
      .map((d) => [d.period_month, d]),
  );
  return MONTH_LABELS.map((label, index) => {
    const month = index + 1;
    const dossier = byMonth[month] || null;
    return {
      month,
      label,
      short: MONTH_SHORT[index],
      dossier,
      status: dossier?.status || null,
    };
  });
}

export function listAvailableYears(dossiers, extraYear) {
  const years = new Set((dossiers || []).map((d) => d.period_year));
  if (extraYear) years.add(extraYear);
  years.add(new Date().getFullYear());
  return [...years].sort((a, b) => b - a);
}

export async function getUserCabinet() {
  const session = await getSession();
  if (!session?.user) return null;

  const supabase = getSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("cabinet_members")
    .select("cabinet_id, role, cabinets(id, name, slug, is_active)")
    .eq("user_id", session.user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.cabinets?.is_active) return null;

  return {
    cabinet_id: data.cabinet_id,
    role: data.role,
    cabinet: data.cabinets,
  };
}

export async function requireCabinetSession() {
  const session = await getSession();
  if (!session?.user) {
    window.location.href = "login.html";
    return null;
  }
  if (await isSuperAdmin(session.user.id)) {
    window.location.href = "admin.html";
    return null;
  }
  const membership = await getUserCabinet();
  if (!membership) {
    throw new Error("Aucun cabinet actif associé à ce compte.");
  }
  return { session, ...membership };
}

export async function listClientsWithDossiers(cabinetId) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");

  const { data: clients, error: clientError } = await supabase
    .from("cabinet_clients")
    .select("id, name, ice, created_at")
    .eq("cabinet_id", cabinetId)
    .order("name", { ascending: true });
  if (clientError) throw clientError;

  const clientIds = (clients || []).map((c) => c.id);
  let dossiers = [];
  if (clientIds.length > 0) {
    const { data, error } = await supabase
      .from("client_dossiers")
      .select("id, client_id, period_year, period_month, status, updated_at")
      .in("client_id", clientIds)
      .order("period_year", { ascending: false })
      .order("period_month", { ascending: false });
    if (error) throw error;
    dossiers = data || [];
  }

  const dossiersByClient = {};
  for (const dossier of dossiers) {
    if (!dossiersByClient[dossier.client_id]) dossiersByClient[dossier.client_id] = [];
    dossiersByClient[dossier.client_id].push(dossier);
  }

  return (clients || []).map((client) => ({
    ...client,
    dossiers: dossiersByClient[client.id] || [],
  }));
}

export async function createClient(cabinetId, { name, ice }) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");

  const cleanName = String(name || "").trim();
  const cleanIce = String(ice || "").replace(/\D/g, "").slice(0, 15);
  if (cleanName.length < 2) throw new Error("Nom du client requis (2 caractères minimum).");
  if (cleanIce.length !== 15) throw new Error("ICE invalide (15 chiffres exactement).");

  const { data, error } = await supabase
    .from("cabinet_clients")
    .insert({ cabinet_id: cabinetId, name: cleanName, ice: cleanIce })
    .select("id, name, ice, created_at")
    .single();

  if (error) {
    if (error.code === "23505") throw new Error("Un client avec cet ICE existe déjà dans votre cabinet.");
    throw error;
  }
  return data;
}

export async function createDossier(clientId, { year, month }) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");

  const periodYear = Number(year);
  const periodMonth = Number(month);
  if (!periodYear || periodMonth < 1 || periodMonth > 12) {
    throw new Error("Période invalide.");
  }

  const { data, error } = await supabase
    .from("client_dossiers")
    .insert({
      client_id: clientId,
      period_year: periodYear,
      period_month: periodMonth,
    })
    .select("id, client_id, period_year, period_month, status, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error(`Un dossier existe déjà pour ${formatMonthLabel(periodMonth)} ${periodYear}.`);
    }
    throw error;
  }
  return data;
}

export async function loadDossierContext(dossierId) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("client_dossiers")
    .select(`
      id,
      period_year,
      period_month,
      status,
      client:cabinet_clients (
        id,
        name,
        ice,
        cabinet_id
      )
    `)
    .eq("id", dossierId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.client) return null;

  const session = await getSession();
  if (!session?.user) return null;

  const admin = await isSuperAdmin(session.user.id);
  if (!admin) {
    const membership = await getUserCabinet();
    if (!membership || membership.cabinet_id !== data.client.cabinet_id) {
      return null;
    }
  }

  return {
    dossierId: data.id,
    clientId: data.client.id,
    status: data.status,
    year: data.period_year,
    month: data.period_month,
    period: periodToMmaaaa(data.period_year, data.period_month),
    clientName: data.client.name,
    clientIce: data.client.ice,
    cabinetId: data.client.cabinet_id,
  };
}

export function groupDossiersByYear(dossiers) {
  const byYear = {};
  for (const dossier of dossiers) {
    const year = dossier.period_year;
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(dossier);
  }
  for (const year of Object.keys(byYear)) {
    byYear[year].sort((a, b) => b.period_month - a.period_month);
  }
  return Object.entries(byYear)
    .map(([year, items]) => ({ year: Number(year), dossiers: items }))
    .sort((a, b) => b.year - a.year);
}
