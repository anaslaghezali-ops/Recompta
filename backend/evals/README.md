# Évaluation de l'extraction (P0)

Harnais de mesure reproductible du pipeline d'extraction : corpus annoté,
métriques par champ et par ligne, seuils bloquants en CI, rapport lisible.

Objectif : **savoir si une modification améliore ou dégrade l'extraction**, au
lieu de valider des cas isolés à la main.

## Lancer l'évaluation

Depuis `backend/` :

```bash
# Mode de référence CI : pipeline texte/heuristique, aucun appel OpenAI
python evals/run_eval.py --no-ai

# Avec la clé OpenAI de l'environnement (coût réel, à réserver aux évaluations IA)
python evals/run_eval.py

# Rapports détaillés
python evals/run_eval.py --no-ai --markdown evals/baseline.md --json /tmp/eval.json
```

Sortie : une ligne par document, une synthèse, puis le contrôle des seuils de
`evals/thresholds.json`. Code de sortie `1` si un seuil n'est pas respecté —
c'est ce que la CI utilise.

## Corpus

`evals/corpus/manifest.json` décrit les cas :

```json
{
  "id": "fournisseur_multi_taux",
  "document": "scripts/invoices/achibest_FV26-023806.pdf",
  "mime": "application/pdf",
  "expected": {
    "line_count": 2,
    "lines": [
      { "fact_num": "FV26-023806", "ice_frs": "000229475000050", "m_ht": 932.98, "taux": 0.1 },
      { "m_ht": 4380.68, "taux": 0.2 }
    ]
  }
}
```

- `document` est relatif au dossier `backend/` (les PDF de démonstration déjà
  versionnés ne sont pas dupliqués).
- `expected.lines` est une vérité terrain **partielle** : ne déclarer que les
  champs que l'on sait vérifier. La comparaison accepte ±0,50 MAD sur les
  montants, `lib_frss_contains` en sous-chaîne, ICE comparé chiffre à chiffre.
- `line_count` est optionnel ; quand il est présent, un nombre de lignes
  différent fait échouer le document.
- Chaque ligne attendue est appariée sans réutilisation : une même ligne
  extraite ne peut pas satisfaire deux attentes.

Ajouter des documents réels anonymisés est la prochaine étape (200–500 pièces :
scans, photos, multi-taux, avoirs, multi-factures, dossiers ZIP). Les gains de
précision ne se pilotent qu'avec ce corpus.

## Métriques

- `field_accuracy` : champs vérifiés corrects / champs vérifiés ;
- `line_recall` : lignes attendues retrouvées / lignes attendues ;
- `document_pass_rate` : documents sans ligne manquée et sans écart de
  `line_count` ;
- `missed_documents` : documents sans aucune ligne extraite alors qu'on en
  attendait ;
- `extra_lines` : lignes extraites non attendues (bruit) ;
- latence moyenne / p95, répartition des moteurs (`ai`, `text`, `tesseract`…).

## Baseline et non-régression

`evals/baseline.md` est le rapport de référence généré en mode `--no-ai` sur le
corpus de démonstration. La CI rejoue ce corpus à chaque push et publie le
rapport en artefact. Toute modification de l'extraction, du prompt ou de la
normalisation doit maintenir ou améliorer ces chiffres.

## Limites

- Le corpus de démonstration est petit (5 PDF natifs) : il protège contre les
  régressions connues, il ne mesure pas la précision sur les scans réels.
- Sans `OPENAI_API_KEY`, le mode `--no-ai` ne couvre pas les chemins IA ni
  l'OCR. Une évaluation IA (coût) est à lancer manuellement avant une mise en
  production de prompt ou de modèle.
- La fusion des lectures IA (`ai_fusion.py`) et les métadonnées de preuve
  (`ai_structured.py`) sont couvertes par des tests unitaires
  (`scripts/test_ai_fusion.py`, `scripts/test_ai_structured.py`) ; il faudra un
  corpus IA annoté pour les mesurer en précision réelle.
