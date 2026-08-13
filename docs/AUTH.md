# Auth Recompta (étape 1)

Super-admin qui créera ensuite les comptes cabinets. Pas encore d'écran de gestion des cabinets.

## 1. Appliquer le schéma

SQL Editor du projet Recompta :

https://supabase.com/dashboard/project/pbyoxfxngfutoiqjirkx/sql/new

Collez le contenu de `supabase/migrations/20260813190000_auth_super_admin.sql` → **Run**.

## 2. Clé frontend

Dashboard → **Project Settings → API Keys** → copiez la clé **anon** / **publishable**.

Collez-la dans `docs/supabase-config.js` (et les copies `backend/static/` + racine) :

```js
export const SUPABASE_ANON_KEY = "eyJ...";
```

Ne commitez **jamais** la clé `service_role`.

## 3. Premier compte

1. Ouvrez `login.html`
2. **Créer le compte super-admin** avec votre email
3. Dans le SQL Editor :

```sql
select private.grant_super_admin('votre@email.com');
```

4. Déconnexion / reconnexion (le JWT doit se rafraîchir)

Le bandeau de l'outil affiche **Super-admin**.

## 4. Auth dashboard (recommandé pour le bootstrap)

Authentication → Providers → Email :

- Désactiver **Confirm email** le temps de créer le premier compte, ou confirmer le mail
- Les inscriptions publiques pourront être coupées plus tard : les cabinets seront créés par le super-admin, pas par auto-inscription
