# Recompta

Plateforme de **production TVA** pour cabinets comptables au Maroc : portefeuille clients, extraction IA des factures, **rapprochement bancaire**, revue comptable et export Excel **DED TVA**.

**Application en ligne :** https://anaslaghezali-ops.github.io/Recompta/

---

## Ce que fait Recompta

Recompta couvre le flux complet d'une période TVA mensuelle, du dépôt des pièces à l'export pour la déclaration.

### Portefeuille et dossiers (mode cabinet)

- Connexion **cabinet** (Supabase Auth) — voir [docs/AUTH.md](docs/AUTH.md)
- **Portefeuille clients** : KPIs, priorités, retards TVA, accès au workspace par client
- **Dossier TVA** : une période **mois + année** par client (ex. juin 2026 → `062026`)
- **Workspace client** : cockpit de production (période active, pipeline, historique, documents)
- **Sauvegarde cloud** : lignes extraites, relevé bancaire, rapprochements, historique d'activité (Supabase)
- **Clôture de période** : marquer une période comme déclarée (consultation seule ensuite)

Voir [docs/DOSSIERS.md](docs/DOSSIERS.md) pour le schéma et les migrations Supabase.

### Import des pièces

| Flux | Page | Formats |
|------|------|---------|
| **Factures achats** | `import-achats.html?dossier=…` | ZIP, PDF, images (PNG, JPG, WebP, TIFF) |
| **Relevé bancaire** | `import-banque.html?dossier=…` | CSV, Excel, PDF, images |

- Développement **local des ZIP** (Google Drive, etc.) avant envoi
- File d'import **asynchrone** (worker serveur) pour les gros volumes
- Stockage des documents dans **Supabase Storage** (onglet Documents du workspace)
- Suppression **fichier par fichier** ou **dossier entier** (groupe de factures d'un même import)

### Extraction automatique des factures

- Lecture **PDF natif** (texte sélectionnable) — rapide, sans IA
- **OCR Tesseract** (secours gratuit) pour scans simples
- **IA Vision (OpenAI)** pour PDF scannés et images — recommandé en production
- Escalade automatique vers un modèle plus capable si les montants sont incohérents
- Extraction **multi-TVA** (plusieurs taux sur une même facture → plusieurs lignes)
- Détection **avoirs**, numéros alphanumériques, Net à payer = TTC, TVA 0 % légale
- Exclusion automatique de l'**ICE client** (acheteur) pour ne garder que l'ICE fournisseur
- Consolidation et normalisation des résultats (`normalize_results.py`)

Voir [ARCHITECTURE.md](ARCHITECTURE.md) pour les 3 couches (IA + parseurs génériques + validation mathématique).

### Revue comptable

- Tableau éditable ligne par ligne (montants, fournisseur, ICE, IF, désignation, taux…)
- **Confiance par champ** (ok / alerte / erreur) pour guider la correction
- Vue **anomalies** : lignes à traiter en priorité
- Détection des **doublons** (même fournisseur, n° facture, taux, TTC)
- **Aperçu document** : PDF/image de la facture à côté de la ligne (zoom, navigation pages)
- Propagation des corrections **nom fournisseur → IF/ICE** sur les autres lignes du même fournisseur
- Complétion ICE/IF manquants depuis le **carnet fournisseur** (autres factures du même tiers)

### Rapprochement bancaire

> Fonctionnalité centrale du workspace, absente de l'ancienne version du README.

1. **Import du relevé** (CSV, Excel ou PDF/image extrait côté serveur)
2. **Extraction du relevé** : mouvements bancaires (date, libellé, montant)
3. **Frais bancaires** : commissions, agios, tenue de compte… ajoutés automatiquement comme lignes `FRAIS BANCAIRE`
4. **Rapprochement assisté** : pour chaque paiement du relevé, propositions de factures dont le TTC correspond (y compris regroupements multi-factures et **avoirs**)
5. **Validation manuelle** : le comptable confirme ou choisit une autre proposition
6. **Date de paiement** (`DATE_PAIE`) renseignée sur les lignes rapprochées — elle ne vient pas de la facture seule
7. **Alias bancaire** : mémorisation d'un libellé relevé → fournisseur (ex. « MPro » sur le relevé = « Mode Food » sur les factures)

Accessible depuis le **cockpit workspace** : *Extraire le relevé* puis *Lancer le rapprochement*.

### Carnet fournisseurs

- Liste des fournisseurs du client avec ICE, IF, volume de factures
- Historique par année / mois
- Accès rapide aux factures d'un fournisseur depuis la revue

### Export DED TVA

- Génération d'un fichier Excel au format attendu pour la déclaration TVA marocaine
- Colonnes standardisées, feuille `EDIMMYY` ou `EDIMMAAAA`
- **Code TVA** déduit automatiquement (voir tableau ci-dessous)

---

## Deux modes d'utilisation

### Mode cabinet (production)

1. Connexion → **Portefeuille** (`dossiers.html`)
2. Client → **Workspace** (`workspace.html`)
3. Importer factures + relevé bancaire
4. Extraire → revoir → rapprocher → exporter
5. Clôturer la période après déclaration

Administration multi-cabinets : [docs/ADMIN.md](docs/ADMIN.md)

### Mode solo (tests rapides, sans compte)

- **`production.html`** : import, extraction, tableau, export Excel — champs vides par défaut
- Utile pour tester l'extraction IA sans Supabase
- Configurez l'URL du serveur Python (Render / Codespace) pour les scans

---

## Format Excel exporté (DED TVA)

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
| TAUX | 0, 0.1 ou 0.2 (0 % = exonéré) |
| ID_PAIE | 1 (comptant) ou 4 (virement) — défaut 4 |
| DATE_PAIE | Date de paiement (souvent via rapprochement bancaire) |
| DATE_FAC | Date de facture |
| CODE TVA | Code case DED (déduit automatiquement) |

### Correspondance CODE TVA

Codes utilisés pour la **déclaration TVA** (pas des comptes de classe 6) :

| Désignation | Taux | Code |
|-------------|------|------|
| MATIERES CONSOMMABLES | 20 % | 146 |
| MATIERES CONSOMMABLES | 10 % | 150 |
| PRESTATIONS | 20 % | 140 |
| TELEPHONIE | 20 % | 140 |
| FRAIS BANCAIRE | 10 % | 142 |

Les autres couples (ex. matières @ 0 %, prestations @ 10 %) n'ont pas de code automatique — à renseigner manuellement si votre DED l'exige.

---

## Démarrage rapide

### Frontend seul (GitHub Pages)

https://anaslaghezali-ops.github.io/Recompta/

Pour l'**IA sur les scans**, configurez l'URL de votre serveur backend dans l'outil TVA (voir [DEPLOY.md](DEPLOY.md)).

### Serveur Python (IA + OCR + relevé bancaire PDF)

```bash
cd backend
pip install -r requirements.txt
sudo apt-get install -y tesseract-ocr tesseract-ocr-fra tesseract-ocr-eng   # OCR scans
cp .env.example .env
# Éditez .env : OPENAI_API_KEY=sk-... (recommandé pour les scans)
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Ouvrir http://localhost:8000 — badge vert **« Extraction IA activée »** si la clé est valide.

Variables utiles :

```env
OPENAI_API_KEY=sk-...
OPENAI_VISION_MODEL=gpt-5.4-mini
OPENAI_VISION_MODEL_FALLBACK=gpt-5.6-terra
SUPABASE_SERVICE_ROLE_KEY=...          # worker d'import asynchrone
IMPORT_WORKER_ENABLED=1
```

> Ne commitez jamais `.env` (déjà dans `.gitignore`).

---

## Moteurs d'extraction

| Type de document | Moteur | Précision |
|------------------|--------|-----------|
| PDF avec texte | Lecture directe | Excellente |
| PDF scanné / image | **IA (OpenAI Vision)** si clé configurée | Meilleure (~95 % sur scans marocains) |
| PDF scanné / image | Tesseract (secours) | Moyenne (~60–70 %) |
| Relevé bancaire PDF/image | Serveur (`/api/import-bank-statement`) | Variable selon la banque |

---

## API backend

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/api/health` | GET | Santé, moteur IA, worker d'import |
| `/api/reference` | GET | Colonnes, désignations, taux, codes TVA |
| `/api/extract` | POST | Extraction factures (multipart) |
| `/api/import-bank-statement` | POST | Extraction relevé bancaire |
| `/api/dossiers/{id}/analyze` | POST | Lance l'analyse IA d'un dossier |
| `/api/import-jobs/{job_id}/upload` | POST | Upload fichiers pour job d'import |
| `/api/import-jobs/process` | POST | Traite la file d'import (worker) |
| `/api/export` | POST | Génération Excel DED TVA |
| `/api/preview-filename` | POST | Nom de fichier export suggéré |

---

## Tests locaux

```bash
cd backend
python scripts/generate_sample_invoices.py   # PDF de démo dans scripts/invoices/
python scripts/test_extraction.py            # extraction sur les échantillons
python scripts/test_e2e_export.py            # export Excel complet
python scripts/test_net_payer_zero_vat.py    # Probun, Net à payer, IF, TVA 0 %
```

Déposez vos propres scans dans `backend/invoices/upload/` puis :

```bash
python scripts/test_upload_folder.py
```

---

## Documentation complémentaire

| Fichier | Sujet |
|---------|--------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Extraction générique, validation mathématique, modèles IA |
| [DEPLOY.md](DEPLOY.md) | Render, GitHub Pages, configuration production |
| [docs/AUTH.md](docs/AUTH.md) | Authentification super-admin et cabinet |
| [docs/ADMIN.md](docs/ADMIN.md) | Création de cabinets (Edge Function Supabase) |
| [docs/DOSSIERS.md](docs/DOSSIERS.md) | Clients, dossiers, persistance workspace |
| [CODESPACE.md](CODESPACE.md) | Environnement de développement cloud |

---

## Pistes d'évolution

- Imputation **comptes de charge (classe 6 CGNC)** par fournisseur / nature
- Intégration directe avec un logiciel comptable marocain
- Enrichissement du carnet fournisseur (compte par défaut, règles métier)
- Rapports de contrôle période (totaux TVA, écarts relevé / factures)
