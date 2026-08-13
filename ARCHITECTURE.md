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
| **Option** | Modèle IA configurable + escalade automatique sur scans difficiles |

## Fiabilité : pourquoi 3 couches ?

L'IA seule ne suffit pas à 100 % : biais d'entraînement (HT avant TTC), scans flous, mises en page infinies. La couche mathématique corrige **sans connaître le fournisseur** — c'est la garantie SaaS.

## Règle d'or de la réconciliation : corriger sur preuve

Une ligne correcte `HT=150, TVA=30, TTC=180` et une ligne erronée où `150` est
en réalité le TTC (avec TVA recalculée dessus) produisent **exactement les mêmes
nombres**. Aucun contrôle arithmétique ne peut les distinguer.

La correction n'est donc appliquée que sur **preuve** :

| Preuve | Exemple |
|--------|---------|
| Libellé dans le document | `1905,00 TTC` lu dans le texte ou l'OCR |
| Totaux du pied de page | `m_ht` égal au Total TTC et différent du Total HT |
| Ratio impossible | `TVA/HT = 16,67 %` à un taux de 20 % |

Toute règle basée sur la seule arithmétique génère des faux positifs et
corrompt les factures correctes.

## Traitement en volume

Un cabinet importe couramment 50 à 200 factures d'un coup. Une requête unique
contenant tous les fichiers dépasserait les délais du navigateur et du proxy.

| Niveau | Mécanisme |
|--------|-----------|
| Navigateur | ZIP développés localement, envoi par lots de 4 fichiers |
| Serveur | 4 extractions simultanées par lot (`EXTRACTION_CONCURRENCY`) |
| Résilience | Une facture illisible n'interrompt ni son lot ni les suivants |
| Progression | Compteur `X/Y fichier(s)` mis à jour après chaque lot |

Si le serveur devient injoignable en cours de route, l'envoi s'arrête
immédiatement au lieu d'épuiser les lots restants.

## Choix du modèle IA

Deux niveaux, escalade automatique quand la validation mathématique échoue.

| Rôle | Modèle | Coût indicatif / 1 000 pages | Usage |
|------|--------|------------------------------|-------|
| **Principal** | `gpt-5.4-mini` | ~5 $ | Toutes les factures |
| **Secours** | `gpt-5.6-terra` | ~16 $ | Scans flous, tableaux TVA denses |
| Alternative éco | `gpt-5.4-nano` | ~1,7 $ | PDF natifs propres uniquement |

Les modèles `mini` / `nano` réduisent la résolution des pages denses : c'est
la raison principale des erreurs de lecture sur les photos de factures
froissées. Le modèle de secours lit la page en pleine résolution.

L'escalade ne se déclenche que si une ligne est incohérente
(`HT + TVA ≠ TTC` ou `TVA/HT ≠ taux`), donc elle reste marginale en coût.

## Configuration recommandée (production)

```env
OPENAI_API_KEY=sk-...
OPENAI_VISION_MODEL=gpt-5.4-mini
OPENAI_VISION_MODEL_FALLBACK=gpt-5.6-terra
```
