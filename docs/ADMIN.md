# Espace administrateur

Page super-admin (`admin.html`) :

- liste des cabinets avec recherche, filtres (actifs, suspendus, comptes bloqués) et jauge de scans IA du mois ;
- panneau **Gérer** par cabinet : modifier un compte (nom, email, mot de passe), bloquer / débloquer un compte, quota de scans IA, renommer, suspendre / réactiver le cabinet ;
- **Nouveau cabinet** : création du cabinet et du compte responsable ;
- **Paramètres** : quota de scans IA par défaut.

## Edge Function `admin-manage-accounts` (obligatoire pour modifier et bloquer)

Code : `supabase/functions/admin-manage-accounts/index.ts`. Elle vérifie que l'appelant est super-admin, puis utilise la clé `service_role` côté serveur.

```bash
supabase functions deploy admin-manage-accounts --project-ref pbyoxfxngfutoiqjirkx
```

Ou Dashboard Supabase → **Edge Functions** → **Deploy a new function** → nom `admin-manage-accounts` → coller le code (JWT verification activée).

Bloquer un compte : bannissement Supabase Auth (plus de connexion ni de renouvellement de session) **et** `cabinet_members.is_active = false` (les règles RLS coupent l'accès aux dossiers immédiatement). Suspendre un cabinet applique la même chose à tous ses comptes et passe `cabinets.is_active` à `false`. Les comptes super-admin ne peuvent pas être modifiés depuis cet écran.

## Création de cabinet

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

## Équipe du cabinet (page `equipe.html`)

Le responsable d'un cabinet (et ses administrateurs) ajoutent leurs collaborateurs sans passer par le super-admin : création du compte avec mot de passe initial, changement de rôle (Administrateur / Collaborateur), nouveau mot de passe, désactivation / réactivation. Chaque membre peut changer son propre mot de passe sur la même page.

Edge Function : `supabase/functions/cabinet-team/index.ts` (vérifie que l'appelant est owner ou admin actif du cabinet, utilise `service_role` côté serveur).

```bash
supabase functions deploy cabinet-team --project-ref pbyoxfxngfutoiqjirkx
```

Règles : le compte du responsable ne se modifie pas depuis cette page ; seul le responsable nomme ou gère un administrateur ; un administrateur gère les collaborateurs.

### Clients attribués

Un collaborateur (rôle `comptable`) n'accède qu'aux clients qui lui sont attribués (table `client_assignments`, migration `20261117190000_client_assignments.sql`). La restriction est appliquée par les règles RLS : clients, périodes, documents, fichiers Storage, imports, activité et fournisseurs. Le responsable et les administrateurs voient tous les clients et sont les seuls à pouvoir en créer.
