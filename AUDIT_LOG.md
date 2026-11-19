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


### 2026-11-18 — Tests isolés supplémentaires

- Fichier ajouté : `backend/scripts/test_request_auth.py`.
- Couverture : absence de Bearer refusée, vérification du JWT via Auth, transmission de la clé publique, vérification RLS du dossier, refus d'un dossier non visible, lecture RLS du job d'import.
- Exécution isolée de ces scénarios avec réponses HTTP simulées : `OK test_request_auth`.
- Compilation Python des modules de test et du helper d'authentification : réussie dans l'environnement isolé.
- Le workflow complet GitHub Actions reste à exécuter ; aucune validation CI globale n'est revendiquée.
- Commit du test : `fd9a4d9`.


### 2026-11-18 — Traçabilité GitHub finale du lot

- Commits GitHub complémentaires consignés :
  - `b29ec53` : extraction ZIP en flux borné ;
  - `3cee28b` : correction du chemin d'import du test ZIP pour CI ;
  - `176d459` : correction du passage de la clé publique dans la lecture RLS des jobs ;
  - `42152b3` : plafond global de 20 fichiers et 100 Mio par requête d'extraction ;
  - `ecea29b` et `1cd5c0f` : alignement du nom de migration sur la version réellement créée par Supabase, puis suppression du nom provisoire ;
  - `fd9a4d9` : ajout des tests du helper d'authentification ;
  - `8659cf3`, `1048b7b` et `4af38f8` : mises à jour successives du présent journal.
- HEAD vérifié de `main2-chatgpt` : `4af38f80e05d8b51907bbb0fd5867cf01358fa95`.
- Comparaison finale avec `main2` : 22 commits en avance, 0 en retard ; base commune toujours `ade6b47c256db8c2b9ac2377ec19996d2edad96a`.
- Fichiers applicatifs et tests présents dans le diff : `backend/import_job_queue.py`, `backend/main.py`, `backend/request_auth.py`, `backend/scripts/test_request_auth.py`, `backend/scripts/test_zip_security.py`, `backend/zip_utils.py`, `docs/api-client.js`, `supabase/migrations/20261118235947_fix_billing_line_reassignment.sql`, `supabase/tests/test_sales_phase2.sql`, ainsi que ce journal.
- `main2` n'a pas été modifiée ni fusionnée. Aucun déploiement n'a été déclenché.


### 2026-11-19 — Création de la Pull Request brouillon #169

- Type : création d'une Pull Request GitHub en brouillon, sans fusion.
- URL : https://github.com/anaslaghezali-ops/Recompta/pull/169
- Titre : `[DRAFT] Revue sécurisation imports et facturation`.
- Branche source : `main2-chatgpt`.
- Branche cible : `main2`.
- HEAD source au moment de la création : `dba933f0b6cfc7de2058eb13286d46e344e4be83`.
- Base de la PR : `ade6b47c256db8c2b9ac2377ec19996d2edad96a`.
- État confirmé par GitHub après création : ouverte, `draft=true`, `merged=false`; 23 commits, 10 fichiers modifiés.
- Paramètre : `maintainer_can_modify=false`.
- Finalité : demander la revue et déclencher les vérifications configurées pour les Pull Requests.
- Aucun commit ni changement de fichier n'a été effectué sur `main2`. Aucun merge et aucun déploiement n'ont été réalisés.
- Mise à jour du présent journal effectuée uniquement sur `main2-chatgpt`.
- Vérifications à suivre : résultats des checks GitHub Actions, revue du diff et tests SQL sur base isolée avant toute décision ultérieure.


### 2026-11-19 — Lot 1 de sécurisation API et frontend

- Branche modifiée : `main2-chatgpt` uniquement.
- Commits du lot :
  - `af0173b74e32de5743f40394e861f71a7173b566` — garde d'authentification sur les deux routes historiques, restriction super-admin du déclenchement global, réduction des détails de santé et erreurs serveur génériques.
  - `7b7f3669c2ce12fc407ef8b489e32f87260edb5c` — envoi des credentials sur les deux routes historiques et ajout de `apikey` à l'upload XHR.
  - `d1f4804d3930d4b21c5debc713dcbace7f5e62c2` — suppression du déclenchement manuel du worker depuis le navigateur ; le worker de fond et le déclenchement après upload restent les mécanismes normaux.
  - `0f8e8afc2446ea824b03ebc9ec7533db3d2ede8e` — alignement de `api-client.js` à la racine sur `docs/api-client.js` pour satisfaire le contrôle CI des copies.
  - `2136dd308439d7bb5bc3d3ef5348444c1c3df619` — tests du contrôle de rôle super-admin.
- Fichiers modifiés :
  - `backend/main.py` : authentification obligatoire sur `POST /api/extract` et `POST /api/import-bank-statement` ; `POST /api/import-jobs/process` réservé au rôle `super_admin` car il traite une file globale avec Service Role ; retrait des détails d'exécution/mémoire du endpoint health ; réponse d'erreur 500 générique et journalisation serveur.
  - `docs/api-client.js` : envoi de `Authorization` et `apikey` aux routes historiques ; transmission des deux en-têtes pour l'upload XHR ; le navigateur ne déclenche plus le worker global.
  - `api-client.js` : copie alignée avec la version sécurisée de `docs/api-client.js`.
  - `backend/scripts/test_admin_saas_auth.py` : vérifie qu'un super-admin est autorisé et qu'un membre ordinaire reçoit 403.
- Justification : fermer les routes historiques anonymes, corriger l'en-tête `apikey` manquant sur l'upload XHR et éviter qu'un membre déclenche un lot global avec Service Role.
- Compatibilité : le worker de fond est lancé au démarrage du backend et les uploads de jobs déclenchent déjà le traitement ; le client ne lance donc plus de kick global. Les routes historiques exigent désormais une session Supabase. Leur ancien contrat ne fournit pas de dossier ; le contrôle d'appartenance à un dossier précis n'est donc pas établi par ces routes. Cette limite doit être traitée si ces parcours legacy restent utilisés pour des traitements liés à un dossier.
- Tests ajoutés : `backend/scripts/test_admin_saas_auth.py`. Les tests existants `test_request_auth.py` couvrent la validation de session et les contrôles RLS.
- Tests non encore exécutés après ces modifications : exécution locale des scripts Python, tests JS, comparaison des copies et workflow GitHub Actions complet. Le CI doit être contrôlé sur la PR #169.
- Supabase : aucun objet, paramètre Auth, policy, fonction, bucket ou donnée modifié.
- Déploiement : aucun.
- PR #169 : reste en brouillon, non fusionnée ; sa branche source suit les nouveaux commits.
- `main2` et `main3-chatgpt` : non modifiées. Aucun merge effectué.
- Limites restantes : CORS autorise encore toutes les origines ; les routes legacy authentifient l'utilisateur mais ne lient pas encore la requête à un dossier via RLS ; l'audit des permissions de tous les endpoints admin et des fonctions SECURITY DEFINER reste à poursuivre.


### 2026-11-19 — Ajustement du test et première exécution CI du lot 1

- Commit complémentaire : `4df73efb2fdd94823869f57b101473710c069d87`.
- Fichier : `backend/scripts/test_admin_saas_auth.py`.
- Première exécution CI du lot : run `44427016037` (commit `f2c32d7ed93ee5862b01692dc2a3462bed179cdb`).
  - Job SQL : succès.
  - Job Python : échec dès le nouveau script de test, car le chemin du dossier `backend` n'était pas ajouté à `sys.path` lors de l'exécution directe par le workflow.
  - Cause identifiée dans les logs : `ModuleNotFoundError: No module named 'admin_saas'`.
- Correction : ajout du dossier backend à `sys.path`, selon le même modèle que le test existant `test_request_auth.py`.
- Validation après correction : commit poussé sur la branche source de la PR #169 ; nouvelle exécution CI à vérifier. Aucun autre changement de code dans ce correctif.
- Aucun déploiement ni changement Supabase.


### 2026-11-19 — Alignement de la copie backend/static et nouvelle CI

- Diagnostic du run CI `44427112120` : les tests Python et JavaScript ainsi que les tests SQL réussissent ; le contrôle de cohérence échoue sur `api-client.js`.
- Comparaison des trois copies sur le commit de merge de la PR : `docs/api-client.js` et `api-client.js` à la racine contiennent la version sécurisée, tandis que `backend/static/api-client.js` conservait l'ancienne version sans les en-têtes d'authentification et avec l'ancien déclenchement manuel du worker.
- Correction ciblée : alignement de `backend/static/api-client.js` sur `docs/api-client.js`, sans modification de `production.html` ni des données métier.
- Branche modifiée : `main2-chatgpt` uniquement. Aucun changement sur `main2` ou `main3-chatgpt`.
- Aucune modification Supabase et aucun déploiement.
- CI à relancer et à vérifier avant de considérer le lot 1 validé.


### 2026-11-19 — Budgets ZIP cumulés et extraction API par petits lots

- Branche de travail : `main2-chatgpt` uniquement.
- Ajout d'un budget partagé par requête/job : 100 Mio maximum de données décompressées et 1 000 documents maximum, en complément des limites individuelles et par archive existantes.
- Ajout d'un itérateur ZIP en deux passes : prévalidation de tous les membres utiles et de leurs CRC sans conserver les contenus décompressés, puis émission d'un document à la fois.
- La route `POST /api/extract` partage le budget entre les uploads et traite au maximum deux documents simultanément ; les octets d'un lot sont libérés avant le suivant.
- Tests ajoutés : cumul décompressé multi-archives, plafond documentaire multi-archives et absence de consommation du budget lorsqu'une archive est rejetée.
- Validation : à exécuter par GitHub Actions après le commit ; aucun résultat de test n'est présumé à ce stade.
- Aucun changement Supabase, aucune fusion, aucun déploiement. `main2`, `main3-chatgpt` et `production.html` non modifiés.


### 2026-11-19 — Worker d'import progressif par lots

- Le worker partage désormais un budget cumulatif par job : 100 Mio décompressés et 1 000 documents maximum pour l'ensemble de ses fichiers.
- Les archives sont prévalidées puis consommées document par document ; le worker n'accumule plus les contenus binaires de tous les fichiers du job dans `work_items`.
- Les documents sont extraits par lots de deux. La liste conservée pour la fusion, les statuts et l'audit ne contient que les métadonnées et identifiants de source.
- Le contexte de crédits IA et les exclusions ICE sont libérés dans un bloc `finally`, y compris en cas d'échec du traitement.
- Tests : vérification de l'itérateur progressif et test worker de bout en bout sur la taille de lot configurée. GitHub Actions run `44434178914`, commit `417dd4b1898d99111fde2922d1326d3d3053d3c4` : jobs `tests` et `sql` terminés avec succès ; `test_worker_zip_batches` et `test_zip_security` confirmés verts.
- Aucun changement Supabase, aucune fusion et aucun déploiement.


### 2026-11-19 — Réduction des privilèges SQL excessifs sur les tables publiques

- Projet Supabase : `pbyoxfxngfutoiqjirkx` (PostgreSQL 17).
- Migration appliquée et enregistrée : `20261119011756_revoke_excess_public_table_privileges`.
- Fichier versionné sur `main2-chatgpt` : `supabase/migrations/20261119011756_revoke_excess_public_table_privileges.sql`.
- Tables ciblées : `user_roles`, `cabinet_members`, `cabinet_vision_credits`, `platform_settings`, `invoices`, `invoice_lines`, `invoice_payments`.
- Correction : révocation de `TRUNCATE`, `REFERENCES`, `TRIGGER` et `MAINTAIN` pour `anon` et `authenticated`. Les droits CRUD (`SELECT/INSERT/UPDATE/DELETE`) n'ont pas été modifiés ; les politiques RLS existantes n'ont pas été modifiées.
- Vérification post-migration : `has_table_privilege` retourne `false` pour les quatre privilèges révoqués sur les 7 tables et les deux rôles ; les quatre droits CRUD restent `true`. La version `20261119011756` apparaît dans `supabase_migrations.schema_migrations`.
- Limite : la tentative de corriger les privilèges par défaut pour les futures tables a échoué avec `permission denied to change default privileges` ; cette partie a été annulée et n'a pas été appliquée. Les privilèges par défaut restent à traiter avec un rôle autorisé (propriétaire concerné). La migration appliquée ne prétend donc corriger que les 7 tables existantes.
- Contrôles RLS relus : les tables d'administration restent réservées aux rôles/fonctions attendus par les policies ; aucune policy ni donnée métier n'a été modifiée.
- Supabase Advisors : alertes SECURITY DEFINER toujours présentes (1 fonction publique de partage et 22 fonctions accessibles à `authenticated`, à auditer au niveau de leurs gardes internes) ; la protection des mots de passe compromis reste désactivée. Aucun changement Auth.
- Tests : vérification SQL post-migration réussie ; aucun test applicatif ou scénario API n'a été exécuté, car la migration ne change que les privilèges SQL. Aucun test destructif sur les données métier.
- Déploiement : aucun. Fusion : aucune. `main2` et `main3-chatgpt` non modifiées. `production.html` non modifié.


### 2026-11-19 — Restriction des privilèges par défaut de postgres dans public

- Projet Supabase : `pbyoxfxngfutoiqjirkx` (PostgreSQL 17).
- Migration appliquée : `20261119012120_revoke_excess_postgres_public_default_table_privileges`.
- Fichier versionné : `supabase/migrations/20261119012120_revoke_excess_postgres_public_default_table_privileges.sql`.
- Portée exacte : privilèges par défaut des futures tables créées par le rôle `postgres` dans le schéma `public` uniquement.
- Correction : retrait de `TRUNCATE`, `REFERENCES`, `TRIGGER` et `MAINTAIN` pour `anon` et `authenticated`.
- Vérification post-migration : entrée `pg_default_acl` de `postgres/public` pour les tables = `{postgres=arwdDxtm/postgres,anon=arwd/postgres,authenticated=arwd/postgres,service_role=arwdDxtm/postgres}`. Les rôles `anon` et `authenticated` conservent `SELECT`, `INSERT`, `UPDATE`, `DELETE` et n'ont plus les quatre privilèges retirés.
- Historique : version `20261119012120` confirmée dans `supabase_migrations.schema_migrations`.
- Limite non corrigée : les privilèges par défaut de `supabase_admin` n'ont pas été modifiés ; la session SQL courante ne peut pas prendre ce rôle superutilisateur. Les défauts concernant les fonctions et les séquences n'ont pas été modifiés dans ce lot.
- Aucun privilège par défaut global ni autre schéma n'a été modifié. Aucune table existante, policy RLS, fonction, séquence ou donnée métier n'a été touchée par cette migration.
- Tests : vérification SQL de l'ACL par défaut et de l'historique de migration réussie. Un contrôle auxiliaire avec une table fictive a été abandonné car la table de sonde n'existait pas ; aucun objet de test n'a été créé.
- Déploiement : aucun. Fusion : aucune. `main2` et `main3-chatgpt` non modifiées. `production.html` non modifié.


### 2026-11-19 — Audit fonction par fonction des 22 fonctions SECURITY DEFINER

- Projet : `pbyoxfxngfutoiqjirkx`. Audit SQL en lecture seule ; aucune fonction, permission, policy, table ou donnée métier modifiée.
- Périmètre : les 22 fonctions publiques signalées par Supabase Advisor, définition complète, propriétaire, `search_path`, ACL et droits effectifs contrôlés.
- Résultat global :
  - Les 22 fonctions appartiennent à `postgres`, sont `SECURITY DEFINER` et fixent `search_path = ''`.
  - Les 22 sont exécutables par `authenticated` et `service_role`, mais pas par `anon` ni par `PUBLIC`.
  - Seule exception publique : `sales_public_document(text)`, également exécutable par `anon`, cohérente avec le parcours de partage par jeton.
- Contrôles d'autorisation relevés :
  - Quotas/admin : les 4 fonctions `admin_*` appellent `private.is_super_admin()`, qui vérifie `auth.uid()` dans `user_roles`.
  - Facturation cabinet : `billing_issue_invoice` et `billing_cancel_invoice` limitent l'accès aux cabinets retournés par `private.user_manager_cabinet_ids()` (membre actif avec rôle owner/admin).
  - Dossiers : `delete_dossier_documents` filtre par `private.user_can_access_dossier`; `get_workspace_cockpit` refuse explicitement si le dossier n'est pas accessible.
  - Portail : les fonctions de période/upload utilisent `private.portal_client_id()` et/ou `private.portal_can_upload_to()`; les actions de revue utilisent `private.user_client_ids()`. La relation `client_portal_access.user_id` est unique, donc le `LIMIT 1` du helper portail ne choisit pas entre plusieurs accès actifs pour un même utilisateur.
  - Ventes : les fonctions d'action utilisent `private.sales_lock_own()` ou comparent directement `issuer_client_id` à `private.portal_client_id()`.
- Vérifications complémentaires :
  - Aucun utilisateur n'a plusieurs appartenances actives à des cabinets au moment du contrôle ; le comportement « premier cabinet » de `get_my_vision_credits()` n'a donc pas d'effet ambigu observé actuellement.
  - Les 5 cabinets sont actifs au moment de l'audit. Le helper `private.user_manager_cabinet_ids()` vérifie l'appartenance active et le rôle owner/admin, mais ne joint pas `cabinets.is_active` ; à revoir si la désactivation d'un cabinet doit bloquer immédiatement les opérations de facturation.
  - `billing_cancel_invoice` teste `sum(amount) > 0` ; la contrainte `invoice_payments_amount_check` impose `amount > 0`, donc tout paiement enregistré positif empêche l'annulation.
- Points à confirmer fonctionnellement (pas de vulnérabilité inter-cabinets démontrée) :
  1. `sales_public_document(text)` retourne tout document dont le statut est différent de `draft`, donc aussi les statuts `cancelled` et `voided` si un jeton de partage existe encore. Confirmer si le lien public doit rester consultable après annulation/annulation administrative ; ne pas changer sans décision produit.
  2. `get_my_vision_credits()` sélectionne la première appartenance active par date de création sans paramètre de cabinet. Aucun utilisateur multi-cabinet n'est actuellement observé ; prévoir un choix explicite si ce cas devient possible.
  3. `private.user_manager_cabinet_ids()` ne filtre pas `cabinets.is_active`. Aucun cabinet inactif n'est actuellement observé ; confirmer la règle attendue lors d'une désactivation.
- Jetons de partage : la fonction de création génère deux UUID concaténés sans tirets (64 caractères hexadécimaux) ; la lecture publique exige au moins 40 caractères. Le jeton généré satisfait ce minimum avec une marge importante.
- Supabase Advisor après audit : 1 alerte anon (fonction de partage ci-dessus) et 22 alertes authenticated (les fonctions auditées). L'alerte Auth `auth_leaked_password_protection` reste également présente et n'a pas été modifiée.
- Conclusion : aucune faille d'accès inter-cabinets ou d'élévation de privilèges n'a été confirmée dans les 22 corps examinés. Les fonctions `SECURITY DEFINER` sont nécessaires à plusieurs opérations qui passent par des contrôles internes ; ne pas basculer globalement en `SECURITY INVOKER` ni révoquer globalement `EXECUTE`.
- Tests dynamiques inter-utilisateurs/cabinets : non exécutés, car aucun contexte de session utilisateur isolé n'a été utilisé. L'audit repose sur les définitions SQL, ACL effectives, contraintes et helpers.
- Aucune migration, aucun déploiement, aucun merge. `main2`, `main3-chatgpt` et `production.html` non modifiés.


### 2026-11-19 — Blocage des liens publics des factures de vente annulées

- Type : correction Supabase + migration versionnée et journalisation GitHub.
- Branche GitHub : `main2-chatgpt` uniquement ; aucune modification de `main2` ou `main3-chatgpt`.
- Projet Supabase : `pbyoxfxngfutoiqjirkx`.
- Constat confirmé avant correction : `public.sales_public_document(text)` recherchait un document avec `status <> 'draft'`. Un document `cancelled` ou `voided` conservant son `share_token` pouvait donc rester accessible par son lien public.
- Correction appliquée : la fonction ne retourne désormais un document que si `issuer_client_id IS NOT NULL` et `status = 'issued'`.
- Portée fonctionnelle : les factures et avoirs encore émis (`issued`) restent consultables ; les documents annulés (`cancelled`) ou invalidés (`voided`) ne sont plus retournés. Les brouillons restent exclus.
- Contrôles conservés : jeton obligatoire d'au moins 40 caractères, `SECURITY DEFINER`, `search_path` vide, même structure JSON retournée, ACL inchangées.
- Migration Supabase appliquée : `20261119014508_restrict_public_sales_document_to_issued_status`.
- Fichier de migration : `supabase/migrations/20261119014508_restrict_public_sales_document_to_issued_status.sql`.
- Commit du fichier de migration : `bdf60f6036c90c96f0fa3305e8c7afcd2777b854`.
- Vérification post-migration : `pg_get_functiondef` confirme le filtre `status = 'issued'` ; Supabase confirme la migration `20261119014508) enregistrée ; `anon` et `authenticated` conservent `EXECUTE` sur cette fonction publique, sans changement de droits.
- Données métier : aucune facture, aucun avoir, aucun jeton, aucun paiement ni aucune ligne n'a été modifié.
- Tests : vérification SQL de la définition déployée, de la migration enregistrée et des droits d'exécution. Aucun appel public dynamique avec des jetons réels n'a été réalisé afin de ne pas exposer de données métier.
- Limites : le test de comportement sur des documents de chaque statut reste à effectuer dans un environnement de test isolé ; aucun document existant n'a été modifié.
- Déploiement applicatif : aucun ; la correction est côté base Supabase et prend effet à l'appel suivant de la fonction.
- Retour arrière : restaurer la définition antérieure de `sales_public_document(text)` via une migration corrective dédiée, après décision explicite.
- État : correction appliquée et vérifiée sur Supabase ; fichier versionné sur `main2-chatgpt) ; non fusionnée vers `main2), aucun déploiement applicatif.

### 2026-11-19 — Revue indépendante (Claude) et corrections sur `cursor/revue-securite`

- Branche : `cursor/revue-securite`, partie de `main2-chatgpt` (eb8dbf8). `main2-chatgpt` et `main2` non modifiées.
- Constats vérifiés et corrigés :
  - CI : le job `sql` échouait sur `MAINTAIN` (inconnu de Postgres 16, image de la CI) alors que la production est en Postgres 17 → image CI `postgres:17`. La CI ne tournait pas sur les envois vers `main2` → déclenchement aussi sur `main2`, `main2-chatgpt`, `cursor/**`.
  - Cache navigateur : `api-client.js` modifié sans changer sa version chez ses importeurs (règle 3) ; un navigateur gardant l'ancienne copie n'enverrait pas la session → erreurs 401. Version `?v=sec1` appliquée à `api-client.js` et à toute la chaîne d'importeurs jusqu'aux pages ; trois copies resynchronisées.
  - Progression des imports ZIP : `total_files` n'était connu qu'à la fin du fichier (affichage « 17/1 traités »). Le total est désormais annoncé dès la prévalidation de l'archive (test ajouté dans `test_worker_zip_batches.py`).
  - Taille de lot du worker liée au plafond `EXTRACTION_CONCURRENCY` (au moins 2) pour qu'un gros ZIP puisse occuper tous les créneaux si le plafond est relevé.
  - Commentaires explicatifs supprimés dans le worker restaurés.
  - Message clair si aucune session (outil solo ouvert sans connexion) au lieu de « session expirée ».
- Défaut préexistant trouvé (présent avant ce chantier, non corrigé par la migration du 18/11) : supprimer un brouillon de facture contenant des lignes échoue avec « Facture émise… » (la facture est déjà supprimée quand la garde des lignes s'exécute en cascade). Migration préparée `20261119120000_billing_allow_draft_delete.sql`, testée en transaction annulée sur la production (brouillon supprimé ; facture émise, ses lignes et leur modification toujours refusées) et dans la suite SQL. **Non appliquée : accord d'Anas requis.**
- Limite restante notée : `require_dossier_access` s'appuie sur la lecture de `client_dossiers`, que l'utilisateur du portail client peut lire pour son propre dossier ; il peut donc lancer l'analyse IA des documents non traités de son dossier (crédits du cabinet). Portée limitée à son dossier ; à restreindre aux membres du cabinet.
- Retrait de la mémoire dans `/api/health` (choix de ce chantier) : la mesure reste visible dans le terminal du serveur.
