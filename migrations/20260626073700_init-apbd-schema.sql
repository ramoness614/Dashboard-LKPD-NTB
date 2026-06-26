-- ============================================================================
-- APBD NTB — Dashboard Transparansi Keuangan
-- Initial schema (PRD §6) + STATEMENT_LINE extension for the 6-statement
-- "Laporan Keuangan" view, with public read / admin-only write RLS.
--
-- Roles (InsForge built-ins):
--   anon          -> public visitors (read-only)
--   authenticated -> logged-in users
--   project_admin -> migrations / API-key / edge functions (full write)
--
-- Design: all dashboard data is public-read. Writes happen only through the
-- import edge function using the admin key (project_admin), so there are NO
-- write policies for anon/authenticated and the default broad DML grants are
-- revoked from them. The app_admin allowlist gates who may trigger imports.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- REGION — 1 province + 10 kabupaten/kota
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.region (
  id           SERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,                 -- stable id used by the frontend (e.g. 'mataram')
  name         TEXT NOT NULL,
  short        TEXT NOT NULL,                        -- map/chip abbreviation (KOMAT, LOBAR, ...)
  type         TEXT NOT NULL CHECK (type IN ('province','regency','city')),
  code_wilayah TEXT,                                 -- BPS region code
  parent_id    INTEGER REFERENCES public.region(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- BUDGET_ENTRY — per-line pendapatan/belanja/pembiayaan (from LRA)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.budget_entry (
  id              SERIAL PRIMARY KEY,
  region_id       INTEGER NOT NULL REFERENCES public.region(id) ON DELETE CASCADE,
  year            INTEGER NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('pendapatan','belanja','pembiayaan')),
  sub_category    TEXT NOT NULL,
  ref_code        TEXT,                              -- BPK "REF CALK" code (5.1.1.1 ...)
  level           SMALLINT NOT NULL DEFAULT 0,       -- hierarchy depth for display
  planned_amount  NUMERIC(20,2) NOT NULL DEFAULT 0,  -- ANGGARAN (full rupiah)
  realized_amount NUMERIC(20,2) NOT NULL DEFAULT 0,  -- REALISASI (full rupiah)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS budget_entry_region_year_idx ON public.budget_entry (region_id, year);

-- ---------------------------------------------------------------------------
-- STATEMENT_LINE — raw 6 audited statements (LRA, LPSAL, Neraca, LO, LAK, LPE)
-- Stores each statement exactly as the uploaded .xlsx sheet, so the
-- "Laporan Keuangan" view and side-by-side comparison render straight from DB.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.statement_line (
  id          SERIAL PRIMARY KEY,
  region_id   INTEGER NOT NULL REFERENCES public.region(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL,
  statement   TEXT NOT NULL CHECK (statement IN ('LRA','LPSAL','Neraca','LO','LAK','LPE')),
  line_order  INTEGER NOT NULL,                      -- preserves sheet row order
  label       TEXT NOT NULL,                         -- URAIAN
  ref_code    TEXT,
  level       SMALLINT NOT NULL DEFAULT 0,           -- 0 total, 1 section, 2 item
  kind        TEXT NOT NULL DEFAULT 'i' CHECK (kind IN ('t','s','i')),
  v0          NUMERIC(20,2),                         -- statement-specific columns
  v1          NUMERIC(20,2),                         -- (e.g. LRA: anggaran, realisasi, 2024)
  v2          NUMERIC(20,2),
  v3          NUMERIC(20,2),
  is_audited  BOOLEAN NOT NULL DEFAULT true,         -- false => illustrative/scaled
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS statement_line_lookup_idx ON public.statement_line (region_id, year, statement, line_order);

-- ---------------------------------------------------------------------------
-- YEARLY_SUMMARY — yearly aggregates (fast KPI/trend queries)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.yearly_summary (
  id                          SERIAL PRIMARY KEY,
  region_id                   INTEGER NOT NULL REFERENCES public.region(id) ON DELETE CASCADE,
  year                        INTEGER NOT NULL,
  total_planned_revenue       NUMERIC(20,2) NOT NULL DEFAULT 0,
  total_realized_revenue      NUMERIC(20,2) NOT NULL DEFAULT 0,
  total_planned_expenditure   NUMERIC(20,2) NOT NULL DEFAULT 0,
  total_realized_expenditure  NUMERIC(20,2) NOT NULL DEFAULT 0,
  net_financing               NUMERIC(20,2) NOT NULL DEFAULT 0,
  pad_planned                 NUMERIC(20,2) NOT NULL DEFAULT 0,
  pad_realized                NUMERIC(20,2) NOT NULL DEFAULT 0,
  transfer_realized           NUMERIC(20,2) NOT NULL DEFAULT 0,
  bd_pegawai                  NUMERIC(20,2) NOT NULL DEFAULT 0,
  bd_barang                   NUMERIC(20,2) NOT NULL DEFAULT 0,
  bd_modal                    NUMERIC(20,2) NOT NULL DEFAULT 0,
  bd_lain                     NUMERIC(20,2) NOT NULL DEFAULT 0,
  is_audited                  BOOLEAN NOT NULL DEFAULT true,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (region_id, year)
);

-- ---------------------------------------------------------------------------
-- INDICATOR_DATA — serapan / deviasi etc.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.indicator_data (
  id             SERIAL PRIMARY KEY,
  region_id      INTEGER NOT NULL REFERENCES public.region(id) ON DELETE CASCADE,
  year           INTEGER NOT NULL,
  indicator_type TEXT NOT NULL,                      -- 'serapan' | 'deviasi' | ...
  value          DOUBLE PRECISION NOT NULL,
  UNIQUE (region_id, year, indicator_type)
);

-- ---------------------------------------------------------------------------
-- RATIO_RESULT — six headline ratios per region/year
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ratio_result (
  id                  SERIAL PRIMARY KEY,
  region_id           INTEGER NOT NULL REFERENCES public.region(id) ON DELETE CASCADE,
  year                INTEGER NOT NULL,
  ddf                 DOUBLE PRECISION,              -- Derajat Desentralisasi Fiskal
  rkk                 DOUBLE PRECISION,              -- Rasio Kemandirian
  efektivitas_pad     DOUBLE PRECISION,
  efisiensi_belanja   DOUBLE PRECISION,
  belanja_modal_ratio DOUBLE PRECISION,
  ketergantungan      DOUBLE PRECISION,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (region_id, year)
);

-- ---------------------------------------------------------------------------
-- RECOMMENDATION — AI audit-focus cards (OpenRouter)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recommendation (
  id         SERIAL PRIMARY KEY,
  region_id  INTEGER NOT NULL REFERENCES public.region(id) ON DELETE CASCADE,
  year       INTEGER NOT NULL,
  title      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  priority   TEXT NOT NULL CHECK (priority IN ('Tinggi','Sedang','Rendah')),
  data_ref   TEXT,                                   -- e.g. 'ratio:efektivitas_pad', 'detail', 'serapan'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recommendation_region_year_idx ON public.recommendation (region_id, year);

-- ---------------------------------------------------------------------------
-- UPLOAD_LOG — admin upload history (panel "Riwayat Unggahan")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.upload_log (
  id          SERIAL PRIMARY KEY,
  region_id   INTEGER REFERENCES public.region(id) ON DELETE SET NULL,
  year        INTEGER,
  file_name   TEXT,
  storage_key TEXT,
  status      TEXT NOT NULL DEFAULT 'Sukses' CHECK (status IN ('Sukses','Gagal','Proses')),
  message     TEXT,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS upload_log_created_idx ON public.upload_log (created_at DESC);

-- ---------------------------------------------------------------------------
-- APP_ADMIN — allowlist of users permitted to import data
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_admin (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.is_app_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.app_admin a WHERE a.user_id = (SELECT auth.uid()));
$$;

-- ============================================================================
-- RLS — public read on all dashboard tables; writes restricted to admin key
-- ============================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'region','budget_entry','statement_line','yearly_summary',
    'indicator_data','ratio_result','recommendation','upload_log'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    -- public read
    EXECUTE format($p$CREATE POLICY "public read" ON public.%I FOR SELECT TO anon, authenticated USING (true);$p$, t);
    -- writes are admin-key only: drop the default broad DML grants from runtime roles
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon, authenticated;', t);
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated;', t);
  END LOOP;
END $$;

-- upload_log: admins may read their org's history while authenticated (already public read above);
-- app_admin table is private (no public read)
ALTER TABLE public.app_admin ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin self read" ON public.app_admin
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.app_admin FROM anon, authenticated;

GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- ============================================================================
-- SEED — the 11 NTB regions (idempotent)
-- ============================================================================
INSERT INTO public.region (slug, name, short, type, code_wilayah) VALUES
  ('prov',    'Provinsi NTB',        'Prov. NTB', 'province', '52'),
  ('mataram', 'Kota Mataram',        'KOMAT',     'city',     '52.71'),
  ('klu',     'Kab. Lombok Utara',   'KLU',       'regency',  '52.08'),
  ('lobar',   'Kab. Lombok Barat',   'LOBAR',     'regency',  '52.01'),
  ('loteng',  'Kab. Lombok Tengah',  'LOTENG',    'regency',  '52.02'),
  ('lotim',   'Kab. Lombok Timur',   'LOTIM',     'regency',  '52.03'),
  ('ksb',     'Kab. Sumbawa Barat',  'KSB',       'regency',  '52.07'),
  ('sumbawa', 'Kab. Sumbawa',        'SUMBAWA',   'regency',  '52.04'),
  ('dompu',   'Kab. Dompu',          'DOMPU',     'regency',  '52.05'),
  ('bima',    'Kab. Bima',           'KABI',      'regency',  '52.06'),
  ('kobi',    'Kota Bima',           'KOBI',      'city',     '52.72')
ON CONFLICT (slug) DO NOTHING;

-- attach kab/kota to the province
UPDATE public.region c SET parent_id = p.id
FROM public.region p WHERE p.slug = 'prov' AND c.slug <> 'prov' AND c.parent_id IS NULL;
