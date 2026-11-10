// App shell: state, sync, routing between tabs and overlays. Screens live in ./screens, shared pieces in ./components and ./lib.
import { clearSharedQueues, ensureTeamRow, getDeletedSharedIds, getDirtySongIds, getDirtySpellingKeys, getPendingSharedIds, isSupabaseConfigured, leaveTeam, markSharedDeleted, markSharedPending, markSongsDirty, markSpellingDirty, recordDeletedSongId, recordDeletedSpellingKey, subscribeToChanges, syncLibrary } from "./supabaseSync";
import { isNativePlatform } from "./nativeMetronome";
import { tidySections } from "./sections.js";
import { cleanStructure } from "./lib/structure.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { getDeviceId } from "./lib/device.js";
import { hasOpenLayer, isShown, isTypingTarget } from "./lib/keys.js";
import { useIndexedDbState, useLocalStorageState } from "./lib/storage.js";
import { DEFAULT_CLICK_SETTINGS, FONT, colorsFor } from "./lib/constants.js";
import { SONG_ACCENTS_KEY, getSongSubdivision, setSongAccentsLocal, setSongSubdivision } from "./lib/songDevice.js";
import { KEY_TO_SEMITONE } from "./lib/chords.js";
import { formatTimeSig, uid } from "./lib/helpers.js";
import { REMOVED_SEED_WORDS, TANGLISH_EXCEPTIONS, setActiveTanglishExceptions } from "./lib/tanglish.js";
import { applyTamilScale } from "./components/Tamil.jsx";
import { convertOldDrumsText, drumsFromEditor, drumsToEditor, isNewDrumsText, migrateSongShape } from "./lib/songModel.js";
import { DEVICE_CLASS, startPhoneOrientationLock } from "./lib/viewport.js";
import { getSharedAudioContext, loadAudioSamples } from "./lib/audio.js";
import { playingStore, useMetronomeEngine } from "./lib/metronomeEngine.js";
import { useLiveSync } from "./lib/liveSync.js";
import { MetronomeScreen } from "./screens/MetronomeScreen.jsx";
import { PianoScreen } from "./screens/PianoScreen.jsx";
import { SongsScreen } from "./screens/SongsScreen.jsx";
import { SetlistStageScreen, SetlistsScreen } from "./screens/SetlistScreens.jsx";
import { SettingsScreen } from "./screens/SettingsScreen.jsx";
import { joystickChord } from "./components/ChordJoystick.jsx";
import { BottomNav, Toast } from "./components/chrome.jsx";
import { SongForm } from "./screens/SongForm.jsx";
import { SongDetailScreen } from "./screens/SongDetailScreen.jsx";
import { SpellingChartScreen } from "./screens/SpellingChart.jsx";
import { DeleteSetlistModal, DeleteSongModal, RemoveSharedSongModal, StageModeModal, TeamKeyModal } from "./components/dialogs.jsx";

function AppInner() {
  useEffect(() => {
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "viewport";
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover");
  }, []);

  const [songs, setSongs, songsReady] = useIndexedDbState("songs", []);
  const [setlists, persistSetlists] = useIndexedDbState("setlists", []);
  const [fontSize, setFontSize] = useLocalStorageState("altar:font-size", 16);
  const [chordFontSize, setChordFontSize] = useLocalStorageState("altar:chord-font-size", 16);
  const [sectionFontSize, setSectionFontSize] = useLocalStorageState("altar:section-font-size", 12);
  const [textAlign, setTextAlign] = useLocalStorageState("altar:text-align", "left");
  const [lyricsBold, setLyricsBold] = useLocalStorageState("altar:lyrics-bold", false);
  const [notesBold, setNotesBold] = useLocalStorageState("altar:notes-bold", false);
  const [lineSpacing, setLineSpacing] = useLocalStorageState("altar:line-spacing", 1.40);
  const [noteSpacing, setNoteSpacing] = useLocalStorageState("altar:note-spacing", 0.30);
  // The Tight / Airy line spacings were widened (1.2 -> 1.15, 1.7 -> 1.9): a saved old value moves to its new equivalent once.
  useEffect(() => {
    if (Math.abs(lineSpacing - 1.7) < 0.001) setLineSpacing(1.9);
    else if (Math.abs(lineSpacing - 1.2) < 0.001) setLineSpacing(1.15);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [mode, setMode] = useLocalStorageState("altar:mode", "vocals");
  const [clickSettings, setClickSettings] = useLocalStorageState("altar:click-settings", DEFAULT_CLICK_SETTINGS);
  const [tanglishMode, setTanglishMode] = useLocalStorageState("altar:tanglish", false);
  const [spellingChart, setSpellingChart, spellingReady] = useIndexedDbState("tanglish-spelling-chart", TANGLISH_EXCEPTIONS);
  const [spellingChartOpen, setSpellingChartOpen] = useState(false);
  // Keep the runtime transliteration dictionary in sync with persisted edits.
  useEffect(() => { setActiveTanglishExceptions(spellingChart); }, [spellingChart]);
  const [bandKey, setBandKey] = useState(() => localStorage.getItem("zong:access-key") || "");
  const [syncStatus, setSyncStatus] = useState(() => bandKey ? "Ready" : "Public only");
  const [firstSyncDone, setFirstSyncDone] = useState(false);
  // Shared setlist ids edited locally but not yet committed with "Done" —
  // incoming remote updates must not clobber these mid-edit.
  const uncommittedSharedEdits = useRef(new Set());
  // A brand-new setlist lives only here until the user presses Done with ≥1 song.
  const [draftSetlist, setDraftSetlist] = useState(null);
  const syncing = useRef(false);
  // A sync must never start from an empty, not-yet-loaded copy of the library.
  const storesReadyRef = useRef(false);
  storesReadyRef.current = songsReady && spellingReady;

  // Stable refs that always hold the latest state values.
  // performSync reads from these instead of capturing values via closure,
  // avoiding the stale-closure bug where a conflict-retry re-pushes stale data.
  const songsRef = useRef(songs);
  const spellingChartRef = useRef(spellingChart);
  const setlistsRef = useRef(setlists);
  useEffect(() => { songsRef.current = songs; }, [songs]);
  useEffect(() => { spellingChartRef.current = spellingChart; }, [spellingChart]);
  useEffect(() => { setlistsRef.current = setlists; }, [setlists]);

  const C = colorsFor(mode);
  const engine = useMetronomeEngine(clickSettings);

  // Metronome only belongs to Drums mode — stop it whenever the person
  // switches to Chords or Vocals so it doesn't keep clicking in the
  // background while they're reading lyrics or chords.
  useEffect(() => {
    if (mode !== "drums" && playingStore.value) engine.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Keep dynamic theme variables in sync without recreating any stylesheets
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", C.accent);
    document.documentElement.style.setProperty("--accent-dim", C.accentDim);
    document.documentElement.style.setProperty("--text-faint", C.textFaint);
  }, [C.accent, C.accentDim, C.textFaint]);

  const [tab, setTab] = useState(() => (mode === "vocals" ? "songs" : "practice"));
  const [editingSong, setEditingSong] = useState(undefined);
  const [newSongSeed, setNewSongSeed] = useState(null);
  const [stageModalOpen, setStageModalOpen] = useState(false);
  // "/" (or Ctrl/Cmd+K) jumps to the search box on the Songs and Setlists pages.
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || hasOpenLayer()) return;
      const find = (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
      const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target);
      if (!find && !slash) return;
      const box = [...document.querySelectorAll("input[data-search]")].find(isShown);
      if (!box) return;
      e.preventDefault(); box.focus(); box.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // 1 – 4 switch between the bottom bar's pages (Mac / PC). Off while a dialog or a song is open, while typing, and on the chord wheels page
  // (where the number keys play chords).
  const tabKeysRef = useRef({});
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing || hasOpenLayer() || isTypingTarget(e.target)) return;
      const n = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
      if (!n) return;
      const { navHidden, change } = tabKeysRef.current;
      if (navHidden) return;
      e.preventDefault();
      change(["practice", "songs", "setlists", "settings"][Number(n[1]) - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [liveTarget, setLiveTarget] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [songToDelete, setSongToDelete] = useState(null);
  const [sharedSongToRemove, setSharedSongToRemove] = useState(null);
  const [teamKeyModalOpen, setTeamKeyModalOpen] = useState(false);
  const [stageIndex, setStageIndex] = useState(null);
  const [stageAutoOpenPicker, setStageAutoOpenPicker] = useState(false);
  const [pianoQuality, setPianoQuality] = useState("Major");
  // Root of the song last swiped into the piano (semitone 0-11): its key label is tinted while the piano screen is open.
  const [pianoHighlight, setPianoHighlight] = useState(null);
  const [toastMsg, setToastMsg] = useState("");

  // A stable ref that always holds the latest performSync so that save functions
  // defined before performSync's useCallback can still trigger an immediate push.
  const performSyncRef = useRef(null);
  // Set to true when a save is attempted while a sync is already in-flight.
  // performSync checks this on completion and retries immediately.
  const pendingSync = useRef(false);

  // Debounced trigger so rapid commits collapse into one network round-trip.
  const syncTimer = useRef(null);
  // After a failed sync, try again with growing pauses (4s, 8s … 60s) until one succeeds.
  const syncRetry = useRef({ timer: null, attempt: 0 });
  const scheduleSyncRetry = () => {
    const r = syncRetry.current;
    clearTimeout(r.timer);
    r.attempt += 1;
    r.timer = setTimeout(() => performSyncRef.current?.(), Math.min(60000, 4000 * 2 ** (r.attempt - 1)));
  };
  const requestSync = (delay = 0) => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => { syncTimer.current = null; performSyncRef.current?.(); }, delay);
  };

  // Called ONLY on commit actions (Save / Done / delete / import). Rows that
  // actually changed (by reference) are stamped, queued as dirty and pushed.
  // `silent` = persist locally without queueing a push.
  const saveSongs = (next, opts = {}) => {
    const resolved = typeof next === "function" ? next(songsRef.current) : next;
    let out = resolved;
    if (!opts.silent) {
      const prevById = new Map((songsRef.current || []).map((s) => [s.id, s]));
      const now = Date.now();
      const changedIds = [];
      out = (resolved || []).map((s) => {
        if (prevById.get(s.id) === s) return s;
        changedIds.push(s.id);
        return { ...s, updatedAt: now };
      });
      markSongsDirty(changedIds);
    }
    songsRef.current = out;
    setSongs(out);
    if (!opts.silent) requestSync(opts.debounce || 0);
  };
  // Local persistence only. Shared setlists are pushed via commitSetlist().
  const saveSetlists = (next) => {
    const resolved = typeof next === "function" ? next(setlistsRef.current) : next;
    setlistsRef.current = resolved;
    persistSetlists(resolved);
  };
  const saveSpellingChart = (next) => {
    const resolved = typeof next === "function" ? next(spellingChartRef.current) : next;
    const prev = spellingChartRef.current || {};
    const changed = Object.keys(resolved || {}).filter((k) => prev[k] !== resolved[k]);
    markSpellingDirty(changed);
    spellingChartRef.current = resolved;
    setSpellingChart(resolved);
    requestSync();
  };

  // Merge the team's shared setlists into local state.
  //  • Remote is the source of truth: setlists missing remotely were deleted
  //    (or un-shared) on another device and are dropped locally.
  //  • Exceptions: setlists with a queued push / mid-edit are kept as-is.
  //  • Unsaved per-device key/tempo overrides on entries are preserved.
  const mergeSharedSetlists = (localList, remoteShared) => {
    const protectedIds = new Set([...getPendingSharedIds(), ...uncommittedSharedEdits.current]);
    const deletedIds = new Set(getDeletedSharedIds());
    const localShared = new Map(localList.filter((sl) => sl.shared).map((sl) => [sl.id, sl]));
    const merged = [];
    const seen = new Set();
    (remoteShared || []).forEach((rsl) => {
      if (deletedIds.has(rsl.id)) return;
      seen.add(rsl.id);
      const lsl = localShared.get(rsl.id);
      if (lsl && protectedIds.has(rsl.id)) { merged.push(lsl); return; }
      const entries = (rsl.entries || []).map((re) => {
        const le = lsl?.entries?.find((e) => e.songId === re.songId);
        const rk = re.keyOverride ?? null;
        const rt = re.tempoOverride ?? null;
        const localKeyUnsaved = le && (le.keyOverride ?? null) !== (le.syncedKeyOverride ?? null);
        const localTempoUnsaved = le && (le.tempoOverride ?? null) !== (le.syncedTempoOverride ?? null);
        return {
          songId: re.songId,
          keyOverride: localKeyUnsaved ? le.keyOverride : rk,
          tempoOverride: localTempoUnsaved ? le.tempoOverride : rt,
          syncedKeyOverride: rk,
          syncedTempoOverride: rt,
        };
      });
      merged.push({ ...rsl, shared: true, teamSynced: true, entries, lastOpenedAt: lsl?.lastOpenedAt ?? rsl.lastOpenedAt });
    });
    localShared.forEach((lsl, id) => { if (!seen.has(id) && protectedIds.has(id)) merged.push(lsl); });
    return [...localList.filter((sl) => !sl.shared), ...merged];
  };

  const performSync = useCallback(async (force = false) => {
    // Keep the ref in sync so save functions can call the latest closure.
    performSyncRef.current = performSync;
    if (!isSupabaseConfigured()) return;
    if (!storesReadyRef.current) return;   // runs again as soon as local data is loaded
    if (!navigator.onLine) {
      if (force) throw new Error("offline");
      return;
    }
    if (syncing.current) {
      // Another sync is in-flight — retry as soon as it finishes.
      pendingSync.current = true;
      if (force) {
        await new Promise((resolve) => {
          const interval = setInterval(() => {
            if (!syncing.current) { clearInterval(interval); resolve(); }
          }, 100);
          setTimeout(() => { clearInterval(interval); resolve(); }, 3000);
        });
        if (!syncing.current) return performSync(true);
      }
      return;
    }
    syncing.current = true;
    pendingSync.current = false;
    if (bandKey) setSyncStatus("Syncing…");
    try {
      const result = await syncLibrary({
        teamKey: bandKey,
        deviceId: getDeviceId(),
        songs: songsRef.current,
        spellingChart: spellingChartRef.current,
        sharedSetlists: setlistsRef.current.filter((sl) => sl.shared),
      });

      // ── Apply remote songs (functional updates → safe against mid-flight edits)
      const dirtySongs = new Set(getDirtySongIds());
      const remoteDeleted = new Set(result.deletedSongIds || []);
      if ((result.songs && result.songs.length) || remoteDeleted.size) {
        setSongs((prev) => {
          let changed = false;
          let next = prev.filter((s) => {
            const drop = remoteDeleted.has(s.id) && !dirtySongs.has(s.id);
            if (drop) changed = true;
            return !drop;
          });
          result.songs.forEach((rs) => {
            if (dirtySongs.has(rs.id)) return; // our unpushed edit wins
            const idx = next.findIndex((ls) =>
              ls.id === rs.id ||
              ((ls.title || "").trim().toLowerCase() === (rs.title || "").trim().toLowerCase() &&
                (ls.artist || "").trim().toLowerCase() === (rs.artist || "").trim().toLowerCase())
            );
            if (idx === -1) { next = [...next, rs]; changed = true; return; }
            const local = next[idx];
            if ((rs.updatedAt || 0) >= (local.updatedAt || 0) && (local.id !== rs.id || rs.updatedAt !== local.updatedAt)) {
              next = [...next]; next[idx] = { ...rs, structure: rs.structure ?? local.structure, subdivision: local.subdivision ?? rs.subdivision }; changed = true;
            }
          });
          return changed ? next : prev;
        });
      }

      // ── Apply remote spelling changes
      const { upserts, deleted } = result.spelling || { upserts: {}, deleted: [] };
      if (Object.keys(upserts).length || deleted.length) {
        const dirtyKeys = new Set(getDirtySpellingKeys());
        setSpellingChart((prev) => {
          let changed = false;
          const next = { ...prev };
          deleted.forEach((k) => { if (!dirtyKeys.has(k) && k in next) { delete next[k]; changed = true; } });
          Object.entries(upserts).forEach(([k, v]) => { if (!dirtyKeys.has(k) && next[k] !== v) { next[k] = v; changed = true; } });
          return changed ? next : prev;
        });
      }

      // ── Apply team setlists
      if (bandKey && result.team) {
        persistSetlists((prev) => mergeSharedSetlists(prev, result.team.sharedSetlists));
      }

      if (bandKey) setSyncStatus(result.teamError ? `Team error: ${result.teamError}` : "Up to date");
      setFirstSyncDone(true);
      if (result.teamError) scheduleSyncRetry(); else { syncRetry.current.attempt = 0; clearTimeout(syncRetry.current.timer); }
    } catch (error) {
      console.error("[Zong sync]", error);
      scheduleSyncRetry();   // weak signal / server hiccup: the browser may never fire "online", so try again by itself
      if (bandKey) setSyncStatus(navigator.onLine ? error.message : "Offline");
      // Re-throw for manual sync so the UI can show a specific toast.
      if (force) throw error;
    } finally {
      syncing.current = false;
      if (pendingSync.current) {
        pendingSync.current = false;
        setTimeout(() => performSyncRef.current?.(), 0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandKey]);

  // Subscription + sync setup. Re-runs whenever bandKey changes so the team
  // channel subscription is always for the current key. A prevBandKey ref
  // prevents StrictMode double-invocation from creating duplicate subscriptions.
  const prevBandKeyRef = useRef(undefined);
  useEffect(() => {
    if (prevBandKeyRef.current === bandKey) return;
    prevBandKeyRef.current = bandKey;

    // Sync on mount and whenever team key changes
    performSync();

    const online = () => performSync();
    // Realtime sockets can be suspended while the app is backgrounded; one
    // incremental sync on return catches anything missed (tiny payload).
    const onVisible = () => { if (document.visibilityState === "visible") performSync(); };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", onVisible);

    // No polling — Realtime pushes changes from other devices instantly.
    let unsubscribeRealtime = null;
    if (isSupabaseConfigured()) {
      unsubscribeRealtime = subscribeToChanges({
        teamKey: bandKey || null,
        onReconnect: () => performSyncRef.current?.(),
        onSongChange: (_eventType, song, songId) => {
          if (getDirtySongIds().includes(songId)) return; // don't clobber our unpushed edit
          setSongs((prev) => {
            if (!song) return prev.some((s) => s.id === songId) ? prev.filter((s) => s.id !== songId) : prev;
            const idx = prev.findIndex((s) => s.id === songId);
            if (idx === -1) return [...prev, song];
            const existing = prev[idx];
            if (song.updatedAt >= (existing.updatedAt ?? 0)) {
              const next = [...prev]; next[idx] = { ...song, structure: song.structure ?? existing.structure, subdivision: existing.subdivision ?? song.subdivision }; return next;
            }
            return prev;
          });
        },
        onSpellingChange: (_eventType, tamil, latin) => {
          if (getDirtySpellingKeys().includes(tamil)) return;
          setSpellingChart((prev) => {
            if (latin === null) { if (!(tamil in prev)) return prev; const n = { ...prev }; delete n[tamil]; return n; }
            return prev[tamil] === latin ? prev : { ...prev, [tamil]: latin };
          });
        },
        onTeam: (teamData) => {
          persistSetlists((prev) => mergeSharedSetlists(prev, teamData.sharedSetlists));
        }
      });
    }

    return () => {
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", onVisible);
      if (unsubscribeRealtime) unsubscribeRealtime();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandKey]);

  // Clean redundant built-in spellings out of this device's saved spelling chart (once, if unchanged).
  useEffect(() => {
    if (!spellingReady) return;
    const stale = Object.keys(REMOVED_SEED_WORDS).filter((k) => spellingChartRef.current[k] === REMOVED_SEED_WORDS[k]);
    if (!stale.length) return;
    stale.forEach((k) => recordDeletedSpellingKey(k));
    saveSpellingChart((prev) => { const next = { ...prev }; stale.forEach((k) => { delete next[k]; }); return next; });
  }, [spellingReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drums notes written in the old format ([note]lyrics) are rewritten once in the new one
  // (note [lyrics]); the format mark makes this safe to repeat and keeps synced devices consistent.
  useEffect(() => {
    if (!songsReady) return;
    if (!songsRef.current.some((s) => s.drumsText && !isNewDrumsText(s.drumsText))) return;
    saveSongs((prev) => prev.map((s) => (s.drumsText && !isNewDrumsText(s.drumsText) ? { ...s, drumsText: convertOldDrumsText(s.drumsText) } : s)));
  }, [songsReady, songs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every song keeps the same sections (-Verse, -Chorus, …) in lyrics, chords, chart and drums — Stage Mode
  // jumps all devices to the same section. Songs written before that (or edited by an older app version) are
  // tidied here: any section one text has and another lacks is added, empty. Safe to repeat (already-matching
  // songs are left untouched). With a Team it waits for the first sync, so it never works from stale data.
  useEffect(() => {
    if (!songsReady || (bandKey && !firstSyncDone)) return;
    const tidied = (s) => {
      const m = migrateSongShape(s);
      const res = tidySections({ lyrics: m.lyricsText || "", chords: m.chordsText || "", chart: m.chartText || "", drums: drumsToEditor(m.drumsText || "") });
      if (!res.changed) return s;
      return { ...s, lyricsText: res.texts.lyrics, chordsText: res.texts.chords, chartText: res.texts.chart, drumsText: drumsFromEditor(res.texts.drums) };
    };
    if (songsRef.current.every((s) => tidied(s) === s)) return;
    saveSongs((prev) => prev.map(tidied));
  }, [songsReady, songs, firstSyncDone, bandKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Local data finished loading: run the sync that was skipped while it was loading.
  useEffect(() => {
    if (songsReady && spellingReady) performSyncRef.current?.();
  }, [songsReady, spellingReady]);

  // Called when the user commits a setlist edit (Done / leaving the stage).
  // Shared setlists are queued for upload; un-sharing removes them from the team.
  const commitSetlist = (setlistId) => {
    uncommittedSharedEdits.current.delete(setlistId);
    const sl = setlistsRef.current.find((s) => s.id === setlistId);
    if (!sl) return;
    if (sl.shared && bandKey) {
      markSharedPending(sl.id);
      requestSync();
    } else if (!sl.shared && sl.teamSynced) {
      markSharedDeleted(sl.id);
      saveSetlists((list) => list.map((s) => (s.id === sl.id ? { ...s, teamSynced: false } : s)));
      requestSync();
    }
  };

  const handleSaveTeamKey = (newKey) => {
    const clean = newKey.trim().toUpperCase();
    setTeamKeyModalOpen(false);
    if (clean === bandKey) return;
    if (bandKey) {
      // Leaving a team: unregister this device and drop the team's shared
      // setlists from this device (they belong to the team, not to us).
      leaveTeam({ teamKey: bandKey, deviceId: getDeviceId() });
      clearSharedQueues();
      uncommittedSharedEdits.current.clear();
      saveSetlists((list) => list.filter((sl) => !sl.shared));
      setStageIndex(null);
      setDraftSetlist(null);
      setViewing((v) => (v?.fromSetlistId ? null : v));
    }
    localStorage.setItem("zong:access-key", clean);
    setBandKey(clean);
    if (!clean) {
      setSyncStatus("Public only");
      flash("Disconnected from Team");
      return;
    }
    flash("Connected to Team");
    // Surface any Supabase permission errors right away in the status bar.
    // The useEffect([bandKey]) then runs the first sync with the correct key.
    ensureTeamRow({ teamKey: clean, deviceId: getDeviceId() })
      .then((err) => { if (err) setSyncStatus(`Team DB error: ${err}`); })
      .catch(() => { });
  };


  const rootRef = useRef(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const preventGesture = (e) => e.preventDefault();
    const preventMultiTouch = (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); };
    el.addEventListener("gesturestart", preventGesture);
    el.addEventListener("gesturechange", preventGesture);
    el.addEventListener("touchmove", preventMultiTouch, { passive: false });
    return () => {
      el.removeEventListener("gesturestart", preventGesture);
      el.removeEventListener("gesturechange", preventGesture);
      el.removeEventListener("touchmove", preventMultiTouch);
    };
  }, []);

  // Screen rotation rules:
  //   Phone  → always portrait, whatever the rotation setting / lock state is
  //            (see startPhoneOrientationLock; the native app is locked by the OS).
  //   iPad   → free rotation per the device setting.
  //   Mac/PC → UI never rotates; it stays landscape-oriented at any window size.
  // The piano rotates itself to face the wider edge on every device class (<LandscapeLock>).
  useEffect(() => (DEVICE_CLASS === "phone" ? startPhoneOrientationLock() : undefined), []);

  // iOS Safari quirk: focusing a text input (e.g. the search bar) makes the
  // browser scroll the whole layout viewport to keep the input above the
  // on-screen keyboard — even though html/body are position:fixed, this
  // still drags every fixed-position element (including the bottom nav)
  // upward with it. The app never actually uses window/document scrolling
  // itself (all real scrolling happens internal .scroll-list divs,
  // whose scroll events don't bubble to window), so pinning any window-level
  // scroll straight back to the top neutralises this without touching any
  // legitimate scrolling in the app.
  useEffect(() => {
    const pinScroll = () => {
      // Don't fight the browser when a textarea/input is focused — iOS needs
      // to scroll the viewport to keep the keyboard-obscured field visible.
      const active = document.activeElement;
      const isFormField = active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable);
      if (isFormField) return;
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };
    window.addEventListener("scroll", pinScroll, { passive: true });
    window.visualViewport?.addEventListener("scroll", pinScroll);
    window.visualViewport?.addEventListener("resize", pinScroll);
    return () => {
      window.removeEventListener("scroll", pinScroll);
      window.visualViewport?.removeEventListener("scroll", pinScroll);
      window.visualViewport?.removeEventListener("resize", pinScroll);
    };
  }, []);

  // Match the Tamil font size to the Latin one on this device (see <Tamil>).
  useEffect(() => {
    applyTamilScale();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(applyTamilScale).catch(() => { });
  }, []);

  // Screen wake lock while the app is open (metronome/chart use, no auto-lock).
  useEffect(() => {
    if (!navigator.wakeLock) return;
    let sentinel = null;
    const acquire = () => { if (document.visibilityState === "visible") navigator.wakeLock.request("screen").then((s) => { sentinel = s; }).catch(() => { }); };
    acquire();
    const handleVisibility = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => { document.removeEventListener("visibilitychange", handleVisibility); if (sentinel) sentinel.release().catch(() => { }); };
  }, []);

  // Keep iOS routing audio through the "media" session so the hardware
  // silent switch doesn't mute the metronome/piano.
  // On native Capacitor, AVAudioSession.category = .playback already handles
  // this — creating a competing audio element would fight the native session.
  useEffect(() => {
    if (isNativePlatform()) return;
    const audio = document.createElement("audio");
    audio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
    audio.loop = true; audio.setAttribute("playsinline", "true"); audio.volume = 1; audio.style.display = "none";
    document.body.appendChild(audio);
    const unlock = () => { if (audio.paused) audio.play().catch(() => { }); };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("touchstart", unlock, { passive: true });
    const handleVisibility = () => { if (document.visibilityState === "visible" && audio.paused) unlock(); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchstart", unlock);
      document.removeEventListener("visibilitychange", handleVisibility);
      audio.pause(); audio.remove();
    };
  }, []);

  // Preload audio samples (piano + metronome WAVs) on first mount so they are
  // decoded and ready before the user opens the piano or starts the metronome.
  // Not needed on native — the Swift engine loads its own WAVs from the bundle.
  useEffect(() => {
    if (isNativePlatform()) return;
    loadAudioSamples(getSharedAudioContext()).catch(() => { });
  }, []);

  const flash = (msg) => { setToastMsg(msg); setTimeout(() => setToastMsg(""), 2000); };

  const stageSetlist = draftSetlist || (stageIndex !== null ? setlists[stageIndex] : null);
  const viewingSong = viewing ? songs.find((s) => s.id === viewing.songId) : null;
  const viewingSetlist = viewing?.fromSetlistId ? setlists.find((sl) => sl.id === viewing.fromSetlistId) : null;
  const viewingEntry = viewingSetlist ? viewingSetlist.entries.find((e) => e.songId === viewing.songId) : null;
  const viewingSetlistIndex = viewingSetlist ? viewingSetlist.entries.findIndex((e) => e.songId === viewing.songId) : -1;
  const prevSetlistSongId = viewingSetlist && viewingSetlistIndex > 0 ? viewingSetlist.entries[viewingSetlistIndex - 1].songId : null;
  const nextSetlistSongId = viewingSetlist && viewingSetlistIndex >= 0 && viewingSetlistIndex < viewingSetlist.entries.length - 1 ? viewingSetlist.entries[viewingSetlistIndex + 1].songId : null;

  useEffect(() => { if (tab !== "practice") setPianoHighlight(null); }, [tab]);
  // ── Stage Mode wiring ──
  const busyRef = useRef(false);
  busyRef.current = editingSong !== undefined || !!newSongSeed;     // never yank someone out of the song editor
  const latestLivePos = useRef(null);
  const applyLivePosition = (pos) => {
    latestLivePos.current = pos;
    if (!pos?.songId || busyRef.current) return false;
    if (!songsRef.current.some((s) => s.id === pos.songId)) return false;      // not synced to this device yet
    const sl = pos.setlistId && setlistsRef.current.some((l) => l.id === pos.setlistId) ? pos.setlistId : null;
    setViewing((v) => (v && v.songId === pos.songId && (v.fromSetlistId || null) === sl ? v : { songId: pos.songId, fromSetlistId: sl }));
    setLiveTarget({ ...pos, nonce: Math.random() });
    return true;
  };
  // Joystick chord piano: the lead's key / sticks / chord arrive here and are shown (not played) on followers in Chords mode.
  const [joystickOn, setJoystickOn] = useState(false);
  const [joyRemote, setJoyRemote] = useState(null);
  const [joystickKey, setJoystickKey] = useState(null);   // { key, quality, nonce }: key to load into the joystick piano (swipe a song right)
  useEffect(() => { if (!joystickOn) setJoystickKey(null); }, [joystickOn]);   // the swiped-in key applies once
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const applyJoy = (msg) => {
    if (!msg?.o) { setJoyRemote(null); return; }
    if (modeRef.current !== "chords") return;
    const keyQuality = msg.m ? "Minor" : "Major";
    setJoyRemote({ on: true, keyName: msg.k, keyQuality, degree: msg.d, quality: msg.q, chord: joystickChord(msg.k, keyQuality, msg.d, msg.q), at: Date.now() });
    setViewing(null); setStageIndex(null); setTab("practice");   // taken to the joystick piano
  };
  const live = useLiveSync({ teamKey: bandKey, onApply: applyLivePosition, onJoy: applyJoy });
  useEffect(() => { if (live.role !== "follow") setJoyRemote(null); }, [live.role]);
  // Safety: if a "chord released" message is ever lost, don't leave the chord on a follower's screen for good
  // (the lead repeats a held chord every 12 s, so a chord older than 30 s is stale).
  useEffect(() => {
    if (!joyRemote || joyRemote.degree == null) return undefined;
    const t = setTimeout(() => setJoyRemote((j) => (j && j.at === joyRemote.at ? { ...j, degree: null, quality: "auto", chord: null } : j)), 30000);
    return () => clearTimeout(t);
  }, [joyRemote]);
  // The lead tells followers what its joystick is doing.
  const publishJoystick = (state) => live.publishJoy?.(state);
  useEffect(() => {
    if (!busyRef.current && live.role === "follow" && latestLivePos.current) applyLivePosition(latestLivePos.current);
  }, [editingSong, newSongSeed]); // eslint-disable-line react-hooks/exhaustive-deps
  // ── Library export / import (Settings → Library) ──
  const handleExportLibrary = async () => {
    const readMap = (key) => { try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; } };
    const accentsMap = readMap(SONG_ACCENTS_KEY);
    const data = {
      app: "zong", version: 1, exportedAt: new Date().toISOString(),
      songs: songsRef.current.map((s) => ({ ...migrateSongShape(s), accents: accentsMap[s.id] ?? s.accents, subdivision: getSongSubdivision(s.id) })),
      setlists: setlistsRef.current,
      spellingChart: spellingChartRef.current,
    };
    const name = `zong-library-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([JSON.stringify(data)], name, { type: "application/json" });
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: "Zong library" }); return; }
    } catch (err) {
      if (err?.name === "AbortError") return;      // the user closed the share sheet
    }
    const url = URL.createObjectURL(file);          // no share sheet here (desktop browsers): save as a download
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  const handleImportLibrary = async (file) => {
    try {
      if (!file || file.size > 50 * 1024 * 1024) throw new Error("bad file");
      const data = JSON.parse(await file.text());
      if (!data || data.app !== "zong" || !Array.isArray(data.songs)) throw new Error("not a Zong library");
      const same = (a, b) => a.id === b.id || ((a.title || "").trim().toLowerCase() === (b.title || "").trim().toLowerCase() && (a.artist || "").trim().toLowerCase() === (b.artist || "").trim().toLowerCase());
      let added = 0, updated = 0;
      // Only known fields, each forced to the type the rest of the app expects (a hand-edited or damaged file can't break the app).
      const str = (v) => (typeof v === "string" ? v : "");
      const cleanSong = (r) => ({
        id: typeof r.id === "string" && r.id ? r.id.slice(0, 80) : uid(),
        title: str(r.title).trim(), artist: str(r.artist), key: str(r.key).slice(0, 3), keyQuality: r.keyQuality === "Minor" ? "Minor" : "Major",
        tempo: Number.isFinite(Number(r.tempo)) && r.tempo !== "" && r.tempo != null ? Math.min(300, Math.max(30, Number(r.tempo))) : "",
        timeSignature: /^\d{1,2}\/\d{1,2}$/.test(str(r.timeSignature)) ? r.timeSignature : "4/4", language: str(r.language),
        description: str(r.description), lyricsText: str(r.lyricsText), chordsText: str(r.chordsText), chartText: str(r.chartText), drumsText: str(r.drumsText), structure: cleanStructure(r.structure),
        updatedAt: Number.isFinite(Number(r.updatedAt)) ? Number(r.updatedAt) : 0,
        accents: Array.isArray(r.accents) ? r.accents.map((a) => (["normal", "accent", "mute"].includes(a) ? a : "normal")).slice(0, 16) : undefined,
        subdivision: [1, 2, 3, 4].includes(Number(r.subdivision)) ? Number(r.subdivision) : undefined,
      });
      const incoming = data.songs.filter((r) => r && typeof r === "object" && typeof r.title === "string" && r.title.trim()).map(cleanSong);
      saveSongs((prev) => {
        const next = [...prev];
        incoming.forEach((raw) => {
          const song = raw;
          const idx = next.findIndex((l) => same(l, song));
          if (idx === -1) { next.push(song); added += 1; }
          else if ((song.updatedAt || 0) > (next[idx].updatedAt || 0)) { next[idx] = { ...song, id: next[idx].id }; updated += 1; }
        });
        return next;
      });
      incoming.forEach((raw) => {
        const id = songsRef.current.find((l) => same(l, raw))?.id;
        if (!id) return;
        if (Array.isArray(raw.accents)) setSongAccentsLocal(id, raw.accents);
        if (raw.subdivision != null) setSongSubdivision(id, raw.subdivision);
      });
      let lists = 0;
      if (Array.isArray(data.setlists)) {
        saveSetlists((prev) => {
          const next = [...prev];
          data.setlists.forEach((sl) => {
            if (!sl || typeof sl.id !== "string" || typeof sl.name !== "string" || !Array.isArray(sl.entries) || next.some((x) => x.id === sl.id)) return;
            const entries = sl.entries.filter((e) => e && typeof e.songId === "string").map((e) => ({ songId: e.songId, keyOverride: typeof e.keyOverride === "string" ? e.keyOverride : null, tempoOverride: Number.isFinite(Number(e.tempoOverride)) && e.tempoOverride != null ? Number(e.tempoOverride) : null }));
            next.push({ id: sl.id.slice(0, 80), name: sl.name.slice(0, 120), entries, createdAt: Number(sl.createdAt) || Date.now(), shared: false, teamSynced: false });   // imported setlists stay on this device until shared again
            lists += 1;
          });
          return next;
        });
      }
      const words = data.spellingChart && typeof data.spellingChart === "object" ? Object.entries(data.spellingChart).filter(([k, v]) => typeof v === "string" && k.length <= 80 && v.length <= 80) : [];
      if (words.length) saveSpellingChart((prev) => ({ ...prev, ...Object.fromEntries(words) }));
      flash(`Imported ${added} new and ${updated} updated song${added + updated === 1 ? "" : "s"}${lists ? `, ${lists} setlist${lists === 1 ? "" : "s"}` : ""}`);
    } catch {
      flash("That file isn't a Zong library");
    }
  };
  const openStageMode = () => {
    if (!live.available) { flash("Join a Team first (Settings → Team)"); return; }
    live.open();
    setStageModalOpen(true);
  };

  const handleTabChange = (next) => { setTab(next); setStageIndex(null); setViewing(null); };

  const handleSaveSong = (data) => {
    if (editingSong) {
      saveSongs(songs.map((s) => (s.id === editingSong.id ? { ...s, ...data } : s)));
      // accents & subdivision are device-local; already written by SongForm's handleSave for edits.
    } else {
      const newSong = { id: uid(), ...data };
      saveSongs([...songs, newSong]);
      // Seed device-local stores for the brand-new song id.
      if (data.accents) setSongAccentsLocal(newSong.id, data.accents);
      if (data.subdivision != null) setSongSubdivision(newSong.id, data.subdivision);
      setViewing({ songId: newSong.id, fromSetlistId: null });
    }
    setEditingSong(undefined);
    setNewSongSeed(null);
  };
  const requestDeleteSong = (songOrId) => {
    const s = typeof songOrId === "object" && songOrId !== null ? songOrId : songs.find((item) => item.id === songOrId);
    if (s) setSongToDelete(s);
  };
  const executeDeleteSong = (id) => {
    recordDeletedSongId(id);
    // Shared setlists that contained this song need to be re-pushed without it.
    if (bandKey) setlists.forEach((sl) => { if (sl.shared && sl.entries.some((e) => e.songId === id)) markSharedPending(sl.id); });
    saveSongs(songs.filter((s) => s.id !== id));
    saveSetlists(setlists.map((sl) => ({ ...sl, entries: sl.entries.filter((e) => e.songId !== id) })));
    setEditingSong(undefined);
    if (viewing?.songId === id) setViewing(null);
    setSongToDelete(null);
    flash("Song deleted");
  };
  const handleDuplicateSong = (song) => {
    const base = song.title.replace(/\s*\(\d+\)\s*$/, "").trim();
    let n = 2;
    let candidate = `${base} (${n})`;
    const nameExists = (t) => songs.some((s) => s.title.toLowerCase() === t.toLowerCase() && (s.artist || "").toLowerCase() === (song.artist || "").toLowerCase());
    while (nameExists(candidate)) { n += 1; candidate = `${base} (${n})`; }
    const newSong = { ...migrateSongShape(song), id: uid(), title: candidate };
    saveSongs([...songs, newSong]);
    setEditingSong(undefined);
    setViewing({ songId: newSong.id, fromSetlistId: null });
    flash(`Duplicated as "${candidate}"`);
  };
  // A new setlist exists only as an in-memory draft until the user presses
  // Done with at least one song selected (see handleCommitStage).
  const handleCreateSetlist = () => {
    let n = 1;
    while (setlists.some((sl) => sl.name.toLowerCase() === `setlist ${n}`.toLowerCase())) n += 1;
    const now = Date.now();
    setDraftSetlist({ id: uid(), name: `Setlist ${n}`, entries: [], shared: false, createdAt: now, updatedAt: now, lastOpenedAt: now });
    setStageAutoOpenPicker(true);
    setStageIndex(null);
  };
  const handleCommitStage = (id) => {
    if (draftSetlist && draftSetlist.id === id) {
      const d = draftSetlist;
      setDraftSetlist(null);
      if (!d.entries.length) { setStageIndex(null); return; } // nothing selected → nothing created
      saveSetlists([d, ...setlists]);
      setStageIndex(0);
      if (d.shared && bandKey) { markSharedPending(d.id); requestSync(); }
      return;
    }
    commitSetlist(id);
  };
  const handleCloseStage = () => {
    if (draftSetlist) { setDraftSetlist(null); setStageIndex(null); return; }
    const sl = setlists[stageIndex];
    if (sl) commitSetlist(sl.id);
    setStageIndex(null);
  };
  const handleOpenSetlist = (id) => {
    const now = Date.now();
    saveSetlists(setlists.map((sl) => (sl.id === id ? { ...sl, lastOpenedAt: now } : sl)));
    setStageAutoOpenPicker(false);
    setStageIndex(setlists.findIndex((sl) => sl.id === id));
  };
  const [deletingSetlist, setDeletingSetlist] = useState(null);
  const requestDeleteSetlist = (id) => {
    const sl = setlists.find((s) => s.id === id);
    if (!sl) return;
    if (sl.shared) {
      setDeletingSetlist(sl);
    } else {
      saveSetlists(setlists.filter((s) => s.id !== id));
    }
  };
  const handleDeleteSetlist = requestDeleteSetlist;
  const handleUpdateSetlist = (updated) => {
    const stamped = { ...updated, updatedAt: Date.now() };
    if (draftSetlist && updated.id === draftSetlist.id) { setDraftSetlist(stamped); return; }
    // Local only — shared setlists upload when the user commits (Done / back).
    if (stamped.shared || stamped.teamSynced) uncommittedSharedEdits.current.add(stamped.id);
    saveSetlists(setlists.map((sl) => (sl.id === updated.id ? stamped : sl)));
  };
  const handleRemoveSongFromSetlist = (setlistId, songId) => {
    const sl = setlists.find((s) => s.id === setlistId);
    if (sl?.shared) {
      const song = songs.find((s) => s.id === songId);
      if (song) { setSharedSongToRemove({ song, setlist: sl }); return; }
    }
    saveSetlists(setlists.map((s) => (s.id !== setlistId ? s : { ...s, entries: s.entries.filter((e) => e.songId !== songId) })));
    if (sl?.shared) { uncommittedSharedEdits.current.add(setlistId); commitSetlist(setlistId); }
    setViewing(null);
  };
  const handleKeyOverrideChange = (setlistId, songId, newKey) => {
    saveSetlists(setlists.map((sl) => (sl.id !== setlistId ? sl : { ...sl, entries: sl.entries.map((e) => (e.songId === songId ? { ...e, keyOverride: newKey } : e)) })));
  };
  const handleTempoOverrideChange = (setlistId, songId, newTempo) => {
    saveSetlists(setlists.map((sl) => (sl.id !== setlistId ? sl : { ...sl, entries: sl.entries.map((e) => (e.songId === songId ? { ...e, tempoOverride: newTempo } : e)) })));
  };
  const handleSaveOverrideToTeam = (setlistId, songId, { keyOverride, tempoOverride }) => {
    saveSetlists(setlists.map((sl) => {
      if (sl.id !== setlistId) return sl;
      return {
        ...sl,
        entries: sl.entries.map((e) => {
          if (e.songId !== songId) return e;
          const updated = { ...e };
          if (keyOverride !== undefined) {
            updated.keyOverride = keyOverride;
            updated.syncedKeyOverride = keyOverride;
          }
          if (tempoOverride !== undefined) {
            updated.tempoOverride = tempoOverride;
            updated.syncedTempoOverride = tempoOverride;
          }
          return updated;
        })
      };
    }));
    flash("Saved to Team");
    markSharedPending(setlistId);
    requestSync();
  };
  // Accents and subdivision are both device-local (localStorage), not synced.
  const handleUpdateSongAccents = (songId, accents) => setSongAccentsLocal(songId, accents);
  const handleUpdateSongSubdivision = (songId, subdivision) => {
    setSongSubdivision(songId, subdivision);
  };

  const handleLoadSongToPiano = (song) => {
    const q = song.keyQuality || "Major";
    if (mode === "chords") {
      // Chords mode: straight to the joystick chord piano, set to the song's key and scale.
      if (KEY_TO_SEMITONE[song.key] != null) setJoystickKey({ key: song.key, quality: q, nonce: Math.random() });
      setJoystickOn(true);
      setTab("practice");
      return;
    }
    setPianoQuality(q);
    setPianoHighlight(KEY_TO_SEMITONE[song.key] ?? null);
    setTab("practice");
  };

  // The joystick chord piano takes the whole screen: no bottom bar while it is open (the joystick button in its title bar leaves it).
  const navHidden = tab === "practice" && mode === "chords" && (joystickOn || !!joyRemote?.on);
  tabKeysRef.current = { navHidden, change: handleTabChange };

  return (
    <div ref={rootRef} style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0, width: "100%", maxWidth: "none",
      margin: "0 auto", background: C.bg, color: C.text, fontFamily: FONT, overflow: "hidden",
      border: "none", boxSizing: "border-box", touchAction: "pan-x pan-y",
      paddingTop: "var(--safe-top)",
    }}>
      <div style={{ paddingBottom: navHidden ? 0 : "calc(55px + max(36px, 8px + var(--safe-bottom)))", height: "100%", overflow: "hidden", boxSizing: "border-box", position: "relative" }}>
        {/*
          All screens stay mounted at all times. Inactive screens are hidden with
          display:none. Active screens use display:block + height:100% with relative
          positioning so that children can resolve percentages and absolute coordinates.
        */}
        <div style={{ display: tab === "practice" ? "block" : "none", height: "100%", position: "relative" }}>
          {/* Both practice screens always mounted; mode toggles which one is visible */}
          <div style={{ display: mode === "drums" ? "block" : "none", height: "100%", position: "relative" }}>
            <MetronomeScreen engine={engine} onUpdateSongAccents={handleUpdateSongAccents} onUpdateSongSubdivision={handleUpdateSongSubdivision} onLongPressTitle={() => { setNewSongSeed({ tempo: Math.round(engine.bpm), timeSignature: formatTimeSig(engine.timeSig), accents: engine.accents, subdivision: engine.subdivision }); setEditingSong(null); }} C={C} />
          </div>
          <div style={{ display: mode !== "drums" ? "block" : "none", height: "100%", position: "relative" }}>
            <PianoScreen C={C} mode={mode} loadedQuality={pianoQuality} onQualityChange={setPianoQuality} highlightSemitone={tab === "practice" ? pianoHighlight : null}
              joystickOn={joystickOn} onJoystickToggle={(held) => { if (held && !joystickOn) setJoystickKey({ key: held.key, quality: held.quality, nonce: Math.random() }); setJoystickOn((v) => !v); }} joystickKey={joystickKey} joystickRemote={joyRemote} onJoystickState={publishJoystick} onLeaveStage={live.close} />
          </div>
        </div>
        <div style={{ display: tab === "songs" ? "block" : "none", height: "100%", position: "relative" }}>
          <SongsScreen songs={songs} onOpen={(s) => setViewing({ songId: s.id, fromSetlistId: null })} onAdd={() => { if (mode === "drums") setNewSongSeed({ tempo: Math.round(engine.bpm), timeSignature: formatTimeSig(engine.timeSig), accents: engine.accents, subdivision: engine.subdivision }); setEditingSong(null); }} onEdit={(s) => setEditingSong(s)} onDelete={requestDeleteSong} onLoadToMetronome={mode === "drums" ? (s) => { engine.loadSong(s); setTab("practice"); } : undefined} onLoadToPiano={mode === "vocals" || mode === "chords" ? handleLoadSongToPiano : undefined} mode={mode} tanglishMode={tanglishMode} C={C} />
        </div>
        <div style={{ display: tab === "setlists" ? "block" : "none", height: "100%", position: "relative" }}>
          <SetlistsScreen setlists={setlists} onOpenStage={handleOpenSetlist} onCreate={handleCreateSetlist} onDelete={handleDeleteSetlist} C={C} />
        </div>
        <div style={{ display: tab === "settings" ? "block" : "none", height: "100%", position: "relative" }}>
          <SettingsScreen
            live={live} onOpenStageMode={openStageMode} onExportLibrary={handleExportLibrary} onImportLibrary={handleImportLibrary}
            mode={mode} setMode={setMode}
            fontSize={fontSize} setFontSize={setFontSize}
            chordFontSize={chordFontSize} setChordFontSize={setChordFontSize}
            sectionFontSize={sectionFontSize} setSectionFontSize={setSectionFontSize}
            textAlign={textAlign} setTextAlign={setTextAlign}
            lyricsBold={lyricsBold} setLyricsBold={setLyricsBold}
            notesBold={notesBold} setNotesBold={setNotesBold}
            lineSpacing={lineSpacing} setLineSpacing={setLineSpacing} noteSpacing={noteSpacing} setNoteSpacing={setNoteSpacing}
            clickSettings={clickSettings} setClickSettings={setClickSettings}
            tanglishMode={tanglishMode} setTanglishMode={setTanglishMode}
            onOpenSpellingChart={() => setSpellingChartOpen(true)}
            onConfigureSync={() => setTeamKeyModalOpen(true)}
            onForceSync={async () => {
              if (!navigator.onLine) { flash("No internet access"); return; }
              try {
                await performSync(true);
                flash("Songs synced");
              } catch (err) {
                const msg = err?.message;
                if (msg === "offline") flash("No internet access");
                else flash(`Sync error: ${String(msg || "unknown").slice(0, 90)}`);
              }
            }}
            bandKey={bandKey}
            syncStatus={syncStatus}
            C={C}
          />
        </div>
      </div>

      {!navHidden && <BottomNav active={tab} onChange={handleTabChange} mode={mode} C={C} />}

      {editingSong !== undefined && (
        <SongForm initial={editingSong} seed={newSongSeed} onSave={handleSaveSong} onCancel={() => { setEditingSong(undefined); setNewSongSeed(null); }} onDelete={requestDeleteSong} onDuplicate={handleDuplicateSong} songs={songs} mode={mode} fontSize={fontSize} chordFontSize={chordFontSize} lyricsBold={lyricsBold} notesBold={notesBold} lineSpacing={lineSpacing} textAlign={textAlign} C={C} />
      )}

      {viewingSong && (
        <SongDetailScreen
          key={viewing?.fromSetlistId ? `setlist-${viewing.fromSetlistId}` : viewingSong.id}
          song={viewingSong}
          contextKey={viewingEntry ? (viewingEntry.keyOverride ?? viewingSong.key) : viewingSong.key}
          onKeyChange={viewing?.fromSetlistId ? (newKey) => handleKeyOverrideChange(viewing.fromSetlistId, viewingSong.id, newKey) : null}
          contextTempo={viewingEntry ? (viewingEntry.tempoOverride ?? viewingSong.tempo) : viewingSong.tempo}
          onTempoChange={viewing?.fromSetlistId ? (newTempo) => handleTempoOverrideChange(viewing.fromSetlistId, viewingSong.id, newTempo) : null}
          isInSetlist={!!viewing?.fromSetlistId}
          isSharedSetlist={Boolean(viewingSetlist?.shared)}
          syncedKeyOverride={viewingEntry?.syncedKeyOverride}
          syncedTempoOverride={viewingEntry?.syncedTempoOverride}
          onSaveOverrideToTeam={viewing?.fromSetlistId ? (overrides) => handleSaveOverrideToTeam(viewing.fromSetlistId, viewingSong.id, overrides) : null}
          onBack={() => setViewing(null)}
          onEdit={(s) => { setViewing(null); setEditingSong(s); }}
          onDelete={requestDeleteSong}
          onRemoveFromSetlist={viewing?.fromSetlistId ? () => handleRemoveSongFromSetlist(viewing.fromSetlistId, viewingSong.id) : null}
          onPrevSong={viewing?.fromSetlistId && prevSetlistSongId ? () => setViewing({ songId: prevSetlistSongId, fromSetlistId: viewing.fromSetlistId }) : null}
          liveSync={live.role === "off" ? null : {
            role: live.role, status: live.connected ? "live" : "connecting", leaderPresent: live.peeked ? live.otherLead : undefined, target: liveTarget, onLeave: live.close,
            onSection: ({ sectionKey, sectionIdx }) => live.publish({ songId: viewingSong.id, setlistId: viewing?.fromSetlistId || null, sectionKey, sectionIdx }),
          }}
          onNextSong={viewing?.fromSetlistId && nextSetlistSongId ? () => setViewing({ songId: nextSetlistSongId, fromSetlistId: viewing.fromSetlistId }) : null}
          fontSize={fontSize} textAlign={textAlign} lyricsBold={lyricsBold} notesBold={notesBold} lineSpacing={lineSpacing} noteSpacing={noteSpacing} chordFontSize={chordFontSize} sectionFontSize={sectionFontSize}
          mode={mode} engine={engine} tanglishMode={tanglishMode}
          C={C}
        />
      )}

      {stageSetlist && (
        <SetlistStageScreen
          setlist={stageSetlist} songs={songs}
          onBack={handleCloseStage}
          onCommit={handleCommitStage}
          onUpdateSetlist={handleUpdateSetlist}
          onOpenSong={(s) => setViewing({ songId: s.id, fromSetlistId: stageSetlist.id })}
          onDeleteSetlist={handleDeleteSetlist}
          initialPickerOpen={stageAutoOpenPicker}
          mode={mode} tanglishMode={tanglishMode} C={C}
        />
      )}

      {spellingChartOpen && (
        <SpellingChartScreen chart={spellingChart} onSave={saveSpellingChart} onBack={() => setSpellingChartOpen(false)} C={C} />
      )}

      {stageModalOpen && <StageModeModal live={live} onClose={() => setStageModalOpen(false)} C={C} />}
      {songToDelete && (
        <DeleteSongModal
          song={songToDelete}
          onConfirm={() => executeDeleteSong(songToDelete.id)}
          onCancel={() => setSongToDelete(null)}
          C={C}
        />
      )}

      {deletingSetlist && (
        <DeleteSetlistModal
          setlist={deletingSetlist}
          onConfirm={() => {
            // Deleting a shared setlist removes it for every device on the team.
            markSharedDeleted(deletingSetlist.id);
            uncommittedSharedEdits.current.delete(deletingSetlist.id);
            saveSetlists(setlists.filter((sl) => sl.id !== deletingSetlist.id));
            setDeletingSetlist(null);
            requestSync();
          }}
          onCancel={() => setDeletingSetlist(null)}
          C={C}
        />
      )}

      {sharedSongToRemove && (
        <RemoveSharedSongModal
          song={sharedSongToRemove.song}
          setlist={sharedSongToRemove.setlist}
          onConfirm={() => {
            const { song, setlist } = sharedSongToRemove;
            saveSetlists(setlists.map((sl) => (sl.id !== setlist.id ? sl : { ...sl, entries: sl.entries.filter((e) => e.songId !== song.id) })));
            uncommittedSharedEdits.current.add(setlist.id);
            commitSetlist(setlist.id);
            setSharedSongToRemove(null);
            setViewing(null);
          }}
          onCancel={() => setSharedSongToRemove(null)}
          C={C}
        />
      )}

      <TeamKeyModal
        isOpen={teamKeyModalOpen}
        initialKey={bandKey}
        onSave={handleSaveTeamKey}
        onClose={() => setTeamKeyModalOpen(false)}
        C={C}
      />

      <Toast message={toastMsg} C={C} />
    </div>
  );
}

export default function App() {
  return (
    <AppInner />
  );
}
