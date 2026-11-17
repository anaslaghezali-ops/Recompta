import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.86.0";

/**
 * Gestion des comptes depuis l'espace admin (super-admin uniquement).
 *
 * Actions (POST JSON { action, ... }) :
 * - list                 : état des comptes Auth (blocage, dernière connexion)
 * - update_user          : { user_id, email?, display_name?, password? }
 * - set_blocked          : { user_id, blocked }  → ban Auth + membership inactive
 * - update_cabinet       : { cabinet_id, name }
 * - set_cabinet_active   : { cabinet_id, active } → suspend/réactive cabinet + ses comptes
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BAN_FOREVER = "876000h"; // ~100 ans
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isBanned(bannedUntil: string | null | undefined) {
  if (!bannedUntil) return false;
  const until = Date.parse(bannedUntil);
  return Number.isFinite(until) && until > Date.now();
}

async function superAdminIds(admin: SupabaseClient): Promise<Set<string>> {
  const { data } = await admin.from("user_roles").select("user_id").eq("role", "super_admin");
  return new Set((data || []).map((row: { user_id: string }) => row.user_id));
}

async function listAllUsers(admin: SupabaseClient) {
  const users = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return users;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json({ error: "Configuration serveur incomplète" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Authentification requise" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: caller }, error: callerError } = await userClient.auth.getUser();
  if (callerError || !caller) return json({ error: "Session invalide" }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const admins = await superAdminIds(admin);
  if (!admins.has(caller.id)) return json({ error: "Accès réservé au super-admin" }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corps JSON invalide" }, 400);
  }

  const action = String(body.action || "");

  const guardTarget = (userId: string) => {
    if (!userId) return "Compte introuvable";
    if (userId === caller.id) return "Vous ne pouvez pas modifier votre propre compte ici";
    if (admins.has(userId)) return "Les comptes super-admin ne se gèrent pas depuis cet écran";
    return null;
  };

  try {
    if (action === "list") {
      const users = await listAllUsers(admin);
      return json({
        users: users
          .filter((u) => !admins.has(u.id))
          .map((u) => ({
            id: u.id,
            email: u.email,
            display_name: (u.user_metadata?.display_name as string) || null,
            blocked: isBanned((u as { banned_until?: string }).banned_until),
            last_sign_in_at: u.last_sign_in_at || null,
            created_at: u.created_at,
          })),
      });
    }

    if (action === "update_user") {
      const userId = String(body.user_id || "");
      const denied = guardTarget(userId);
      if (denied) return json({ error: denied }, 400);

      const attrs: Record<string, unknown> = {};
      const profile: Record<string, unknown> = {};

      if (body.email !== undefined) {
        const email = String(body.email).trim().toLowerCase();
        if (!emailPattern.test(email)) return json({ error: "Adresse email invalide" }, 400);
        attrs.email = email;
        attrs.email_confirm = true;
        profile.email = email;
      }
      if (body.password !== undefined && body.password !== "") {
        const password = String(body.password);
        if (password.length < 8) {
          return json({ error: "Le mot de passe doit contenir au moins 8 caractères" }, 400);
        }
        attrs.password = password;
      }
      if (body.display_name !== undefined) {
        const name = String(body.display_name).trim();
        attrs.user_metadata = { display_name: name || null };
        profile.display_name = name || null;
      }
      if (!Object.keys(attrs).length) return json({ error: "Aucune modification" }, 400);

      const { error } = await admin.auth.admin.updateUserById(userId, attrs);
      if (error) {
        if (/already|exists|registered/i.test(error.message)) {
          return json({ error: "Cette adresse email est déjà utilisée par un autre compte" }, 409);
        }
        return json({ error: error.message }, 400);
      }
      if (Object.keys(profile).length) {
        await admin.from("profiles").update(profile).eq("user_id", userId);
      }
      return json({ ok: true });
    }

    if (action === "set_blocked") {
      const userId = String(body.user_id || "");
      const denied = guardTarget(userId);
      if (denied) return json({ error: denied }, 400);
      const blocked = Boolean(body.blocked);

      const { error } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: blocked ? BAN_FOREVER : "none",
      });
      if (error) return json({ error: error.message }, 400);

      // Coupe l'accès aux données immédiatement (RLS sur cabinet_members.is_active).
      await admin.from("cabinet_members").update({ is_active: !blocked }).eq("user_id", userId);
      return json({ ok: true, blocked });
    }

    if (action === "update_cabinet") {
      const cabinetId = Number(body.cabinet_id);
      const name = String(body.name || "").trim();
      if (!cabinetId) return json({ error: "Cabinet introuvable" }, 400);
      if (name.length < 2) return json({ error: "Le nom doit contenir au moins 2 caractères" }, 400);
      const { error } = await admin
        .from("cabinets")
        .update({ name, updated_at: new Date().toISOString() })
        .eq("id", cabinetId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "set_cabinet_active") {
      const cabinetId = Number(body.cabinet_id);
      if (!cabinetId) return json({ error: "Cabinet introuvable" }, 400);
      const active = Boolean(body.active);

      const { data: members, error: memError } = await admin
        .from("cabinet_members")
        .select("user_id")
        .eq("cabinet_id", cabinetId);
      if (memError) return json({ error: memError.message }, 400);

      for (const m of members || []) {
        if (admins.has(m.user_id)) continue;
        await admin.auth.admin.updateUserById(m.user_id, { ban_duration: active ? "none" : BAN_FOREVER });
      }
      await admin.from("cabinet_members").update({ is_active: active }).eq("cabinet_id", cabinetId);
      const { error } = await admin
        .from("cabinets")
        .update({ is_active: active, updated_at: new Date().toISOString() })
        .eq("id", cabinetId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, active });
    }

    return json({ error: `Action inconnue : ${action}` }, 400);
  } catch (err) {
    return json({ error: (err as Error).message || "Erreur serveur" }, 500);
  }
});
