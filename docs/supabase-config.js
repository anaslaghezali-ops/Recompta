/** Unique fichier de config frontend. GitHub Pages et uvicorn lisent `docs/`. */
export const SUPABASE_URL = "https://pbyoxfxngfutoiqjirkx.supabase.co";

/**
 * Clé «anon » (legacy) ou « publishable » du projet Recompta uniquement :
 * Dashboard → Project Settings → API Keys
 * Collez la clé entre les guillemets. Jamais la clé service_role.
 */
const RAW_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBieW94ZnhuZ2Z1dG9pcWppcmt4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MzM0NTksImV4cCI6MjEwMjIwOTQ1OX0.XnBB0ZlLPLcdssCHfEyXSgVJlzi4oORkOxBAaWHT5kI";

export const SUPABASE_ANON_KEY = RAW_ANON_KEY.trim().replace(/^["']|["']$/g, "");
