import {
  getSession,
  getSupabase,
  isSuperAdmin,
} from "./auth-client.js?v=auth5";

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
