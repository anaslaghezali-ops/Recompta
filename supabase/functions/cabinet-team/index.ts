import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.86.0";

/**
 * Équipe d'un cabinet : le responsable (owner) et les administrateurs gèrent
 * leurs collaborateurs sans passer par le super-admin.
 *
 * POST JSON { action, ... } :
 * - list                                   : membres du cabinet (tout membre actif)
 * - add       { email, password, display_name?, role? }   (owner / admin)
 * - set_role  { user_id, role }            : admin <-> comptable (owner uniquement pour admin)
 * - set_active{ user_id, active }          : désactiver / réactiver un compte
 * - reset_password { user_id, password }   : nouveau mot de passe
 * - update_profile { user_id, display_name }
 * - set_clients { user_id, client_ids }    : clients attribués à un collaborateur
 *
 * Les collaborateurs (comptable) n'accèdent qu'aux clients attribués
 * (table client_assignments, appliquée par les règles RLS).
 *
 * Règles : on ne modifie jamais le responsable, ni son propre compte, ni un super-admin.
 * Un administrateur ne gère que les comptables.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BAN_FOREVER = "876000h";
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(["admin", "comptable"]);

type Member = { user_id: string; role: string; is_active: boolean; created_at: string };

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

async function isSuperAdmin(admin: SupabaseClient, userId: string) {
  const { data } = await admin
    .from("user_roles")
    .select("user_id")
    .eq("user_id", userId)
    .eq("role", "super_admin")
    .maybeSingle();
  return Boolean(data);
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

  // Cabinet de l'appelant (membre actif d'un cabinet actif)
  const { data: myMembership } = await admin
    .from("cabinet_members")
    .select("cabinet_id, role, is_active, cabinets(id, name, is_active)")
    .eq("user_id", caller.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  const cabinet = (myMembership as { cabinets?: { id: number; name: string; is_active: boolean } } | null)?.cabinets;
  if (!myMembership || !cabinet?.is_active) {
    return json({ error: "Aucun cabinet actif associé à ce compte" }, 403);
  }
  const cabinetId = myMembership.cabinet_id as number;
  const myRole = myMembership.role as string;
  const canManage = myRole === "owner" || myRole === "admin";

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corps JSON invalide" }, 400);
  }
  const action = String(body.action || "");

  async function loadMembers(): Promise<Member[]> {
    const { data, error } = await admin
      .from("cabinet_members")
      .select("user_id, role, is_active, created_at")
      .eq("cabinet_id", cabinetId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data || []) as Member[];
  }

  /** Vérifie que l'appelant peut agir sur ce membre ; renvoie le membre ou un message d'erreur. */
  async function targetMember(userId: string): Promise<Member | string> {
    if (!canManage) return "Seuls le responsable et les administrateurs peuvent gérer l'équipe";
    if (!userId) return "Collaborateur introuvable";
    if (userId === caller.id) return "Utilisez « Mon mot de passe » pour votre propre compte";
    const members = await loadMembers();
    const member = members.find((m) => m.user_id === userId);
    if (!member) return "Ce compte ne fait pas partie de votre cabinet";
    if (member.role === "owner") return "Le compte du responsable ne peut pas être modifié ici";
    if (myRole === "admin" && member.role === "admin") {
      return "Seul le responsable peut gérer un administrateur";
    }
    if (await isSuperAdmin(admin, userId)) return "Ce compte ne peut pas être modifié ici";
    return member;
  }

  /** Remplace la liste des clients attribués ; ne garde que des clients de ce cabinet. */
  async function replaceAssignments(userId: string, rawIds: unknown[]): Promise<number[] | string> {
    const wanted = [...new Set(rawIds.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))];
    let valid: number[] = [];
    if (wanted.length) {
      const { data, error } = await admin
        .from("cabinet_clients")
        .select("id")
        .eq("cabinet_id", cabinetId)
        .in("id", wanted);
      if (error) return error.message;
      valid = (data || []).map((r: { id: number }) => r.id);
    }
    const { error: delError } = await admin
      .from("client_assignments")
      .delete()
      .eq("cabinet_id", cabinetId)
      .eq("user_id", userId);
    if (delError) return delError.message;
    if (valid.length) {
      const { error: insError } = await admin
        .from("client_assignments")
        .insert(valid.map((clientId) => ({ client_id: clientId, user_id: userId, cabinet_id: cabinetId, created_by: caller.id })));
      if (insError) return insError.message;
    }
    return valid;
  }

  try {
    if (action === "list") {
      const members = await loadMembers();
      const ids = members.map((m) => m.user_id);
      const { data: profiles } = ids.length
        ? await admin.from("profiles").select("user_id, email, display_name").in("user_id", ids)
        : { data: [] };
      const byId = Object.fromEntries((profiles || []).map((p: { user_id: string }) => [p.user_id, p]));
      const users = await Promise.all(ids.map(async (id) => {
        const { data } = await admin.auth.admin.getUserById(id);
        return [id, data?.user] as const;
      }));
      const authById = Object.fromEntries(users);
      const { data: clientRows } = await admin
        .from("cabinet_clients")
        .select("id, name, ice")
        .eq("cabinet_id", cabinetId)
        .order("name", { ascending: true });
      const { data: assignmentRows } = await admin
        .from("client_assignments")
        .select("client_id, user_id")
        .eq("cabinet_id", cabinetId);
      const assignmentsByUser: Record<string, number[]> = {};
      for (const a of (assignmentRows || []) as { client_id: number; user_id: string }[]) {
        (assignmentsByUser[a.user_id] ||= []).push(a.client_id);
      }
      return json({
        cabinet: { id: cabinetId, name: cabinet.name },
        me: { user_id: caller.id, role: myRole, can_manage: canManage },
        clients: canManage ? clientRows || [] : [],
        members: members.map((m) => {
          const p = byId[m.user_id] as { email?: string; display_name?: string } | undefined;
          const u = authById[m.user_id] as { email?: string; last_sign_in_at?: string; banned_until?: string } | undefined;
          return {
            user_id: m.user_id,
            role: m.role,
            active: m.is_active && !isBanned(u?.banned_until),
            email: p?.email || u?.email || null,
            display_name: p?.display_name || null,
            last_sign_in_at: u?.last_sign_in_at || null,
            created_at: m.created_at,
            client_ids: assignmentsByUser[m.user_id] || [],
          };
        }),
      });
    }

    if (action === "add") {
      if (!canManage) return json({ error: "Seuls le responsable et les administrateurs peuvent ajouter des collaborateurs" }, 403);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const displayName = String(body.display_name || "").trim();
      let role = String(body.role || "comptable");
      if (!ROLES.has(role)) role = "comptable";
      if (role === "admin" && myRole !== "owner") {
        return json({ error: "Seul le responsable peut nommer un administrateur" }, 403);
      }
      if (!emailPattern.test(email)) return json({ error: "Adresse email invalide" }, 400);
      if (password.length < 8) return json({ error: "Le mot de passe doit contenir au moins 8 caractères" }, 400);

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName || null },
      });
      if (createError || !created?.user) {
        const msg = createError?.message || "";
        if (/already|exists|registered/i.test(msg)) {
          return json({ error: "Un compte Recompta existe déjà avec cet email" }, 409);
        }
        return json({ error: msg || "Création du compte impossible" }, 400);
      }
      const userId = created.user.id;

      const { error: profileError } = await admin
        .from("profiles")
        .upsert({ user_id: userId, email, display_name: displayName || null }, { onConflict: "user_id" });
      const { error: memberError } = await admin
        .from("cabinet_members")
        .insert({ cabinet_id: cabinetId, user_id: userId, role, is_active: true });
      if (profileError || memberError) {
        await admin.auth.admin.deleteUser(userId); // pas de compte orphelin
        return json({ error: (memberError || profileError)?.message || "Ajout impossible" }, 400);
      }
      if (role === "comptable" && Array.isArray(body.client_ids) && body.client_ids.length) {
        const result = await replaceAssignments(userId, body.client_ids as unknown[]);
        if (typeof result === "string") return json({ ok: true, user_id: userId, warning: result });
      }
      return json({ ok: true, user_id: userId });
    }

    if (action === "set_role") {
      const target = await targetMember(String(body.user_id || ""));
      if (typeof target === "string") return json({ error: target }, 403);
      const role = String(body.role || "");
      if (!ROLES.has(role)) return json({ error: "Rôle invalide" }, 400);
      if (role === "admin" && myRole !== "owner") {
        return json({ error: "Seul le responsable peut nommer un administrateur" }, 403);
      }
      const { error } = await admin
        .from("cabinet_members")
        .update({ role })
        .eq("cabinet_id", cabinetId)
        .eq("user_id", target.user_id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "set_active") {
      const target = await targetMember(String(body.user_id || ""));
      if (typeof target === "string") return json({ error: target }, 403);
      const active = Boolean(body.active);
      const { error } = await admin.auth.admin.updateUserById(target.user_id, {
        ban_duration: active ? "none" : BAN_FOREVER,
      });
      if (error) return json({ error: error.message }, 400);
      await admin
        .from("cabinet_members")
        .update({ is_active: active })
        .eq("cabinet_id", cabinetId)
        .eq("user_id", target.user_id);
      return json({ ok: true, active });
    }

    if (action === "reset_password") {
      const target = await targetMember(String(body.user_id || ""));
      if (typeof target === "string") return json({ error: target }, 403);
      const password = String(body.password || "");
      if (password.length < 8) return json({ error: "Le mot de passe doit contenir au moins 8 caractères" }, 400);
      const { error } = await admin.auth.admin.updateUserById(target.user_id, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "update_profile") {
      const target = await targetMember(String(body.user_id || ""));
      if (typeof target === "string") return json({ error: target }, 403);
      const name = String(body.display_name || "").trim();
      await admin.auth.admin.updateUserById(target.user_id, { user_metadata: { display_name: name || null } });
      const { error } = await admin.from("profiles").update({ display_name: name || null }).eq("user_id", target.user_id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "set_clients") {
      const target = await targetMember(String(body.user_id || ""));
      if (typeof target === "string") return json({ error: target }, 403);
      if (target.role !== "comptable") {
        return json({ error: "Les administrateurs ont déjà accès à tous les clients" }, 400);
      }
      if (!Array.isArray(body.client_ids)) return json({ error: "Liste de clients invalide" }, 400);
      const result = await replaceAssignments(target.user_id, body.client_ids as unknown[]);
      if (typeof result === "string") return json({ error: result }, 400);
      return json({ ok: true, client_ids: result });
    }

    return json({ error: `Action inconnue : ${action}` }, 400);
  } catch (err) {
    return json({ error: (err as Error).message || "Erreur serveur" }, 500);
  }
});
