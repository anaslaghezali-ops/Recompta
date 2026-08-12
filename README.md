# Recompta

Automatisation de la saisie des factures fournisseurs pour la déclaration TVA marocaine (fichier Excel DED TVA).

## Problème

Les cabinets comptables reçoivent de nombreuses factures fournisseurs scannées (PDF, images). Pour la déclaration TVA, ils doivent saisir manuellement chaque facture dans un fichier Excel structuré (ex. `Aichoum_DED_TVA_062026.xlsx`).

## Solution

Recompta permet de :

1. **Importer** des factures PDF ou images
2. **Extraire** automatiquement les informations clés (numéro, montants, ICE, dates…)
3. **Vérifier / corriger** les lignes dans une interface web
4. **Exporter** un fichier Excel au format DED TVA attendu

## Format Excel généré

Colonnes exportées (feuille `EDIMMYY` ou `EDIMMAAAA`) :

| Colonne | Description |
|---------|-------------|
| OR | Optionnel |
| FACT_NUM | Numéro de facture |
| DESIGNATION | MATIERES CONSOMMABLES, PRESTATIONS, TELEPHONIE, FRAIS BANCAIRE |
| M_HT | Montant HT |
| TVA | Montant TVA |
| M_TTC | Montant TTC |
| IF | Identifiant fiscal fournisseur |
| LIB_FRSS | Nom du fournisseur |
| ICE_FRS | ICE fournisseur (15 chiffres) |
| TAUX | 0.1 ou 0.2 |
| ID_PAIE | 1 ou 4 |
| DATE_PAIE | Date de paiement |
| DATE_FAC | Date de facture |
| CODE TVA | Code TVA (déduit automatiquement) |

### Correspondance CODE TVA

| Désignation | Taux | Code |
|-------------|------|------|
| MATIERES CONSOMMABLES | 20% | 146 |
| MATIERES CONSOMMABLES | 10% | 150 |
| PRESTATIONS | 20% | 140 |
| TELEPHONIE | 20% | 140 |
| FRAIS BANCAIRE | 10% | 142 |

## Tester avec des factures

### Factures PDF de démonstration (basées sur vos données réelles)

```bash
cd backend
python scripts/generate_sample_invoices.py   # génère 5 PDF dans scripts/invoices/
python scripts/test_extraction.py            # vérifie l'extraction (5/5)
python scripts/test_e2e_export.py            # export Excel complet (6 lignes)
```

### Vos propres factures scannées

1. Déposez vos PDF ou images dans `backend/invoices/upload/`
2. Lancez le test :

```bash
python scripts/test_upload_folder.py
```

3. Ou utilisez l'interface web : http://localhost:8000

**Images scannées (JPG/PNG)** : configurez `OPENAI_API_KEY` pour l'extraction par vision IA.
Les PDF avec texte sélectionnable fonctionnent sans clé API.


```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Ouvrir http://localhost:8000

## Vendre à des cabinets comptables (SaaS)

Guide complet : **[docs/SAAS.md](docs/SAAS.md)**

- Comptes cabinet avec **Supabase Auth**
- Multi-tenant : chaque cabinet voit uniquement ses clients
- Pages : `/login.html` → `/register.html` → `/dashboard.html` → import TVA

**Setup Supabase** (projet dédié `recompta`) :
1. Créer un projet sur https://supabase.com
2. SQL Editor → coller `supabase/migrations/001_recompta_saas.sql`
3. Copier URL + clés dans `backend/.env`

## Mettre en ligne (lien web pour le cabinet)

**GitHub Pages ne suffit pas** — il faut un hébergeur qui exécute Python.

Guide détaillé : **[DEPLOY.md](DEPLOY.md)**

En bref avec [Render](https://render.com) (gratuit) :
1. Connexion GitHub → repo Recompta → **Blueprint** (fichier `render.yaml` inclus)
2. Variable d'environnement `OPENAI_API_KEY` dans le dashboard Render
3. Vous obtenez un lien du type `https://recompta.onrender.com`

## Extraction automatique

| Type de document | Moteur | Précision |
|------------------|--------|-----------|
| PDF avec texte | Lecture directe | Excellente |
| PDF scanné / image | **IA (OpenAI Vision)** si clé configurée | **Meilleure** (~95% sur scans marocains) |
| PDF scanné / image | Tesseract (secours gratuit) | Moyenne (~60-70%) |

**Recommandation** : utilisez l'IA pour les factures scannées. Tesseract reste en secours si pas de clé API.

```bash
cd backend
cp .env.example .env
```

Ouvrez le fichier **`backend/.env`** et remplacez la clé :

```
OPENAI_API_KEY=sk-votre-vraie-clé-ici
```

Puis lancez le serveur **depuis le dossier `backend/`** :

```bash
pip install -r requirements.txt
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Sur la page web http://localhost:8000, vous devez voir le badge vert **« Extraction IA activée »**.

> Ne commitez jamais le fichier `.env` (il est déjà dans `.gitignore`).

## API

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/api/health` | GET | Santé du service |
| `/api/reference` | GET | Colonnes et codes TVA |
| `/api/extract` | POST | Extraction depuis fichiers |
| `/api/export` | POST | Génération Excel |

## Prochaines étapes possibles

- ~~Connexion à un OCR local (Tesseract) pour les scans sans OpenAI~~ ✓ fait (secours)
- Base fournisseurs (ICE → nom, IF) pour auto-complétion
- Import en lot depuis un dossier / email
- Validation métier (doublons, totaux période)
- Intégration logiciel comptable marocain
