-- Recompta SaaS schema
--
-- ⚠️  NE PAS exécuter sur un Supabase existant (autre app) !
--     Créez un NOUVEAU projet Supabase dédié uniquement à Recompta.
--
-- Run on a DEDICATED Supabase project (not shared with other apps)

-- Cabinets comptables (tenants)
CREATE TABLE IF NOT EXISTS recompta_cabinets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'starter', 'pro', 'cabinet')),
  trial_ends_at TIMESTAMPTZ DEFAULT (now() + interval '14 days'),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Membres d'un cabinet
CREATE TABLE IF NOT EXISTS recompta_cabinet_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cabinet_id UUID NOT NULL REFERENCES recompta_cabinets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'comptable' CHECK (role IN ('owner', 'admin', 'comptable')),
  display_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cabinet_id, user_id)
);

-- Clients du cabinet (entreprises dont on fait la TVA)
CREATE TABLE IF NOT EXISTS recompta_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cabinet_id UUID NOT NULL REFERENCES recompta_cabinets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  if_fiscal TEXT,
  ice TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Déclarations TVA (une par client + période)
CREATE TABLE IF NOT EXISTS recompta_declarations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES recompta_clients(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period ~ '^\d{6}$'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'exported', 'submitted')),
  exported_at TIMESTAMPTZ,
  export_filename TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, period)
);

-- Lignes extraites (format DED TVA)
CREATE TABLE IF NOT EXISTS recompta_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id UUID NOT NULL REFERENCES recompta_declarations(id) ON DELETE CASCADE,
  source_file TEXT,
  fact_num TEXT NOT NULL DEFAULT '',
  designation TEXT NOT NULL DEFAULT 'MATIERES CONSOMMABLES',
  m_ht NUMERIC(12,2) NOT NULL DEFAULT 0,
  tva NUMERIC(12,2) NOT NULL DEFAULT 0,
  m_ttc NUMERIC(12,2) NOT NULL DEFAULT 0,
  if_fournisseur TEXT DEFAULT '',
  lib_frss TEXT DEFAULT '',
  ice_frs TEXT DEFAULT '',
  taux NUMERIC(4,2) NOT NULL DEFAULT 0.2,
  id_paie INT NOT NULL DEFAULT 4,
  date_paie DATE,
  date_fac DATE,
  code_tva INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fichiers uploadés (métadonnées)
CREATE TABLE IF NOT EXISTS recompta_uploaded_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id UUID NOT NULL REFERENCES recompta_declarations(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  storage_path TEXT,
  mime_type TEXT,
  uploaded_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_recompta_members_user ON recompta_cabinet_members(user_id);
CREATE INDEX IF NOT EXISTS idx_recompta_clients_cabinet ON recompta_clients(cabinet_id);
CREATE INDEX IF NOT EXISTS idx_recompta_declarations_client ON recompta_declarations(client_id);
CREATE INDEX IF NOT EXISTS idx_recompta_lines_declaration ON recompta_invoice_lines(declaration_id);

-- RLS
ALTER TABLE recompta_cabinets ENABLE ROW LEVEL SECURITY;
ALTER TABLE recompta_cabinet_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE recompta_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE recompta_declarations ENABLE ROW LEVEL SECURITY;
ALTER TABLE recompta_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE recompta_uploaded_files ENABLE ROW LEVEL SECURITY;

-- Helper: cabinet IDs for current user
CREATE OR REPLACE FUNCTION recompta_user_cabinet_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cabinet_id FROM recompta_cabinet_members
  WHERE user_id = auth.uid() AND is_active = true;
$$;

-- Policies: cabinets
CREATE POLICY recompta_cabinets_select ON recompta_cabinets
  FOR SELECT USING (id IN (SELECT recompta_user_cabinet_ids()));

CREATE POLICY recompta_cabinets_update ON recompta_cabinets
  FOR UPDATE USING (
    id IN (
      SELECT cabinet_id FROM recompta_cabinet_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin') AND is_active = true
    )
  );

-- Policies: members
CREATE POLICY recompta_members_select ON recompta_cabinet_members
  FOR SELECT USING (cabinet_id IN (SELECT recompta_user_cabinet_ids()));

CREATE POLICY recompta_members_insert ON recompta_cabinet_members
  FOR INSERT WITH CHECK (
    cabinet_id IN (
      SELECT cabinet_id FROM recompta_cabinet_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin') AND is_active = true
    )
  );

-- Policies: clients
CREATE POLICY recompta_clients_all ON recompta_clients
  FOR ALL USING (cabinet_id IN (SELECT recompta_user_cabinet_ids()))
  WITH CHECK (cabinet_id IN (SELECT recompta_user_cabinet_ids()));

-- Policies: declarations (via client → cabinet)
CREATE POLICY recompta_declarations_all ON recompta_declarations
  FOR ALL USING (
    client_id IN (
      SELECT c.id FROM recompta_clients c
      WHERE c.cabinet_id IN (SELECT recompta_user_cabinet_ids())
    )
  )
  WITH CHECK (
    client_id IN (
      SELECT c.id FROM recompta_clients c
      WHERE c.cabinet_id IN (SELECT recompta_user_cabinet_ids())
    )
  );

-- Policies: invoice lines
CREATE POLICY recompta_lines_all ON recompta_invoice_lines
  FOR ALL USING (
    declaration_id IN (
      SELECT d.id FROM recompta_declarations d
      JOIN recompta_clients c ON c.id = d.client_id
      WHERE c.cabinet_id IN (SELECT recompta_user_cabinet_ids())
    )
  )
  WITH CHECK (
    declaration_id IN (
      SELECT d.id FROM recompta_declarations d
      JOIN recompta_clients c ON c.id = d.client_id
      WHERE c.cabinet_id IN (SELECT recompta_user_cabinet_ids())
    )
  );

-- Policies: uploaded files
CREATE POLICY recompta_files_all ON recompta_uploaded_files
  FOR ALL USING (
    declaration_id IN (
      SELECT d.id FROM recompta_declarations d
      JOIN recompta_clients c ON c.id = d.client_id
      WHERE c.cabinet_id IN (SELECT recompta_user_cabinet_ids())
    )
  )
  WITH CHECK (
    declaration_id IN (
      SELECT d.id FROM recompta_declarations d
      JOIN recompta_clients c ON c.id = d.client_id
      WHERE c.cabinet_id IN (SELECT recompta_user_cabinet_ids())
    )
  );

-- Allow insert cabinet on signup (first member becomes owner via API with service role)
-- Cabinet insert done server-side with service role key during onboarding
