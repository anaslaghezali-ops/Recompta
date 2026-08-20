# Recompta Freemium

Branche de travail longue durée : **`freemium`** (basée sur `main`).

## Stratégie

| Gratuit | Payant (plus tard : packs crédits) |
|---------|-------------------------------------|
| Plateforme complète (dossiers, revue, banque, export DED) | Scans / photos au-delà du quota |
| PDF natifs (couche texte) | 1 crédit = 1 document scanné (max 5 pages) |
| Relevés CSV / Excel banque | Packs : 99 / 399 / 1 299 MAD |
| **30 crédits vision / mois / cabinet** | |

Phase 1 : **inscription self-serve** + **compteur crédits**.  
Phase 2 (après masse de cabinets) : abonnement Pro récurrent, portail client, etc.

## Détection scan vs PDF natif (base du compteur)

Seuls les documents **`engine: scan`** ou **`engine: ai`** consomment un crédit.  
Les PDF **`engine: text`** et les relevés banque CSV/Excel restent à **0 crédit**.

### Règle métier

| Type | MIME / cas | `engine` | Crédit |
|------|------------|----------|--------|
| PDF facture native | Texte extractible (ICE, Total HT/TVA…) | `text` | **0** |
| PDF scanné | Pas de texte significatif | `scan` → IA | **1** |
| Photo JPG/PNG | `image/*` | `scan` → IA | **1** |
| Relevé banque CSV/Excel | import banque | — | **0** |
| Extraction serveur vision | OpenAI Vision | `ai` | **1** |

### Implémentation existante (à réutiliser, ne pas dupliquer)

**Navigateur** — `extract-client.js` :

- `isMeaningfulPdfText(text)` : ≥ 60 caractères + motif facture (ICE 15 chiffres, « facture », « total ht/ttc/tva »).
- PDF : texte significatif → extraction locale `engine: "text"` ; sinon → `engine: "scan"` (IA serveur obligatoire).
- Images : toujours `engine: "scan"`.

**Serveur** — `backend/invoice_extractor.py` :

- `is_meaningful_pdf_text()` / `pdf_is_scanned()` : même logique.
- Test de non-régression : `backend/scripts/test_scan_routing.py`.

```bash
cd backend && python scripts/test_scan_routing.py
```

### Prochaine étape code (compteur)

1. Exposer côté API un champ **`billable: true|false`** par fichier extrait (`scan`/`ai` = true).
2. Table Supabase `cabinet_credits` : quota mensuel, consommé, reset le 1er du mois.
3. Bloquer l’envoi IA si `credits_remaining <= 0` (message + lien achat pack).

## Inscription self-serve (implémenté)

- UI : `login.html` → onglet **Créer un cabinet**
- API : Edge Function **`signup-cabinet`** (`supabase/functions/signup-cabinet/`)
- Migration : `20260820180000_self_serve_signup.sql` (`signup_source` sur `cabinets`)
- Doc déploiement : [docs/AUTH.md](docs/AUTH.md)

## Branches

| Branche | Rôle |
|---------|------|
| `main` | Production stable (hors freemium tant que non mergé) |
| `freemium` | Ligne de développement Freemium (intégration) |
| `freemium-<changement>` | **Une branche par feature** — ex. `freemium-credits-counter`, `freemium-stripe-packs` |

### Convention

```
git checkout freemium && git pull
git checkout -b freemium-credits-counter
# … travail …
# PR → freemium → merge
```

Ne pas utiliser le préfixe `cursor/` pour les nouvelles features Freemium.

## Déploiement

GitHub Pages peut pointer une branche **`freemium`** pour tester en public avant merge sur `main`.
