-- =============================================================================
-- Zong Supabase Schema (Global Songs & Spelling Chart + Multi-Team Setlists)
-- =============================================================================
-- Instructions:
-- 1. Create a project at https://supabase.com
-- 2. Open SQL Editor -> New query -> Paste this script -> Run
-- 3. In Table Editor -> zong_global -> Enable Realtime toggle
-- 4. In Table Editor -> zong_teams -> Enable Realtime toggle
-- =============================================================================

-- 1. Global song library + spelling chart (shared by all churches worldwide)
CREATE TABLE IF NOT EXISTS zong_global (
  id              TEXT PRIMARY KEY DEFAULT 'main',
  revision        INTEGER NOT NULL DEFAULT 0,
  songs           JSONB NOT NULL DEFAULT '[]'::jsonb,
  spelling_chart  JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Seed initial row
INSERT INTO zong_global (id, revision, songs, spelling_chart)
VALUES ('main', 0, '[]'::jsonb, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- 2. Per-team shared setlists (one isolated row per team key / church)
CREATE TABLE IF NOT EXISTS zong_teams (
  team_key        TEXT PRIMARY KEY,
  revision        INTEGER NOT NULL DEFAULT 0,
  shared_setlists JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 3. Row Level Security (RLS)
ALTER TABLE zong_global ENABLE ROW LEVEL SECURITY;
ALTER TABLE zong_teams ENABLE ROW LEVEL SECURITY;

-- Allow anonymous read & write (access is controlled by knowing the team key)
DROP POLICY IF EXISTS "global_read" ON zong_global;
CREATE POLICY "global_read" ON zong_global FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "global_write" ON zong_global;
CREATE POLICY "global_write" ON zong_global FOR ALL TO anon USING (true);

DROP POLICY IF EXISTS "team_read" ON zong_teams;
CREATE POLICY "team_read" ON zong_teams FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "team_write" ON zong_teams;
CREATE POLICY "team_write" ON zong_teams FOR ALL TO anon USING (true);

-- 4. Enable realtime replication publication
ALTER PUBLICATION supabase_realtime ADD TABLE zong_global;
ALTER PUBLICATION supabase_realtime ADD TABLE zong_teams;
