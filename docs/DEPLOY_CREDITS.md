# Déploiement crédits vision — CHECKLIST OBLIGATOIRE

Sans **les 3 étapes**, le compteur UI peut afficher `1/1` alors que le Codespace
extrait encore sans limite (ancien backend).

## 1. SQL Editor Supabase (dans l’ordre)

1. `supabase/migrations/20260820193000_vision_credits.sql`
2. `supabase/migrations/20260820194500_fix_consume_vision_credit_atomic.sql`
3. `supabase/migrations/20260820200000_secure_consume_and_peek_credits.sql`

## 2. Codespace / serveur Python (branche `freemium`)

```bash
cd backend   # ou racine selon votre setup
git fetch origin
git checkout freemium
git pull origin freemium
# Vérifiez que SUPABASE_SERVICE_ROLE_KEY est dans .env (décommentée)
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## 3. Vérifier que le serveur est à jour

Ouvrez dans le navigateur :

`https://VOTRE-CODESPACE-8000.app.github.dev/api/health`

Doit contenir :

```json
"vision_credits_enforced": true,
"vision_credits_version": 2
```

Si ce champ est **absent**, GitHub Pages **refuse** désormais l’extraction
(toast « Serveur IA obsolète »). C’est normal : l’ancien serveur n’applique pas les crédits.

## Comportement attendu

| Crédits | Scans en attente | Résultat |
|---------|------------------|----------|
| 0 | 5 | Blocage total |
| 1 | 5 | **1** job mis en file, **4** restent en attente |
| 10 | 5 | 5 extraits |

La limite est appliquée **à la mise en file** (`/api/dossiers/{id}/analyze`)
**et** à chaque appel OpenAI Vision.
