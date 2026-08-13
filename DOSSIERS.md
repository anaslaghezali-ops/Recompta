# Dossiers clients (étape 3)

Chaque cabinet gère ses **clients** et ouvre un **dossier mensuel** pour la déclaration TVA.

URL : `docs/dossiers.html` (redirection après connexion cabinet).

## Schéma

1. **Client** — nom + ICE de la société (15 chiffres)
2. **Dossier** — une période **année + mois** par client (ex. juin 2026 → `062026`)

Un client peut avoir plusieurs dossiers (un par mois). Un dossier ouvre l'outil TVA avec les paramètres préremplis et **vierges** (aucune ligne Aichoum / démo).

## Migration Supabase

SQL Editor :

https://supabase.com/dashboard/project/pbyoxfxngfutoiqjirkx/sql/new

1. `supabase/migrations/20260813220000_cabinet_clients_dossiers.sql` → **Run**
2. Si erreur RLS à la création de dossier : `supabase/migrations/20260813230000_fix_dossiers_rls.sql` → **Run**
3. Persistance lignes + banque + historique : `supabase/migrations/20260813240000_dossier_workspace_persistence.sql` → **Run**

## Flux cabinet

1. Connexion → **dossiers.html** (portefeuille clients — dashboard)
2. Carte client → **workspace.html** (calendrier TVA annuel + actions rapides)
3. Clic sur un mois ou « Déclaration TVA » → `production.html?dossier=…`

## Mode solo (sans compte)

`production.html` reste accessible sans connexion pour les tests rapides, avec des champs vides (pas de données Aichoum par défaut).

La page d'accueil `index.html` présente Recompta et oriente vers la connexion cabinet.

## Sauvegarde automatique

Chaque dossier TVA enregistre dans Supabase :
- **Lignes extraites** et modifications du tableau
- **Relevé bancaire** importé
- **Historique** (extractions, exports, rapprochements)

Sauvegarde auto toutes les ~1,5 s après modification. À la réouverture du dossier, tout est restauré.

**Note :** les fichiers PDF/images ne sont pas encore stockés (aperçu document après rechargement = prochaine étape). Les **données métier** (lignes, montants, dates) sont conservées.

## Prochaine étape

Stockage des fichiers sources dans Supabase Storage pour l'aperçu document après rechargement.
