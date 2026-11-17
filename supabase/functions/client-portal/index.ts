import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.86.0";

/**
 * Portail client : accès sans mot de passe par lien personnel.
 *
 * POST JSON { action, ... } :
 * Côté client (aucune session requise, clé publique suffit) :
 * - exchange { token }                 : échange le lien contre une connexion (token_hash à vérifier côté navigateur)
 *
 * Côté cabinet (membre actif ayant accès au client) :
 * - status   { client_id }
 * - invite   { client_id, portal_url, contact_name?, contact_phone?, contact_email? }
 * - new_link { client_id, portal_url } : nouveau lien (l'ancien ne marche plus), réactive l'accès
 * - revoke   { client_id }             : coupe l'accès (lien invalidé, sessions bloquées)
 * - update_contact { client_id, contact_name?, contact_phone?, contact_email? }
 *
 * Le lien contient un jeton aléatoire de 256 bits ; seule son empreinte SHA-256 est stockée.
 * Le compte portail n'est membre d'aucun cabinet : les règles RLS ne lui ouvrent que son espace.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const BAN_FOREVER = "876000h";
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function base64url(bytes: Uint8Array) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function cleanText(value: unknown, max = 120) {
  const s = String(value ?? "").trim().slice(0, max);
  return s || null;
}

function portalLink(portalUrl: unknown, token: string): string | null {
  const raw = String(portalUrl || "").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if (!/portail\.html$/.test(url.pathname)) return null;
  url.search = "";
  url.hash = `acces=${token}`;
  return url.toString();
}

const ACCESS_COLUMNS = "client_id, cabinet_id, user_id, contact_name, contact_phone, contact_email, is_active, created_at, link_created_at, last_used_at";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceKey || !anonKey) return json({ error: "Configuration serveur incomplète" }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corps JSON invalide" }, 400);
  }
  const action = String(body.action || "");

  // ------------------------------------------------------------------
  // Échange du lien personnel contre une connexion (côté client)
  // ------------------------------------------------------------------
  if (action === "exchange") {
    const token = String(body.token || "");
    const invalid = json({ error: "Ce lien d'accès n'est plus valide. Demandez un nouveau lien à votre cabinet." }, 403);
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return invalid;
    const hash = await sha256Hex(token);
    const { data: access } = await admin
      .from("client_portal_access")
      .select("client_id, user_id, is_active, cabinet_clients(id, cabinets(is_active))")
      .eq("token_hash", hash)
      .maybeSingle();
    const cabinetActive = (access as { cabinet_clients?: { cabinets?: { is_active: boolean } } } | null)
      ?.cabinet_clients?.cabinets?.is_active;
    if (!access || !access.is_active || !cabinetActive) return invalid;

    const { data: userData, error: userError } = await admin.auth.admin.getUserById(access.user_id);
    if (userError || !userData?.user?.email) return invalid;
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: userData.user.email });
    const hashed = link?.properties?.hashed_token;
    if (linkError || !hashed) return json({ error: "Connexion impossible pour le moment, réessayez." }, 500);
    await admin.from("client_portal_access").update({ last_used_at: new Date().toISOString() }).eq("client_id", access.client_id);
    return json({ token_hash: hashed, type: "magiclink" });
  }

  // ------------------------------------------------------------------
  // Actions du cabinet
  // ------------------------------------------------------------------
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Authentification requise" }, 401);
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: { user: caller }, error: callerError } = await userClient.auth.getUser();
  if (callerError || !caller) return json({ error: "Session invalide" }, 401);

  const clientId = Number(body.client_id);
  if (!Number.isInteger(clientId) || clientId <= 0) return json({ error: "Client introuvable" }, 400);

  // Le client doit appartenir au cabinet de l'appelant, et l'appelant y avoir accès (règles RLS).
  const { data: client } = await admin.from("cabinet_clients").select("id, name, cabinet_id").eq("id", clientId).maybeSingle();
  if (!client) return json({ error: "Client introuvable" }, 404);
  const { data: membership } = await admin
    .from("cabinet_members")
    .select("role, is_active, cabinets(is_active)")
    .eq("user_id", caller.id)
    .eq("cabinet_id", client.cabinet_id)
    .eq("is_active", true)
    .maybeSingle();
  if (!membership || !(membership as { cabinets?: { is_active: boolean } }).cabinets?.is_active) {
    return json({ error: "Client introuvable" }, 404);
  }
  const { data: visible } = await userClient.from("cabinet_clients").select("id").eq("id", clientId).maybeSingle();
  if (!visible) return json({ error: "Ce client ne vous est pas attribué" }, 403);

  async function loadAccess() {
    const { data } = await admin.from("client_portal_access").select(ACCESS_COLUMNS).eq("client_id", clientId).maybeSingle();
    return data;
  }

  async function setBanned(userId: string, banned: boolean) {
    await admin.auth.admin.updateUserById(userId, { ban_duration: banned ? BAN_FOREVER : "none" });
  }

  function contactFields(src: Record<string, unknown>) {
    const email = cleanText(src.contact_email, 160);
    if (email && !emailPattern.test(email)) return "Adresse email du contact invalide";
    return {
      contact_name: cleanText(src.contact_name),
      contact_phone: cleanText(src.contact_phone, 40),
      contact_email: email ? email.toLowerCase() : null,
    };
  }

  try {
    if (action === "status") {
      return json({ access: await loadAccess() });
    }

    if (action === "invite") {
      if (await loadAccess()) return json({ error: "Ce client a déjà un accès : générez un nouveau lien si besoin" }, 409);
      const token = newToken();
      const link = portalLink(body.portal_url, token);
      if (!link) return json({ error: "Adresse du portail invalide" }, 400);
      const contact = contactFields(body);
      if (typeof contact === "string") return json({ error: contact }, 400);

      // Compte technique sans mot de passe ni email réel : la connexion se fait uniquement par le lien.
      const suffix = base64url(crypto.getRandomValues(new Uint8Array(6))).toLowerCase().replace(/[^a-z0-9]/g, "x");
      // Aucun email n'est jamais envoyé à cette adresse technique ; domaine réservé en priorité.
      let created: { user: { id: string } | null } | null = null;
      let createError: { message: string } | null = null;
      for (const domain of ["portail.recompta.invalid", "portail.recompta.app"]) {
        const res = await admin.auth.admin.createUser({
          email: `client-${clientId}-${suffix}@${domain}`,
          email_confirm: true,
          app_metadata: { portal_client_id: clientId },
          user_metadata: { display_name: contact.contact_name || client.name, portal: true },
        });
        created = res.data;
        createError = res.error;
        if (!createError && created?.user) break;
        if (!/email/i.test(createError?.message || "")) break;
      }
      if (createError || !created?.user) return json({ error: createError?.message || "Création de l'accès impossible" }, 500);

      const { error: insertError } = await admin.from("client_portal_access").insert({
        client_id: clientId,
        cabinet_id: client.cabinet_id,
        user_id: created.user.id,
        token_hash: await sha256Hex(token),
        ...contact,
        created_by: caller.id,
      });
      if (insertError) {
        await admin.auth.admin.deleteUser(created.user.id);
        throw insertError;
      }
      return json({ link, access: await loadAccess() });
    }

    const access = await loadAccess();
    if (!access) return json({ error: "Ce client n'a pas encore d'accès au portail" }, 404);

    if (action === "new_link") {
      const token = newToken();
      const link = portalLink(body.portal_url, token);
      if (!link) return json({ error: "Adresse du portail invalide" }, 400);
      const { error } = await admin
        .from("client_portal_access")
        .update({ token_hash: await sha256Hex(token), is_active: true, link_created_at: new Date().toISOString() })
        .eq("client_id", clientId);
      if (error) throw error;
      await setBanned(access.user_id, false);
      return json({ link, access: await loadAccess() });
    }

    if (action === "revoke") {
      const { error } = await admin.from("client_portal_access").update({ is_active: false, token_hash: null }).eq("client_id", clientId);
      if (error) throw error;
      await setBanned(access.user_id, true);
      return json({ ok: true, access: await loadAccess() });
    }

    if (action === "update_contact") {
      const contact = contactFields(body);
      if (typeof contact === "string") return json({ error: contact }, 400);
      const { error } = await admin.from("client_portal_access").update(contact).eq("client_id", clientId);
      if (error) throw error;
      return json({ ok: true, access: await loadAccess() });
    }

    return json({ error: "Action invalide" }, 400);
  } catch (err) {
    return json({ error: (err as Error).message || "Erreur serveur" }, 500);
  }
});
