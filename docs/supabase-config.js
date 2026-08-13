/** Unique fichier de config frontend. GitHub Pages et uvicorn lisent `docs/`. */
export const SUPABASE_URL = "https://pbyoxfxngfutoiqjirkx.supabase.co";

/**
 * Clé «anon » (legacy) ou « publishable » du projet Recompta uniquement :
 * Dashboard → Project Settings → API Keys
 * Collez la clé entre les guillemets. Jamais la clé service_role.
 */
const RAW_ANON_KEY = "";

export const SUPABASE_ANON_KEY = RAW_ANON_KEY.trim().replace(/^["']|["']$/g, "");
