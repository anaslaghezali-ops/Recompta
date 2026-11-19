# Recompta — suivi des tâches

Fichier partagé entre Anas, Claude et l'autre discussion de développement.
**Règle :** quand une tâche avance, mettre à jour sa ligne (statut, date) et ajouter une entrée au journal en bas,
dans le même commit que le code. Une tâche n'est « Fait » que si elle est fusionnée dans `main2` et que la CI est verte.

Statuts : ⬜ à faire · 🔄 en cours · ⏸️ en attente (décision ou action d'Anas) · ✅ fait
Qui : **Anas** · **Claude** · **Autre** (autre discussion) · **Dev** (n'importe quelle discussion)

---

## 1. Décisions et actions d'Anas

| # | Tâche | Statut | Détail |
|---|---|---|---|
| A1 | Mettre le serveur du Codespace sur `main2` | ⏸️ | Ctrl+C, `git checkout main2`, `git pull origin main2`, relancer `uvicorn`. |
| A2 | Purger la file d'import (libère ~1,28 Go sur 1 Go gratuit) | ⏸️ | Dans le Codespace : `python backend/scripts/purge_import_queue.py`, puis `--supprimer`. |
| A3 | Accord : appliquer en production la correction « supprimer un brouillon de facture avec lignes » | ⏸️ | Migration `20261119120000_billing_allow_draft_delete.sql`, testée en transaction annulée. |
| A4 | Décision : lien public d'une facture annulée | ⏸️ | Aujourd'hui « lien plus valide ». Alternative : afficher la facture avec la mention « Annulée ». |
| A5 | Mesures de référence (baseline) | ⬜ | 2 dossiers (petit + 369 lignes) × 5 fois : ouvrir la revue, modifier une ligne, ouvrir les ventes. Puis Administration → « Exporter les mesures » → envoyer le fichier. |
| A6 | Envoyer le « pic » mémoire du terminal après un lot de ~20 factures | ⬜ | Décide si on passe `EXTRACTION_CONCURRENCY` de 2 à 3. |
| A7 | Fermer la PR #169 (contenu déjà dans `main2`) | ⬜ | Sur GitHub → Pull requests → #169 → Close. |
| A8 | Remettre `main` à jour avec `main2` (sécurité incluse) ? | ⏸️ | `main` a été aligné sur `main2` avant la sécurité. |
| A9 | Retours du comptable qui teste en parallèle | ⬜ | Noter chaque problème ici (section 6). |
| A10 | Protection des mots de passe divulgués (Supabase Auth) | ⬜ | Vérifier si disponible sur l'offre gratuite avant d'activer. |

## 2. Performance et scalabilité (dans cet ordre)

| # | Tâche | Qui | Statut | Détail |
|---|---|---|---|---|
| P1 | Outils de mesure locaux + export admin | Autre + Claude | ✅ 19/11 | `performance-metrics.js`, bouton dans `admin.html`. |
| P2 | Fiabiliser les sauvegardes automatiques | Autre | ✅ 19/11 | Une écriture à la fois, dernier état réessayé. |
| P3 | Analyser la référence (A5) et choisir le premier point | Claude | ⬜ | Dépend de A5. |
| P4 | Stocker les lignes dans une table (`dossier_lines`) au lieu d'un bloc JSON | Dev | ⬜ | 377 Ko réécrits à chaque modification (369 lignes). Avant P5. Migration = accord d'Anas, code et base livrés ensemble. |
| P5 | Optimiser la revue des lignes | Dev | ⬜ | Après P4. |
| P6 | Filtrer et paginer les ventes | Dev | ⬜ | |
| P7 | Index sur les 20 clés étrangères | Dev | ⬜ | Ne supprimer aucun index « inutilisé ». |
| P8 | Rationaliser les règles d'accès (23 doublons) | Dev | ⬜ | Tests entre 2 cabinets et portail client d'abord. |
| P9 | Lecture en parallèle plafonnée (2 factures à la fois) | Claude | ✅ 18/11 | Mémoire dans le terminal. |
| P10 | Hébergement permanent (VPS LWS) | Anas + Dev | ⬜ | Remplace le Codespace. |

## 3. Sécurité

| # | Tâche | Qui | Statut | Détail |
|---|---|---|---|---|
| S1 | Authentifier le serveur Python (routes d'import, analyse, extraction) | Autre | ✅ 19/11 | Vérification de session + accès au dossier. |
| S2 | ZIP bornés (taille, nombre, chemins, bombes) | Autre | ✅ 19/11 | |
| S3 | Garde des lignes de facture (déplacement) + droits SQL réduits | Autre | ✅ 19/11 | 4 migrations appliquées en production. |
| S4 | CI Postgres 17 sur `main2`, versions de cache, progression ZIP | Claude | ✅ 19/11 | |
| S5 | Le client du portail peut lancer l'analyse IA de son dossier (crédits du cabinet) | Dev | ⬜ | Restreindre `/api/dossiers/{id}/analyze` aux membres du cabinet. |
| S6 | Échappement HTML systématique (~70 insertions non échappées) | Dev | ⬜ | Un seul `escapeHtml` partagé. |
| S7 | CORS : n'autoriser que les adresses de Recompta | Dev | ⬜ | Aujourd'hui toutes les origines. |
| S8 | Contrôle d'intégrité (SRI) des bibliothèques chargées depuis unpkg / jsdelivr | Dev | ⬜ | |
| S9 | Cabinet désactivé peut encore facturer ; cas multi-cabinet des crédits IA | Dev | ⬜ | Pas de cas réel aujourd'hui. |
| S10 | Retirer les droits techniques inutiles des 20 autres tables | Dev | ⬜ | Sans risque actuel, nettoyage. Migration = accord d'Anas. |

## 4. Qualité du code

| # | Tâche | Qui | Statut | Détail |
|---|---|---|---|---|
| Q1 | Supprimer la triple copie des fichiers (racine, `docs/`, `backend/static/`) | Dev | ⬜ | Source unique + copie automatique au déploiement. |
| Q2 | Décider du sort de `production.html` / `app.js` (outil TVA solo, 1 670 lignes) | Anas | ⏸️ | Supprimer ou garder. |
| Q3 | Découper `workspace.html` (2 450 lignes de JS dans la page) | Dev | ⬜ | |
| Q4 | Contrôle de syntaxe JS et linter dans la CI | Dev | ⬜ | Aurait détecté les erreurs du 19/11. |

## 5. Produit et précision

| # | Tâche | Qui | Statut | Détail |
|---|---|---|---|---|
| R1 | Mesure de précision sur un mois complet (août : relevé « EDI 082026 revu SM ») | Claude | ⬜ | Glovo, SRM multi-taux, Carrefour, frais bancaires. |
| R2 | Regrouper les frais bancaires en une ligne mensuelle | Dev | ⬜ | Le cabinet n'en déclare qu'une. |
| R3 | Associer un libellé bancaire à un fournisseur, stocké en base | Dev | ⬜ | Aujourd'hui dans le navigateur (`localStorage`). |
| R4 | Rendre le crédit IA quand une extraction échoue ; compteur « x/y » en direct ; erreur 405 `get_cabinet_vision_credits` | Dev | ⬜ | |
| R5 | Compresser les scans à l'enregistrement | Dev | ⬜ | Stockage gratuit limité à 1 Go. |
| R6 | Ventes des clients, phases 1 à 5 | Autre | ✅ 18/11 | |
| R7 | Application mobile avec scan + WhatsApp | Plus tard | ⬜ | |

## 6. Retours du comptable

| Date | Problème signalé | Statut | Suite donnée |
|---|---|---|---|
| | | | |

---

## Journal

### 19/11/2026
- Sécurité de `main2-chatgpt` relue, corrigée et fusionnée dans `main2` (S1–S4).
- Branche `main-old` = ancien `main` ; `main` aligné sur `main2` (avant sécurité).
- Mesures de performance : 2 erreurs de syntaxe corrigées (revue et outil solo ne se chargeaient plus), stockage local, export admin ; fusionné dans `main2` (P1, P2).
- Création de ce fichier de suivi.

### 18/11/2026
- Lecture de 2 factures à la fois avec plafond global, mémoire dans le terminal (P9).
- Statut de lecture par document appliqué en production (migration du 18/11).
- Audits : scalabilité, puis qualité du code (documents de projet).
