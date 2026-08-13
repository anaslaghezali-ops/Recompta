/** Unique fichier de config frontend. GitHub Pages et uvicorn lisent `docs/`. */
export const SUPABASE_URL = "https://pbyoxfxngfutoiqjirkx.supabase.co";

/**
 * Clé «anon » (legacy) ou « publishable » du projet Recompta uniquement :
 * Dashboard → Project Settings → API Keys
 * Collez la clé entre les guillemets. Jamais la clé service_role.
 */
const RAW_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhzb2pmaHRhYm1mY3pocGl3dXhzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MzM1NjcsImV4cCI6MjEwMjIwOTU2N30.cAg84siHXy5rBLibWEZYlObCRdO_pAzl19qYhnLM2MA";

export const SUPABASE_ANON_KEY = RAW_ANON_KEY.trim().replace(/^["']|["']$/g, "");
