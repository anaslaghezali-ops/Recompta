# Journal d'audit et de modifications — Recompta

## Objectif

Ce document permet au développeur de comprendre et de vérifier chaque différence entre `main2` et `main3-chatgpt`. Toutes les corrections seront réalisées uniquement sur `main3-chatgpt`, en commits atomiques, avec tests et mise à jour de ce journal.

## Référence initiale

- Dépôt : `anaslaghezali-ops/Recompta`
- Branche source : `main2`
- Branche de travail : `main3-chatgpt`
- Commit de référence : `ade6b47c256db8c2b9ac2377ec19996d2edad96a`
- Arbre Git initial : `37c7c63c1d523de26c60516037d71889051fc0e6`
- Date du commit source : 2026-11-18
- État initial : la branche `main3-chatgpt` a été créée depuis exactement le même commit que `main2`. Aucun fichier applicatif n'a été modifié à ce stade.

## Règles de travail

1. Ne jamais modifier `main2`.
2. Préserver `production.html` et les parcours de l'interface active, sauf demande explicite et justification validée.
3. Avant chaque correction : relire le code concerné, ses dépendances, migrations et tests.
4. Faire une correction ciblée par commit, éviter les refactorisations larges non nécessaires.
5. Ajouter au journal les fichiers touchés, le problème observé, la solution, les tests exécutés et leurs résultats.
6. Ne jamais présenter une hypothèse d'audit statique comme un défaut confirmé.
7. Ne pas déclarer une correction terminée sans tests adaptés. Signaler explicitement tout test non exécuté.

## Journal des changements

### 2026-11-18 — Initialisation de la branche

- Type : création de branche et documentation.
- Fichiers applicatifs modifiés : aucun.
- Fichier ajouté : `AUDIT_LOG.md` (ce document).
- Base : commit `ade6b47c256db8c2b9ac2377ec19996d2edad96a` de `main2`.
- Vérification : le HEAD initial de `main3-chatgpt` correspond exactement au HEAD de `main2`.
- Tests applicatifs : non exécutés ; aucune modification applicative.
- Résultat attendu : seule la documentation diffère après l'ajout de ce fichier.

## Points d'audit à vérifier — non confirmés

Les éléments ci-dessous sont des pistes issues d'une première lecture statique. Ils ne constituent pas des constats définitifs et ne doivent pas être corrigés avant inspection du code complet et de ses dépendances.

| Priorité indicative | Zone | Question à vérifier |
|---|---|---|
| Haute | Routes d'import et d'analyse dans `backend/main.py` | Les routes d'upload, d'analyse de dossier et de traitement des imports vérifient-elles correctement l'identité, le tenant et les droits sur chaque ressource ? |
| Haute | `backend/import_job_queue.py` | L'utilisation du rôle Service Role est-elle strictement encadrée par des contrôles d'autorisation et d'appartenance ? |
| Haute | Uploads dans `backend/main.py` | Existe-t-il des limites fiables de taille, de type et de durée de lecture ? |
| Haute | `backend/zip_utils.py` | La décompression protège-t-elle contre les archives volumineuses, bombes ZIP, chemins traversants et nombres excessifs de fichiers ? |
| Haute | Migrations billing et lignes de facture | Les triggers couvrent-ils correctement les insertions, modifications, suppressions et déplacements de lignes entre factures ? |
| Haute | RLS des lignes de facture | Les politiques garantissent-elles l'isolation par organisation et les règles d'immuabilité des factures émises ? |
| Moyenne | Worker d'import | Le mécanisme en mémoire est-il sûr en multi-instance, avec reprise, idempotence et gestion des tâches bloquées ? |
| Moyenne | Edge Function `cabinet-team` | Les appels utilisateur par utilisateur créent-ils un problème N+1 évitable ? |
| Moyenne | GitHub Actions | Les workflows sont-ils déclenchés sur les branches réellement utilisées, notamment `main2` et `main3-chatgpt` ? |
| Moyenne | Base de données | Les index, transactions et tests RLS couvrent-ils les scénarios réels et les volumes attendus ? |

## Format obligatoire pour chaque correction future

Pour chaque commit, ajouter une section comprenant :
- Date et SHA du commit ;
- fichiers modifiés ;
- comportement ou risque observé (avec preuve/code concerné) ;
- changement réalisé et justification ;
- tests exécutés (commandes, résultats) ;
- tests non exécutés et limites connues ;
- impact fonctionnel, sécurité, données et compatibilité ;
- comparaison avec `main2`.
