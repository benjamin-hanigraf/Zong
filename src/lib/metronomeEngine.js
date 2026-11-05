// Metronome engine hook (web scheduler + native iOS engine bridge) and beat / playing stores.
import { isNativePlatform, nativeMetronome } from "../nativeMetronome";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { defaultAccents, getSongAccents, getSongSubdivision, setSongSubdivision } from "./songDevice.js";
import { parseTimeSig } from "./helpers.js";
import { stripAltTitle } from "./songText.js";
import { _metronomeBuffers, getSharedAudioContext, loadAudioSamples, unlockAudioPlayback } from "./audio.js";

/* =========================================================================
   Metronome engine (drums mode + song-view bottom bar)
   ========================================================================= */
// The lit beat changes several times a second. Keeping it in React state of <App>
// re-rendered the whole app on every beat, which stalled taps (start/stop felt laggy).
// A tiny external store lets only the beat dots re-render.
const beatStore = {
  value: -1,
  subs: new Set(),
  set(v) { if (v === this.value) return; this.value = v; this.subs.forEach((f) => f()); },
  subscribe: (f) => { beatStore.subs.add(f); return () => beatStore.subs.delete(f); },
  get: () => beatStore.value,
};

const setFlashBeat = (v) => beatStore.set(v);

export function useFlashBeat() { return useSyncExternalStore(beatStore.subscribe, beatStore.get); }

// Same idea for "is the metronome playing": only the play/stop glyphs re-render on a toggle,
// not the entire app, so the button reacts at once.
export const playingStore = {
  value: false,
  subs: new Set(),
  set(v) { if (v === this.value) return; this.value = v; this.subs.forEach((f) => f()); },
  subscribe: (f) => { playingStore.subs.add(f); return () => playingStore.subs.delete(f); },
  get: () => playingStore.value,
};

export function usePlaying() { return useSyncExternalStore(playingStore.subscribe, playingStore.get); }

// ---------------------------------------------------------------------------
// useMetronomeEngine — unified metronome hook.
// On native iOS (Capacitor) it delegates audio scheduling to the Swift
// NativeMetronomePlugin; on web it uses the existing Web Audio scheduler.
// The returned object is identical in both cases so all callers are unchanged.
// ---------------------------------------------------------------------------
export function useMetronomeEngine(settings) {
  // Known synchronously at load time (never flips after mount).
  const isNative = isNativePlatform();
  const [bpm, setBpmState] = useState(() => {
    try { const s = localStorage.getItem("altar_metronome_bpm"); return s ? Number(s) : 120; } catch { return 120; }
  });
  const [timeSig, setTimeSigState] = useState(() => {
    try { const s = localStorage.getItem("altar_metronome_time_sig"); return s ? JSON.parse(s) : { beats: 4, unit: 4 }; } catch { return { beats: 4, unit: 4 }; }
  });
  const [accents, setAccentsState] = useState(() => {
    try {
      const s = localStorage.getItem("altar_metronome_accents");
      if (s) return JSON.parse(s);
      const ts = JSON.parse(localStorage.getItem("altar_metronome_time_sig") || "{}");
      const beats = ts.beats || 4;
      const effBeats = (beats === 6 && ts.unit === 8) ? 4 : beats;
      return defaultAccents(effBeats);
    } catch { return defaultAccents(4); }
  });
  const [subdivision, setSubdivisionState] = useState(() => {
    try { const s = localStorage.getItem("altar_metronome_subdivision"); return s ? Number(s) : 1; } catch { return 1; }
  });
  const setPlaying = (v) => playingStore.set(v);
  const [loadedSong, setLoadedSong] = useState(null);
  // Silent beats: every beat has three states — normal, accent, silent ("mute": no click, but its dot still blinks in time).
  // Long-pressing the beat dots silences every beat at once and long-pressing again brings them back as they were: the saved pattern
  // (`accents`) is never touched by this, it only stays covered while `silenced` lists beats. Tapping a dot in the pop-up changes
  // that beat for real (it is no longer covered) — also while silenced, which is how a beat is un-silenced by hand. Not remembered
  // across app launches, song loads or time-signature changes.
  const [silenced, setSilencedState] = useState([]);
  const silencedRef = useRef([]);
  const setSilenced = (list) => { silencedRef.current = list; setSilencedState(list); };
  const toggleMuted = () => {
    const beats = timeSigRef.current?.beats || 4;
    setSilenced(silencedRef.current.length ? [] : Array.from({ length: beats }, (_, i) => i));
  };
  const beatState = (i) => (silencedRef.current.includes(i) ? "mute" : (accentsRef.current[i] || "normal"));

  useEffect(() => { try { localStorage.setItem("altar_metronome_bpm", bpm); } catch { } }, [bpm]);
  useEffect(() => { try { localStorage.setItem("altar_metronome_time_sig", JSON.stringify(timeSig)); } catch { } }, [timeSig]);
  useEffect(() => { try { localStorage.setItem("altar_metronome_accents", JSON.stringify(accents)); } catch { } }, [accents]);
  useEffect(() => { try { localStorage.setItem("altar_metronome_subdivision", subdivision); } catch { } }, [subdivision]);

  const bpmRef = useRef(bpm);
  const timeSigRef = useRef(timeSig);
  const accentsRef = useRef(accents);
  const subdivisionRef = useRef(subdivision);
  const clickToneRef = useRef(settings?.clickTone || "classic");
  const panRef = useRef(settings?.pan || "center");
  const audioCtxRef = useRef(null);
  const masterCompRef = useRef(null);
  const schedulerRef = useRef(null);
  const nextNoteTimeRef = useRef(0);
  const beatRef = useRef(0);
  const tapTimesRef = useRef([]);
  const loadedSongRef = useRef(loadedSong);
  useEffect(() => { loadedSongRef.current = loadedSong; }, [loadedSong]);

  const ensureMasterChain = (ctx) => {
    if (!masterCompRef.current || masterCompRef.current.context !== ctx) {
      const master = ctx.createGain();
      master.gain.setValueAtTime(1.0, ctx.currentTime);
      master.connect(ctx.destination);
      masterCompRef.current = master;
    }
    return masterCompRef.current;
  };

  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => {
    const effBeats = (timeSig.beats === 6 && timeSig.unit === 8) ? 4 : timeSig.beats;
    timeSigRef.current = { beats: effBeats, unit: timeSig.unit };
    beatRef.current = 0;
  }, [timeSig]);
  useEffect(() => { accentsRef.current = accents; }, [accents]);
  useEffect(() => { subdivisionRef.current = subdivision; }, [subdivision]);
  useEffect(() => { if (settings?.clickTone) clickToneRef.current = settings.clickTone; }, [settings?.clickTone]);
  useEffect(() => { if (settings?.pan) panRef.current = settings.pan; }, [settings?.pan]);
  useEffect(() => () => clearInterval(schedulerRef.current), []);
  const wasPlayingBeforeHideRef = useRef(false);
  useEffect(() => {
    // On native, AVAudioSession + UIBackgroundModes:audio handle background
    // playback; the web visibility-change stop/resume would fight it.
    if (isNative) return;
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        // Screen locked / app backgrounded: cleanly pause the metronome
        if (schedulerRef.current !== null) {
          wasPlayingBeforeHideRef.current = true;
          stop();
        } else {
          wasPlayingBeforeHideRef.current = false;
        }
      } else if (document.visibilityState === "visible") {
        // Unlocked / app returned to foreground: resume metronome if it was playing
        if (wasPlayingBeforeHideRef.current) {
          wasPlayingBeforeHideRef.current = false;
          start();
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [isNative]);

  const setBpm = (v, keepSong = false) => {
    const clamped = Math.min(300, Math.max(30, Math.round(v)));
    setBpmState(clamped);
    if (!keepSong) setLoadedSong(null);
    bpmRef.current = clamped;
  };
  const setTimeSig = (ts) => {
    setTimeSigState(ts);
    const effBeats = (ts.beats === 6 && ts.unit === 8) ? 4 : ts.beats;
    const newAccents = defaultAccents(effBeats);
    setAccentsState(newAccents);
    setSilenced([]);
  };
  const setAccents = (arr) => {
    setAccentsState(arr);
  };
  // `next` = the beat pattern as shown (silenced beats appear as "mute") with the user's edit in it. Only the beats that differ from what
  // was shown are changed for real; the rest of the saved pattern is kept. Returns the pattern to save.
  const editAccents = (next) => {
    const merged = accentsRef.current.slice();
    let covered = silencedRef.current;
    next.forEach((state, i) => {
      if (state !== beatState(i)) { merged[i] = state; covered = covered.filter((x) => x !== i); }
    });
    if (covered.length !== silencedRef.current.length) setSilenced(covered);
    accentsRef.current = merged;
    setAccentsState(merged);
    return merged;
  };
  const setSubdivision = (n) => {
    setSubdivisionState(n);
    subdivisionRef.current = n;
    if (loadedSongRef.current?.id) {
      setSongSubdivision(loadedSongRef.current.id, n);
    } else {
      try { localStorage.setItem("altar_metronome_subdivision", n); } catch { }
    }
  };
  const panValue = () => (panRef.current === "left" ? -1 : panRef.current === "right" ? 1 : 0);

  const playClick = (state, time) => {
    if (state === "mute") return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const isAccent = state === "accent";
    const tone = clickToneRef.current;
    const master = ensureMasterChain(ctx);
    const scheduledTime = Math.max(time, ctx.currentTime + 0.002);
    let dest = master;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(panValue(), scheduledTime);
      panner.connect(master);
      dest = panner;
    }
    if (tone === "cowbell") {
      const dur = 0.12;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(isAccent ? 0.42 : 0.24, scheduledTime);
      gain.gain.exponentialRampToValueAtTime(0.001, scheduledTime + dur);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 1.1;
      gain.connect(bp); bp.connect(dest);
      [800, 540].forEach((f) => {
        const osc = ctx.createOscillator();
        osc.type = "square"; osc.frequency.value = isAccent ? f * 1.05 : f;
        osc.connect(gain); osc.start(scheduledTime); osc.stop(scheduledTime + dur);
      });
      return;
    }
    if (tone === "sharp") {
      const dur = 0.05;
      const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 3);
      const noise = ctx.createBufferSource(); noise.buffer = buffer;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass"; hp.frequency.value = isAccent ? 3200 : 2600;
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(isAccent ? 0.9 : 0.65, scheduledTime);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, scheduledTime + dur);
      noise.connect(hp); hp.connect(noiseGain); noiseGain.connect(dest);
      noise.start(scheduledTime); noise.stop(scheduledTime + dur);

      const osc = ctx.createOscillator(); const oscGain = ctx.createGain();
      osc.type = "triangle"; osc.frequency.value = isAccent ? 2600 : 2000;
      oscGain.gain.setValueAtTime(isAccent ? 0.55 : 0.38, scheduledTime);
      oscGain.gain.exponentialRampToValueAtTime(0.001, scheduledTime + 0.025);
      osc.connect(oscGain); oscGain.connect(dest);
      osc.start(scheduledTime); osc.stop(scheduledTime + 0.025);
      return;
    }
    if (tone === "digital") {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = "square"; osc.frequency.value = isAccent ? 1800 : 1200;
      gain.gain.setValueAtTime(isAccent ? 0.5 : 0.28, scheduledTime);
      gain.gain.exponentialRampToValueAtTime(0.001, scheduledTime + 0.03);
      osc.connect(gain); gain.connect(dest);
      osc.start(scheduledTime); osc.stop(scheduledTime + 0.03);
      return;
    }
    // "classic" tone: pre-decoded m_hi.wav (accent) and m_low.wav (normal beat)
    if (_metronomeBuffers && (_metronomeBuffers.hi || _metronomeBuffers.low)) {
      const buf = isAccent ? _metronomeBuffers.hi : _metronomeBuffers.low;
      if (buf) {
        const source = ctx.createBufferSource();
        source.buffer = buf;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(isAccent ? 1.0 : 0.85, scheduledTime);
        source.connect(gain);
        gain.connect(dest);
        source.start(scheduledTime);
        source.onended = () => {
          try { source.disconnect(); gain.disconnect(); } catch { }
        };
        return;
      }
    }
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.frequency.value = isAccent ? 1500 : 1000;
    gain.gain.setValueAtTime(isAccent ? 0.7 : 0.4, scheduledTime);
    gain.gain.exponentialRampToValueAtTime(0.001, scheduledTime + 0.05);
    osc.connect(gain); gain.connect(dest);
    osc.start(scheduledTime); osc.stop(scheduledTime + 0.05);
  };

  const scheduleClick = (beatNum, time) => {
    const ctx = audioCtxRef.current;
    const state = beatState(beatNum);
    playClick(state, time);   // a silent beat makes no sound, but still blinks
    const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    setTimeout(() => setFlashBeat(beatNum), delayMs);
  };

  const scheduler = () => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    while (nextNoteTimeRef.current < ctx.currentTime + 0.1) {
      const beatIndex = beatRef.current;
      const stateNow = beatState(beatIndex);
      const sub = subdivisionRef.current;
      const beatDur = 60 / bpmRef.current;
      const subDur = beatDur / sub;
      for (let k = 0; k < sub; k++) {
        const t = nextNoteTimeRef.current + k * subDur;
        if (k === 0) scheduleClick(beatIndex, t);
        else if (stateNow !== "mute") playClick("normal", t);
      }
      nextNoteTimeRef.current += beatDur;
      beatRef.current = (beatIndex + 1) % timeSigRef.current.beats;
    }
  };

  // ── Native engine mirroring ─────────────────────────────────────────────
  // The Swift engine is the source of truth for "playing" and for the beat
  // position (both come from the audio clock). Subscribe once, not per render.
  useEffect(() => {
    if (!isNative) return;
    const removeBeat = nativeMetronome.addBeatListener(({ beatIndex }) => setFlashBeat(beatIndex));
    const removeState = nativeMetronome.addStateListener(({ playing: p }) => {
      // While one of our own start/stop commands is in flight, its result decides the
      // final state; applying in-between events would make the button flicker.
      if (pendingNativeRef.current > 0) return;
      setPlaying(p);
      if (!p) setFlashBeat(-1);
    });
    const removeTempo = nativeMetronome.addTempoListener(({ bpm: b }) => { if (b) setBpm(b, true); });
    // Re-sync when the app returns to the foreground (e.g. after a call, or lock-screen buttons).
    const resync = () => {
      if (document.visibilityState !== "visible") return;
      nativeMetronome.getState().then(({ playing: p, bpm: b }) => {
        setPlaying(Boolean(p));
        if (!p) setFlashBeat(-1);
        if (p && b) setBpm(b, true);
      }).catch(() => { });
    };
    document.addEventListener("visibilitychange", resync);
    resync();
    return () => { removeBeat(); removeState(); removeTempo(); document.removeEventListener("visibilitychange", resync); };
  }, [isNative]);

  // Number of start/stop commands sent to the engine that haven't answered yet.
  const pendingNativeRef = useRef(0);
  const runNativeCommand = async (command) => {
    pendingNativeRef.current += 1;
    let result = null;
    try {
      result = await command();
    } catch (e) {
      console.error("[Zong metronome]", e);
    } finally {
      pendingNativeRef.current -= 1;
    }
    if (pendingNativeRef.current === 0) {
      const p = Boolean(result?.playing);
      setPlaying(p);
      if (!p) setFlashBeat(-1);
    }
  };
  const shownAccentsNow = () => accentsRef.current.map((_, i) => beatState(i));
  const nativeSettings = () => ({
    bpm: bpmRef.current,
    beatsPerBar: timeSigRef.current.beats,
    accents: shownAccentsNow().map((a) => (a === "mute" ? "silent" : a)),   // the engine's "silent" = no click, beat still reported
    subdivision: subdivisionRef.current,
    title: loadedSongRef.current ? stripAltTitle(loadedSongRef.current.title) : "Metronome",
  });
  // Any change to tempo / time signature / accents / subdivision while playing is
  // sent to the engine once (debounced), whatever caused it — knob, song load, etc.
  useEffect(() => {
    if (!isNative) return;
    const t = setTimeout(() => {
      if (playingStore.value) nativeMetronome.update(nativeSettings()).catch((e) => console.error("[Zong metronome]", e));
    }, 60);
    return () => clearTimeout(t);
  }, [isNative, bpm, timeSig, accents, subdivision, loadedSong, silenced]);

  const start = async () => {
    if (isNative) {
      setPlaying(true); // instant feedback; the engine's answer is applied when it arrives
      await runNativeCommand(() => nativeMetronome.start(nativeSettings()));
      return;
    }
    unlockAudioPlayback();
    // Clear any in-flight scheduler FIRST to prevent a double-click from a
    // scheduler tick that fires between stop() and this new start() call.
    clearInterval(schedulerRef.current);
    schedulerRef.current = null;
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = getSharedAudioContext();
    }
    if (audioCtxRef.current.state === "suspended" || audioCtxRef.current.state === "interrupted") {
      await audioCtxRef.current.resume();
    }
    if (!_metronomeBuffers) {
      await loadAudioSamples(audioCtxRef.current).catch(() => { });
    }
    audioCtxRef.current.onstatechange = () => {
      const ctx = audioCtxRef.current;
      if (!ctx || !schedulerRef.current) return;
      if ((ctx.state === "suspended" || ctx.state === "interrupted") && document.visibilityState === "visible") {
        ctx.resume().catch(() => { });
      }
    };
    ensureMasterChain(audioCtxRef.current);
    beatRef.current = 0;
    // A 50ms lead-in ensures any audio still draining from the previous stop
    // has completely flushed before the first click fires.
    nextNoteTimeRef.current = audioCtxRef.current.currentTime + 0.05;
    schedulerRef.current = setInterval(scheduler, 25);
    setPlaying(true);
  };
  const stop = () => {
    if (isNative) {
      setPlaying(false);
      setFlashBeat(-1);
      runNativeCommand(() => nativeMetronome.stop());
      return;
    }
    clearInterval(schedulerRef.current);
    schedulerRef.current = null;
    setPlaying(false);
    setFlashBeat(-1);
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state !== "closed") {
      // Disconnect the master output node so any already-scheduled (but not yet
      // played) buffer sources have no destination. This is the key guard against
      // the double-click: suspended contexts replay queued sources on resume,
      // but if the master node is disconnected they produce no audible output.
      try {
        if (masterCompRef.current) {
          masterCompRef.current.disconnect();
          masterCompRef.current = null;
        }
      } catch { }
      try { ctx.suspend().catch(() => { }); } catch { }
    }
  };
  const toggle = () => (playingStore.value ? stop() : start());

  const tapTempo = () => {
    const now = performance.now();
    const taps = tapTimesRef.current.filter((t) => now - t < 2000);
    taps.push(now);
    tapTimesRef.current = taps;
    if (taps.length >= 2) {
      const intervals = taps.slice(1).map((t, i) => t - taps[i]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      setBpm(60000 / avg, true);
    }
  };

  const loadSong = (song) => {
    setLoadedSong(song);
    loadedSongRef.current = song;
    const beats = parseTimeSig(song.timeSignature).beats || 4;
    const unit = parseTimeSig(song.timeSignature).unit || 4;
    setBpmState(song.tempo || 120);
    setTimeSigState({ beats, unit });
    const effBeats = (beats === 6 && unit === 8) ? 4 : beats;
    setAccentsState(getSongAccents(song.id, effBeats));
    setSilenced([]);
    // Load per-song on-device subdivision (Requirement 9)
    const songSub = getSongSubdivision(song.id);
    setSubdivisionState(songSub);
    subdivisionRef.current = songSub;
    beatRef.current = 0;
  };
  const loadSongAndPlay = (song) => {
    const beats = parseTimeSig(song.timeSignature).beats || 4;
    const unit = parseTimeSig(song.timeSignature).unit || 4;
    const effBeats = (beats === 6 && unit === 8) ? 4 : beats;
    const pattern = getSongAccents(song.id, effBeats);
    const sub = getSongSubdivision(song.id);
    bpmRef.current = song.tempo || 120;
    timeSigRef.current = { beats: effBeats, unit };
    accentsRef.current = pattern;
    subdivisionRef.current = sub;
    setLoadedSong(song);
    loadedSongRef.current = song;
    setBpmState(song.tempo || 120);
    setTimeSigState({ beats, unit });
    setAccentsState(pattern);
    setSilenced([]);
    setSubdivisionState(sub);
    beatRef.current = 0;
    start();
  };

  return {
    bpm, setBpm, timeSig, setTimeSig, accents, setAccents, subdivision, setSubdivision,
    shownAccents: accents.map((a, i) => (silenced.includes(i) ? "mute" : (a || "normal"))), editAccents,
    toggle, start, stop, tapTempo, loadedSong, loadSong, loadSongAndPlay, muted: silenced.length > 0, toggleMuted,
  };
}
