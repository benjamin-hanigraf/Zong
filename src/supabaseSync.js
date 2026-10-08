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

  let chart = {};
  const deletedKeys = [];
  let readFromTable = false;

  if (hasTable) {
    try {
      const { data: rows, error } = await sb
        .from("zong_spelling_chart")
        .select("tamil, latin, is_deleted, updated_at")
        .order("tamil", { ascending: true });

      if (!error && rows) {
        readFromTable = true;
        rows.forEach((r) => {
          if (r.is_deleted) {
            deletedKeys.push(r.tamil);
          } else {
            chart[r.tamil] = r.latin;
          }
        });
      }
    } catch (e) {
      console.warn("[Zong Sync] Failed reading zong_spelling_chart:", e);
    }
  }

  // Graceful fallback: If zong_global still exists before being dropped, migrate its spelling_chart
  if (!readFromTable || Object.keys(chart).length === 0) {
    try {
      const { data: globalData, error } = await sb
        .from("zong_global")
        .select("spelling_chart")
        .eq("id", "main")
        .maybeSingle();

      if (!error && globalData?.spelling_chart && typeof globalData.spelling_chart === "object") {
        if (hasTable && readFromTable && Object.keys(chart).length === 0) {
          const rows = Object.entries(globalData.spelling_chart).map(([tamil, latin]) => ({
            tamil,
            latin,
            is_deleted: false,
            updated_at: new Date().toISOString()
          }));
          if (rows.length > 0) {
            await sb.from("zong_spelling_chart").upsert(rows, { onConflict: "tamil" });
          }
        }
        chart = { ...globalData.spelling_chart, ...chart };
      }
    } catch {}
  }

  return { chart, deletedKeys };
}

/**
 * Writes spelling chart entries to zong_spelling_chart.
 */
async function writeSpellingChart(spellingChart) {
  const sb = client();
  const hasTable = await checkHasZongSpellingTable();

  if (hasTable) {
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

      // 2. Upsert active spelling entries
      const entries = Object.entries(spellingChart || {});
      const rows = entries.map(([tamil, latin]) => ({
        tamil,
        latin,
        is_deleted: false,
        updated_at: new Date().toISOString()
      }));

      if (rows.length > 0) {
        await sb.from("zong_spelling_chart").upsert(rows, { onConflict: "tamil" });
      }
    } catch (e) {
      console.warn("[Zong Sync] Failed writing zong_spelling_chart:", e);
    }
  }

  // Optional legacy backup to zong_global if it still exists (ignored if dropped)
  try {
    await sb
      .from("zong_global")
      .update({ spelling_chart: spellingChart, updated_at: new Date().toISOString() })
      .eq("id", "main");
  } catch {}
}

/**
 * Pulls global state:
 * - songs from zong_songs
 * - spelling chart from zong_spelling_chart
 */
async function readGlobal() {
  const sb = client();
  const hasSongsTable = await checkHasZongSongsTable();

  let songs = [];
  const deletedSongIds = [];
  let songsFromTable = false;

  if (hasSongsTable) {
    try {
      const { data: songRows, error: sErr } = await sb
        .from("zong_songs")
        .select("*")
        .order("title", { ascending: true });

      if (!sErr && songRows) {
        songsFromTable = true;
        songRows.forEach((r) => {
          if (r.is_deleted) {
            deletedSongIds.push(r.id);
          } else {
            songs.push(rowToSong(r));
          }
        });
      }
    } catch (e) {
      console.warn("[Zong Sync] Failed to read zong_songs:", e);
    }
  }

  // Read spelling chart from zong_spelling_chart
  const { chart: spellingChart, deletedKeys: deletedSpellingKeys } = await readSpellingChart();

  // If songs table has 0 rows and zong_global still exists, migrate legacy songs
  if (!hasSongsTable || (songsFromTable && songs.length === 0)) {
    try {
      const { data: globalData, error } = await sb
        .from("zong_global")
        .select("songs")
        .eq("id", "main")
        .maybeSingle();

      if (!error && Array.isArray(globalData?.songs) && globalData.songs.length > 0) {
        if (hasSongsTable && songsFromTable && songs.length === 0) {
          const rows = globalData.songs.map(songToRow);
          if (rows.length > 0) {
            await sb.from("zong_songs").upsert(rows, { onConflict: "id" });
          }
        }
        songs = globalData.songs.map((s) => ({ ...s, subdivision: 1 }));
      }
    } catch {}
  }

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
async function writeGlobal({ songs, spellingChart }) {
  const onlineSongs = (songs || []).map((s) => ({
    ...s,
    subdivision: 1
  }));

  const hasSongsTable = await checkHasZongSongsTable();
  if (hasSongsTable) {
    try {
      // 1. Process explicit song deletions
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

      // 2. Upsert active songs
      const rows = onlineSongs.map(songToRow);
      if (rows.length > 0) {
        await client().from("zong_songs").upsert(rows, { onConflict: "id" });
      }
    } catch (e) {
      console.warn("[Zong Sync] Failed writing to zong_songs table:", e);
    }
  }

  // 3. Write spelling chart to zong_spelling_chart
  await writeSpellingChart(spellingChart);

  // Optional legacy backup to zong_global if it still exists (ignored if dropped)
  try {
    await client()
      .from("zong_global")
      .update({
        songs: onlineSongs,
        spelling_chart: spellingChart,
        updated_at: new Date().toISOString()
      })
      .eq("id", "main");
  } catch {}

  return {
    revision: 1,
    songs: onlineSongs,
    spellingChart
  };
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
    const pushed = await writeGlobal({
      songs:         state.songs || [],
      spellingChart: state.spellingChart || {},
      baseRevision:  rev.global
    });

    nextGlobal = {
      ...pushed,
      deletedIds:          remote.deletedIds || [],
      deletedSpellingKeys: remote.deletedSpellingKeys || []
    };
  }

  // ── 2. Team sync (shared setlists only) ─────────────────────────────────────
  let nextTeam = {
    revision:       rev.team,
    sharedSetlists: state.sharedSetlists ?? []
  };
  let teamConflict = false;

  if (isTeam) {
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

    if (changed) {
      const pushedTeam = await writeTeam({
        teamKey:            key,
        sharedSetlists:     state.sharedSetlists ?? [],
        baseRevision:       rev.team,
        deviceId,
        currentSubscribers: remoteTeam.subscribers
      });
      if (!pushedTeam) {
        teamConflict = true;
      } else {
        nextTeam = pushedTeam;
      }
    } else {
      const mergedMap = new Map();
      (remoteTeam.sharedSetlists || []).forEach((rsl) => mergedMap.set(rsl.id, rsl));
      (state.sharedSetlists || []).forEach((lsl) => {
        if (!mergedMap.has(lsl.id)) mergedMap.set(lsl.id, lsl);
      });
      nextTeam.sharedSetlists = Array.from(mergedMap.values());
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
  const hasTeamUpdate   = isTeam && (nextTeam.revision !== rev.team || nextTeam.sharedSetlists.length !== (state.sharedSetlists?.length || 0));

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
    pulled:   !changed && (hasGlobalUpdate || hasTeamUpdate || (remote.songs || []).length !== (state.songs || []).length || (isTeam && (nextTeam.sharedSetlists?.length || 0) > 0))
  };
}

// ---------------------------------------------------------------------------
//  Public: Realtime subscriptions
// ---------------------------------------------------------------------------

let _songsChannel    = null;
let _spellingChannel = null;
let _teamChannel     = null;

export function subscribeToChanges({ onGlobal, onTeam, teamKey }) {
  const sb = client();

  // 1. Songs channel — listen to ALL events on zong_songs
  _songsChannel = sb
    .channel("zong_songs_changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "zong_songs" },
      async (payload) => {
        console.log("[Zong Realtime] Received song change from Supabase:", payload);
        if (onGlobal) {
          const fresh = await readGlobal();
          onGlobal(fresh);
        }
      }
    )
    .subscribe((status) => {
      console.log("[Zong Realtime] Songs channel status:", status);
    });

  // 2. Spelling channel — listen to ALL events on zong_spelling_chart
  _spellingChannel = sb
    .channel("zong_spelling_changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "zong_spelling_chart" },
      async (payload) => {
        console.log("[Zong Realtime] Received spelling change from Supabase:", payload);
        if (onGlobal) {
          const fresh = await readGlobal();
          onGlobal(fresh);
        }
      }
    )
    .subscribe((status) => {
      console.log("[Zong Realtime] Spelling channel status:", status);
    });

  // 3. Team channel (only if a team key is set)
  if (teamKey && onTeam) {
    _teamChannel = sb
      .channel(`zong_team_${teamKey}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "zong_teams", filter: `team_key=eq.${teamKey}` },
        (payload) => {
          console.log("[Zong Realtime] Received team change from Supabase:", payload);
          const row = payload.new;
          if (row && onTeam) {
            onTeam({
              revision:       row.revision        ?? 0,
              sharedSetlists: row.shared_setlists ?? []
            });
          }
        }
      )
      .subscribe((status) => {
        console.log(`[Zong Realtime] Team (${teamKey}) channel status:`, status);
      });
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
