# Crédits vision IA (Freemium)

## Migration SQL

Exécuter dans le SQL Editor Supabase :

`supabase/migrations/20260820193000_vision_credits.sql`

## Comportement

| Élément | Détail |
|---------|--------|
| **Défaut plateforme** | **10** scans IA / mois / cabinet |
| **PDF natifs** | 0 crédit |
| **CSV/Excel banque** | 0 crédit |
| **1 crédit** | 1 document scanné traité par OpenAI Vision |

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
