-- =============================================================================
-- Zong Supabase Complete Schema & Fix Script
-- =============================================================================
-- INSTRUCTIONS (HOW TO RUN IN SUPABASE):
-- 1. Log in to your Supabase project (https://supabase.com/dashboard)
-- 2. Click "SQL Editor" in the left sidebar
-- 3. Click "New query" (or the "+" button)
-- 4. Paste this entire script into the editor
-- 5. Click "Run" (green button)
--
-- This script is completely safe and idempotent (can be run multiple times).
-- It will:
--   • Ensure all 3 tables exist (zong_songs, zong_spelling_chart, zong_teams).
--   • Ensure all required columns exist (including `subscribers` on zong_teams).
--   • Grant full permissions (SELECT, INSERT, UPDATE, DELETE) to anon & authenticated roles.
--   • Create robust Row Level Security (RLS) policies with WITH CHECK (true).
--   • Enable REPLICA IDENTITY FULL and Realtime push replication.
--   • Safely migrate legacy zong_global data (if any remains).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Table Definitions
-- -----------------------------------------------------------------------------

-- 1A. Songs table
CREATE TABLE IF NOT EXISTS public.zong_songs (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  artist          TEXT DEFAULT '',
  key             TEXT DEFAULT '',
  tempo           INTEGER DEFAULT 120,
  time_signature  TEXT DEFAULT '4/4',
  language        TEXT DEFAULT '',
  lyrics_text     TEXT DEFAULT '',
  chords_text     TEXT DEFAULT '',
  chart_text      TEXT DEFAULT '',
  drums_text      TEXT DEFAULT '',
  -- accents is kept for backward compatibility but is no longer read or written
  -- by the client app. Beat accents are now stored per-device in localStorage.
  accents         JSONB DEFAULT '[]'::jsonb,
  key_quality     TEXT DEFAULT 'Major',
  description     TEXT DEFAULT '',
  is_deleted      BOOLEAN DEFAULT FALSE,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Ensure all columns exist on zong_songs
ALTER TABLE public.zong_songs ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE public.zong_songs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 1B. Spelling Chart table
CREATE TABLE IF NOT EXISTS public.zong_spelling_chart (
  tamil           TEXT PRIMARY KEY,
  latin           TEXT NOT NULL,
  is_deleted      BOOLEAN DEFAULT FALSE,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Ensure all columns exist on zong_spelling_chart
ALTER TABLE public.zong_spelling_chart ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE public.zong_spelling_chart ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 1C. Teams table (Shared setlists + device subscriber list)
CREATE TABLE IF NOT EXISTS public.zong_teams (
  team_key        TEXT PRIMARY KEY,
  revision        INTEGER NOT NULL DEFAULT 0,
  shared_setlists JSONB NOT NULL DEFAULT '[]'::jsonb,
  subscribers     JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Ensure all columns exist on zong_teams (essential if table was created in an earlier version)
ALTER TABLE public.zong_teams ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.zong_teams ADD COLUMN IF NOT EXISTS shared_setlists JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.zong_teams ADD COLUMN IF NOT EXISTS subscribers JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.zong_teams ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- -----------------------------------------------------------------------------
-- 2. Permissions & Grants
-- -----------------------------------------------------------------------------

-- Ensure PostgREST roles have schema usage and full table privileges
GRANT USAGE ON SCHEMA public TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zong_songs          TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zong_spelling_chart  TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zong_teams           TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Row Level Security (RLS)
-- -----------------------------------------------------------------------------

ALTER TABLE public.zong_songs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zong_spelling_chart ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zong_teams ENABLE ROW LEVEL SECURITY;

-- Clean up older policies
DROP POLICY IF EXISTS "songs_read"    ON public.zong_songs;
DROP POLICY IF EXISTS "songs_write"   ON public.zong_songs;
DROP POLICY IF EXISTS "songs_all"     ON public.zong_songs;

DROP POLICY IF EXISTS "spelling_read"  ON public.zong_spelling_chart;
DROP POLICY IF EXISTS "spelling_write" ON public.zong_spelling_chart;
DROP POLICY IF EXISTS "spelling_all"   ON public.zong_spelling_chart;

DROP POLICY IF EXISTS "team_read"     ON public.zong_teams;
DROP POLICY IF EXISTS "team_write"    ON public.zong_teams;
DROP POLICY IF EXISTS "team_all"      ON public.zong_teams;

-- Create comprehensive policies allowing read & write with explicit check
CREATE POLICY "songs_all" ON public.zong_songs
  FOR ALL TO anon, authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "spelling_all" ON public.zong_spelling_chart
  FOR ALL TO anon, authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "team_all" ON public.zong_teams
  FOR ALL TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 3B. Incremental-sync support (keeps free-tier egress minimal)
--   • Server stamps updated_at so devices with wrong clocks can't be missed.
--   • Indexes make "rows changed since X" queries cheap.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zong_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS zong_songs_touch    ON public.zong_songs;
DROP TRIGGER IF EXISTS zong_spelling_touch ON public.zong_spelling_chart;
CREATE TRIGGER zong_songs_touch    BEFORE INSERT OR UPDATE ON public.zong_songs
  FOR EACH ROW EXECUTE FUNCTION public.zong_touch_updated_at();
CREATE TRIGGER zong_spelling_touch BEFORE INSERT OR UPDATE ON public.zong_spelling_chart
  FOR EACH ROW EXECUTE FUNCTION public.zong_touch_updated_at();

CREATE INDEX IF NOT EXISTS zong_songs_updated_at_idx    ON public.zong_songs (updated_at);
CREATE INDEX IF NOT EXISTS zong_spelling_updated_at_idx ON public.zong_spelling_chart (updated_at);

-- -----------------------------------------------------------------------------
-- 4. Realtime & Replica Identity
-- -----------------------------------------------------------------------------

-- Set FULL replica identity so Realtime change payloads contain all columns on UPDATE and DELETE
ALTER TABLE public.zong_songs          REPLICA IDENTITY FULL;
ALTER TABLE public.zong_spelling_chart  REPLICA IDENTITY FULL;
ALTER TABLE public.zong_teams           REPLICA IDENTITY FULL;

-- Add tables to the supabase_realtime publication if not already included
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'zong_songs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.zong_songs;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'zong_spelling_chart'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.zong_spelling_chart;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'zong_teams'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.zong_teams;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 5. Data Migration (Only runs if legacy zong_global table exists)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'zong_global') THEN
    -- Migrate songs
    INSERT INTO public.zong_songs (
      id, title, artist, key, tempo, time_signature, language, 
      lyrics_text, chords_text, chart_text, drums_text, 
      accents, key_quality, description, is_deleted, updated_at
    )
    SELECT
      s->>'id',
      COALESCE(s->>'title', ''),
      COALESCE(s->>'artist', ''),
      COALESCE(s->>'key', ''),
      COALESCE(NULLIF(s->>'tempo', '')::integer, 120),
      COALESCE(s->>'timeSignature', '4/4'),
      COALESCE(s->>'language', ''),
      COALESCE(s->>'lyricsText', ''),
      COALESCE(s->>'chordsText', ''),
      COALESCE(s->>'chartText', ''),
      COALESCE(s->>'drumsText', ''),
      COALESCE(s->'accents', '["normal","normal","normal","normal"]'::jsonb),
      COALESCE(s->>'keyQuality', 'Major'),
      COALESCE(s->>'description', ''),
      false,
      now()
    FROM public.zong_global, jsonb_array_elements(songs) AS s
    WHERE s->>'id' IS NOT NULL
    ON CONFLICT (id) DO UPDATE SET
      title          = EXCLUDED.title,
      artist         = EXCLUDED.artist,
      key            = EXCLUDED.key,
      tempo          = EXCLUDED.tempo,
      time_signature = EXCLUDED.time_signature,
      language       = EXCLUDED.language,
      lyrics_text    = EXCLUDED.lyrics_text,
      chords_text    = EXCLUDED.chords_text,
      chart_text     = EXCLUDED.chart_text,
      drums_text     = EXCLUDED.drums_text,
      accents        = EXCLUDED.accents,
      key_quality    = EXCLUDED.key_quality,
      description    = EXCLUDED.description,
      is_deleted     = false,
      updated_at     = now();

    -- Migrate spelling chart
    INSERT INTO public.zong_spelling_chart (tamil, latin, is_deleted, updated_at)
    SELECT
      key,
      value#>>'{}',
      false,
      now()
    FROM public.zong_global, jsonb_each(spelling_chart)
    WHERE key IS NOT NULL AND key != ''
    ON CONFLICT (tamil) DO UPDATE SET
      latin      = EXCLUDED.latin,
      is_deleted = false,
      updated_at = now();

    -- Drop legacy zong_global table
    DROP TABLE IF EXISTS public.zong_global CASCADE;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 6. Verification Output
-- -----------------------------------------------------------------------------
SELECT 
  t.table_name,
  (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name) AS column_count,
  EXISTS (SELECT 1 FROM pg_publication_tables p WHERE p.pubname = 'supabase_realtime' AND p.tablename = t.table_name) AS realtime_enabled
FROM information_schema.tables t
WHERE t.table_schema = 'public' 
  AND t.table_name IN ('zong_songs', 'zong_spelling_chart', 'zong_teams')
ORDER BY t.table_name;
