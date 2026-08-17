-- Cockpit : compteurs + refs de lignes (source_id / source_file) sans le JSON lines/bank.
CREATE OR REPLACE FUNCTION public.get_workspace_cockpit(p_dossier_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT private.user_can_access_dossier(p_dossier_id) THEN
    RAISE EXCEPTION 'dossier inaccessible';
  END IF;

  SELECT jsonb_build_object(
    'line_count', COALESCE(w.line_count, 0),
    'bank_count', COALESCE(w.bank_count, 0),
    'anomaly_count', COALESCE(w.anomaly_count, 0),
    'updated_at', w.updated_at,
    'bank_meta', COALESCE(w.bank_meta, '{}'::jsonb),
    'missing_payment_dates', COALESCE((
      SELECT count(*)::integer
      FROM jsonb_array_elements(COALESCE(w.lines, '[]'::jsonb)) rec
      WHERE nullif(btrim(coalesce(rec->>'date_paie', '')), '') IS NULL
    ), 0),
    'line_refs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'source_id', rec->>'source_id',
        'source_file', rec->>'source_file'
      ))
      FROM jsonb_array_elements(COALESCE(w.lines, '[]'::jsonb)) rec
    ), '[]'::jsonb)
  )
  INTO result
  FROM public.dossier_workspaces w
  WHERE w.dossier_id = p_dossier_id;

  RETURN COALESCE(result, jsonb_build_object(
    'line_count', 0,
    'bank_count', 0,
    'anomaly_count', 0,
    'updated_at', null,
    'bank_meta', '{}'::jsonb,
    'missing_payment_dates', 0,
    'line_refs', '[]'::jsonb
  ));
END;
$$;

COMMENT ON FUNCTION public.get_workspace_cockpit(bigint) IS
  'Résumé cockpit : compteurs + line_refs (source_id/source_file) sans télécharger lines/bank.';

GRANT EXECUTE ON FUNCTION public.get_workspace_cockpit(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_workspace_cockpit(bigint) TO service_role;
