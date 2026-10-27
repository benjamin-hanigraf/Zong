/**
 * supabaseSync.js
 *
 * Multi-device synchronization engine for Zong (Supabase free-tier friendly).
 *
 * Tables:
 *   zong_songs          — one row per song
 *   zong_spelling_chart — one row per Tamil → Tanglish override
 *   zong_teams          — one row per team key (shared_setlists JSON + subscribers)
 *
 * Design rules (to keep egress/requests minimal):
 *   1. WRITES happen only when the user commits (Done / Save). Callers mark
 *      ids dirty; `syncLibrary` pushes just those rows.
 *   2. READS are incremental: only rows with updated_at >= a persisted cursor
 *      are downloaded (full download only on a device's very first sync).
 *   3. LIVE updates come from Realtime payloads, which are applied directly —
 *      no refetch.
 *   4. All queues (dirty rows, pending deletions, pending shared-setlist
 *      pushes/deletes) are persisted in localStorage so nothing is lost if the
 *      app closes or the device is offline.
 *   5. Team writes use optimistic concurrency (compare-and-swap on `revision`)
 *      so two devices can never silently overwrite each other.
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

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

// ---------------------------------------------------------------------------
//  Persisted queues  (id -> timestamp maps in localStorage)
// ---------------------------------------------------------------------------

function makeQueue(storageKey) {
  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(storageKey) || "{}");
      if (Array.isArray(v)) { const o = {}; v.forEach((id) => { o[id] = 0; }); return o; } // legacy array
      return v && typeof v === "object" ? v : {};
    } catch { return {}; }
  };
  const write = (o) => { try { localStorage.setItem(storageKey, JSON.stringify(o)); } catch { /* ignore */ } };
  return {
    add(ids) {
      const list = Array.isArray(ids) ? ids : [ids];
      if (!list.length) return;
      const o = read(); const now = Date.now();
      list.forEach((id) => { if (id != null && id !== "") o[id] = now; });
      write(o);
    },
    remove(ids) {
      const list = Array.isArray(ids) ? ids : [ids];
      const o = read(); list.forEach((id) => { delete o[id]; }); write(o);
    },
    // Remove only entries not re-queued since `snapshotTs` (protects edits made mid-flight).
    clearUpTo(ids, snapshotTs) {
      const o = read();
      ids.forEach((id) => { if ((o[id] ?? 0) <= snapshotTs) delete o[id]; });
      write(o);
    },
    ids() { return Object.keys(read()); },
    has(id) { return Object.prototype.hasOwnProperty.call(read(), id); },
    clearAll() { write({}); }
  };
}

const dirtySongs      = makeQueue("zong:q:dirty-songs");
const deletedSongs    = makeQueue("zong:deleted-song-ids");
const dirtySpelling   = makeQueue("zong:q:dirty-spelling");
const deletedSpelling = makeQueue("zong:deleted-spelling-keys");
const pendingShared   = makeQueue("zong:q:pending-shared");   // shared setlists awaiting push (after Done)
const deletedShared   = makeQueue("zong:q:deleted-shared");   // shared setlists awaiting removal from team

export const markSongsDirty        = (ids) => dirtySongs.add(ids);
export const markSpellingDirty     = (keys) => dirtySpelling.add(keys);
export const recordDeletedSongId   = (id) => { deletedSongs.add(id); dirtySongs.remove(id); };
export const recordDeletedSpellingKey = (k) => { deletedSpelling.add(k); dirtySpelling.remove(k); };
export const getDirtySongIds       = () => dirtySongs.ids();
export const getDirtySpellingKeys  = () => dirtySpelling.ids();
export const markSharedPending     = (id) => { pendingShared.add(id); deletedShared.remove(id); };
export const markSharedDeleted     = (id) => { deletedShared.add(id); pendingShared.remove(id); };
export const getPendingSharedIds   = () => pendingShared.ids();
export const getDeletedSharedIds   = () => deletedShared.ids();
export const clearSharedQueues     = () => { pendingShared.clearAll(); deletedShared.clearAll(); };

// Pull cursors (server `updated_at` high-water marks)
const CURSOR_KEY = "zong:pull-cursor";
const CURSOR_MARGIN_MS = 120000; // re-read a 2-minute overlap to tolerate client clock skew
function readCursor() {
  try { return JSON.parse(localStorage.getItem(CURSOR_KEY) || "{}") || {}; } catch { return {}; }
}
function writeCursor(c) { try { localStorage.setItem(CURSOR_KEY, JSON.stringify(c)); } catch { /* ignore */ } }
function cursorToFilter(iso) {
  if (!iso) return null;
  return new Date(new Date(iso).getTime() - CURSOR_MARGIN_MS).toISOString();
}
function maxIso(rows, prev) {
  let best = prev || "";
  rows.forEach((r) => { if (r.updated_at && r.updated_at > best) best = r.updated_at; });
  return best;
}

// ---------------------------------------------------------------------------
//  Row mapping
// ---------------------------------------------------------------------------

const SONG_COLUMNS = "id, title, artist, key, tempo, time_signature, language, lyrics_text, chords_text, chart_text, drums_text, key_quality, description, is_deleted, updated_at";

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
    // accents and subdivision are device-local; not stored in Supabase.
    keyQuality:    row.key_quality || "Major",
    description:   row.description || "",
    updatedAt:     row.updated_at ? new Date(row.updated_at).getTime() : Date.now()
  };
}

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
    // accents and subdivision are device-local; never written to Supabase.
    key_quality:    song.keyQuality || "Major",
    description:    song.description || "",
    is_deleted:     false,
    updated_at:     new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
//  Songs
// ---------------------------------------------------------------------------

async function pullSongs(cursorIso) {
  let q = client().from("zong_songs").select(SONG_COLUMNS);
  const since = cursorToFilter(cursorIso);
  if (since) q = q.gte("updated_at", since);
  const { data, error } = await q;
  if (error) throw new Error(`Songs pull failed: ${error.message}`);
  const rows = data || [];
  return {
    songs: rows.filter((r) => !r.is_deleted).map(rowToSong),
    deletedIds: rows.filter((r) => r.is_deleted).map((r) => r.id),
    allIds: rows.map((r) => r.id),
    cursor: maxIso(rows, cursorIso)
  };
}

async function pushSongs(songs) {
  const snapshotTs = Date.now();

  // 1. Soft-delete explicitly removed songs
  const delIds = deletedSongs.ids();
  if (delIds.length) {
    const { error } = await client().from("zong_songs")
      .upsert(delIds.map((id) => ({ id, title: "", is_deleted: true, updated_at: new Date().toISOString() })), { onConflict: "id" });
    if (error) throw new Error(`Song delete failed: ${error.message}`);
    deletedSongs.clearUpTo(delIds, snapshotTs);
  }

  // 2. Upsert only dirty songs (batched)
  const dirtyIds = dirtySongs.ids();
  if (dirtyIds.length) {
    const byId = new Map((songs || []).map((s) => [s.id, s]));
    const rows = dirtyIds.map((id) => byId.get(id)).filter(Boolean).map(songToRow);
    if (rows.length) {
      const { error } = await client().from("zong_songs").upsert(rows, { onConflict: "id" });
      if (error) throw new Error(`Song push failed: ${error.message}`);
    }
    dirtySongs.clearUpTo(dirtyIds, snapshotTs);
  }
  return delIds.length > 0 || dirtyIds.length > 0;
}

// ---------------------------------------------------------------------------
//  Spelling chart
// ---------------------------------------------------------------------------

async function pullSpelling(cursorIso) {
  let q = client().from("zong_spelling_chart").select("tamil, latin, is_deleted, updated_at");
  const since = cursorToFilter(cursorIso);
  if (since) q = q.gte("updated_at", since);
  const { data, error } = await q;
  if (error) throw new Error(`Spelling pull failed: ${error.message}`);
  const rows = data || [];
  const upserts = {};
  const deleted = [];
  rows.forEach((r) => { if (r.is_deleted) deleted.push(r.tamil); else upserts[r.tamil] = r.latin; });
  return { upserts, deleted, allKeys: rows.map((r) => r.tamil), cursor: maxIso(rows, cursorIso) };
}

async function pushSpelling(chart) {
  const snapshotTs = Date.now();
  const delKeys = deletedSpelling.ids();
  if (delKeys.length) {
    const now = new Date().toISOString();
    const { error } = await client().from("zong_spelling_chart")
      .upsert(delKeys.map((tamil) => ({ tamil, latin: "", is_deleted: true, updated_at: now })), { onConflict: "tamil" });
    if (error) throw new Error(`Spelling delete failed: ${error.message}`);
    deletedSpelling.clearUpTo(delKeys, snapshotTs);
  }
  const dirtyKeys = dirtySpelling.ids();
  if (dirtyKeys.length) {
    const now = new Date().toISOString();
    const rows = dirtyKeys.filter((k) => chart && k in chart)
      .map((tamil) => ({ tamil, latin: chart[tamil], is_deleted: false, updated_at: now }));
    if (rows.length) {
      const { error } = await client().from("zong_spelling_chart").upsert(rows, { onConflict: "tamil" });
      if (error) throw new Error(`Spelling push failed: ${error.message}`);
    }
    dirtySpelling.clearUpTo(dirtyKeys, snapshotTs);
  }
  return delKeys.length > 0 || dirtyKeys.length > 0;
}

// ---------------------------------------------------------------------------
//  Teams (shared setlists)
// ---------------------------------------------------------------------------

async function readTeamRow(teamKey) {
  const { data, error } = await client()
    .from("zong_teams")
    .select("revision, shared_setlists, subscribers")
    .eq("team_key", teamKey)
    .maybeSingle();
  if (error) throw new Error(`Team pull failed: ${error.message}`);
  return data
    ? { exists: true, revision: data.revision ?? 0, sharedSetlists: data.shared_setlists ?? [], subscribers: data.subscribers ?? [] }
    : { exists: false, revision: 0, sharedSetlists: [], subscribers: [] };
}

/**
 * Atomic read-modify-write on a team row. `mutate(sharedSetlists)` returns the
 * new list (or the same reference to signal "no change"). Retries on conflict.
 * A write only succeeds if `revision` is unchanged since we read it.
 */
async function mutateTeam({ teamKey, deviceId, mutate }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await readTeamRow(teamKey);
    const subs = [...row.subscribers];
    const joined = deviceId && !subs.includes(deviceId);
    if (joined) subs.push(deviceId);
    const next = mutate(row.sharedSetlists);
    const changed = next !== row.sharedSetlists;

    if (!changed && !joined && row.exists) return { revision: row.revision, sharedSetlists: row.sharedSetlists, wrote: false };

    const payload = {
      shared_setlists: next,
      subscribers: subs,
      revision: row.revision + 1,
      updated_at: new Date().toISOString()
    };

    if (!row.exists) {
      const { error } = await client().from("zong_teams").insert({ team_key: teamKey, ...payload });
      if (!error) return { revision: payload.revision, sharedSetlists: next, wrote: true };
      if (error.code === "23505") continue; // someone created it first — retry as update
      throw new Error(`Team push failed: ${error.message}`);
    }

    const { data, error } = await client().from("zong_teams")
      .update(payload)
      .eq("team_key", teamKey)
      .eq("revision", row.revision)
      .select("revision");
    if (error) throw new Error(`Team push failed: ${error.message}`);
    if (data && data.length) return { revision: payload.revision, sharedSetlists: next, wrote: true };
    // else: revision moved under us → loop and retry
  }
  throw new Error("Team busy — please retry");
}

// Strip device-local overrides that were never explicitly saved to the team.
function toRemoteSetlist(sl) {
  const { shared, ...rest } = sl;
  return {
    ...rest,
    entries: (sl.entries || []).map((e) => ({
      songId: e.songId,
      keyOverride:   e.syncedKeyOverride   !== undefined ? e.syncedKeyOverride   : (e.keyOverride   ?? null),
      tempoOverride: e.syncedTempoOverride !== undefined ? e.syncedTempoOverride : (e.tempoOverride ?? null)
    }))
  };
}

/**
 * Creates/touches the team row when a device enters a team code.
 * Returns null on success or an error message string.
 */
export async function ensureTeamRow({ teamKey, deviceId }) {
  if (!teamKey || !isSupabaseConfigured()) return null;
  try {
    await mutateTeam({ teamKey, deviceId, mutate: (l) => l });
    return null;
  } catch (err) {
    return err?.message || "Unknown error";
  }
}

/** Removes this device from the team; deletes the team row once nobody is left. */
export async function leaveTeam({ teamKey, deviceId }) {
  if (!teamKey || !isSupabaseConfigured()) return;
  try {
    const row = await readTeamRow(teamKey);
    if (!row.exists) return;
    const subs = row.subscribers.filter((id) => id !== deviceId);
    if (subs.length === 0) {
      await client().from("zong_teams").delete().eq("team_key", teamKey);
    } else {
      await client().from("zong_teams")
        .update({ subscribers: subs, updated_at: new Date().toISOString() })
        .eq("team_key", teamKey);
    }
  } catch (err) {
    console.error("[Zong Team] Error during leaveTeam:", err);
  }
}

export async function checkIsOnlyTeamMember({ teamKey, deviceId }) {
  if (!teamKey || !isSupabaseConfigured()) return false;
  try {
    const row = await readTeamRow(teamKey);
    if (!row.exists) return false;
    const subs = row.subscribers;
    return subs.length === 0 || (subs.length === 1 && (!deviceId || subs[0] === deviceId));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
//  Public: syncLibrary
// ---------------------------------------------------------------------------

/**
 * One sync cycle:  push queued local changes, then pull whatever changed remotely.
 *
 * @param {object} p
 * @param {string}  p.teamKey
 * @param {string}  p.deviceId
 * @param {Array}   p.songs           local songs
 * @param {object}  p.spellingChart   local spelling chart
 * @param {Array}   p.sharedSetlists  local shared setlists (used for pending pushes)
 * @param {boolean} [p.pullTeam=true] whether to read the team row when nothing needs pushing
 *
 * @returns {{ songs, deletedSongIds, spelling:{upserts,deleted}, team:null|{revision,sharedSetlists}, teamError }}
 */
export async function syncLibrary({ teamKey, deviceId, songs, spellingChart, sharedSetlists = [] }) {
  const cursor = readCursor();
  const isFirstSongSync = !cursor.songs;

  // ── Songs & spelling: push first, then incremental pull ────────────────────
  await pushSongs(songs);
  await pushSpelling(spellingChart);

  const [songPull, spellPull] = await Promise.all([pullSongs(cursor.songs), pullSpelling(cursor.spelling)]);

  // First sync on this device: upload any local-only songs/spellings the server has never seen.
  if (isFirstSongSync) {
    const remoteSongIds = new Set(songPull.allIds);
    const localOnly = (songs || []).filter((s) => !remoteSongIds.has(s.id));
    if (localOnly.length) {
      const { error } = await client().from("zong_songs").upsert(localOnly.map(songToRow), { onConflict: "id" });
      if (error) throw new Error(`Song push failed: ${error.message}`);
    }
  }
  if (!cursor.spelling) {
    const remoteKeys = new Set(spellPull.allKeys);
    const localOnlyKeys = Object.keys(spellingChart || {}).filter((k) => !remoteKeys.has(k));
    // Only upload user overrides when the table is empty (avoids pushing the whole built-in dictionary).
    if (localOnlyKeys.length && spellPull.allKeys.length === 0) {
      const now = new Date().toISOString();
      const { error } = await client().from("zong_spelling_chart")
        .upsert(localOnlyKeys.map((tamil) => ({ tamil, latin: spellingChart[tamil], is_deleted: false, updated_at: now })), { onConflict: "tamil" });
      if (error) throw new Error(`Spelling push failed: ${error.message}`);
    }
  }
  writeCursor({ songs: songPull.cursor || cursor.songs || new Date(0).toISOString(), spelling: spellPull.cursor || cursor.spelling || new Date(0).toISOString() });

  // ── Team: push queued shared-setlist changes, then pull ────────────────────
  let team = null;
  let teamError = null;
  if (teamKey) {
    try {
      const pendingIds = new Set(pendingShared.ids());
      const deleteIds  = new Set(deletedShared.ids());
      const snapshotTs = Date.now();
      const toPush = (sharedSetlists || []).filter((sl) => pendingIds.has(sl.id)).map(toRemoteSetlist);

      const res = await mutateTeam({
        teamKey,
        deviceId,
        mutate: (remote) => {
          if (!toPush.length && !deleteIds.size) return remote;
          const pushMap = new Map(toPush.map((sl) => [sl.id, sl]));
          let changed = false;
          const kept = [];
          remote.forEach((sl) => {
            if (deleteIds.has(sl.id)) { changed = true; return; }
            if (pushMap.has(sl.id)) { kept.push(pushMap.get(sl.id)); pushMap.delete(sl.id); changed = true; return; }
            kept.push(sl);
          });
          pushMap.forEach((sl) => { kept.push(sl); changed = true; });
          return changed ? kept : remote;
        }
      });
      pendingShared.clearUpTo([...pendingIds], snapshotTs);
      deletedShared.clearUpTo([...deleteIds], snapshotTs);
      team = { revision: res.revision, sharedSetlists: res.sharedSetlists };
    } catch (err) {
      teamError = err?.message || "Team sync failed";
    }
  }

  return {
    songs: songPull.songs,
    deletedSongIds: songPull.deletedIds,
    spelling: { upserts: spellPull.upserts, deleted: spellPull.deleted },
    team,
    teamError
  };
}

// ---------------------------------------------------------------------------
//  Public: Realtime subscriptions
// ---------------------------------------------------------------------------

let _songsChannel    = null;
let _spellingChannel = null;
let _teamChannel     = null;

/**
 * Realtime payloads are applied directly to local state — no refetch.
 *   onSongChange(eventType, song|null, songId)
 *   onSpellingChange(eventType, tamil, latin|null)
 *   onTeam({ revision, sharedSetlists })
 */
export function subscribeToChanges({ onSongChange, onSpellingChange, onTeam, teamKey }) {
  const sb = client();

  _songsChannel = sb
    .channel("zong_songs_changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "zong_songs" }, (payload) => {
      if (!onSongChange) return;
      const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
      if (!row?.id) return;
      const gone = payload.eventType === "DELETE" || row.is_deleted;
      onSongChange(payload.eventType, gone ? null : rowToSong(row), row.id);
    })
    .subscribe();

  _spellingChannel = sb
    .channel("zong_spelling_changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "zong_spelling_chart" }, (payload) => {
      if (!onSpellingChange) return;
      const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
      if (!row?.tamil) return;
      const gone = payload.eventType === "DELETE" || row.is_deleted;
      onSpellingChange(payload.eventType, row.tamil, gone ? null : row.latin);
    })
    .subscribe();

  if (teamKey && onTeam) {
    _teamChannel = sb
      .channel(`zong_team_${teamKey}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "zong_teams", filter: `team_key=eq.${teamKey}` }, (payload) => {
        const row = payload.new;
        if (row) onTeam({ revision: row.revision ?? 0, sharedSetlists: row.shared_setlists ?? [] });
      })
      .subscribe();
  }

  return function unsubscribe() {
    if (_songsChannel)    { sb.removeChannel(_songsChannel);    _songsChannel    = null; }
    if (_spellingChannel) { sb.removeChannel(_spellingChannel); _spellingChannel = null; }
    if (_teamChannel)     { sb.removeChannel(_teamChannel);     _teamChannel     = null; }
  };
}

/** Wipes pull cursors so the next sync does a full download (used on team change / manual reset). */
export function resetSyncCursors() {
  try { localStorage.removeItem(CURSOR_KEY); } catch { /* ignore */ }
}
