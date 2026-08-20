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

function slugify(name: string): string {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function allocateUniqueSlug(
  admin: ReturnType<typeof createClient>,
  baseName: string,
): Promise<string | null> {
  const base = slugify(baseName);
  if (!base || !slugPattern.test(base)) return null;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (!slugPattern.test(candidate)) continue;

    const { data, error } = await admin
      .from("cabinets")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();

    if (error) throw error;
    if (!data) return candidate;
  }

  return null;
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
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Configuration serveur incomplète" }, 500);
  }

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corps JSON invalide" }, 400);
  }

  const cabinetName = (body.cabinet_name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const displayName = (body.display_name || "").trim();

  if (!cabinetName || cabinetName.length < 2) {
    return json({ error: "Nom du cabinet requis (2 caractères minimum)" }, 400);
  }
  if (!email || !email.includes("@")) {
    return json({ error: "Email invalide" }, 400);
  }
  if (!password || password.length < 6) {
    return json({ error: "Mot de passe requis (6 caractères minimum)" }, 400);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const slug = await allocateUniqueSlug(admin, cabinetName);
  if (!slug) {
    return json({ error: "Impossible de générer un identifiant cabinet valide" }, 400);
  }

  const { data: newUser, error: createUserError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: displayName ? { display_name: displayName } : {},
  });

  if (createUserError || !newUser.user) {
    const msg = createUserError?.message || "Impossible de créer le compte";
    if (/already registered|already exists/i.test(msg)) {
      return json({ error: "Cet email est déjà utilisé — connectez-vous." }, 409);
    }
    return json({ error: msg }, 400);
  }

  const ownerId = newUser.user.id;

  const { data: cabinet, error: cabinetError } = await admin
    .from("cabinets")
    .insert({ name: cabinetName, slug, signup_source: "self_serve" })
    .select("id, name, slug, signup_source, is_active, created_at")
    .single();

  if (cabinetError || !cabinet) {
    await admin.auth.admin.deleteUser(ownerId);
    if (cabinetError?.code === "23505") {
      return json({ error: "Identifiant cabinet déjà pris — choisissez un autre nom." }, 409);
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
    user: { id: ownerId, email, display_name: displayName || null },
  });
});
