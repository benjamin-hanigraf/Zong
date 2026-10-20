/**
 * supabaseSync.js
 *
 * Realtime multi-device synchronization engine for Zong.
 * Uses three Supabase tables:
 *   zong_songs          — individual song rows (all fields as columns)
 *   zong_spelling_chart — individual spelling rows (tamil -> latin)
 *   zong_teams          — shared_setlists per team key
 *
 * zong_global has been fully deprecated and dropped.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL      = (typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_URL) || (typeof process !== "undefined" && process.env?.VITE_SUPABASE_URL);
const SUPABASE_ANON_KEY = (typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_ANON_KEY) || (typeof process !== "undefined" && process.env?.VITE_SUPABASE_ANON_KEY);

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
//  Explicit Deletion Tracking (Songs & Spelling Chart)
// ---------------------------------------------------------------------------

const DELETED_SONGS_KEY = "zong:deleted-song-ids";
const DELETED_SPELLING_KEY = "zong:deleted-spelling-keys";

export function recordDeletedSongId(id) {
  if (!id) return;
  try {
    const list = JSON.parse(localStorage.getItem(DELETED_SONGS_KEY) || "[]");
    if (!list.includes(id)) {
      list.push(id);
      localStorage.setItem(DELETED_SONGS_KEY, JSON.stringify(list));
    }
  } catch {}
}

export function getDeletedSongIds() {
  try {
    return JSON.parse(localStorage.getItem(DELETED_SONGS_KEY) || "[]");
  } catch {
    return [];
  }
}

export function clearDeletedSongIds(ids) {
  try {
    const list = JSON.parse(localStorage.getItem(DELETED_SONGS_KEY) || "[]");
    const idSet = new Set(ids);
    const remaining = list.filter((id) => !idSet.has(id));
    localStorage.setItem(DELETED_SONGS_KEY, JSON.stringify(remaining));
  } catch {}
}

export function recordDeletedSpellingKey(tamil) {
  if (!tamil) return;
  try {
    const list = JSON.parse(localStorage.getItem(DELETED_SPELLING_KEY) || "[]");
    if (!list.includes(tamil)) {
      list.push(tamil);
      localStorage.setItem(DELETED_SPELLING_KEY, JSON.stringify(list));
    }
  } catch {}
}

export function getDeletedSpellingKeys() {
  try {
    return JSON.parse(localStorage.getItem(DELETED_SPELLING_KEY) || "[]");
  } catch {
    return [];
  }
}

export function clearDeletedSpellingKeys(keys) {
  try {
    const list = JSON.parse(localStorage.getItem(DELETED_SPELLING_KEY) || "[]");
    const keySet = new Set(keys);
    const remaining = list.filter((k) => !keySet.has(k));
    localStorage.setItem(DELETED_SPELLING_KEY, JSON.stringify(remaining));
  } catch {}
}

// ---------------------------------------------------------------------------
//  Internal: Table helpers & Column mapping
// ---------------------------------------------------------------------------

let _hasZongSongsTable = null;
let _lastTableCheck = 0;

export async function checkHasZongSongsTable() {
  const now = Date.now();
  if (_hasZongSongsTable === true) return true;
  if (_hasZongSongsTable === false && now - _lastTableCheck < 5000) return false;

  _lastTableCheck = now;
  try {
    const { error } = await client().from("zong_songs").select("id").limit(1);
    _hasZongSongsTable = !error;
  } catch {
    _hasZongSongsTable = false;
  }
  return _hasZongSongsTable;
}

let _hasZongSpellingTable = null;
let _lastSpellingTableCheck = 0;

export async function checkHasZongSpellingTable() {
  const now = Date.now();
  if (_hasZongSpellingTable === true) return true;
  if (_hasZongSpellingTable === false && now - _lastSpellingTableCheck < 5000) return false;

  _lastSpellingTableCheck = now;
  try {
    const { error } = await client().from("zong_spelling_chart").select("tamil").limit(1);
    _hasZongSpellingTable = !error;
  } catch {
    _hasZongSpellingTable = false;
  }
  return _hasZongSpellingTable;
}

/**
 * Converts a database row to an in-memory Song object.
 */
function rowToSong(row) {
  return {
    id:            row.id,
    title:         row.title || "",
    artist:        row.artist || "",
    key:           row.key || "",
    tempo:         row.tempo != null && row.tempo !== "" ? Number(row.tempo) : "",
    timeSignature: row.time_signature || "4/4",
    language:      row.language || "",
    lyricsText:    row.lyrics_text || "",
    chordsText:    row.chords_text || "",
    chartText:     row.chart_text || "",
    drumsText:     row.drums_text || "",
    accents:       Array.isArray(row.accents) ? row.accents : ["normal", "normal", "normal", "normal"],
    keyQuality:    row.key_quality || "Major",
    description:   row.description || "",
    subdivision:   1, // Online default is single beat (Requirement 9)
    updatedAt:     row.updated_at ? new Date(row.updated_at).getTime() : Date.now()
  };
}

/**
 * Converts an in-memory Song object to a database row.
 */
function songToRow(song) {
  return {
    id:             song.id,
    title:          song.title || "",
    artist:         song.artist || "",
    key:            song.key || "",
    tempo:          song.tempo !== "" && song.tempo != null ? Number(song.tempo) : null,
    time_signature: song.timeSignature || "4/4",
    language:       song.language || "",
    lyrics_text:    song.lyricsText || "",
    chords_text:    song.chordsText || "",
    chart_text:     song.chartText || "",
    drums_text:     song.drumsText || "",
    accents:        Array.isArray(song.accents) ? song.accents : ["normal", "normal", "normal", "normal"],
    key_quality:    song.keyQuality || "Major",
    description:    song.description || "",
    is_deleted:     false,
    updated_at:     new Date().toISOString()
  };
}

/**
 * Reads spelling chart rows from zong_spelling_chart.
 */
async function readSpellingChart() {
  const sb = client();
  const hasTable = await checkHasZongSpellingTable();
  const chart = {};
  const deletedKeys = [];

  if (hasTable) {
    try {
      // Fix #3: explicit column list (no '*')
      const { data: rows, error } = await sb
        .from("zong_spelling_chart")
        .select("tamil, latin, is_deleted");

      if (!error && rows) {
        rows.forEach((r) => {
          if (r.is_deleted) deletedKeys.push(r.tamil);
          else chart[r.tamil] = r.latin;
        });
      }
    } catch (e) {
      console.warn("[Zong Sync] Failed reading zong_spelling_chart:", e);
    }
  }

  // Fix #8: removed zong_global fallback — table was dropped by the schema migration.
  return { chart, deletedKeys };
}

/**
 * Writes spelling chart entries to zong_spelling_chart.
 */
/**
 * Writes spelling chart entries to zong_spelling_chart.
 * @param {object} spellingChart  - full chart (tamil → latin)
 * @param {Set<string>} [changedKeys] - if provided, only these keys are upserted (Fix #7)
 */
async function writeSpellingChart(spellingChart, changedKeys) {
  const sb = client();
  const hasTable = await checkHasZongSpellingTable();
  if (!hasTable) return;

  try {
    // 1. Process explicit deletions
    const deletedKeys = getDeletedSpellingKeys();
    if (deletedKeys.length > 0) {
      const { error: softErr } = await sb
        .from("zong_spelling_chart")
        .update({ is_deleted: true, updated_at: new Date().toISOString() })
        .in("tamil", deletedKeys);
      if (softErr) {
        await sb.from("zong_spelling_chart").delete().in("tamil", deletedKeys);
      }
      clearDeletedSpellingKeys(deletedKeys);
    }

    // 2. Upsert only changed entries (Fix #7: skip unchanged rows)
    const entries = Object.entries(spellingChart || {}).filter(
      ([k]) => !changedKeys || changedKeys.has(k)
    );
    if (entries.length > 0) {
      const rows = entries.map(([tamil, latin]) => ({
        tamil, latin, is_deleted: false, updated_at: new Date().toISOString()
      }));
      await sb.from("zong_spelling_chart").upsert(rows, { onConflict: "tamil" });
    }
  } catch (e) {
    console.warn("[Zong Sync] Failed writing zong_spelling_chart:", e);
  }
  // Fix #8: removed zong_global legacy write — table was dropped by schema migration.
}

/**
 * Pulls global state:
 * - songs from zong_songs
 * - spelling chart from zong_spelling_chart
 */
async function readGlobal() {
  const sb = client();
  const hasSongsTable = await checkHasZongSongsTable();

  const songs = [];
  const deletedSongIds = [];

  if (hasSongsTable) {
    try {
      // Fix #3: explicit column list instead of select('*')
      const { data: songRows, error: sErr } = await sb
        .from("zong_songs")
        .select("id, title, artist, key, tempo, time_signature, language, lyrics_text, chords_text, chart_text, drums_text, accents, key_quality, description, is_deleted, updated_at")
        .order("title", { ascending: true });

      if (!sErr && songRows) {
        songRows.forEach((r) => {
          if (r.is_deleted) deletedSongIds.push(r.id);
          else songs.push(rowToSong(r));
        });
      }
    } catch (e) {
      console.warn("[Zong Sync] Failed to read zong_songs:", e);
    }
  }

  // Fix #8: removed zong_global legacy migration fallback — dropped by schema.sql.
  const { chart: spellingChart, deletedKeys: deletedSpellingKeys } = await readSpellingChart();

  return {
    revision: 1,
    songs,
    deletedIds: deletedSongIds,
    spellingChart,
    deletedSpellingKeys
  };
}

/**
 * Writes global state:
 * - songs to zong_songs
 * - spelling chart to zong_spelling_chart
 */
/**
 * Writes global state to Supabase.
 * @param {object} params
 * @param {Array}  params.songs          - full local songs array
 * @param {object} params.spellingChart  - full local spelling chart
 * @param {Set<string>} [params.dirtySongIds]    - only upsert these songs (Fix #6)
 * @param {Set<string>} [params.dirtySpellingKeys] - only upsert these spelling keys (Fix #7)
 */
async function writeGlobal({ songs, spellingChart, dirtySongIds, dirtySpellingKeys }) {
  const hasSongsTable = await checkHasZongSongsTable();
  if (hasSongsTable) {
    try {
      // 1. Soft-delete songs that were explicitly removed
      const deletedIds = getDeletedSongIds();
      if (deletedIds.length > 0) {
        const { error: softErr } = await client()
          .from("zong_songs")
          .update({ is_deleted: true, updated_at: new Date().toISOString() })
          .in("id", deletedIds);
        if (softErr) {
          await client().from("zong_songs").delete().in("id", deletedIds);
        }
        clearDeletedSongIds(deletedIds);
      }

      // 2. Fix #6: only upsert songs that actually changed
      const songsToWrite = dirtySongIds
        ? (songs || []).filter((s) => dirtySongIds.has(s.id))
        : (songs || []);
      if (songsToWrite.length > 0) {
        const rows = songsToWrite.map(songToRow);
        await client().from("zong_songs").upsert(rows, { onConflict: "id" });
      }
    } catch (e) {
      console.warn("[Zong Sync] Failed writing to zong_songs table:", e);
    }
  }

  // 3. Fix #7: only write changed spelling entries
  await writeSpellingChart(spellingChart, dirtySpellingKeys);

  // Fix #8: removed zong_global legacy write.
  return { revision: 1, songs: songs || [], spellingChart };
}

// ---------------------------------------------------------------------------
//  Internal: Team table helpers (shared setlists only)
// ---------------------------------------------------------------------------

async function readTeam(teamKey) {
  const { data, error } = await client()
    .from("zong_teams")
    .select("revision, shared_setlists, subscribers")
    .eq("team_key", teamKey)
    .maybeSingle();

  if (error && error.code !== "PGRST116") throw new Error(`Team pull failed: ${error.message}`);

  return {
    revision:       data?.revision ?? 0,
    sharedSetlists: data?.shared_setlists ?? [],
    subscribers:    data?.subscribers ?? []
  };
}

async function writeTeam({ teamKey, sharedSetlists, baseRevision, deviceId, currentSubscribers = [] }) {
  const targetRevision = (baseRevision || 0) + 1;
  const nextSubs = Array.isArray(currentSubscribers) ? [...currentSubscribers] : [];
  if (deviceId && !nextSubs.includes(deviceId)) {
    nextSubs.push(deviceId);
  }

  const remote = await readTeam(teamKey);
  const mergedMap = new Map();
  (remote.sharedSetlists || []).forEach((rsl) => mergedMap.set(rsl.id, rsl));
  (sharedSetlists || []).forEach((lsl) => mergedMap.set(lsl.id, lsl));
  const merged = Array.from(mergedMap.values());

  const { data, error } = await client()
    .from("zong_teams")
    .upsert({
      team_key:        teamKey,
      shared_setlists: merged,
      revision:        targetRevision,
      subscribers:     nextSubs,
      updated_at:      new Date().toISOString()
    }, {
      onConflict:       "team_key",
      ignoreDuplicates: false
    })
    .select("revision, shared_setlists, subscribers");

  if (error) throw new Error(`Team push failed: ${error.message}`);

  const written = data?.[0];
  return {
    revision:       written?.revision ?? targetRevision,
    sharedSetlists: written?.shared_setlists ?? merged,
    subscribers:    written?.subscribers     ?? nextSubs
  };
}

export async function leaveTeam({ teamKey, deviceId }) {
  if (!teamKey || !isSupabaseConfigured()) return;
  try {
    const { data: team, error } = await client()
      .from("zong_teams")
      .select("subscribers, shared_setlists")
      .eq("team_key", teamKey)
      .maybeSingle();

    if (error || !team) return;

    let subs = Array.isArray(team.subscribers) ? team.subscribers : [];
    if (deviceId) {
      subs = subs.filter((id) => id !== deviceId);
    }

    if (subs.length === 0) {
      console.log(`[Zong Team] Deleting team ${teamKey} because 0 subscribers remain.`);
      await client()
        .from("zong_teams")
        .delete()
        .eq("team_key", teamKey);
    } else {
      await client()
        .from("zong_teams")
        .update({
          subscribers: subs,
          updated_at: new Date().toISOString()
        })
        .eq("team_key", teamKey);
    }
  } catch (err) {
    console.error("[Zong Team] Error during leaveTeam:", err);
  }
}

export async function checkIsOnlyTeamMember({ teamKey, deviceId }) {
  if (!teamKey || !isSupabaseConfigured()) return false;
  try {
    const { data: team, error } = await client()
      .from("zong_teams")
      .select("subscribers")
      .eq("team_key", teamKey)
      .maybeSingle();

    if (error || !team) return false;
    const subs = Array.isArray(team.subscribers) ? team.subscribers : [];
    if (subs.length === 0) return true;
    if (subs.length === 1 && (!deviceId || subs[0] === deviceId)) return true;
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
//  Public: syncLibrary
// ---------------------------------------------------------------------------

export async function syncLibrary({ key, state, revision = 0, changed, deviceId }) {
  const isTeam = Boolean(key && key.trim());

  const rev = typeof revision === "object" && revision !== null
    ? revision
    : { global: Number(revision) || 0, team: 0 };

  // ── 1. Sync global (songs + spelling chart) ────────────────────────────────
  const remote = await readGlobal();

  let nextGlobal = {
    revision:            remote.revision,
    songs:               remote.songs,
    deletedIds:          remote.deletedIds || [],
    spellingChart:       remote.spellingChart,
    deletedSpellingKeys: remote.deletedSpellingKeys || []
  };

  const isFreshRemote = (!remote.songs || remote.songs.length === 0) && (!remote.spellingChart || Object.keys(remote.spellingChart).length === 0);
  const hasLocalData  = (state.songs && state.songs.length > 0) || (state.spellingChart && Object.keys(state.spellingChart).length > 0);

  if (changed || (isFreshRemote && hasLocalData)) {
    // Snapshot deleted IDs BEFORE writeGlobal clears them so we can exclude
    // them when merging remote back — prevents deleted songs re-appearing.
    const preDeletedIds = new Set(getDeletedSongIds());

    await writeGlobal({
      songs:             state.songs || [],
      spellingChart:     state.spellingChart || {},
      dirtySongIds:      state.dirtySongIds,
      dirtySpellingKeys: state.dirtySpellingKeys,
    });

    // Build post-push nextGlobal: local state wins (we just pushed it), but pull
    // in any songs/spelling from remote that we don't have locally — this is how
    // fresh-install devices (local=empty) receive the full remote library.
    const localSongIds = new Set((state.songs || []).map((s) => s.id));
    const extraFromRemote = (remote.songs || []).filter(
      (rs) => !localSongIds.has(rs.id) && !preDeletedIds.has(rs.id)
    );
    nextGlobal = {
      revision:            1,
      songs:               [...(state.songs || []), ...extraFromRemote],
      deletedIds:          remote.deletedIds || [],
      // Remote wins for keys only it knows; local wins for recently changed keys
      spellingChart:       { ...(remote.spellingChart || {}), ...(state.spellingChart || {}) },
      deletedSpellingKeys: remote.deletedSpellingKeys || []
    };
  }

  // ── 2. Team sync (shared setlists only) ─────────────────────────────────────
  let nextTeam = {
    revision:       rev.team,
    sharedSetlists: state.sharedSetlists ?? []
  };
  let teamConflict = false;

  const localSharedSetlists = state.sharedSetlists ?? [];

  if (isTeam) {
    try {
    const remoteTeam = await readTeam(key);
    nextTeam.revision = remoteTeam.revision;
    nextTeam.sharedSetlists = remoteTeam.sharedSetlists;

    if (deviceId && Array.isArray(remoteTeam.subscribers) && !remoteTeam.subscribers.includes(deviceId)) {
      const updatedSubs = [...remoteTeam.subscribers, deviceId];
      try {
        await client()
          .from("zong_teams")
          .update({ subscribers: updatedSubs, updated_at: new Date().toISOString() })
          .eq("team_key", key);
        remoteTeam.subscribers = updatedSubs;
      } catch (e) {
        console.warn("[Zong Sync] Failed to register subscriber:", e);
      }
    }

    // Only push team data if explicitly changed, OR if local has setlists
    // the remote doesn't know about yet. This prevents an unnecessary write
    // on every background sync, which was causing "Syncing error" on Mac PWA.
    const remoteSetlistIds = new Set((remoteTeam.sharedSetlists || []).map((sl) => sl.id));
    const hasUnpushedSetlists = localSharedSetlists.some((sl) => !remoteSetlistIds.has(sl.id));
    const shouldPushTeam = changed || hasUnpushedSetlists;

    if (shouldPushTeam) {
      try {
        const pushedTeam = await writeTeam({
          teamKey:            key,
          sharedSetlists:     localSharedSetlists,
          baseRevision:       rev.team,
          deviceId,
          currentSubscribers: remoteTeam.subscribers
        });
        if (!pushedTeam) {
          teamConflict = true;
        } else {
          nextTeam = pushedTeam;
        }
      } catch (teamErr) {
        // Team write errors are non-fatal — log and fall back to the remote state
        // so the rest of the sync (songs, spelling chart) still succeeds.
        // This prevents "Syncing error" on Mac PWA from a transient team table issue.
        console.warn("[Zong Sync] Team push failed (non-fatal):", teamErr?.message);
        teamConflict = true;
      }
    } else {
      // Pull-only: merge remote setlists, with remote winning for shared content.
      const mergedMap = new Map();
      // Remote is source of truth for shared setlists.
      (remoteTeam.sharedSetlists || []).forEach((rsl) => mergedMap.set(rsl.id, rsl));
      // Add any local shared setlists that don't exist remotely yet.
      localSharedSetlists.forEach((lsl) => {
        if (!mergedMap.has(lsl.id)) mergedMap.set(lsl.id, lsl);
      });
      nextTeam.sharedSetlists = Array.from(mergedMap.values());
    }
    } catch (teamReadErr) {
      // If we can't reach the team table at all (network error, RLS, etc.),
      // skip team sync entirely — songs and spelling chart still sync normally.
      console.warn("[Zong Sync] Team read failed (non-fatal), skipping team sync:", teamReadErr?.message);
    }
  }

  // Detect differences between local and remote songs
  const localSongIds = new Set((state.songs || []).map((s) => s.id));
  const hasSongMembershipChange = (remote.songs || []).some((s) => !localSongIds.has(s.id)) ||
                                  (state.songs || []).some((s) => (remote.deletedIds || []).includes(s.id));
  const hasSongContentChange = (remote.songs || []).some((rs) => {
    const ls = (state.songs || []).find((s) => s.id === rs.id);
    return ls && rs.updatedAt && ls.updatedAt && rs.updatedAt > ls.updatedAt;
  });

  // Detect differences between local and remote spelling chart
  const remoteSpellingKeys = Object.keys(remote.spellingChart || {});
  const localSpellingKeys = Object.keys(state.spellingChart || {});
  const hasSpellingChange = remoteSpellingKeys.some((k) => (state.spellingChart || {})[k] !== remote.spellingChart[k]) ||
                            (remote.deletedSpellingKeys || []).some((k) => k in (state.spellingChart || {})) ||
                            remoteSpellingKeys.length !== localSpellingKeys.length;

  const hasGlobalUpdate = hasSongMembershipChange || hasSongContentChange || hasSpellingChange;
  // Deep-compare remote vs local shared setlists so that content changes
  // (renamed setlist, updated entries) are detected even when the count stays the same.
  const hasTeamUpdate = isTeam && (
    nextTeam.revision !== rev.team ||
    nextTeam.sharedSetlists.length !== (state.sharedSetlists?.length || 0) ||
    JSON.stringify(nextTeam.sharedSetlists) !== JSON.stringify(state.sharedSetlists || [])
  );

  return {
    revision: { global: 1, team: nextTeam.revision },
    state: {
      songs:               nextGlobal.songs,
      deletedIds:          nextGlobal.deletedIds || [],
      spellingChart:       nextGlobal.spellingChart,
      deletedSpellingKeys: nextGlobal.deletedSpellingKeys || [],
      sharedSetlists:      nextTeam.sharedSetlists
    },
    conflict: teamConflict,
    // Remove the !changed guard: remote data must always be applied to state
    // when it differs from local, regardless of whether we just pushed a write.
    // Without this, a fresh PWA install (changed=true, local empty) never receives
    // the songs already in Supabase.
    pulled: hasGlobalUpdate || hasTeamUpdate || (remote.songs || []).length !== (state.songs || []).length || (isTeam && (nextTeam.sharedSetlists?.length || 0) > 0)
  };
}

// ---------------------------------------------------------------------------
//  Public: Realtime subscriptions
// ---------------------------------------------------------------------------

let _songsChannel    = null;
let _spellingChannel = null;
let _teamChannel     = null;

/**
 * Subscribe to Realtime changes.
 * Fix #2: payloads are applied directly to local state — no full table refetch.
 * Fix #4: removed console.log from hot paths.
 *
 * Callbacks:
 *   onSongChange(eventType, song|null, songId)  — called per-song row change
 *   onSpellingChange(eventType, tamil, latin)    — called per-spelling row change
 *   onTeamChange({ revision, sharedSetlists })   — called on team row change
 */
export function subscribeToChanges({ onSongChange, onSpellingChange, onTeam, teamKey }) {
  const sb = client();

  // 1. Songs channel — apply row payload directly, never re-read the whole table
  _songsChannel = sb
    .channel("zong_songs_changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "zong_songs" },
      (payload) => {
        if (!onSongChange) return;
        const row = payload.new ?? payload.old;
        const eventType = payload.eventType; // INSERT | UPDATE | DELETE
        if (!row?.id) return;
        // For DELETE or soft-delete (is_deleted=true), pass null as song
        const song = (eventType === "DELETE" || row.is_deleted) ? null : rowToSong(row);
        onSongChange(eventType, song, row.id);
      }
    )
    .subscribe();

  // 2. Spelling channel — apply row payload directly
  _spellingChannel = sb
    .channel("zong_spelling_changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "zong_spelling_chart" },
      (payload) => {
        if (!onSpellingChange) return;
        const row = payload.new ?? payload.old;
        if (!row?.tamil) return;
        const eventType = payload.eventType;
        // Pass null for latin when the row is deleted or soft-deleted
        const latin = (eventType === "DELETE" || row.is_deleted) ? null : row.latin;
        onSpellingChange(eventType, row.tamil, latin);
      }
    )
    .subscribe();

  // 3. Team channel — payload already has the full shared_setlists JSON column
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
    if (_songsChannel)    { sb.removeChannel(_songsChannel);    _songsChannel    = null; }
    if (_spellingChannel) { sb.removeChannel(_spellingChannel); _spellingChannel = null; }
    if (_teamChannel)     { sb.removeChannel(_teamChannel);     _teamChannel     = null; }
  };
}

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}
