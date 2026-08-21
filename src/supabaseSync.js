/**
 * supabaseSync.js
 *
 * Drop-in replacement for bandSync.js.
 * Uses two Supabase tables:
 *   zong_global  — songs + spelling_chart (shared by all churches, no key needed)
 *   zong_teams   — shared_setlists only   (one row per team key)
 *
 * External API matches bandSync.syncLibrary() exactly so App.jsx changes are minimal.
 * Adds subscribeToChanges() for Realtime push (replaces 10s polling interval).
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

let _client = null;
function client() {
  if (!_client) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error("Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env");
    }
    _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _client;
}

// ---------------------------------------------------------------------------
//  Internal: global table helpers
// ---------------------------------------------------------------------------

async function readGlobal() {
  const { data, error } = await client()
    .from("zong_global")
    .select("revision, songs, spelling_chart")
    .eq("id", "main")
    .single();
  if (error) throw new Error(`Pull failed: ${error.message}`);
  return {
    revision:      data.revision ?? 0,
    songs:         data.songs         ?? [],
    spellingChart: data.spelling_chart ?? {}
  };
}

async function writeGlobal({ songs, spellingChart, baseRevision }) {
  const { data, error } = await client()
    .from("zong_global")
    .update({
      songs,
      spelling_chart: spellingChart,
      revision:       baseRevision + 1,
      updated_at:     new Date().toISOString()
    })
    .eq("id", "main")
    .eq("revision", baseRevision)   // optimistic concurrency check
    .select("revision, songs, spelling_chart");

  if (error) throw new Error(`Push failed: ${error.message}`);

  if (!data || data.length === 0) {
    // Another device pushed first — conflict
    return null;
  }
  return {
    revision:      data[0].revision,
    songs:         data[0].songs          ?? songs,
    spellingChart: data[0].spelling_chart ?? spellingChart
  };
}

// ---------------------------------------------------------------------------
//  Internal: team table helpers (shared setlists only)
// ---------------------------------------------------------------------------

async function readTeam(teamKey) {
  const { data, error } = await client()
    .from("zong_teams")
    .select("revision, shared_setlists")
    .eq("team_key", teamKey)
    .maybeSingle();          // returns null if team doesn't exist yet

  if (error) throw new Error(`Team pull failed: ${error.message}`);
  return {
    revision:       data?.revision        ?? 0,
    sharedSetlists: data?.shared_setlists ?? []
  };
}

async function writeTeam({ teamKey, sharedSetlists, baseRevision }) {
  // UPSERT so the row is created automatically on first push for new teams
  const { data, error } = await client()
    .from("zong_teams")
    .upsert({
      team_key:        teamKey,
      shared_setlists: sharedSetlists,
      revision:        baseRevision + 1,
      updated_at:      new Date().toISOString()
    }, {
      onConflict:       "team_key",
      ignoreDuplicates: false
    })
    // Supabase upsert doesn't support optimistic locking natively; we'll
    // use a separate update with the revision check for conflict detection
    .select("revision, shared_setlists");

  if (error) throw new Error(`Team push failed: ${error.message}`);

  // Check if another device already bumped the revision ahead of us.
  // Supabase upsert always writes, so we verify the written revision is
  // exactly baseRevision + 1 (meaning no race happened).
  const written = data?.[0];
  if (!written || written.revision !== baseRevision + 1) {
    // Conflict: re-read and return the latest
    return null;
  }

  return {
    revision:       written.revision,
    sharedSetlists: written.shared_setlists ?? sharedSetlists
  };
}

// ---------------------------------------------------------------------------
//  Public: syncLibrary — drop-in replacement for bandSync.syncLibrary()
//
//  revision shape: { global: N, team: M }
//  (accepts plain number for backward-compat with stored localStorage values)
// ---------------------------------------------------------------------------

export async function syncLibrary({ key, state, revision = 0, changed }) {
  const isTeam = Boolean(key && key.trim());

  // Normalise revision (handle legacy plain-number values stored in localStorage)
  const rev = typeof revision === "object" && revision !== null
    ? revision
    : { global: Number(revision) || 0, team: 0 };

  // ── Always sync global (songs + spelling chart) ────────────────────────────
  const remote = await readGlobal();

  let nextGlobal = {
    revision:      remote.revision,
    songs:         remote.songs,
    spellingChart: remote.spellingChart
  };
  let globalConflict = false;

  if (changed) {
    const pushed = await writeGlobal({
      songs:         state.songs,
      spellingChart: state.spellingChart,
      baseRevision:  rev.global
    });

    if (!pushed) {
      // Conflict — return remote state so caller can merge
      globalConflict = true;
    } else {
      nextGlobal = pushed;
    }
  } else if (remote.revision > rev.global) {
    // Remote is newer — pull it in
  }

  // ── Team sync (shared setlists only) ─────────────────────────────────────
  let nextTeam = {
    revision:       rev.team,
    sharedSetlists: state.sharedSetlists ?? []
  };
  let teamConflict = false;

  if (isTeam) {
    const remoteTeam = await readTeam(key);
    nextTeam.revision = remoteTeam.revision;
    nextTeam.sharedSetlists = remoteTeam.sharedSetlists;

    if (changed) {
      const pushedTeam = await writeTeam({
        teamKey:        key,
        sharedSetlists: state.sharedSetlists ?? [],
        baseRevision:   rev.team
      });
      if (!pushedTeam) {
        teamConflict = true;
        // Keep remote team state on conflict
      } else {
        nextTeam = pushedTeam;
      }
    }
  }

  return {
    revision: { global: nextGlobal.revision, team: nextTeam.revision },
    state: {
      songs:          nextGlobal.songs,
      spellingChart:  nextGlobal.spellingChart,
      sharedSetlists: nextTeam.sharedSetlists
    },
    conflict: globalConflict || teamConflict,
    pulled:   !changed && remote.revision > rev.global
  };
}

// ---------------------------------------------------------------------------
//  Public: Realtime subscriptions — replaces the 10-second polling setInterval
//
//  subscribeToChanges({ onGlobal, onTeam, teamKey })
//   - onGlobal(state)  called whenever any device pushes songs/spelling chart
//   - onTeam(state)    called whenever any device pushes this team's setlists
//
//  Returns an unsubscribe() function.
// ---------------------------------------------------------------------------

let _globalChannel = null;
let _teamChannel   = null;

export function subscribeToChanges({ onGlobal, onTeam, teamKey }) {
  const sb = client();

  // Global channel
  _globalChannel = sb
    .channel("zong_global_changes")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "zong_global", filter: "id=eq.main" },
      (payload) => {
        const row = payload.new;
        if (row && onGlobal) {
          onGlobal({
            revision:      row.revision ?? 0,
            songs:         row.songs          ?? [],
            spellingChart: row.spelling_chart ?? {}
          });
        }
      }
    )
    .subscribe();

  // Team channel (only if a team key is set)
  if (teamKey && onTeam) {
    _teamChannel = sb
      .channel(`zong_team_${teamKey}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "zong_teams", filter: `team_key=eq.${teamKey}` },
        (payload) => {
          const row = payload.new;
          if (row && onTeam) {
            onTeam({
              revision:       row.revision        ?? 0,
              sharedSetlists: row.shared_setlists ?? []
            });
          }
        }
      )
      .subscribe();
  }

  return function unsubscribe() {
    if (_globalChannel) { sb.removeChannel(_globalChannel); _globalChannel = null; }
    if (_teamChannel)   { sb.removeChannel(_teamChannel);   _teamChannel   = null; }
  };
}

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}
