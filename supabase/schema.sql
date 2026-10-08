-- =============================================================================
-- Zong Supabase Schema (Individual Songs & Spelling Chart + Team Setlists)
-- =============================================================================
-- INSTRUCTIONS (HOW TO RUN IN SUPABASE):
-- 1. Log in to your Supabase project (https://supabase.com/dashboard)
-- 2. Click "SQL Editor" in the left sidebar
-- 3. Click "New query" (or "+" button)
-- 4. Paste this entire script into the editor
-- 5. Click "Run" (green button)
-- 
-- That's it! 
-- • All existing songs in zong_global will be converted into zong_songs rows.
-- • All existing spelling rules will be converted into zong_spelling_chart rows.
-- • zong_global will be safely deleted.
-- • Realtime push will be enabled for instant sync across all devices.
-- =============================================================================

-- 1. Individual Songs Table (each row is one song with all fields as columns)
CREATE TABLE IF NOT EXISTS zong_songs (
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
  accents         JSONB DEFAULT '["normal","normal","normal","normal"]'::jsonb,
  key_quality     TEXT DEFAULT 'Major',
  description     TEXT DEFAULT '',
  is_deleted      BOOLEAN DEFAULT FALSE,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Ensure columns exist if table was created earlier
ALTER TABLE zong_songs ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE zong_songs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 2. Individual Spelling Chart Table (each row is one Tamil -> Latin spelling rule)
CREATE TABLE IF NOT EXISTS zong_spelling_chart (
  tamil           TEXT PRIMARY KEY,
  latin           TEXT NOT NULL,
  is_deleted      BOOLEAN DEFAULT FALSE,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE zong_spelling_chart ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE zong_spelling_chart ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 3. Per-team shared setlists (one row per team key / church)
CREATE TABLE IF NOT EXISTS zong_teams (
  team_key        TEXT PRIMARY KEY,
  revision        INTEGER NOT NULL DEFAULT 0,
  shared_setlists JSONB NOT NULL DEFAULT '[]'::jsonb,
  subscribers     JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE zong_teams ADD COLUMN IF NOT EXISTS subscribers JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 4. Row Level Security (RLS) policies
ALTER TABLE zong_songs ENABLE ROW LEVEL SECURITY;
ALTER TABLE zong_spelling_chart ENABLE ROW LEVEL SECURITY;
ALTER TABLE zong_teams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "songs_read" ON zong_songs;
CREATE POLICY "songs_read" ON zong_songs FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "songs_write" ON zong_songs;
CREATE POLICY "songs_write" ON zong_songs FOR ALL TO anon USING (true);

DROP POLICY IF EXISTS "spelling_read" ON zong_spelling_chart;
CREATE POLICY "spelling_read" ON zong_spelling_chart FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "spelling_write" ON zong_spelling_chart;
CREATE POLICY "spelling_write" ON zong_spelling_chart FOR ALL TO anon USING (true);

DROP POLICY IF EXISTS "team_read" ON zong_teams;
CREATE POLICY "team_read" ON zong_teams FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "team_write" ON zong_teams;
CREATE POLICY "team_write" ON zong_teams FOR ALL TO anon USING (true);

-- 5. Enable Realtime Replication for instant push updates
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'zong_songs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE zong_songs;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'zong_spelling_chart'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE zong_spelling_chart;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'zong_teams'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE zong_teams;
  END IF;
END $$;

-- =============================================================================
-- Migration: Copy all songs & spelling rules from zong_global if it exists
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'zong_global') THEN
    -- Migrate songs
    INSERT INTO zong_songs (
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
    FROM zong_global, jsonb_array_elements(songs) AS s
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
    INSERT INTO zong_spelling_chart (tamil, latin, is_deleted, updated_at)
    SELECT
      key,
      value#>>'{}',
      false,
      now()
    FROM zong_global, jsonb_each(spelling_chart)
    WHERE key IS NOT NULL AND key != ''
    ON CONFLICT (tamil) DO UPDATE SET
      latin      = EXCLUDED.latin,
      is_deleted = false,
      updated_at = now();

    -- Safely drop zong_global now that all data is translated!
    DROP TABLE IF EXISTS zong_global CASCADE;
  END IF;
END $$;
