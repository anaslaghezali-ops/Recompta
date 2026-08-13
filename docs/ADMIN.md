# Admin cabinets (étape 2)

Page super-admin : créer un **cabinet** + le **compte owner** (email / mot de passe).

URL : `docs/admin.html` (lien **Admin cabinets** dans l’en-tête si vous êtes super-admin).

## Déployer l’Edge Function (obligatoire sur GitHub Pages)

La création d’utilisateur nécessite la clé `service_role` → **jamais dans le frontend**.  
Une Edge Function Supabase fait le travail côté serveur.

### Option A — Dashboard Supabase

1. **Edge Functions** → **Deploy a new function**
2. Nom : `admin-create-cabinet`
3. Collez le code de `supabase/functions/admin-create-cabinet/index.ts`
4. Déployez (JWT verification : **activée** par défaut)

### Option B — Supabase CLI

```bash
supabase login
supabase link --project-ref pbyoxfxngfutoiqjirkx
supabase functions deploy admin-create-cabinet --no-verify-jwt=false
```

L’URL appelée par l’app :

`https://pbyoxfxngfutoiqjirkx.supabase.co/functions/v1/admin-create-cabinet`

### Vérification

Connecté en super-admin → **Admin cabinets** → créez un cabinet test.  
Si erreur réseau : l’Edge Function n’est pas encore déployée.

## Fallback backend local (optionnel)

Si vous lancez `uvicorn` avec `SUPABASE_SERVICE_ROLE_KEY` dans `backend/.env`,  
l’app peut aussi appeler `POST /api/admin/cabinets` quand l’URL Codespace/Render est configurée dans l’outil TVA.

## Flux

1. **Super-admin uniquement** crée cabinet + owner sur **admin.html**
2. Le responsable se connecte → **dossiers.html** (clients + dossiers année/mois)
3. Ouverture d'un dossier → outil TVA vierge pour ce client/période

Voir [DOSSIERS.md](DOSSIERS.md) pour la migration et l'utilisation.

## Sécurité

- RLS : `INSERT` sur `cabinets` et `cabinet_members` réservé au super-admin
- Edge Function : vérifie le JWT super-admin avant `createUser`
- Désactiver **Allow new users to sign up** dans Supabase Auth
