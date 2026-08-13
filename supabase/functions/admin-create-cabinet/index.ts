import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.86.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Méthode non autorisée" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json({ error: "Configuration serveur incomplète" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Authentification requise" }, 401);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();
  if (userError || !user) {
    return json({ error: "Session invalide" }, 401);
  }

  const { data: roleRow, error: roleError } = await userClient
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (roleError || roleRow?.role !== "super_admin") {
    return json({ error: "Accès réservé au super-admin" }, 403);
  }

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corps JSON invalide" }, 400);
  }

  const cabinetName = (body.cabinet_name || "").trim();
  const slug = (body.slug || "").trim().toLowerCase();
  const ownerEmail = (body.owner_email || "").trim().toLowerCase();
  const ownerPassword = body.owner_password || "";
  const displayName = (body.display_name || "").trim();

  if (!cabinetName || cabinetName.length < 2) {
    return json({ error: "Nom du cabinet requis (2 caractères minimum)" }, 400);
  }
  if (!slugPattern.test(slug)) {
    return json({ error: "Identifiant (slug) invalide : lettres minuscules, chiffres et tirets uniquement" }, 400);
  }
  if (!ownerEmail || !ownerEmail.includes("@")) {
    return json({ error: "Email du responsable invalide" }, 400);
  }
  if (!ownerPassword || ownerPassword.length < 6) {
    return json({ error: "Mot de passe requis (6 caractères minimum)" }, 400);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: newUser, error: createUserError } = await admin.auth.admin.createUser({
    email: ownerEmail,
    password: ownerPassword,
    email_confirm: true,
    user_metadata: displayName ? { display_name: displayName } : {},
  });

  if (createUserError || !newUser.user) {
    const msg = createUserError?.message || "Impossible de créer l'utilisateur";
    if (/already registered|already exists/i.test(msg)) {
      return json({ error: "Cet email est déjà utilisé" }, 409);
    }
    return json({ error: msg }, 400);
  }

  const ownerId = newUser.user.id;

  const { data: cabinet, error: cabinetError } = await admin
    .from("cabinets")
    .insert({ name: cabinetName, slug })
    .select("id, name, slug, is_active, created_at")
    .single();

  if (cabinetError || !cabinet) {
    await admin.auth.admin.deleteUser(ownerId);
    if (cabinetError?.code === "23505") {
      return json({ error: "Ce slug de cabinet existe déjà" }, 409);
    }
    return json({ error: cabinetError?.message || "Impossible de créer le cabinet" }, 400);
  }

  const { error: memberError } = await admin.from("cabinet_members").insert({
    cabinet_id: cabinet.id,
    user_id: ownerId,
    role: "owner",
  });

  if (memberError) {
    await admin.from("cabinets").delete().eq("id", cabinet.id);
    await admin.auth.admin.deleteUser(ownerId);
    return json({ error: memberError.message }, 400);
  }

  if (displayName) {
    await admin.from("profiles").update({ display_name: displayName }).eq("user_id", ownerId);
  }

  return json({
    cabinet,
    owner: { id: ownerId, email: ownerEmail, display_name: displayName || null },
  });
});
