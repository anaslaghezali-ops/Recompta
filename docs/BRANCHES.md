# Branches et versions

Chaque modification doit vivre sur **sa propre branche**, pour pouvoir revenir à une version précédente sans perdre l'historique.

## Branche Freemium (phase actuelle)

Développement du modèle gratuit + crédits vision :

- Branche longue durée : **`freemium`** (depuis `main`)
- Spec produit : [FREEMIUM.md](../FREEMIUM.md) à la racine
- **GitHub Pages** : déploie le dossier `docs/` depuis **`freemium`** (pas `main`)
- Les PRs Freemium ciblent **`freemium`** jusqu’au merge final sur `main`

### Nommage des branches Freemium

Pendant cette phase, **chaque changement** part d’une branche dédiée :

- Format : **`freemium-<description-courte>`** (minuscules, tirets)
- Exemples : `freemium-self-serve-signup`, `freemium-credits-counter`, `freemium-stripe-packs`
- Toujours créer la branche depuis **`freemium`** à jour (pas depuis `main`)
- Une PR par branche → merge dans **`freemium`**

Les anciennes branches `cursor/*-7cb5` restent des snapshots historiques ; ne plus en créer pour le travail Freemium.

## Règles (hors phase Freemium / historique)

### 1. Branche de travail (avant merge)

- Format historique : `cursor/<description-courte>-7cb5`
- **Phase Freemium** : utiliser `freemium-<description-courte>` (voir ci-dessus)

### 2. Branche snapshot (après merge)

Après chaque merge sur `main`, créer une branche figée au commit de merge :

- Format : `cursor/pr<N>-<description-courte>-7cb5`
- Exemple : `cursor/pr128-import-achats-7cb5` → état exact de `main` juste après le PR #128

Ces branches ne servent **pas** au développement : ce sont des points de restauration.

### 3. Script de snapshot

```bash
./scripts/create-pr-snapshot.sh 128 import-achats
```

Crée (ou met à jour) `cursor/pr128-import-achats-7cb5` au merge commit du PR #128.

## Revenir à une version précédente

```bash
# Consulter l'état après le PR 98
git checkout cursor/pr98-extraction-batch-7cb5

# Repartir de là pour une nouvelle modification
git checkout -b cursor/ma-nouvelle-modif-7cb5
```

## Snapshots disponibles (PR 98 → 128)

| PR | Branche snapshot | Sujet |
|----|------------------|-------|
| 98 | `cursor/pr98-extraction-batch-7cb5` | Extraction batch complète |
| 99 | `cursor/pr99-workspace-upload-7cb5` | Upload factures dans le workspace |
| 100–124 | `cursor/pr100-…` à `cursor/pr124-import-queue-7cb5` | Voir `git branch -r \| grep cursor/pr` |
| 125 | `cursor/pr125-restore-toast-7cb5` | Toast extraction |
| 126 | `cursor/pr126-show-extract-7cb5` | Bouton extraction visible |
| 127 | `cursor/pr127-restore-queue-7cb5` | Restauration file PR 120 |
| 128 | `cursor/pr128-import-achats-7cb5` | Import centralisé sur import-achats.html |

`main` = dernière version mergée (actuellement après PR #128).
