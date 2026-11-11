# Auth Recompta (étape 1)

Super-admin qui créera ensuite les comptes cabinets. Pas encore d'écran de gestion des cabinets.

## 1. Appliquer le schéma

SQL Editor du projet Recompta :

https://supabase.com/dashboard/project/pbyoxfxngfutoiqjirkx/sql/new

Collez le contenu de `supabase/migrations/20260813190000_auth_super_admin.sql` → **Run**.

## 2. Clé frontend (un seul fichier)

Le site GitHub Pages publie la **racine** du dépôt. `login.html` à la racine redirige vers `docs/login.html`.

La clé se colle **uniquement** dans :

`docs/supabase-config.js`

Dashboard du projet **Recompta** (`https://pbyoxfxngfutoiqjirkx.supabase.co`) → **Project Settings → API Keys** → clé **anon**.

Si le JWT contient un autre `ref` (ex. `hsojfhtabmfczhpiwuxs`), c’est le **mauvais projet** → `Invalid API key`.

```js
const RAW_ANON_KEY = "eyJ...";
```

Ne commitez **jamais** la clé `service_role`.

Pour n’avoir que `docs/` en ligne : GitHub → Settings → Pages → Folder **`/docs`** (au lieu de `/`).

## 3. Premier compte super-admin (bootstrap unique)

La page `login.html` ne propose **pas** d'inscription. Créez le premier compte dans le dashboard Supabase :

1. **Authentication → Users → Add user** (email + mot de passe, confirmer l'email)
2. SQL Editor :

```sql
select private.grant_super_admin('votre@email.com');
```

3. Connectez-vous sur `login.html` → redirection vers **admin.html**

Le bandeau de l'outil affiche **Super-admin**.

## 4. Fermer l'inscription publique (obligatoire)

**Authentication → Providers → Email** :

- Désactiver **Allow new users to sign up**

Seul le super-admin crée des comptes cabinet via **admin.html** (Edge Function `admin-create-cabinet`).  
Les responsables de cabinet se connectent avec les identifiants que vous leur fournissez.

## 5. Migration RLS (création cabinets)

Appliquez aussi `supabase/migrations/20260813210000_lock_cabinet_creation.sql` dans le SQL Editor  
(défense en profondeur : `INSERT` sur `cabinets` et `cabinet_members` réservé au super-admin).

## 6. Auth email

Authentication → Providers → Email :

- **Confirm email** : au choix (désactivé simplifie les tests)
- Avec l'inscription publique coupée, seuls les comptes créés par le super-admin existent

## 7. Authentification du serveur (routes `/api/…`)

Le serveur Python écrit dans Supabase avec la clé `service_role`, qui contourne la RLS.
Il vérifie donc lui-même chaque appel (`backend/auth.py`) :

| Route | Qui peut appeler |
|-------|------------------|
| `POST /api/extract`, `POST /api/import-bank-statement`, `POST /api/import-jobs/process` | Membre actif d'un cabinet, ou super-admin |
| `POST /api/import-jobs/{id}/upload` | Utilisateur ayant accès au dossier du job |
| `POST /api/dossiers/{id}/analyze` | Utilisateur ayant accès au dossier |
| `GET /api/health`, `GET /api/reference`, `POST /api/export` | Public (aucune donnée cabinet, aucun appel IA) |

Le navigateur envoie le jeton de session Supabase (`Authorization: Bearer …`), ajouté
automatiquement par `api-client.js`. L'accès au dossier est vérifié en interrogeant
Supabase **avec le jeton de l'utilisateur** : ce sont les règles RLS qui décident.

Variable à définir côté serveur (Codespace `backend/.env`, Render, etc.) :

```env
SUPABASE_ANON_KEY=eyJ...   # la clé publique, la même que dans docs/auth-client.js
```

À défaut, le serveur utilise `SUPABASE_SERVICE_ROLE_KEY` comme `apikey` (les droits
restent ceux du jeton utilisateur). Sans aucune des deux, les routes protégées
répondent `503`.

Conséquence : `production.html` (mode solo) exige désormais d'être connecté pour
l'extraction IA.
