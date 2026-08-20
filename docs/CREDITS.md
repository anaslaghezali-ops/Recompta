# Crédits vision IA (Freemium)

## Migration SQL

Exécuter dans le SQL Editor Supabase :

`supabase/migrations/20260820193000_vision_credits.sql`

Sans cette migration, l’UI affiche quand même **10/10 scans IA** (estimation) mais la consommation backend ne fonctionne pas.

Exécuter aussi :

`supabase/migrations/20260820194500_fix_consume_vision_credit_atomic.sql`

(Corrige le dépassement de quota quand plusieurs scans sont extraits en parallèle.)

## Backend (obligatoire pour bloquer les scans)

Le worker Python (`backend/import_job_worker.py`) consomme les crédits **avant chaque appel OpenAI Vision**. Il faut **redéployer le backend** (Render / Codespace) depuis la branche `freemium` après chaque changement crédits.

Variables requises côté serveur : `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`.

## GitHub Pages

Le déploiement Pages utilise le dossier **`docs/`** sur la branche **`freemium`** (voir `.github/workflows/pages.yml`). Après un push sur `freemium`, attendre ~1 min puis **Ctrl+Shift+R** sur le navigateur.

## Comportement

| Élément | Détail |
|---------|--------|
| **Défaut plateforme** | **10** scans IA / mois / cabinet |
| **PDF natifs** | 0 crédit |
| **CSV/Excel banque** | 0 crédit |
| **1 crédit** | 1 document scanné traité par OpenAI Vision |
| **Extraction partielle** | Si N scans et M crédits (M < N) : M extraits, N−M restent en attente avec message explicite |

## Super-admin

Page **admin.html** → section **Crédits vision IA** :

- Modifier le **quota mensuel par défaut** (tous les cabinets sans override)
- Modifier le **quota par cabinet** (colonne Crédits IA — vide = défaut)

## RPC

| Fonction | Rôle |
|----------|------|
| `get_my_vision_credits()` | Bandeau portefeuille cabinet |
| `consume_vision_credit(cabinet_id)` | Backend worker (service_role) |
| `admin_set_vision_credits_default(quota)` | Super-admin |
| `admin_set_cabinet_vision_quota(cabinet_id, quota)` | Super-admin |

## Backend

Le worker d'import (`import_job_worker.py`) consomme un crédit **avant chaque appel OpenAI Vision** (pas sur PDF texte local).
