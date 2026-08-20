# Auth Recompta

Deux modes de création de cabinet :

| Mode | Qui | Comment |
|------|-----|---------|
| **Self-serve (Freemium)** | Tout cabinet | `login.html` → onglet **Créer un cabinet** |
| **Admin** | Super-admin | `admin.html` → Edge Function `admin-create-cabinet` |

## 1. Appliquer le schéma

SQL Editor :

https://supabase.com/dashboard/project/pbyoxfxngfutoiqjirkx/sql/new

Appliquer les migrations dans l'ordre (au minimum auth + dossiers + self-serve) :

1. `supabase/migrations/20260813190000_auth_super_admin.sql`
2. `supabase/migrations/20260813210000_lock_cabinet_creation.sql`
3. … (dossiers, persistence, etc. selon votre déploiement)
4. **`supabase/migrations/20260820180000_self_serve_signup.sql`** — colonne `signup_source` sur `cabinets`

## 2. Clé frontend

La clé **anon** est dans `auth-client.js` (racine, `docs/`, `backend/static/`).

Projet : `https://pbyoxfxngfutoiqjirkx.supabase.co`

Ne commitez **jamais** la clé `service_role`.

## 3. Déployer l'Edge Function `signup-cabinet`

Inscription self-serve (Freemium) :

```bash
supabase functions deploy signup-cabinet --project-ref pbyoxfxngfutoiqjirkx
```

Variables automatiques : `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`.

La fonction crée en une transaction : compte Auth + cabinet (`signup_source = self_serve`) + membre `owner`.

## 4. Inscription self-serve (Freemium)

1. Ouvrir **`login.html?mode=signup`**
2. Renseigner nom du cabinet, email, mot de passe
3. Redirection vers **`dossiers.html`** (portefeuille clients)

**Authentication → Providers → Email** : vous pouvez laisser **Allow new users to sign up** **désactivé** — l'inscription passe par l'Edge Function (`service_role`), pas par `signUp` public.

## 5. Premier compte super-admin (bootstrap)

1. **Authentication → Users → Add user**
2. SQL Editor :

```sql
select private.grant_super_admin('votre@email.com');
```

3. Connexion → **admin.html**

## 6. Création cabinet par super-admin

**admin.html** appelle `admin-create-cabinet` (inchangé).  
RLS : seul le super-admin peut `INSERT` directement sur `cabinets` — les self-serve passent par l'Edge Function.

## 7. Auth email

**Confirm email** : au choix. L'Edge Function crée les comptes avec `email_confirm: true`.
