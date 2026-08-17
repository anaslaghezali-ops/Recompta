-- ZIP cabinet (export Drive) souvent > 50 Mo. Plafond bucket 200 Mo.
-- Le plafond global du projet (Storage Settings) doit être au moins aussi haut
-- (Free = max 50 Mo ; Pro = à monter dans le dashboard).

update storage.buckets
set file_size_limit = 209715200
where id in ('dossier-documents', 'import-queue');
