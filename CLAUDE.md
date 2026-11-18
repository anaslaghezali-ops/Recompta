# Recompta — contexte pour Claude

SaaS pour cabinets comptables marocains : import des factures d'achat et du relevé bancaire d'un client,
extraction (texte PDF / OCR / IA vision), rapprochement bancaire, revue, export de la déclaration TVA
(relevé des déductions, format EDI DGI). Modules en plus : facturation des clients du cabinet, portail client
(le client dépose ses pièces), équipe, administration.

Le propriétaire (Anas) n'est pas développeur. Il écrit en français et veut des réponses directes et exactes,
sans affirmation non vérifiée. Expliquer en langage simple ce qu'il doit faire (commandes à copier, où cliquer).

## Règles impératives

1. **Branches** : travailler sur une branche `cursor/<sujet>` partie de `main2`, puis fusionner dans `main2`
   (`git merge --no-ff`) et pousser. **Ne jamais pousser sur `main`.** `main2` est la branche servie.
2. **Trois copies des fichiers front** : chaque fichier `.js` / `.html` / `.css` de la racine existe aussi dans
   `docs/` (GitHub Pages) et `backend/static/` (servi par FastAPI). Après toute modification à la racine,
   recopier à l'identique :
   `for f in <fichiers>; do cp $f docs/$f; cp $f backend/static/$f; done`
   (exception : `supabase-config.js` n'existe pas dans `backend/static/`).
3. **Cache navigateur** : les imports portent une version (`./bank-statement-client.js?v=bank5`). Quand un module
   change, incrémenter sa version **chez tous ses importeurs**, puis remonter la chaîne (le fichier importeur
   change aussi, donc sa propre version doit changer chez ses importeurs, jusqu'aux `.html`).
4. **Base de production Supabase** (`pbyoxfxngfutoiqjirkx`) : toute migration ou déploiement d'Edge Function
   demande l'accord explicite d'Anas à chaque fois. Tester d'abord en SQL dans une transaction annulée
   (`begin; … raise exception 'RESULTATS %' …`). Migrations dans `supabase/migrations/`.
5. **Secrets** : ne jamais lire, afficher ni demander les clés. Anas les saisit lui-même dans `backend/.env`
   (`SUPABASE_SERVICE_ROLE_KEY` = clé secrète `sb_secret_…`, `OPENAI_API_KEY`).
6. **Crédits IA** : chaque document lu par l'IA consomme un crédit (`cabinet_vision_credits.used_this_period`).
   Ne pas relancer d'extractions inutilement ; rendre les crédits consommés par une panne.

## Architecture

- **Front** : HTML + modules JS natifs (pas de build), Supabase JS côté navigateur, RLS pour l'isolement.
  Pages : `dossiers.html` (portefeuille), `workspace.html` (période d'un client : import, extraction, revue,
  rapprochement, export), `facturation.html` / `facture.html`, `equipe.html`, `admin.html`, `login.html`
  (commune cabinet et client), `portail.html` (client final).
- **Backend** `backend/` (FastAPI, Python) : extraction et file d'import.
  - `invoice_extractor.py` : texte PDF → OCR → IA vision (OpenAI). `_needs_ai_upgrade` bascule vers l'IA si la
    lecture texte est incohérente (HT nul avec TVA, TTC = TVA, HT+TVA≠TTC, ICE fournisseur manquant).
  - `import_job_worker.py` : traite `import_jobs` / `import_job_files` **un job à la fois** (verrou), écrit les
    lignes dans `dossier_workspaces.lines` (JSON), copie les originaux dans le bucket `dossier-documents`,
    puis supprime la copie temporaire du bucket `import-queue`.
  - `vat_intelligence.py`, `vat_multi_rate.py`, `normalize_results.py` : contrôles et normalisation génériques
    (aucune règle par fournisseur — voir `ARCHITECTURE.md`).
- **Supabase** : tables principales `cabinets`, `cabinet_members`, `cabinet_clients`, `client_dossiers`
  (une période TVA), `dossier_workspaces` (lignes + transactions bancaires en JSON), `dossier_documents`,
  `import_jobs`, `import_job_files`, `invoices*` / `billing_*` (facturation), `client_portal_access`,
  `document_requests`, `portal_uploads` (portail). Helpers RLS dans le schéma `private`.
  Edge Functions : `client-portal`, `cabinet-team`, `admin-manage-accounts`, `admin-create-cabinet`,
  `signup-cabinet`. Plan gratuit : 50 Mo par fichier, 1 Go de stockage.
- **Ventes des clients** (portail, onglet « Mes ventes ») : `invoices.issuer_client_id` vide = honoraires du
  cabinet, rempli = vente d'un client. `client_customers`, `client_billing_settings` (sans nom ni ICE : source
  `cabinet_clients`), vue `sales_invoices` (état de paiement calculé), RPC `sales_validate_invoice`,
  `sales_void_invoice`, `sales_set_last_number`. Pièces dans le bucket `sales-documents`, jamais dans
  `dossier_documents`. Front : `sales-client.js`, `portal-sales.js`.
- **Rapprochement bancaire** (`bank-statement-client.js`, `workspace-bank-match.js`) : automatique si montant
  exact (une facture ou une combinaison d'un même fournisseur) ; sinon propositions à valider : paiement
  partiel (facture scindée au prorata, TVA comprise), ou virement couvrant des factures + reste non justifié.

## Règles métier (Maroc)

- TVA déductible **à l'encaissement** : une facture entre dans la déclaration du mois où elle est payée
  (paiement partiel → déduction au prorata). Une facture impayée n'est pas déclarée.
- ICE = 15 chiffres. L'ICE du client lui-même doit être exclu des lignes fournisseur.
- Un IF ne différant que par un zéro de tête est le même IF.
- Taux courants 20 %, 14 %, 10 %, 7 % ; une facture peut avoir plusieurs taux (une ligne par taux).

## Lancer et tester

- Serveur : `cd backend && python -m uvicorn main:app --host 0.0.0.0 --port 8000`
  (sans `--reload` pendant les extractions). Il tourne aujourd'hui dans le Codespace d'Anas.
- Tests front : `node test-bank-reconcile.mjs`, `node test-bulk-field-update.mjs`, `node test-concurrent-lines.mjs`.
- Tests back : `cd backend && python scripts/test_*.py` (chaque script est autonome).
- Tests SQL (toutes les migrations rejouées sur un Postgres vierge + RLS, numérotation concurrente) :
  `PGURL=postgresql://… supabase/tests/run.sh` (job `sql` de la CI).
- Purge de la file d'import : `python backend/scripts/purge_import_queue.py` (liste) puis `--supprimer`.

## Mesure de précision

Comparer les lignes brutes d'un dossier (avant toute correction) au projet TVA du cabinet : appariement par
n° de facture + taux, puis fournisseur + TVA ; précision par champ, lignes absentes, lignes en trop ;
compter les documents lus par l'IA (`extraction_engine = 'ai'`) et l'écart de crédits.
Dernier résultat (sept. 2026, client Ferfer, 11 factures) : 9/9 factures présentes chez le cabinet exactes
après correctif ; détails dans le document de projet « mesure-precision ».

## Pistes ouvertes

1. Mesure sur un mois complet (Glovo, SRM multi-taux, Carrefour, frais bancaires non encore testés).
2. Regrouper les frais bancaires en une ligne mensuelle (le cabinet n'en déclare qu'une).
3. Associer un libellé bancaire à un fournisseur depuis la revue et le stocker en base
   (aujourd'hui en localStorage).
4. Rendre le crédit IA quand une extraction échoue ; compteur « x/y analysées » en direct ;
   erreur `get_cabinet_vision_credits` 405 (transaction en lecture seule).
5. Hébergement permanent du backend (Render/Railway) au lieu du Codespace.
