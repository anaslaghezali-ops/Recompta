# Déployer l'inscription self-serve

L'erreur **« Service d'inscription indisponible »** signifie que l'Edge Function **`signup-cabinet`** n'est pas encore déployée sur Supabase (réponse HTTP 404).

## Étape 1 — Migration SQL (une fois)

Dashboard → **SQL Editor** → New query :

https://supabase.com/dashboard/project/pbyoxfxngfutoiqjirkx/sql/new

Collez et exécutez :

`supabase/migrations/20260820180000_self_serve_signup.sql`

## Étape 2 — Déployer l'Edge Function

### Option A — CLI (recommandé)

```bash
# Installer la CLI (si besoin)
npm install -g supabase

# Se connecter
supabase login

# Depuis la racine du repo Recompta
cd /chemin/vers/Recompta
git checkout freemium
supabase functions deploy signup-cabinet --project-ref pbyoxfxngfutoiqjirkx
```

Le code source est dans `supabase/functions/signup-cabinet/index.ts`.

### Option B — Dashboard Supabase

1. https://supabase.com/dashboard/project/pbyoxfxngfutoiqjirkx/functions
2. **Deploy a new function** (ou **Create function**)
3. Nom : **`signup-cabinet`**
4. Collez le contenu de `supabase/functions/signup-cabinet/index.ts`
5. **Deploy**

Les variables `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont injectées automatiquement.

## Étape 3 — Vérifier

```bash
curl -s -X POST "https://pbyoxfxngfutoiqjirkx.supabase.co/functions/v1/signup-cabinet" \
  -H "apikey: VOTRE_CLE_ANON" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test1234","cabinet_name":"Test Cabinet"}'
```

- **404** `NOT_FOUND` → fonction pas déployée
- **400** avec message JSON (email invalide, etc.) → **OK**, la fonction répond
- **200** → inscription réussie (compte de test créé — supprimez-le si besoin)

## Étape 4 — Retester sur le site

https://anaslaghezali-ops.github.io/Recompta/login.html?mode=signup

Assurez-vous que GitHub Pages sert la branche **`freemium`** (Settings → Pages → Branch).

## Comparaison

| Fonction | Statut attendu |
|----------|----------------|
| `admin-create-cabinet` | Déjà déployée (super-admin) |
| `signup-cabinet` | **À déployer** pour l'inscription publique |
