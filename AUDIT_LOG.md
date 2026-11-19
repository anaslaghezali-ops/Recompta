# Journal d'audit et de modifications — Recompta

## Règles impératives du projet

- Branche de travail : `main2-chatgpt` (créée depuis `main2`).
- Ne jamais modifier `main2`.
- Ne jamais modifier `main3-chatgpt` pour ce chantier.
- Préserver `production.html` et l'interface active ; ne toucher à aucun fichier applicatif sans analyse, tests et justification.
- Toute modification GitHub (branche, fichier, commit, workflow, etc.) et toute modification Supabase (SQL, migration, configuration, Edge Function, Storage, Auth, etc.) doit être consignée ici avec date, portée, preuve, validation et impact.
- Aucun changement Supabase n'est autorisé sans accord explicite préalable. Les audits en lecture seule sont autorisés.
- Les corrections de code sont limitées à `main2-chatgpt`, en commits atomiques. Ne jamais déployer automatiquement.
- Ne jamais inscrire de secret, jeton, clé API, donnée personnelle ou contenu métier sensible dans ce journal.

## Références

- Dépôt : `anaslaghezali-ops/Recompta`
- Branche source protégée par consigne utilisateur : `main2`
- Branche de travail : `main2-chatgpt`
- Commit source vérifié : `ade6b47c256db8c2b9ac2377ec19996d2edad96a`
- Arbre source vérifié : `37c7c63c1d523de26c60516037d71889051fc0e6`
- Supabase confirmé par l'utilisateur : projet `chicknster@gmail.com's Project`
- Référence Supabase : `pbyoxfxngfutoiqjirkx` (région eu-west-3, PostgreSQL 17.6.1.155)
- Le projet Supabase `Recompta` (référence `hsojfhtabmfczhpiwuxs`) est distinct et n'est pas la base retenue pour cet audit.

## Historique des modifications

### 2026-11-18 — Création de la branche de travail

- Type : modification GitHub (création de branche uniquement).
- Action : création de `main2-chatgpt` à partir de la référence `main2`.
- Vérification : HEAD de `main2-chatgpt` = `ade6b47c256db8c2b9ac2377ec19996d2edad96a`, identique au HEAD de `main2` au moment de la création.
- Fichiers applicatifs modifiés : aucun.
- Supabase modifié : non.
- Tests : sans objet (aucun code modifié).

### 2026-11-18 — Audit initial en lecture seule de Supabase et du dépôt

- Type : audit / lectures uniquement ; aucune modification Supabase ou applicative.
- Projet Supabase : `pbyoxfxngfutoiqjirkx`.
- Inventaire : 28 tables dans `public`, RLS activé sur les 28 ; 10 migrations enregistrées ; 5 Edge Functions listées comme actives.
- Tables d'import : `import_jobs` contient 953 lignes ; `import_job_files` comporte des états `done`, `processing` et `uploaded`.
- Agrégats observés pour `import_jobs` : 696 jobs `failed`, 257 `completed` (selon l'agrégation par statut et type, 953 au total). Les chiffres ne suffisent pas à conclure à une panne : il faut examiner les causes et l'ancienneté des jobs avant toute action.
- Buckets `import-queue` et `dossier-documents` : privés, limite observée 200 MiB chacun.
- Migrations : les 10 versions retournées par Supabase sont consignées comme inventaire, mais leur correspondance exacte avec tous les fichiers locaux doit être contrôlée avant une migration.
- Aucun contenu de document, facture, client ou secret n'a été copié dans ce journal.

## Constats techniques — preuves à vérifier lors des corrections

### C-01 — Authentification des routes backend à confirmer en priorité

- Fichier : `backend/main.py`.
- Routes concernées : `POST /api/extract`, `POST /api/import-bank-statement`, `POST /api/import-jobs/{job_id}/upload`, `POST /api/dossiers/{dossier_id}/analyze`, `POST /api/import-jobs/process`.
- Constat de lecture : les handlers examinés ne déclarent pas de dépendance d'authentification ni de vérification de session/utilisateur dans le code de ces routes.
- Risque : si le service est joignable directement sans authentification/contrôle d'accès au niveau du proxy ou de la plateforme, un appelant pourrait déclencher des traitements ou téléverser des données en utilisant les accès privilégiés du backend.
- Gravité potentielle : critique/haute selon l'exposition réelle.
- Limite : l'exposition réseau, les règles du reverse proxy et les éventuels contrôles externes n'ont pas été vérifiés. Ne pas affirmer que l'API est publiquement exploitable avant cette vérification.
- Correction proposée : authentifier chaque route et vérifier côté serveur l'appartenance de l'utilisateur au dossier/job ; ne pas se fier à un identifiant fourni par le client. Vérifier également les protections réseau en défense en profondeur.
- État : à corriger après confirmation du mode de déploiement et ajout de tests négatifs.

### C-02 — Upload par ID de job avec Service Role sans contrôle d'appartenance visible

- Fichiers : `backend/main.py`, `backend/import_job_queue.py`, `backend/supabase_service.py`.
- Constat : `complete_job_upload(job_id, ...)` lit le job par son ID avec les en-têtes Service Role, puis dépose le fichier et modifie le job. La fonction ne reçoit ni identité appelante ni dossier attendu et ne vérifie pas elle-même l'autorisation sur le dossier.
- Risque : combiné à l'absence de contrôle d'identité visible sur la route HTTP, un ID de job deviné/obtenu pourrait permettre un accès inter-dossier.
- Limite : dépend de l'exposition réelle de l'API et des protections externes.
- Correction proposée : transmettre un contexte utilisateur authentifié, vérifier l'accès au dossier avant toute opération Service Role, puis borner l'ID de job au dossier autorisé.
- État : confirmé au niveau du code local examiné ; exploitabilité externe à confirmer.

### C-03 — Décompression ZIP sans bornes applicatives visibles

- Fichier : `backend/zip_utils.py`.
- Constat : `_extract_zip` parcourt `infolist()`, lit chaque membre admissible entièrement avec `archive.read(info)` et accumule tous les octets en mémoire. Aucun plafond applicatif visible sur le nombre de fichiers, la taille totale décompressée, la taille d'un membre ou le ratio de compression.
- Risque : archive volumineuse ou ZIP bomb pouvant provoquer une forte consommation mémoire/CPU et interrompre le worker.
- Contexte : le bucket autorise jusqu'à 200 MiB par objet ; cette limite concerne le fichier compressé et ne borne pas le volume décompressé.
- Correction proposée : plafonds explicites (fichier compressé, membres, taille par membre, taille totale décompressée, ratio), validation des chemins et traitement en flux/temporaires avec nettoyage garanti.
- Tests existants : `backend/scripts/test_zip_paths.py`, `backend/scripts/test_zip_reupload.py` couvrent des chemins/fonctions métier mais pas les bombes ZIP ou les limites de ressources.
- État : confirmé dans l'implémentation examinée.

### C-04 — Déplacement d'une ligne entre factures : garde et recalcul incomplets

- Migration : `supabase/migrations/20261117200000_billing.sql`.
- Fonctions : `private.billing_lines_guard()` et `private.billing_lines_after()`.
- Constat : sur UPDATE, la garde calcule `target := coalesce(new.invoice_id, old.invoice_id)` et vérifie le statut de cette seule facture cible. Si une ligne appartient à une facture émise A et est déplacée vers une facture brouillon B, le contrôle peut ne regarder que B et ne pas bloquer le retrait de la ligne de A.
- Constat complémentaire : le trigger AFTER UPDATE appelle `billing_recompute(coalesce(new.invoice_id, old.invoice_id))`, donc ne recalcule que la facture cible B ; les totaux de A peuvent rester incohérents.
- Risque : contournement potentiel de l'immuabilité des lignes émises et incohérence des totaux.
- Correction proposée : sur UPDATE, vérifier séparément OLD.invoice_id et NEW.invoice_id ; interdire tout déplacement depuis une facture non brouillon (sauf opération interne autorisée) ; recalculer les deux factures brouillon dans une logique sûre. Ajouter un test SQL de régression couvrant le déplacement d'une ligne d'une facture émise et le recalcul des deux brouillons.
- État : défaut logique confirmé par lecture de la fonction et du trigger ; test de régression non encore exécuté.

### C-05 — Alerte sur fonction de partage public

- Fonction : `public.sales_public_document(text)`.
- Supabase Advisor signale une fonction `SECURITY DEFINER` exécutable par `anon`.
- Lecture du corps : recherche un document émis/non brouillon via un jeton de partage d'au moins 40 caractères et ne retourne qu'un objet JSON composé de champs de document et de lignes.
- Interprétation : l'accès public semble intentionnel pour les liens de partage ; l'alerte n'est pas en soi une preuve de vulnérabilité.
- À vérifier : entropie/génération des jetons, limitation de débit, révocation, champs exposés et comportement après annulation.
- État : revue complémentaire nécessaire ; ne pas révoquer l'accès public sans analyse fonctionnelle.

### C-06 — Fonctions SECURITY DEFINER accessibles aux utilisateurs authentifiés

- Supabase Advisor signale 22 fonctions publiques `SECURITY DEFINER` exécutables par `authenticated`.
- Plusieurs fonctions inspectées ont des gardes internes explicites (ex. contrôle super-admin, propriétaire du document ou utilisateur du portail) et un `search_path` vide.
- L'alerte est un signal de revue, pas une preuve automatique de défaut.
- Action : auditer chaque corps et ses helpers ; conserver uniquement les droits nécessaires ; ajouter des tests d'accès croisé entre cabinets/clients.
- État : revue partielle ; non corrigé.

### C-07 — Protection des mots de passe compromis désactivée

- Supabase Auth Advisor signale que la protection contre les mots de passe divulgués est désactivée.
- Action proposée : activer ce contrôle dans Auth après vérification de l'impact sur les parcours d'inscription et de changement de mot de passe.
- État : constat Advisor ; aucune configuration modifiée.

### C-08 — Optimisation SQL / index

- Advisor performance signale des clés étrangères sans index couvrant, des politiques permissives qui se chevauchent et 14 index inutilisés.
- Advisor signale également `public.billing_counters` sans clé primaire.
- Vérification complémentaire : `billing_counters` possède un index unique fonctionnel `billing_counters_series_uidx` sur `(cabinet_id, coalesce(issuer_client_id, 0), kind, year)`. L'alerte « sans clé primaire » est donc à distinguer de l'absence de contrainte unique.
- Ne pas supprimer les index inutilisés sans fenêtre d'observation suffisante et vérification des requêtes/contraintes.
- État : optimisations à planifier, aucune modification.

### C-09 — Volumétrie des imports en échec

- Lecture agrégée : 696 jobs `failed` et 257 `completed` dans `import_jobs` au moment de l'audit.
- 649 fichiers sont en statut `uploaded` et 36 en statut `processing` dans `import_job_files` au moment de la requête.
- Ces chiffres justifient une analyse des causes, de l'âge des jobs et de leur correspondance avec les fichiers, mais ne justifient aucune suppression ou relance en masse.
- Action : diagnostiquer par groupes de messages d'erreur et ancienneté, sans afficher de données personnelles ; aucune purge automatique.

### C-10 — Triggers de facturation et tests

- Les triggers présents couvrent INSERT/UPDATE/DELETE pour la garde des lignes, INSERT/UPDATE pour le recalcul, INSERT/UPDATE/DELETE pour la garde facture, et INSERT/UPDATE pour la garde paiement.
- Les tests SQL existants couvrent les totaux multi-taux, le verrouillage d'une ligne après émission et les workflows facture/devis/avoir.
- Le scénario de déplacement d'une ligne entre deux factures n'a pas été trouvé dans les tests examinés.
- Action : ajouter les tests ciblés de C-04 avant de modifier la migration.

## Vérifications et limites

- Audits Supabase réalisés via requêtes SELECT et outils de diagnostic ; aucune instruction SQL d'écriture exécutée.
- Lecture des fichiers GitHub réalisée sur `main2-chatgpt`.
- Aucun test applicatif/SQL n'a été exécuté dans un environnement de test lors de cet audit.
- Aucune migration, policy, fonction, trigger, bucket, Edge Function, paramètre Auth ou donnée Supabase n'a été modifié.
- Aucune modification de fichier applicatif n'a été faite dans le commit initial de ce journal.
- Les résultats Advisor sont des alertes automatiques ; ils doivent être interprétés avec le code et le modèle d'autorisation.

## Protocole obligatoire pour toute correction ultérieure

Chaque changement doit avoir une section datée contenant :
1. SHA du commit et branche (`main2-chatgpt` uniquement) ;
2. fichiers GitHub ou objets Supabase modifiés ;
3. preuve du défaut et portée exacte ;
4. solution et justification ;
5. tests exécutés, commandes et résultats ;
6. tests non exécutés et limites ;
7. impact fonctionnel, sécurité, données, compatibilité et retour arrière ;
8. état de validation par rapport à `main2`.

Pour Supabase : préparer une migration versionnée, la relire, obtenir l'accord explicite de l'utilisateur, l'appliquer uniquement après validation, puis vérifier le résultat et consigner le SHA/fichier de migration et les tests. Ne jamais modifier la base de production pendant une phase d'audit.


## 2026-11-18 — Lot de corrections préparé sur main2-chatgpt

### GitHub — modifications de code

- Branche : `main2-chatgpt` uniquement.
- Commits de travail : `b4a0af9`, `5a48534`, `7e09fbc`, `78ceb87`, `a4ec5e4`, `174503d`, `d4994ea`, `efcbab7`, `1f06b41`, `fbfc971`, `9006768`.
- Fichiers modifiés :
  - `backend/zip_utils.py` : limites de taille archive/document, nombre d'entrées, volume décompressé, ratio de compression, rejet des chemins traversants, liens symboliques et archives chiffrées.
  - `backend/main.py` : lecture des uploads par blocs avec plafond ; contrôle d'identité pour upload de job, analyse de dossier et déclenchement du worker.
  - `backend/request_auth.py` : validation du JWT par l'endpoint Auth Supabase et vérification d'accès par requêtes PostgREST soumises aux RLS.
  - `backend/import_job_queue.py` : contrôle de cohérence du dossier entre la lecture RLS du job et l'opération privilégiée Service Role.
  - `docs/api-client.js` : envoi du JWT utilisateur et de la clé publique Supabase sur les routes protégées ; messages distincts pour session expirée et droits insuffisants.
  - `backend/scripts/test_zip_security.py` : tests de traversée de chemin, chemins absolus/Windows, ratio ZIP, taille individuelle et archive normale.
  - `supabase/tests/test_sales_phase2.sql` : tests de déplacement interdit depuis une facture émise et de recalcul des deux brouillons lors d'un déplacement.
- Compatibilité : les routes historiques `/api/extract` et `/api/import-bank-statement` restent accessibles sans session à ce stade afin de ne pas casser les anciens parcours ; leurs uploads sont désormais bornés. Leur protection contre l'abus doit être traitée séparément.
- Aucun déploiement du backend effectué.
- Tests : fichiers de test ajoutés ; exécution CI complète et tests en environnement isolé encore en attente. Aucun test de facturation n'a été exécuté sur les données réelles.

### Supabase — migration préparée, application en attente

- Fichier ajouté : `supabase/migrations/20261118221000_fix_billing_line_reassignment.sql`.
- Objet : vérifier les factures OLD et NEW dans le trigger de garde et recalculer les deux factures brouillon après déplacement d'une ligne ; le trigger de recalcul couvre également DELETE.
- Migration préparée à partir de la définition réelle des triggers de `public.invoice_lines` observée sur le projet connecté.
- État au moment de cette entrée : **fichier GitHub préparé ; migration non appliquée à Supabase**.
- Aucun autre objet Supabase (table, donnée, policy, bucket, Auth, Edge Function) modifié.
- Application et vérification post-migration à consigner dans une entrée séparée après exécution.

### Limites et déploiement

- Les modifications de sécurité des routes nécessitent le redéploiement du backend et la mise à jour du frontend depuis `main2-chatgpt` pour prendre effet.
- Le backend doit continuer à pointer vers le projet Supabase attendu ; la clé publique transmise par le navigateur est uniquement utilisée comme clé de projet, tandis que le JWT utilisateur porte l'identité et déclenche l'application des RLS.
- Ne pas déployer ce lot avant validation des tests et vérification de la configuration réelle du service backend.


### 2026-11-18 — Application et vérification de la migration Supabase

- Projet : `pbyoxfxngfutoiqjirkx` (`chicknster@gmail.com's Project`).
- Migration appliquée via Supabase : `fix_billing_line_reassignment`.
- Version effectivement enregistrée par Supabase : `20261118235947`.
- Fichier GitHub aligné sur cette version : `supabase/migrations/20261118235947_fix_billing_line_reassignment.sql`.
- Vérification SQL après application :
  - `private.billing_lines_guard()` vérifie le statut de la facture source OLD et de la destination NEW pour UPDATE.
  - `invoice_lines_totals` est bien un trigger AFTER INSERT OR UPDATE OR DELETE.
  - `private.billing_lines_after()` recalcule la facture d'origine lors d'un déplacement, puis la facture de destination.
  - La migration apparaît dans `supabase_migrations.schema_migrations` avec la version ci-dessus.
- Données métier : aucune ligne de facture, facture, client ou document n'a été modifiée par cette migration ; seules les définitions de fonctions/triggers et l'historique de migration ont changé.
- Tests SQL métier : le test de régression est ajouté dans `supabase/tests/test_sales_phase2.sql`, mais n'a pas encore été exécuté sur une base de test isolée. Aucun test destructif n'a été exécuté sur la base de production.
- Supabase Advisors après migration :
  - Les alertes de sécurité restantes incluent 1 fonction publique `SECURITY DEFINER` destinée au partage public, 22 fonctions `SECURITY DEFINER` accessibles à `authenticated`, et la protection des mots de passe compromis désactivée.
  - Les alertes de performance restantes incluent 20 clés étrangères sans index couvrant, 14 index inutilisés, 23 cas de politiques permissives qui se chevauchent et l'absence de clé primaire sur `billing_counters` (un index unique fonctionnel est toutefois présent).
  - Ces alertes ne sont pas automatiquement des vulnérabilités ; elles nécessitent une revue dédiée. Aucun de ces points n'a été modifié dans cette migration.

### 2026-11-18 — Vérification des tests et limites du lot

- Le scénario ZIP de sécurité a été exécuté dans un environnement Python isolé sur une copie du code : chemins traversants/absolus/Windows refusés, ratio ZIP anormal refusé, fichier trop volumineux refusé et ZIP normal accepté.
- La suite complète `.github/workflows/tests.yml` n'a pas été déclenchée : le workflow est configuré sur pull request ou push vers `main`, pas sur un push de branche de travail.
- Aucun déploiement frontend/backend n'a été effectué.
- Les corrections d'authentification API ne prennent effet qu'après déploiement coordonné de `backend/` et `docs/` depuis `main2-chatgpt`.
- La migration Supabase est appliquée ; les corrections du backend et du frontend restent uniquement sur la branche de travail.
