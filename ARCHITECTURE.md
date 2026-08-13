# Architecture Recompta — extraction générique (SaaS multi-cabinets)

## Principe

**Aucune règle par fournisseur.** Chaque cabinet a ses propres factures ; le système doit comprendre n'importe quel format via une intelligence générique + des contrôles mathématiques universels.

```
┌─────────────────────────────────────────────────────────────┐
│  1. COMPRÉHENSION (IA Vision)                               │
│     Lit le document : libellés HT/TTC/TVA, tableaux, ICE   │
│     Prompt = règles comptables marocaines, pas de noms      │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  2. RELECTURE DOCUMENT (OCR / texte PDF)                    │
│     Parseurs génériques indépendants du fournisseur :         │
│     • « XXX TTC  20%  YYY »                                 │
│     • Tableau « Taux | Montant HT | TVA »                   │
│     • Totaux pied de page (Total HT / Taxes / TTC)          │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  3. VALIDATION MATHÉMATIQUE (100 % générique)               │
│     Pour chaque ligne : HT + TVA ≈ TTC, TVA/HT ≈ taux       │
│     Détection TTC confondu avec HT (ratio taux/(1+taux))    │
│     Alignement avec totaux du document                      │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
                    Lignes DED TVA fiables
```

## Ce qui est générique (tous cabinets, tous fournisseurs)

| Composant | Rôle |
|-----------|------|
| `vat_intelligence.py` | Parseurs + réconciliation TVA |
| Prompt IA | Méthode en 4 étapes + auto-vérification mathématique |
| Exclusion ICE client | Paramètre par dossier (pas par fournisseur) |
| Consolidation lignes | Fusion uniquement si TVA incomplète sur éclats produit |

## Ce qui ne doit PAS exister en production SaaS

- Listes `ACHIBEST`, `EATMEAT`, `MOSE` codées en dur
- ICE/IF fournisseur injectés sans lecture du document
- « Si fournisseur X alors parser Y »

## Multi-cabinets (roadmap)

| Phase | Fonctionnalité |
|-------|----------------|
| **Actuel** | Mode solo, extraction + export Excel |
| **Prochain** | Comptes cabinet (Supabase), dossiers clients isolés |
| **Ensuite** | ICE client par dossier, historique fournisseurs appris (pas codé) |
| **Option** | Modèle IA configurable (`gpt-4o` pour scans difficiles) |

## Fiabilité : pourquoi 3 couches ?

L'IA seule ne suffit pas à 100 % : biais d'entraînement (HT avant TTC), scans flous, mises en page infinies. La couche mathématique corrige **sans connaître le fournisseur** — c'est la garantie SaaS.

## Configuration recommandée (production)

```env
OPENAI_API_KEY=sk-...
OPENAI_VISION_MODEL=gpt-4o        # meilleure lecture que gpt-4o-mini
```
