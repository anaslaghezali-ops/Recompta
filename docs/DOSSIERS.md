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

## Flux cabinet

1. Connexion avec le compte créé par le super-admin
2. **Dossiers clients** → ajouter un client (nom + ICE)
3. **+ Dossier** sur le client → choisir année et mois
4. Ouverture de l'outil TVA (`index.html?dossier=…`) — extraction et export pour ce dossier

## Mode solo (sans compte)

`index.html` reste accessible sans connexion pour les tests rapides, avec des champs vides (pas de données Aichoum par défaut).

## Prochaine étape

Persistance des lignes extraites et des fichiers dans Supabase (aujourd'hui : session navigateur uniquement).
