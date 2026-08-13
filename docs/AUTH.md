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

## 3. Premier compte

1. Ouvrez `login.html`
2. **Créer le compte super-admin** avec votre email
3. Dans le SQL Editor :

```sql
select private.grant_super_admin('votre@email.com');
```

4. Déconnexion / reconnexion

Le bandeau de l'outil affiche **Super-admin**.

## 4. Auth dashboard (recommandé pour le bootstrap)

Authentication → Providers → Email :

- Désactiver **Confirm email** le temps de créer le premier compte, ou confirmer le mail
- Les inscriptions publiques pourront être coupées plus tard : les cabinets seront créés par le super-admin
