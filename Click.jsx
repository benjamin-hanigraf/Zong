import { useState, useEffect, useRef, useCallback } from "react";
import {
  Search, Plus, Pencil, Trash2, ChevronLeft, ChevronRight, Play, Square,
  Gauge, ListMusic, Layers, X, Check, Settings, Upload, Download,
} from "lucide-react";


// ---- design tokens ---------------------------------------------------
const C = {
  bg: "#000000",
  surface: "#121212",
  surface2: "#1C1C1E",
  surface3: "#2C2C2E",
  border: "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.18)",
  text: "#FFFFFF",
  textMuted: "#98989D",
  textFaint: "#4D4D50",
  accent: "#FFB020",
  accentDim: "rgba(255,176,32,0.35)",
  danger: "#FF453A",
};

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif";

const TIME_SIGS = [
  { beats: 2, unit: 4 }, { beats: 3, unit: 4 }, { beats: 4, unit: 4 },
  { beats: 6, unit: 4 }, { beats: 6, unit: 8 },
];

const SEED_SONGS = [
  { id: "seed-1", title: "Ella Naamathirkum", artist: "Benny Visuvasam", bpm: 74, beats: 4, unit: 4, subdivision: 2 },
  { id: "seed-2", title: "Holding My World", artist: "Kristian Stanfill", bpm: 97, beats: 6, unit: 8 },
  { id: "seed-3", title: "Our God", artist: "Chris Tomlin", bpm: 105, beats: 4, unit: 4 },
];

const CLICK_TONES = [
  { id: "classic", name: "Classic" },
  { id: "digital", name: "Digital" },
  { id: "wood", name: "Wood Block" },
  { id: "cowbell", name: "Cowbell" },
];
const PAN_OPTIONS = [
  { id: "left", label: "Left" },
  { id: "center", label: "Centre" },
  { id: "right", label: "Right" },
];
const DEFAULT_SETTINGS = { clickTone: "classic", pan: "center" };

// ---- persistence hook for a single settings object ----------------------
function usePersistedObject(key, defaults) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? { ...defaults, ...JSON.parse(stored) } : defaults;
    } catch {
      return defaults;
    }
  });
  const persist = useCallback((next) => {
    setValue(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { }
  }, [key]);
  return [value, persist];
}

// ---- persistence hooks -------------------------------------------------
function usePersistedList(key, seed) {
  const [items, setItems] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : seed;
    } catch {
      return seed;
    }
  });
  const persist = useCallback((next) => {
    setItems(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { }
  }, [key]);
  return [items, persist];
}

// ---- accent pattern helpers ---------------------------------------------
// Each beat is "accent" | "normal" | "mute". Default: no accents, all normal.
function defaultAccents(beats) {
  return Array.from({ length: beats }, () => "normal");
}

// ---- metronome engine (shared by Metronome tab + Stage mode) -----------
function useMetronomeEngine(settings) {
  const [bpm, setBpmState] = useState(() => {
    try {
      const stored = localStorage.getItem("metronome_bpm");
      return stored ? Number(stored) : 120;
    } catch {
      return 120;
    }
  });
  const [timeSig, setTimeSigState] = useState(() => {
    try {
      const stored = localStorage.getItem("metronome_time_sig");
      return stored ? JSON.parse(stored) : { beats: 4, unit: 4 };
    } catch {
      return { beats: 4, unit: 4 };
    }
  });
  const [accents, setAccentsState] = useState(() => {
    try {
      const stored = localStorage.getItem("metronome_accents");
      if (stored) return JSON.parse(stored);

      const storedTimeSig = localStorage.getItem("metronome_time_sig");
      const ts = storedTimeSig ? JSON.parse(storedTimeSig) : { beats: 4, unit: 4 };
      const effBeats = (ts.beats === 6 && ts.unit === 8) ? 4 : ts.beats;
      return defaultAccents(effBeats);
    } catch {
      return defaultAccents(4);
    }
  });
  const [subdivision, setSubdivisionState] = useState(() => {
    try {
      const stored = localStorage.getItem("metronome_subdivision");
      return stored ? Number(stored) : 1;
    } catch {
      return 1;
    }
  }); // 1, 2, or 3 clicks per beat
  const [playing, setPlaying] = useState(false);
  const [flashBeat, setFlashBeat] = useState(-1);
  const [loadedSong, setLoadedSong] = useState(null);

  useEffect(() => {
    try { localStorage.setItem("metronome_bpm", bpm); } catch { }
  }, [bpm]);
  useEffect(() => {
    try { localStorage.setItem("metronome_time_sig", JSON.stringify(timeSig)); } catch { }
  }, [timeSig]);
  useEffect(() => {
    try { localStorage.setItem("metronome_accents", JSON.stringify(accents)); } catch { }
  }, [accents]);
  useEffect(() => {
    try { localStorage.setItem("metronome_subdivision", subdivision); } catch { }
  }, [subdivision]);

  const bpmRef = useRef(bpm);
  const timeSigRef = useRef(timeSig);
  const accentsRef = useRef(accents);
  const subdivisionRef = useRef(subdivision);
  const clickToneRef = useRef(settings?.clickTone || "classic");
  const panRef = useRef(settings?.pan || "center");
  const audioCtxRef = useRef(null);
  const schedulerRef = useRef(null);
  const nextNoteTimeRef = useRef(0);
  const beatRef = useRef(0);
  const tapTimesRef = useRef([]);

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
  // Recover from iOS silently suspending/killing the AudioContext while the
  // tab was backgrounded or the screen was locked mid-playback.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== "visible" || !audioCtxRef.current) return;
      if (audioCtxRef.current.state === "closed") {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      } else if (audioCtxRef.current.state === "suspended" || audioCtxRef.current.state === "interrupted") {
        // iOS 17+ can leave the context in "interrupted" (not just "suspended")
        // after a backgrounding/lock-screen event; both need an explicit resume().
        audioCtxRef.current.resume().catch(() => { });
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  const setBpm = (v, keepSong = false) => {
    setBpmState(Math.min(300, Math.max(30, Math.round(v))));
    if (!keepSong) {
      setLoadedSong(null);
    }
  };
  const setTimeSig = (ts) => {
    setTimeSigState(ts);
    const effBeats = (ts.beats === 6 && ts.unit === 8) ? 4 : ts.beats;
    setAccentsState(defaultAccents(effBeats));
  };
  const setAccents = (arr) => setAccentsState(arr);
  const setSubdivision = (n) => setSubdivisionState(n);

  const panValue = () => (panRef.current === "left" ? -1 : panRef.current === "right" ? 1 : 0);

  // Plays a single click, using whichever tone is selected in Settings.
  // Used both for the beat-defining click (which can be accented/muted per
  // the beat's pattern) and for plain subdivision fill clicks in between,
  // which always sound like an ordinary "normal" click.
  const playClick = (state, time) => {
    if (state === "mute") return;
    const ctx = audioCtxRef.current;
    const isAccent = state === "accent";
    const tone = clickToneRef.current;

    let dest = ctx.destination;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(panValue(), time);
      panner.connect(ctx.destination);
      dest = panner;
    }

    if (tone === "cowbell") {
      // Classic drum-machine cowbell: two square oscillators through a
      // bandpass filter, which is what tames the raw square waves into a
      // metallic "clang" instead of a harsh buzz.
      const dur = 0.12;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(isAccent ? 0.6 : 0.34, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 900;
      bp.Q.value = 1.1;
      gain.connect(bp); bp.connect(dest);
      [800, 540].forEach((f) => {
        const osc = ctx.createOscillator();
        osc.type = "square";
        osc.frequency.value = isAccent ? f * 1.05 : f;
        osc.connect(gain);
        osc.start(time); osc.stop(time + dur);
      });
      return;
    }

    if (tone === "wood") {
      // A wood block is a short, resonant "tock" — better modeled as a
      // brief burst of bandpass-filtered noise than a pitch-sweeping tone,
      // which is what made the old version sound synthetic/sweepy.
      const dur = 0.045;
      const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = isAccent ? 1600 : 1100;
      bp.Q.value = 6;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(isAccent ? 1.0 : 1.0, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
      noise.connect(bp); bp.connect(gain); gain.connect(dest);
      noise.start(time); noise.stop(time + dur);
      return;
    }

    if (tone === "digital") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = isAccent ? 1800 : 1200;
      gain.gain.setValueAtTime(isAccent ? 0.7 : 0.4, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
      osc.connect(gain); gain.connect(dest);
      osc.start(time); osc.stop(time + 0.03);
      return;
    }

    // classic (default): sine beep
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = isAccent ? 1500 : 1000;
    gain.gain.setValueAtTime(isAccent ? 1.0 : 0.56, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    osc.connect(gain); gain.connect(dest);
    osc.start(time); osc.stop(time + 0.05);
  };

  // The beat-defining click: respects accent/mute and flashes the dot.
  // Subdivision fill clicks (scheduled separately) never flash the dot, so
  // the indicator dots keep working exactly as before regardless of subdivision.
  const scheduleClick = (beatNum, time) => {
    const ctx = audioCtxRef.current;
    const state = accentsRef.current[beatNum] || "normal";
    playClick(state, time);
    if (state === "mute") return;
    const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    setTimeout(() => setFlashBeat(beatNum), delayMs);
  };

  const scheduler = () => {
    const ctx = audioCtxRef.current;
    while (nextNoteTimeRef.current < ctx.currentTime + 0.1) {
      const beatIndex = beatRef.current;
      const beatState = accentsRef.current[beatIndex] || "normal";
      const sub = subdivisionRef.current;
      const beatDur = 60 / bpmRef.current;
      const subDur = beatDur / sub;
      for (let k = 0; k < sub; k++) {
        const t = nextNoteTimeRef.current + k * subDur;
        if (k === 0) {
          scheduleClick(beatIndex, t);
        } else if (beatState !== "mute") {
          playClick("normal", t);
        }
      }
      nextNoteTimeRef.current += beatDur;
      beatRef.current = (beatIndex + 1) % timeSigRef.current.beats;
    }
  };

  const start = async () => {
    clearInterval(schedulerRef.current); // guard against a leftover interval from a prior start()
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtxRef.current.state === "suspended" || audioCtxRef.current.state === "interrupted") {
      await audioCtxRef.current.resume();
    }
    beatRef.current = 0;
    nextNoteTimeRef.current = audioCtxRef.current.currentTime + 0.05;
    schedulerRef.current = setInterval(scheduler, 25);
    setPlaying(true);
  };

  const stop = () => {
    clearInterval(schedulerRef.current);
    setPlaying(false);
    setFlashBeat(-1);
  };

  const toggle = () => (playing ? stop() : start());

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
    setBpmState(song.bpm);
    setTimeSigState({ beats: song.beats, unit: song.unit });
    const effBeats = (song.beats === 6 && song.unit === 8) ? 4 : song.beats;
    setAccentsState(song.accents && song.accents.length === effBeats ? song.accents : defaultAccents(effBeats));
    setSubdivisionState(song.subdivision || 1);
    beatRef.current = 0;
  };

  // Loads a song and starts playback immediately. Updates the refs the
  // scheduler reads synchronously (rather than waiting for the effects that
  // sync state -> refs) so playback starts at the new song's tempo/time
  // signature right away instead of a stale one.
  const loadSongAndPlay = (song) => {
    const effBeats = (song.beats === 6 && song.unit === 8) ? 4 : song.beats;
    const pattern = song.accents && song.accents.length === effBeats ? song.accents : defaultAccents(effBeats);
    const sub = song.subdivision || 1;
    bpmRef.current = song.bpm;
    timeSigRef.current = { beats: effBeats, unit: song.unit };
    accentsRef.current = pattern;
    subdivisionRef.current = sub;
    setLoadedSong(song);
    setBpmState(song.bpm);
    setTimeSigState({ beats: song.beats, unit: song.unit });
    setAccentsState(pattern);
    setSubdivisionState(sub);
    beatRef.current = 0;
    start();
  };

  return {
    bpm, setBpm, timeSig, setTimeSig, accents, setAccents, subdivision, setSubdivision,
    playing, toggle, flashBeat, tapTempo, loadedSong, loadSong, loadSongAndPlay,
  };
}

// ---- rotary knob (multi-turn, like a real encoder) -----------------------
// Dragging fully around the knob once changes tempo by DEG_PER_BPM's worth
// of degrees-per-bpm — several full rotations are needed to sweep 30→300,
// matching the feel of dedicated metronome hardware/apps.
const DEG_PER_BPM = 6; // 360° rotation ≈ 60 bpm

const KNOB_TOUCH_PAD = 28; // extra invisible touch margin around the visible ring

function Knob({ value, min = 30, max = 300, onChange, size = 220, playing, onToggle }) {
  const knobRef = useRef(null);
  const rectRef = useRef(null);
  const lastAngleRef = useRef(0);
  const downPosRef = useRef({ x: 0, y: 0 });
  const runningValueRef = useRef(value); // accumulates during a drag, independent of React's render timing
  const [spin, setSpin] = useState(0);
  const [dragging, setDragging] = useState(false);

  const angleFromPointer = (clientX, clientY) => {
    const rect = rectRef.current;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    return Math.atan2(dx, -dy) * (180 / Math.PI); // -180..180, 0 = up
  };

  const handlePointerDown = (e) => {
    rectRef.current = knobRef.current.getBoundingClientRect();
    lastAngleRef.current = angleFromPointer(e.clientX, e.clientY);
    downPosRef.current = { x: e.clientX, y: e.clientY };
    runningValueRef.current = value;
    knobRef.current.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const handlePointerMove = (e) => {
    if (!dragging) return;
    const current = angleFromPointer(e.clientX, e.clientY);
    let delta = current - lastAngleRef.current;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    lastAngleRef.current = current;

    setSpin((s) => (s + delta) % 360);
    runningValueRef.current = Math.min(max, Math.max(min, runningValueRef.current + delta / DEG_PER_BPM));
    onChange(runningValueRef.current);
  };

  const handlePointerUp = (e) => {
    setDragging(false);
    try { knobRef.current.releasePointerCapture(e.pointerId); } catch { }
    // A genuine tap (barely any movement) nudges the tempo instead of
    // spinning: left side of the dial nudges down, right side nudges up.
    // The start/stop button in the center has its own handler that stops
    // propagation, so taps landing there never reach this logic at all.
    const moved = Math.hypot(e.clientX - downPosRef.current.x, e.clientY - downPosRef.current.y);
    if (moved < 6 && rectRef.current) {
      const centerX = rectRef.current.left + rectRef.current.width / 2;
      const step = e.clientX < centerX ? -1 : 1;
      onChange(Math.min(max, Math.max(min, value + step)));
    }
  };

  const ticks = Array.from({ length: 40 });

  return (
    <div
      ref={knobRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        width: size + KNOB_TOUCH_PAD * 2, height: size + KNOB_TOUCH_PAD * 2, margin: -KNOB_TOUCH_PAD,
        position: "relative", touchAction: "none", userSelect: "none", cursor: "grab",
      }}
    >
      <div style={{
        position: "absolute", inset: KNOB_TOUCH_PAD, borderRadius: "50%",
        background: `radial-gradient(circle at 50% 38%, ${C.surface3}, ${C.surface2} 70%)`,
        boxShadow: `inset 0 2px 6px rgba(0,0,0,0.6), inset 0 -1px 0 rgba(255,255,255,0.04), 0 8px 24px rgba(0,0,0,0.5)`,
        border: `1px solid ${C.border}`,
        pointerEvents: "none",
      }}>
        {/* the whole ring (ticks + indicator) rotates together with the finger */}
        <div style={{ position: "absolute", inset: 0, transform: `rotate(${spin}deg)` }}>
          <svg width={size} height={size} style={{ position: "absolute", inset: 0 }}>
            {ticks.map((_, i) => {
              const t = (i / ticks.length) * 360;
              const rad = (t * Math.PI) / 180;
              const r1 = size / 2 - 13;
              const r2 = size / 2 - 7;
              const cx = size / 2, cy = size / 2;
              const x1 = cx + r1 * Math.sin(rad), y1 = cy - r1 * Math.cos(rad);
              const x2 = cx + r2 * Math.sin(rad), y2 = cy - r2 * Math.cos(rad);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.border} strokeWidth={1.5} strokeLinecap="round" />;
            })}
          </svg>
          <div style={{
            position: "absolute", top: "50%", left: "50%", width: 4, height: size * 0.32,
            background: C.accent, borderRadius: 2, transformOrigin: "top center",
            transform: "translate(-50%, 0)",
            boxShadow: `0 0 6px ${C.accent}99`,
          }} />
        </div>

        {/* inner face: purely decorative arrows now (no separate hit zones —
            taps/drags anywhere on the dial are handled by the outer knob's
            own handlers above, which is what fixed the jitter/misfires) */}
        <div style={{
          position: "absolute", inset: size * 0.14, borderRadius: "50%",
          background: `linear-gradient(180deg, ${C.surface2}, #0A0A0A)`,
          border: `1px solid ${C.border}`,
          pointerEvents: "none",
        }}>
          <div style={{
            position: "absolute", left: 0, top: 0, bottom: 0, width: "38%",
            display: "flex", alignItems: "center", justifyContent: "flex-start", paddingLeft: size * 0.09,
          }}>
            <ChevronLeft size={size * 0.1} color={C.textFaint} />
          </div>

          <div style={{
            position: "absolute", right: 0, top: 0, bottom: 0, width: "38%",
            display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: size * 0.09,
          }}>
            <ChevronRight size={size * 0.1} color={C.textFaint} />
          </div>

          <button
            onPointerDown={(e) => { e.stopPropagation(); }}
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            style={{
              position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
              width: size * 0.34, height: size * 0.34, borderRadius: "50%", border: "none",
              background: "transparent", pointerEvents: "auto",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            {playing
              ? <Square size={size * 0.13} color="#fff" fill="#fff" />
              : <Play size={size * 0.14} color="#fff" fill="#fff" style={{ marginLeft: size * 0.015 }} />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- time signature dropdown --------------------------------------------
function TimeSigPicker({ value, onChange, compact, fullWidth }) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const btnRef = useRef(null);
  const DROPDOWN_HEIGHT = 220; // rough max height of the options list

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUpward(spaceBelow < DROPDOWN_HEIGHT && rect.top > spaceBelow);
    }
    setOpen((o) => !o);
  };

  return (
    <div style={{ position: "relative", width: fullWidth ? "100%" : undefined }}>
      <button
        ref={btnRef}
        onClick={handleToggle}
        style={{
          fontFamily: FONT, fontSize: compact ? 14 : 16, fontWeight: 600,
          borderRadius: 10, boxSizing: "border-box",
          border: `1px solid ${C.border}`, background: C.surface2, color: C.text,
          width: fullWidth ? "100%" : undefined, textAlign: "center",
          height: fullWidth ? 58 : undefined,
          padding: fullWidth ? "0 10px" : (compact ? "6px 14px" : "10px 18px"),
          display: fullWidth ? "flex" : undefined, alignItems: fullWidth ? "center" : undefined, justifyContent: fullWidth ? "center" : undefined,
        }}
      >
        {value.beats}/{value.unit}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{
            position: "absolute",
            ...(openUpward ? { bottom: "110%" } : { top: "110%" }),
            left: "50%", transform: "translateX(-50%)", zIndex: 50, minWidth: 84,
            background: C.surface3, border: `1px solid ${C.borderStrong}`, borderRadius: 12,
            overflow: "hidden", boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
          }}>
            {TIME_SIGS.map((ts) => {
              const active = ts.beats === value.beats && ts.unit === value.unit;
              return (
                <div key={`${ts.beats}/${ts.unit}`}
                  onClick={() => { onChange(ts); setOpen(false); }}
                  style={{
                    padding: "10px 16px", fontFamily: FONT, fontSize: 15, fontWeight: 500, textAlign: "center",
                    color: active ? C.accent : C.text,
                    background: active ? "rgba(255,176,32,0.1)" : "transparent",
                  }}>
                  {ts.beats}/{ts.unit}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ---- beat dots + accent editor -------------------------------------------
// Dot count always equals the time signature's top number (the beats-per-bar),
// regardless of the bottom number — so 6/4 and 6/8 both show 6 dots, each
// clicking once per entered BPM. This matches how most simple metronomes
// (and the click track above) treat tempo: the bottom number doesn't change
// click speed, only what "one beat" represents on paper.
//
// Tapping the whole row opens an editor, in the same spot, with enlarged
// dots. Tapping an individual beat there cycles: accent -> normal -> mute.
function dotColor(state, lit) {
  if (state === "mute") return "transparent";
  if (state === "accent") return lit ? C.accent : C.accentDim;
  return lit ? "#fff" : C.surface3;
}

function BeatAccentControl({ count, flashBeat, accents, onChange, size = 9 }) {
  const [open, setOpen] = useState(false);
  const pattern = accents && accents.length === count ? accents : defaultAccents(count);

  const cycleBeat = (i) => {
    const order = ["normal", "accent", "mute"];
    const next = order[(order.indexOf(pattern[i] || "normal") + 1) % order.length];
    const nextPattern = pattern.slice();
    nextPattern[i] = next;
    onChange(nextPattern);
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(true)}
        style={{ display: "flex", gap: 8, justifyContent: "center", background: "none", border: "none", padding: 6, cursor: "pointer" }}
      >
        {pattern.map((state, i) => (
          <div key={i} style={{
            width: size, height: size, borderRadius: "50%",
            background: dotColor(state, flashBeat === i),
            border: state === "mute" ? `1.5px solid ${C.textFaint}` : "none",
            boxSizing: "border-box",
            transition: "background 60ms linear",
          }} />
        ))}
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 140 }} />
          <div style={{
            position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)", marginTop: 10,
            zIndex: 150, background: C.surface3, border: `1px solid ${C.borderStrong}`, borderRadius: 16,
            padding: "16px 18px", boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", gap: 14, minWidth: 220, justifyContent: "center",
          }}>
            {pattern.map((state, i) => (
              <button key={i} onClick={() => cycleBeat(i)} style={{
                background: "none", border: "none", padding: 4, cursor: "pointer",
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: "50%",
                  background: state === "mute" ? "transparent" : state === "accent" ? C.accent : "#fff",
                  border: state === "mute" ? `2px solid ${C.textFaint}` : "none",
                  boxSizing: "border-box",
                }} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const stepBtnStyle = {
  width: 40, height: 40, borderRadius: "50%", border: `1px solid ${C.borderStrong}`,
  background: C.surface2, color: C.text, fontSize: 20, fontFamily: FONT,
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};

const bigStepBtnStyle = {
  width: 56, height: 56, borderRadius: "50%", border: `1px solid ${C.borderStrong}`,
  background: C.surface2, color: C.text, fontSize: 26, fontFamily: FONT,
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};

// ---- beat-subdivision icon (single / two-beamed / three-beamed-with-3) ---
// drawn by hand since lucide-react has no note glyphs.
// ---- musical keyboard icon (small piano glyph, hand-drawn) --------------
function PianoIcon({ size = 20, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="2" y="5" width="20" height="14" rx="1.5" stroke={color} strokeWidth="1.6" />
      <line x1="7.2" y1="5" x2="7.2" y2="19" stroke={color} strokeWidth="1.2" />
      <line x1="12" y1="5" x2="12" y2="19" stroke={color} strokeWidth="1.2" />
      <line x1="16.8" y1="5" x2="16.8" y2="19" stroke={color} strokeWidth="1.2" />
      <rect x="5.4" y="5" width="2.6" height="8" fill={color} />
      <rect x="10.2" y="5" width="2.6" height="8" fill={color} />
      <rect x="15" y="5" width="2.6" height="8" fill={color} />
    </svg>
  );
}

function SubdivisionIcon({ value, size = 18, color }) {
  if (value === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <ellipse cx="7.5" cy="18" rx="4" ry="3" fill={color} />
        <line x1="11.3" y1="18" x2="11.3" y2="4" stroke={color} strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (value === 2) {
    return (
      <svg width={size * 1.15} height={size} viewBox="0 0 28 24" fill="none">
        <ellipse cx="6.5" cy="19" rx="3.4" ry="2.6" fill={color} />
        <ellipse cx="21.5" cy="19" rx="3.4" ry="2.6" fill={color} />
        <line x1="9.7" y1="19" x2="9.7" y2="6" stroke={color} strokeWidth="2" strokeLinecap="round" />
        <line x1="24.7" y1="19" x2="24.7" y2="6" stroke={color} strokeWidth="2" strokeLinecap="round" />
        <line x1="9.7" y1="6" x2="24.7" y2="6" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width={size * 1.5} height={size} viewBox="0 0 40 24" fill="none">
      <text x="20" y="5.5" fontSize="7" fontWeight="700" fill={color} textAnchor="middle" fontFamily={FONT}>3</text>
      <ellipse cx="6" cy="19" rx="3" ry="2.3" fill={color} />
      <ellipse cx="20" cy="19" rx="3" ry="2.3" fill={color} />
      <ellipse cx="34" cy="19" rx="3" ry="2.3" fill={color} />
      <line x1="9" y1="19" x2="9" y2="8" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <line x1="23" y1="19" x2="23" y2="8" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <line x1="37" y1="19" x2="37" y2="8" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <line x1="9" y1="8" x2="37" y2="8" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function StartStopButton({ playing, onClick, size = "large" }) {
  const large = size === "large";
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", justifyContent: "center", gap: large ? 10 : 8,
      fontFamily: FONT, fontSize: large ? 15 : 13, fontWeight: 700,
      padding: large ? "16px 0" : 0,
      height: large ? "auto" : 42,
      width: large ? "100%" : 112,
      maxWidth: large ? 320 : undefined,
      borderRadius: large ? 14 : 10, border: "none",
      background: C.accent, color: "#000",
      boxSizing: "border-box",
    }}>
      {playing
        ? <Square size={large ? 18 : 14} fill="#000" />
        : <Play size={large ? 18 : 14} fill="#000" style={{ marginLeft: large ? 2 : 1.5 }} />}
      <span style={{ minWidth: large ? 48 : 38, textAlign: "left" }}>{playing ? "STOP" : "START"}</span>
    </button>
  );
}

// ---- Metronome tab (full page) -------------------------------------------
function MetronomeScreen({ engine, onUpdateSongAccents, onUpdateSongSubdivision, onOpenSettings, onOpenKeyboard, onLongPressTitle }) {
  const { bpm, setBpm, timeSig, setTimeSig, accents, setAccents, subdivision, setSubdivision, playing, toggle, flashBeat, tapTempo, loadedSong } = engine;
  const [editingBpm, setEditingBpm] = useState(false);
  const [bpmDraft, setBpmDraft] = useState("");
  const longPressTimerRef = useRef(null);

  const startTitleTouch = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      if (onLongPressTitle) onLongPressTitle();
    }, 500);
  };

  const clearTitleTouch = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const changeAccents = (next) => {
    setAccents(next);
    if (loadedSong) onUpdateSongAccents(loadedSong.id, next);
  };

  const cycleSubdivision = () => {
    const next = (subdivision % 3) + 1;
    setSubdivision(next);
    if (loadedSong) onUpdateSongSubdivision(loadedSong.id, next);
  };

  return (
    <div style={{
      minHeight: "calc(100vh - 84px)", display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "space-evenly", padding: "28px 20px 0", boxSizing: "border-box",
    }}>
      <div
        onTouchStart={startTitleTouch}
        onTouchMove={clearTitleTouch}
        onTouchEnd={clearTitleTouch}
        onTouchCancel={clearTitleTouch}
        onMouseDown={startTitleTouch}
        onMouseUp={clearTitleTouch}
        onMouseLeave={clearTitleTouch}
        style={{ textAlign: "center", height: 40, display: "flex", flexDirection: "column", justifyContent: "center", cursor: "pointer" }}
      >
        {loadedSong ? (
          <>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{loadedSong.title}</div>
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>
              {loadedSong.artist}
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 18, fontWeight: 600 }}>Metronome</div>
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>BH</div>
          </>
        )}
      </div>

      <div style={{ textAlign: "center" }}>
        <input
          type="tel"
          inputMode="numeric"
          value={editingBpm ? bpmDraft : String(Math.round(bpm))}
          onFocus={() => { setEditingBpm(true); setBpmDraft(""); }}
          onChange={(e) => setBpmDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
          onBlur={() => {
            const n = parseInt(bpmDraft, 10);
            if (!isNaN(n)) setBpm(n, true);
            setEditingBpm(false);
          }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          className="bpm-number-input"
          style={{
            fontSize: 60, fontWeight: 600, fontFamily: FONT, color: C.accent, fontVariantNumeric: "tabular-nums",
            lineHeight: "42px", background: "transparent", border: "none", textAlign: "center", width: 150, padding: 0,
            caretColor: "transparent",
          }}
        />
        <div style={{ fontSize: 11, letterSpacing: 2, color: C.textMuted, marginTop: 6 }}>BPM</div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", maxWidth: 320, position: "relative" }}>
        <button onClick={onOpenSettings} style={{
          position: "absolute", left: 0, background: "none", border: "none", padding: 8,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Settings size={20} color={C.text} />
        </button>
        <BeatAccentControl count={(timeSig.beats === 6 && timeSig.unit === 8) ? 4 : timeSig.beats} flashBeat={flashBeat} accents={accents} onChange={changeAccents} />
        <button onClick={onOpenKeyboard} style={{
          position: "absolute", right: 0, background: "none", border: "none", padding: 8,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <PianoIcon size={20} color={C.text} />
        </button>
      </div>

      <Knob value={bpm} onChange={(v) => setBpm(v, true)} size={268} playing={playing} onToggle={toggle} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", maxWidth: 320 }}>
        <div style={{ flex: 1 }}>
          <TimeSigPicker value={timeSig} onChange={setTimeSig} fullWidth />
        </div>
        <button onClick={cycleSubdivision} style={{
          flex: 1, height: 58, boxSizing: "border-box", borderRadius: 10, border: `1px solid ${C.border}`,
          background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <SubdivisionIcon value={subdivision} size={19} color={C.text} />
        </button>
        <button onPointerDown={tapTempo} style={{
          flex: 1, height: 58, boxSizing: "border-box", fontFamily: FONT, fontSize: 14, letterSpacing: 1, fontWeight: 600,
          borderRadius: 10, border: `1px solid ${C.border}`,
          background: C.surface2, color: C.text,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          TAP
        </button>
      </div>
    </div>
  );
}

// ---- shared form bits ------------------------------------------------
const inputStyle = {
  width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10,
  padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box",
};
const iconBtnStyle = {
  width: 32, height: 32, borderRadius: 8, border: "none", background: "transparent",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};
function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, letterSpacing: 1.5, color: C.textFaint, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

// Text input whose clear (x) button only appears while the field is
// actively focused/being typed in — not just whenever it happens to hold
// a value. onPointerDown on the clear button calls preventDefault so the
// button can be tapped without the input blurring first (which would hide
// the button before the click ever registers).
function ClearableInput({ value, onChangeText, placeholder, leftIcon, style, type, inputMode, autoFocus, className }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      {leftIcon}
      <input
        autoFocus={autoFocus}
        type={type}
        inputMode={inputMode}
        className={className}
        value={value}
        onChange={(e) => onChangeText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        style={style}
      />
      {focused && value ? (
        <button
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onChangeText("")}
          style={{
            position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
            background: "none", border: "none", padding: 4, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <X size={14} color={C.textMuted} />
        </button>
      ) : null}
    </div>
  );
}

// ---- song form ------------------------------------------------------------
function SongForm({ initial, onSave, onCancel, onDelete, metronomeValues, songs }) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [artist, setArtist] = useState(initial?.artist ?? "");
  const [bpm, setBpm] = useState(initial?.bpm ?? metronomeValues.bpm ?? 120);
  const [timeSig, setTimeSig] = useState(() => {
    if (initial) {
      return { beats: initial.beats ?? 4, unit: initial.unit ?? 4 };
    }
    return { beats: metronomeValues.timeSig.beats ?? 4, unit: metronomeValues.timeSig.unit ?? 4 };
  });
  const [accents, setAccents] = useState(() => {
    const initialBeats = initial?.beats ?? metronomeValues.timeSig.beats ?? 4;
    const initialUnit = initial?.unit ?? metronomeValues.timeSig.unit ?? 4;
    const effBeats = (initialBeats === 6 && initialUnit === 8) ? 4 : initialBeats;
    if (initial) {
      return initial.accents && initial.accents.length === effBeats ? initial.accents : defaultAccents(effBeats);
    }
    return metronomeValues.accents ? [...metronomeValues.accents] : defaultAccents(effBeats);
  });
  const [subdivision, setSubdivision] = useState(() => {
    if (initial) {
      return initial.subdivision ?? 1;
    }
    return metronomeValues.subdivision ?? 1;
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");

  // Swipe left-to-right to go back, matching Stage/Settings screens.
  const touchStartRef = useRef(null);
  const [dragX, setDragX] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const handleTouchStart = (e) => {
    if (leaving) return;
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const handleTouchMove = (e) => {
    if (!touchStartRef.current || leaving) return;
    const dx = e.touches[0].clientX - touchStartRef.current.x;
    const dy = e.touches[0].clientY - touchStartRef.current.y;
    if (dx > 0 && dx > Math.abs(dy)) setDragX(dx);
  };
  const handleTouchEnd = () => {
    if (!touchStartRef.current) return;
    touchStartRef.current = null;
    if (dragX > 30) {
      setLeaving(true);
      setDragX(typeof window !== "undefined" ? window.innerWidth : 375);
      setTimeout(onCancel, 200);
    } else {
      setDragX(0);
    }
  };

  const handleTimeSigChange = (ts) => {
    setTimeSig(ts);
    const effBeats = (ts.beats === 6 && ts.unit === 8) ? 4 : ts.beats;
    setAccents(defaultAccents(effBeats));
  };

  const handleSave = () => {
    const cleanTitle = title.trim();
    const cleanArtist = artist.trim();

    // Check if duplicate exists (case-insensitive)
    const isDuplicate = songs.some((s) => {
      if (initial && s.id === initial.id) return false;
      return s.title.trim().toLowerCase() === cleanTitle.toLowerCase() &&
        (s.artist || "").trim().toLowerCase() === cleanArtist.toLowerCase();
    });

    if (isDuplicate) {
      setError("Song already exists");
      return;
    }

    onSave({
      title: cleanTitle,
      artist: cleanArtist,
      bpm,
      beats: timeSig.beats,
      unit: timeSig.unit,
      accents,
      subdivision
    });
  };

  const canSave = title.trim().length > 0;

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 100, overflowY: "auto",
        transform: `translateX(${dragX}px)`,
        transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none",
      }}
      onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} onTouchCancel={handleTouchEnd}
    >
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, background: C.bg }}>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}>
          <ChevronLeft size={22} />
        </button>
        <div style={{ fontSize: 17, fontWeight: 600 }}>{initial ? "Edit Song" : "Add Song"}</div>
      </div>

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18, paddingBottom: 60 }}>
        <Field label="TITLE">
          <ClearableInput
            autoFocus={!initial}
            value={title}
            onChangeText={(v) => { setTitle(v); setError(""); }}
            placeholder="Song title"
            style={{ ...inputStyle, paddingRight: title ? 36 : 14 }}
          />
        </Field>
        <Field label="ARTIST">
          <ClearableInput
            value={artist}
            onChangeText={(v) => { setArtist(v); setError(""); }}
            placeholder="Artist"
            style={{ ...inputStyle, paddingRight: artist ? 36 : 14 }}
          />
        </Field>
        <div style={{ display: "flex", gap: 14 }}>
          <div style={{ flex: 1 }}>
            <Field label="TIME SIGNATURE">
              <TimeSigPicker value={timeSig} onChange={handleTimeSigChange} fullWidth />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="TEMPO (BPM)">
              <input
                type="number"
                inputMode="numeric"
                value={bpm}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") { setBpm(""); return; }
                  const n = parseInt(v, 10);
                  if (!isNaN(n)) setBpm(n);
                }}
                onBlur={() => setBpm((b) => Math.min(300, Math.max(30, Math.round(Number(b) || 120))))}
                className="bpm-number-input"
                style={{
                  ...inputStyle, fontSize: 20, fontVariantNumeric: "tabular-nums", textAlign: "center",
                  height: 58, boxSizing: "border-box",
                }}
              />
            </Field>
          </div>
        </div>

        {/* Accents and beat division are no longer set here — they're
            dialed in on the Metronome tab itself and saved back onto the
            song automatically (see onUpdateSongAccents/onUpdateSongSubdivision). */}

        {error && (
          <div style={{ color: C.danger, fontSize: 13, textAlign: "center", marginBottom: 4, fontWeight: 500 }}>
            {error}
          </div>
        )}

        <button
          disabled={!canSave}
          onClick={handleSave}
          style={{
            marginTop: 8, fontFamily: FONT, fontWeight: 700, fontSize: 15,
            padding: "16px 0", borderRadius: 14, border: "none",
            background: canSave ? C.accent : C.surface2, color: canSave ? "#000" : C.textFaint,
          }}
        >
          SAVE
        </button>

        {initial && (
          confirmDelete ? (
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setConfirmDelete(false)} style={{
                flex: 1, fontFamily: FONT, fontWeight: 600, fontSize: 14,
                padding: "14px 0", borderRadius: 12, border: `1px solid ${C.borderStrong}`, background: "transparent", color: C.textMuted,
              }}>Cancel</button>
              <button onClick={() => onDelete(initial.id)} style={{
                flex: 1, fontFamily: FONT, fontWeight: 700, fontSize: 14,
                padding: "14px 0", borderRadius: 12, border: "none", background: C.danger, color: "#fff",
              }}>Confirm Delete</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} style={{
              fontFamily: FONT, fontWeight: 600, fontSize: 14,
              padding: "14px 0", borderRadius: 12, border: `1px solid ${C.border}`, background: "transparent", color: C.danger,
            }}>Delete Song</button>
          )
        )}
      </div>
    </div>
  );
}

// ---- song row (tap to load, long-press to edit) -------------------------
function SongRow({ song, onOpen, onEdit }) {
  const longPressTimerRef = useRef(null);
  const firedLongPressRef = useRef(false);

  const startPress = () => {
    firedLongPressRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      firedLongPressRef.current = true;
      onEdit(song);
    }, 500);
  };
  const cancelPress = () => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  };
  const handleClick = () => {
    if (firedLongPressRef.current) { firedLongPressRef.current = false; return; }
    onOpen(song);
  };

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}
      onClick={handleClick}
      onTouchStart={startPress}
      onTouchMove={cancelPress}
      onTouchEnd={cancelPress}
      onTouchCancel={cancelPress}
      onMouseDown={startPress}
      onMouseUp={cancelPress}
      onMouseLeave={cancelPress}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>
          {song.artist || "Unknown"} · {song.beats}/{song.unit}
        </div>
      </div>
      <div style={{ fontSize: 18, color: C.accent, minWidth: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{song.bpm}</div>
    </div>
  );
}

// ---- Songs tab ------------------------------------------------------------
function SongsScreen({ songs, onLoadSong, onAdd, onEdit }) {
  const [query, setQuery] = useState("");
  const filtered = songs
    .filter((s) => (s.title + " " + s.artist).toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  return (
    <div style={{ height: "calc(100vh - 84px)", display: "flex", flexDirection: "column" }}>
      {/* stationary header: title + search never scroll */}
      <div style={{ flex: "0 0 auto", padding: "22px 20px 14px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700 }}>Songs</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{songs.length} songs</div>
          </div>
          <button onClick={onAdd} style={{
            width: 34, height: 34, borderRadius: "50%", border: `1px solid ${C.border}`, background: C.surface2,
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <Plus size={17} color={C.accent} />
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          <ClearableInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search title or artist"
            leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
            style={{ ...inputStyle, paddingLeft: 36, paddingRight: query ? 36 : 14 }}
          />
        </div>
      </div>

      {/* only this part scrolls */}
      <div
        style={{
          flex: 1,
          overflowY: "scroll",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
          msOverflowStyle: "none",
          padding: "0 20px 14px",
          boxSizing: "border-box",
        }}
        className="no-scrollbar"
      >
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>
            {songs.length === 0 ? "No songs yet — tap + to add one." : "No matches."}
          </div>
        ) : filtered.map((s) => (
          <SongRow key={s.id} song={s} onOpen={onLoadSong} onEdit={onEdit} />
        ))}
      </div>
    </div>
  );
}

// ---- full-page song picker (used from Stage mode) -------------------
function SongPickerScreen({ songs, selectedIds, onToggle, onClose, setlistName }) {
  const [query, setQuery] = useState("");
  const filtered = songs.filter((s) => (s.title + " " + s.artist).toLowerCase().includes(query.toLowerCase()));

  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 150, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onClose} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}>
          <ChevronLeft size={22} />
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 600 }}>Add Songs</div>
          {setlistName && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 1 }}>{setlistName}</div>}
        </div>
        <button onClick={onClose} style={{
          background: "none", border: "none", fontFamily: FONT, fontSize: 15.5, fontWeight: 700, color: C.accent, padding: "6px 4px",
        }}>
          Done
        </button>
      </div>

      <div style={{ padding: "14px 20px 6px" }}>
        <div style={{ position: "relative" }}>
          <Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)" }} />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title or artist" style={{ ...inputStyle, paddingLeft: 36 }} />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "6px 20px 40px" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>
            {songs.length === 0 ? "No songs in your library yet." : "No matches."}
          </div>
        ) : filtered.map((s) => {
          const checked = selectedIds.includes(s.id);
          return (
            <div key={s.id} onClick={() => onToggle(s.id)} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "13px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer",
            }}>
              <div style={{
                width: 21, height: 21, borderRadius: "50%", border: `1.5px solid ${checked ? C.accent : C.borderStrong}`,
                background: checked ? C.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}>
                {checked && <Check size={14} color="#000" />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15.5, fontWeight: 600 }}>{s.title}</div>
                <div style={{ fontSize: 12.5, color: C.textMuted }}>{s.artist || "Unknown"}</div>
              </div>
              <div style={{ fontSize: 15, color: C.accent, fontVariantNumeric: "tabular-nums" }}>{s.bpm}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- modal shell (still used for "New Setlist") -----------------------
function Modal({ title, onClose, children }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "flex-end" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)" }} />
      <div style={{
        position: "relative", width: "100%", background: C.surface2, borderTopLeftRadius: 20, borderTopRightRadius: 20,
        padding: 20, paddingBottom: 32, fontFamily: FONT, color: C.text, maxHeight: "80vh", overflowY: "auto",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{title}</div>
          <button onClick={onClose} style={iconBtnStyle}><X size={18} color={C.textMuted} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---- swipe-to-delete row (iOS style: swipe right-to-left to reveal Delete) --
// Controlled via id/openId/onOpenIdChange so a list can guarantee only one
// row is revealed at a time — opening a new one auto-closes the previous.
const SWIPE_REVEAL = 76;
function SwipeToDelete({ id, openId, onOpenIdChange, onDelete, children }) {
  const [translateX, setTranslateX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startTranslateRef = useRef(0);
  const movedRef = useRef(false);
  const directionRef = useRef(null); // null = undetermined, "x" = swipe, "y" = vertical scroll
  const isOpen = openId === id;

  useEffect(() => { if (!isOpen) setTranslateX(0); }, [isOpen]);

  const handleTouchStart = (e) => {
    if (openId !== null && openId !== id) onOpenIdChange(null); // close any other open row
    startXRef.current = e.touches[0].clientX;
    startYRef.current = e.touches[0].clientY;
    startTranslateRef.current = translateX;
    movedRef.current = false;
    directionRef.current = null;
    setDragging(true);
  };
  const handleTouchMove = (e) => {
    const dx = e.touches[0].clientX - startXRef.current;
    const dy = e.touches[0].clientY - startYRef.current;

    // Determine intent once, from the first meaningful movement: a mostly
    // vertical gesture is a list scroll and should never also drag the row
    // sideways — once locked to "y" we stop reacting to further moves and
    // let the browser's native scrolling take over.
    if (directionRef.current === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      directionRef.current = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    }
    if (directionRef.current === "y") return;

    e.stopPropagation();
    if (Math.abs(dx) > 6) movedRef.current = true;
    const next = Math.min(0, Math.max(-SWIPE_REVEAL, startTranslateRef.current + dx));
    setTranslateX(next);
  };
  const handleTouchEnd = (e) => {
    setDragging(false);
    if (directionRef.current === "y") { directionRef.current = null; return; }
    e.stopPropagation();
    const shouldOpen = translateX < -SWIPE_REVEAL / 2;
    setTranslateX(shouldOpen ? -SWIPE_REVEAL : 0);
    onOpenIdChange(shouldOpen ? id : null);
    directionRef.current = null;
  };
  const handleContentClickCapture = (e) => {
    if (movedRef.current) { e.stopPropagation(); return; }
    if (isOpen) {
      e.stopPropagation();
      setTranslateX(0);
      onOpenIdChange(null);
    }
  };

  return (
    <div style={{ position: "relative", overflow: "hidden" }}>
      <div style={{
        position: "absolute", top: 0, right: 0, bottom: 0, width: SWIPE_REVEAL,
        display: "flex", alignItems: "stretch", justifyContent: "center", background: "#161618",
      }}>
        <button
          onClick={() => { onDelete(); setTranslateX(0); onOpenIdChange(null); }}
          style={{ width: "100%", background: "none", border: "none", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <Trash2 size={18} color={C.danger} />
        </button>
      </div>
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClickCapture={handleContentClickCapture}
        style={{
          transform: `translateX(${translateX}px)`,
          transition: dragging ? "none" : "transform 200ms ease",
          background: C.bg,
          touchAction: "pan-y",
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ---- Setlists tab ----------------------------------------------------
function SetlistsScreen({ setlists, onOpenStage, onCreate, onDelete, creating, setCreating }) {
  const [name, setName] = useState("");
  const [openSwipeId, setOpenSwipeId] = useState(null);
  const [query, setQuery] = useState("");

  const submit = () => {
    if (name.trim()) onCreate(name.trim());
    setName(""); setCreating(false);
  };

  const filtered = setlists.filter((sl) => sl.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div style={{ height: "calc(100vh - 84px)", display: "flex", flexDirection: "column" }}>
      {/* stationary header: title + search never scroll */}
      <div style={{ flex: "0 0 auto", padding: "22px 20px 14px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700 }}>Setlists</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{setlists.length} setlist{setlists.length === 1 ? "" : "s"}</div>
          </div>
          <button onClick={() => setCreating(true)} style={{
            width: 34, height: 34, borderRadius: "50%", border: `1px solid ${C.border}`,
            background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <Plus size={17} color={C.accent} />
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          <ClearableInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search setlists"
            leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
            style={{ ...inputStyle, paddingLeft: 36, paddingRight: query ? 36 : 14 }}
          />
        </div>
      </div>

      {/* only this part scrolls */}
      <div
        style={{
          flex: 1,
          overflowY: "scroll",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
          msOverflowStyle: "none",
          padding: "0 20px 14px",
          boxSizing: "border-box",
        }}
        className="no-scrollbar"
      >
        {filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>
            {setlists.length === 0 ? "No Setlists Added" : "No matches."}
          </div>
        )}
        {[...filtered].reverse().map((sl) => (
          <SwipeToDelete key={sl.id} id={sl.id} openId={openSwipeId} onOpenIdChange={setOpenSwipeId} onDelete={() => onDelete(sl.id)}>
            <div onClick={() => onOpenStage(sl.id)} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{sl.name}</div>
                <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>{sl.songIds.length} song{sl.songIds.length === 1 ? "" : "s"}</div>
              </div>
            </div>
          </SwipeToDelete>
        ))}
      </div>

      {creating && (
        <Modal title="New Setlist" onClose={() => setCreating(false)}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Setlist name" style={inputStyle} />
          <button onClick={submit} disabled={!name.trim()} style={{
            marginTop: 14, width: "100%", fontFamily: FONT, fontWeight: 700, fontSize: 15,
            padding: "14px 0", borderRadius: 12, border: "none",
            background: name.trim() ? C.accent : C.surface3, color: name.trim() ? "#000" : C.textFaint,
          }}>
            CREATE
          </button>
        </Modal>
      )}
    </div>
  );
}

// ---- Stage mode (no knob — number + steppers, to leave room for songs) --
// ---- press-and-hold repeat, with an accelerating (ease-out) speed curve --
// First tap fires immediately. Holding waits a beat, then repeats, speeding
// up the longer you hold — starts slow, ramps up quickly, settles near a
// fast floor rate (an "upward curve" of speed, i.e. a decaying interval).
function useHoldRepeat(step) {
  const timeoutRef = useRef(null);
  const startTimeRef = useRef(0);
  const activeRef = useRef(false);
  const stepRef = useRef(step);
  stepRef.current = step;

  const clear = () => {
    activeRef.current = false;
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  };

  const scheduleNext = () => {
    if (!activeRef.current) return;
    const heldSeconds = (performance.now() - startTimeRef.current) / 1000;
    const minInterval = 35;    // fastest repeat rate once fully ramped up (ms)
    const startInterval = 300; // repeat rate right as holding begins (ms)
    const tau = 0.55;          // how quickly it ramps up toward minInterval
    const interval = minInterval + (startInterval - minInterval) * Math.exp(-heldSeconds / tau);
    timeoutRef.current = setTimeout(() => {
      stepRef.current();
      scheduleNext();
    }, interval);
  };

  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    clear();
    activeRef.current = true;
    startTimeRef.current = performance.now();
    stepRef.current(); // fire immediately for a normal tap
    timeoutRef.current = setTimeout(scheduleNext, 380); // pause before repeats begin
  };

  useEffect(() => () => clear(), []);

  return { onPointerDown, onPointerUp: clear, onPointerLeave: clear, onPointerCancel: clear };
}

function StageScreen({ setlists, songs, index, onBack, engine, onUpdateSetlist, initialPickerOpen }) {

  const [pickerOpen, setPickerOpen] = useState(!!initialPickerOpen);
  const [openSwipeId, setOpenSwipeId] = useState(null);
  const touchStartRef = useRef(null);
  const [dragX, setDragX] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const nameLongPressTimerRef = useRef(null);
  const setlist = setlists[index];

  // Song reorder drag state variables
  const [activeDragIndex, setActiveDragIndex] = useState(null);
  const [dragY, setDragY] = useState(0);
  const dragTimerRef = useRef(null);
  const startYRef = useRef(0);
  const justDraggedRef = useRef(false);

  // Kept in sync so the hold-repeat loop always steps from the latest bpm,
  // not a value captured when the press started.
  const stageBpmRef = useRef(engine.bpm);
  useEffect(() => { stageBpmRef.current = engine.bpm; }, [engine.bpm]);
  const decHold = useHoldRepeat(() => changeStageBpm(stageBpmRef.current - 1));
  const incHold = useHoldRepeat(() => changeStageBpm(stageBpmRef.current + 1));

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed) onUpdateSetlist({ ...setlist, name: trimmed });
    setEditingName(false);
  };

  const startNameLongPress = () => {
    if (nameLongPressTimerRef.current) clearTimeout(nameLongPressTimerRef.current);
    nameLongPressTimerRef.current = setTimeout(() => {
      setNameDraft(setlist.name);
      setEditingName(true);
    }, 500);
  };
  const cancelNameLongPress = () => {
    if (nameLongPressTimerRef.current) { clearTimeout(nameLongPressTimerRef.current); nameLongPressTimerRef.current = null; }
  };

  const handleTouchStart = (e) => {
    if (leaving) return;
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const handleTouchMove = (e) => {
    if (!touchStartRef.current || leaving) return;
    const dx = e.touches[0].clientX - touchStartRef.current.x;
    const dy = e.touches[0].clientY - touchStartRef.current.y;
    if (dx > 0 && dx > Math.abs(dy)) setDragX(dx);
  };
  const handleTouchEnd = () => {
    if (!touchStartRef.current) return;
    touchStartRef.current = null;
    if (dragX > 30) {
      setLeaving(true);
      setDragX(typeof window !== "undefined" ? window.innerWidth : 375);
      setTimeout(onBack, 200);
    } else {
      setDragX(0);
    }
  };

  if (!setlist) return null;
  // Apply any per-setlist tempo/accent override on top of the song's defaults
  // from the main Songs library — editing here never writes back to that library.
  const setlistSongs = setlist.songIds
    .map((id) => {
      const s = songs.find((s) => s.id === id);
      if (!s) return null;
      const bpmOverride = setlist.tempos?.[id];
      const accentOverride = setlist.accentOverrides?.[id];
      return {
        ...s,
        bpm: bpmOverride != null ? bpmOverride : s.bpm,
        accents: accentOverride || s.accents,
      };
    })
    .filter(Boolean);

  // Removing a song from a setlist also clears its tempo/accent overrides for
  // that setlist, so re-adding it later restores the song's original tempo.
  const removeFromStage = (songId) => {
    const nextTempos = { ...(setlist.tempos || {}) };
    delete nextTempos[songId];
    const nextAccentOverrides = { ...(setlist.accentOverrides || {}) };
    delete nextAccentOverrides[songId];
    onUpdateSetlist({ ...setlist, songIds: setlist.songIds.filter((id) => id !== songId), tempos: nextTempos, accentOverrides: nextAccentOverrides });
  };
  const toggleSong = (songId) => {
    const has = setlist.songIds.includes(songId);
    if (has) removeFromStage(songId);
    else onUpdateSetlist({ ...setlist, songIds: [...setlist.songIds, songId] });
  };

  // Changing tempo/accents in Stage mode only affects this song within this setlist.
  const changeStageBpm = (newBpm) => {
    const clamped = Math.min(300, Math.max(30, Math.round(newBpm)));
    engine.setBpm(clamped, true);
    if (engine.loadedSong) {
      onUpdateSetlist({ ...setlist, tempos: { ...(setlist.tempos || {}), [engine.loadedSong.id]: clamped } });
    }
  };
  const changeStageAccents = (nextAccents) => {
    engine.setAccents(nextAccents);
    if (engine.loadedSong) {
      onUpdateSetlist({ ...setlist, accentOverrides: { ...(setlist.accentOverrides || {}), [engine.loadedSong.id]: nextAccents } });
    }
  };

  const handleSongTouchStart = (idx, e) => {
    if (e.touches.length !== 1) return;
    const clientY = e.touches[0].clientY;
    startYRef.current = clientY;

    if (dragTimerRef.current) clearTimeout(dragTimerRef.current);
    dragTimerRef.current = setTimeout(() => {
      setActiveDragIndex(idx);
      setDragY(0);
      if (navigator.vibrate) navigator.vibrate(15);
    }, 400);
  };

  const handleSongTouchMove = (idx, e) => {
    if (e.touches.length !== 1) return;
    const clientY = e.touches[0].clientY;

    if (activeDragIndex === null) {
      const diffY = Math.abs(clientY - startYRef.current);
      if (diffY > 10) {
        clearTimeout(dragTimerRef.current);
      }
    } else {
      e.preventDefault();
      e.stopPropagation();
      const deltaY = clientY - startYRef.current;
      setDragY(deltaY);

      const rowHeight = 60;
      const totalSongs = setlistSongs.length;

      if (deltaY > rowHeight / 2 && idx < totalSongs - 1) {
        const newSongIds = [...setlist.songIds];
        const temp = newSongIds[idx];
        newSongIds[idx] = newSongIds[idx + 1];
        newSongIds[idx + 1] = temp;
        onUpdateSetlist({ ...setlist, songIds: newSongIds });

        startYRef.current += rowHeight;
        setActiveDragIndex(idx + 1);
        setDragY(clientY - startYRef.current);
      } else if (deltaY < -rowHeight / 2 && idx > 0) {
        const newSongIds = [...setlist.songIds];
        const temp = newSongIds[idx];
        newSongIds[idx] = newSongIds[idx - 1];
        newSongIds[idx - 1] = temp;
        onUpdateSetlist({ ...setlist, songIds: newSongIds });

        startYRef.current -= rowHeight;
        setActiveDragIndex(idx - 1);
        setDragY(clientY - startYRef.current);
      }
    }
  };

  const handleSongTouchEnd = () => {
    if (dragTimerRef.current) clearTimeout(dragTimerRef.current);
    if (activeDragIndex !== null) justDraggedRef.current = true;
    setActiveDragIndex(null);
    setDragY(0);
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 100, display: "flex", flexDirection: "column",
        transform: `translateX(${dragX}px)`,
        transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none",
      }}
      onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} onTouchCancel={handleTouchEnd}>
      <div style={{ padding: "16px 16px 12px", display: "flex", alignItems: "center", gap: 6 }}>
        <button onClick={onBack} style={{
          width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center",
          background: "none", border: "none", color: C.textMuted, flexShrink: 0,
        }}>
          <ChevronLeft size={22} />
        </button>

        {/* Setlist name — long-press to edit inline */}
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            style={{
              flex: 1, fontFamily: FONT, fontSize: 16, fontWeight: 700,
              background: "transparent", border: "none", borderRadius: 8,
              color: C.text, textAlign: "center", padding: "6px 10px",
              textTransform: "uppercase", letterSpacing: 0.5,
              outline: "none", boxShadow: "none", caretColor: C.accent,
              WebkitTapHighlightColor: "transparent",
            }}
          />
        ) : (
          <button
            onTouchStart={startNameLongPress}
            onTouchMove={cancelNameLongPress}
            onTouchEnd={cancelNameLongPress}
            onTouchCancel={cancelNameLongPress}
            onMouseDown={startNameLongPress}
            onMouseUp={cancelNameLongPress}
            onMouseLeave={cancelNameLongPress}
            style={{
              flex: 1, textAlign: "center", fontSize: 16, fontWeight: 700, padding: "0 4px",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              textTransform: "uppercase", letterSpacing: 0.5,
              background: "none", border: "none", color: C.text,
            }}
          >
            {setlist.name}
          </button>
        )}

        <button onClick={() => setPickerOpen(true)} style={{
          width: 34, height: 34, borderRadius: "50%", border: `1px solid ${C.border}`, background: C.surface2,
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }}>
          <Pencil size={15} color={C.accent} />
        </button>
      </div>

      {/* tempo + beat indicator dots */}
      <div style={{ flex: "0 0 auto", padding: "18px 20px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 44, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{engine.bpm}</div>
        <BeatAccentControl count={(engine.timeSig.beats === 6 && engine.timeSig.unit === 8) ? 4 : engine.timeSig.beats} flashBeat={engine.flashBeat} accents={engine.accents} onChange={changeStageAccents} />
      </div>

      {/* song list */}
      <div
        className="no-scrollbar"
        style={{
          flex: 1, overflowY: activeDragIndex !== null ? "hidden" : "auto", padding: "8px 0 12px",
          scrollbarWidth: "none", msOverflowStyle: "none", touchAction: activeDragIndex !== null ? "none" : "pan-y",
        }}
      >
        {setlistSongs.length === 0 ? (
          <div style={{ textAlign: "center", padding: "36px 20px", color: C.textFaint, fontSize: 13 }}>No songs added yet.</div>
        ) : setlistSongs.map((s, idx) => {
          const selected = engine.loadedSong?.id === s.id;
          const isDraggingThis = activeDragIndex === idx;
          return (
            <SwipeToDelete key={s.id} id={s.id} openId={openSwipeId} onOpenIdChange={setOpenSwipeId} onDelete={() => removeFromStage(s.id)}>
              <div
                onTouchStart={(e) => handleSongTouchStart(idx, e)}
                onTouchMove={(e) => handleSongTouchMove(idx, e)}
                onTouchEnd={handleSongTouchEnd}
                onTouchCancel={handleSongTouchEnd}
                onClick={() => {
                  if (justDraggedRef.current) {
                    justDraggedRef.current = false;
                    return;
                  }
                  if (activeDragIndex === null) {
                    engine.loadSongAndPlay(s);
                  }
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "12px 28px 12px 20px", borderBottom: `1px solid ${C.border}`,
                  cursor: "pointer",
                  position: "relative",
                  transform: isDraggingThis ? `translateY(${dragY}px)` : "none",
                  zIndex: isDraggingThis ? 100 : 1,
                  background: isDraggingThis ? C.surface3 : C.bg,
                  boxShadow: isDraggingThis ? "0 8px 24px rgba(0,0,0,0.6)" : "none",
                  transition: isDraggingThis ? "none" : "transform 0.15s ease, background 0.15s ease",
                  touchAction: activeDragIndex !== null ? "none" : "pan-y",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: selected ? C.accent : C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                  <div style={{ fontSize: 12, color: C.textMuted }}>{s.artist ? s.artist : "Unknown"} · {s.beats}/{s.unit}</div>
                </div>
                <div style={{ fontSize: 16, color: selected ? C.accent : C.textMuted, fontVariantNumeric: "tabular-nums" }}>{s.bpm}</div>
              </div>
            </SwipeToDelete>
          );
        })}
      </div>

      {/* now-playing style control band */}
      <div style={{
        flex: "0 0 auto", display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center",
        padding: "16px 20px max(34px, calc(16px + env(safe-area-inset-bottom, 0px)))", background: "#0B0B0C", borderTop: `1px solid ${C.border}`,
      }}>
        <button {...decHold} style={{ ...bigStepBtnStyle, justifySelf: "center", touchAction: "none" }}>−</button>
        <button onClick={engine.toggle} style={{
          width: 112, height: 112, borderRadius: "50%", border: "none", background: "#000",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }}>
          {engine.playing
            ? <Square size={38} color={C.accent} fill={C.accent} />
            : <Play size={38} color={C.accent} fill={C.accent} style={{ marginLeft: 3 }} />}
        </button>
        <button {...incHold} style={{ ...bigStepBtnStyle, justifySelf: "center", touchAction: "none" }}>+</button>
      </div>

      {pickerOpen && (
        <SongPickerScreen
          songs={songs}
          selectedIds={setlist.songIds}
          onToggle={toggleSong}
          onClose={() => setPickerOpen(false)}
          setlistName={setlist.name}
        />
      )}
    </div>
  );
}

// ---- bottom nav -----------------------------------------------------
function BottomNav({ active, onChange }) {
  const items = [
    { id: "metronome", label: "Metronome", icon: Gauge },
    { id: "songs", label: "Songs", icon: ListMusic },
    { id: "setlists", label: "Setlists", icon: Layers },
  ];

  return (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 30 }}>
      {/* solid black fill from the bar's top to the very bottom of the screen */}
      <div style={{
        display: "flex",
        background: "#000000",
        paddingTop: 10,
        paddingBottom: "max(28px, calc(10px + env(safe-area-inset-bottom, 0px)))",
      }}>
        {items.map(({ id, label, icon: Icon }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              onClick={() => onChange(id)}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 3,
                padding: "0 0 6px",
                background: "none",
                border: "none",
                fontFamily: FONT,
                cursor: "pointer",
              }}
            >
              <Icon size={18} color={isActive ? C.accent : C.textMuted} strokeWidth={isActive ? 2.3 : 1.8} />
              <span style={{ fontSize: 8, color: isActive ? C.accent : C.textMuted, fontWeight: isActive ? 600 : 400 }}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- root ----------------------------------------------------------
// ---- Settings screen -----------------------------------------------------
function SettingsScreen({ settings, onChange, onExport, onImport, onClose }) {
  const [toneIndex, setToneIndex] = useState(() => Math.max(0, CLICK_TONES.findIndex((t) => t.id === settings.clickTone)));
  const [importError, setImportError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const fileInputRef = useRef(null);
  const touchStartRef = useRef(null);
  const [dragX, setDragX] = useState(0);
  const [leaving, setLeaving] = useState(false);

  const cycleTone = (dir) => {
    const next = (toneIndex + dir + CLICK_TONES.length) % CLICK_TONES.length;
    setToneIndex(next);
    onChange({ ...settings, clickTone: CLICK_TONES[next].id });
  };

  const handleFileSelected = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    setImportError("");
    setImportBusy(true);
    try {
      await onImport(file);
    } catch (err) {
      setImportError(err.message || "Import failed.");
    } finally {
      setImportBusy(false);
    }
  };

  const handleTouchStart = (e) => {
    if (leaving) return;
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const handleTouchMove = (e) => {
    if (!touchStartRef.current || leaving) return;
    const dx = e.touches[0].clientX - touchStartRef.current.x;
    const dy = e.touches[0].clientY - touchStartRef.current.y;
    if (dx > 0 && dx > Math.abs(dy)) setDragX(dx);
  };
  const handleTouchEnd = () => {
    if (!touchStartRef.current) return;
    touchStartRef.current = null;
    if (dragX > 30) {
      setLeaving(true);
      setDragX(typeof window !== "undefined" ? window.innerWidth : 375);
      setTimeout(onClose, 200);
    } else {
      setDragX(0);
    }
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 100,
        display: "flex", flexDirection: "column",
        transform: `translateX(${dragX}px)`,
        transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none",
      }}
      onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} onTouchCancel={handleTouchEnd}
    >
      <div style={{ flex: "0 0 auto", padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onClose} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}>
          <ChevronLeft size={22} />
        </button>
        <div style={{ fontSize: 17, fontWeight: 600 }}>Settings</div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "24px 20px 24px", display: "flex", flexDirection: "column", gap: 32 }}>
        {/* Click tone */}
        <div>
          <div style={{ fontSize: 11, letterSpacing: 1.5, color: C.textFaint, marginBottom: 10 }}>CLICK TONE</div>
          <div style={{
            height: 48, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between",
            background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "0 6px",
          }}>
            <button onClick={() => cycleTone(-1)} style={{ background: "none", border: "none", padding: 10, display: "flex" }}>
              <ChevronLeft size={20} color={C.text} />
            </button>
            <div style={{ fontSize: 16, fontWeight: 600, textAlign: "center", flex: 1 }}>{CLICK_TONES[toneIndex].name}</div>
            <button onClick={() => cycleTone(1)} style={{ background: "none", border: "none", padding: 10, display: "flex" }}>
              <ChevronRight size={20} color={C.text} />
            </button>
          </div>
        </div>

        {/* Pan */}
        <div>
          <div style={{ fontSize: 11, letterSpacing: 1.5, color: C.textFaint, marginBottom: 10 }}>AUDIO OUTPUT</div>
          <div style={{ display: "flex", gap: 8 }}>
            {PAN_OPTIONS.map((p) => {
              const active = settings.pan === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => onChange({ ...settings, pan: p.id })}
                  style={{
                    flex: 1, height: 48, boxSizing: "border-box", borderRadius: 10, fontFamily: FONT, fontSize: 15, fontWeight: 700,
                    border: `1px solid ${active ? C.accent : C.border}`,
                    background: active ? "rgba(255,176,32,0.12)" : C.surface2,
                    color: active ? C.accent : C.text,
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Library import/export */}
        <div>
          <div style={{ fontSize: 11, letterSpacing: 1.5, color: C.textFaint, marginBottom: 10 }}>SONG LIBRARY</div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => fileInputRef.current?.click()} disabled={importBusy} style={{
              flex: 1, height: 48, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontFamily: FONT, fontSize: 14, fontWeight: 600,
            }}>
              <Download size={17} color={C.accent} />
              {importBusy ? "Importing…" : "Import"}
            </button>
            <button onClick={onExport} style={{
              flex: 1, height: 48, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontFamily: FONT, fontSize: 14, fontWeight: 600,
            }}>
              <Upload size={17} color={C.accent} />
              Export
            </button>
            <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={handleFileSelected} style={{ display: "none" }} />
          </div>
          {importError && <div style={{ fontSize: 12.5, color: C.danger, marginTop: 8 }}>{importError}</div>}
        </div>
      </div>

      <div style={{ flex: "0 0 auto", textAlign: "center", fontSize: 11, color: C.textFaint, padding: "12px 20px calc(12px + env(safe-area-inset-bottom, 0px))" }}>
        Created by Benjamin Hanigraf
      </div>
    </div>
  );
}

// ---- Keyboard (placeholder for now — full version is the next step) -----
// Builds a custom waveform from a piano-like harmonic series (a handful of
// overtones falling off roughly like a real struck string, rather than a
// plain triangle/sine which reads as "digital"/synthetic).
function buildPianoWave(ctx) {
  const numHarmonics = 9;
  const real = new Float32Array(numHarmonics + 1);
  const imag = new Float32Array(numHarmonics + 1);
  const amps = [0, 1, 0.55, 0.32, 0.22, 0.15, 0.1, 0.07, 0.05, 0.03];
  for (let n = 1; n <= numHarmonics; n++) imag[n] = amps[n];
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

// ---- piano keyboard (landscape, single octave, multi-touch, glissando) ---
const WHITE_KEY_BG = "#F2F1EC";
const WHITE_KEY_BG_PRESSED = C.accent;
const BLACK_KEY_BG = "#0A0A0A";
const BLACK_KEY_BG_PRESSED = C.accent;

// Semitone offsets from the octave's C, in ascending pitch order.
const WHITE_KEYS = [
  { name: "C", semitone: 0 }, { name: "D", semitone: 2 }, { name: "E", semitone: 4 },
  { name: "F", semitone: 5 }, { name: "G", semitone: 7 }, { name: "A", semitone: 9 }, { name: "B", semitone: 11 },
];
// afterWhiteIndex = the black key sits on the boundary just after this white key's index (0-based).
const BLACK_KEYS = [
  { name: "C#", semitone: 1, afterWhiteIndex: 0 },
  { name: "D#", semitone: 3, afterWhiteIndex: 1 },
  { name: "F#", semitone: 6, afterWhiteIndex: 3 },
  { name: "G#", semitone: 8, afterWhiteIndex: 4 },
  { name: "A#", semitone: 10, afterWhiteIndex: 5 },
];

function KeyboardScreen({ onClose }) {
  const [octaveStart, setOctaveStartState] = useState(4); // C4 default
  const octaveStartRef = useRef(4);
  const audioCtxRef = useRef(null);
  const pianoWaveRef = useRef(null); // custom PeriodicWave, rebuilt whenever the context is (re)created
  const activeRef = useRef(new Map()); // pointerId -> { semitone, voice, keyEl }
  const containerRef = useRef(null);

  useEffect(() => { octaveStartRef.current = octaveStart; }, [octaveStart]);

  const setOctaveStart = (n) => setOctaveStartState(Math.min(5, Math.max(3, n)));

  // Recovers from an AudioContext that iOS has silently killed (state
  // "closed") — this is the fix for "sound randomly stops until I leave and
  // come back": leaving/re-entering was really just recreating the context;
  // now we detect and recreate it in place instead.
  const ensureCtx = () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      pianoWaveRef.current = buildPianoWave(audioCtxRef.current);
    }
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume().catch(() => { });
    }
    return audioCtxRef.current;
  };

  // C4 = MIDI 60, A4 = 440Hz — standard scientific-pitch / concert-A tuning.
  const freqFor = (semitone) => {
    const midi = (octaveStartRef.current + 1) * 12 + semitone;
    return 440 * Math.pow(2, (midi - 69) / 12);
  };

  // A synthesized piano-ish tone: a custom waveform built from a piano-like
  // harmonic series (rather than a plain triangle/sine, which reads as
  // "digital"), a lowpass filter that starts bright and mellows over time
  // (real piano tone loses its high harmonics first), and an amplitude
  // envelope that keeps decaying even while the key is held — real strings
  // lose energy continuously, they don't hold at a flat volume like an organ.
  const startVoice = (semitone) => {
    const ctx = ensureCtx();
    const now = ctx.currentTime;
    const freq = freqFor(semitone);

    const gain = ctx.createGain();
    const peak = 0.68;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.008); // fast hammer-strike attack
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.4), now + 0.4); // initial falloff
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 7); // long tail while held

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.6;
    filter.frequency.setValueAtTime(Math.min(9000, freq * 9), now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(500, freq * 2), now + 2.2);

    const osc = ctx.createOscillator();
    osc.setPeriodicWave(pianoWaveRef.current);
    osc.frequency.value = freq;

    osc.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
    osc.start(now);
    return { osc, gain };
  };
  const stopVoice = (voice) => {
    if (!voice || !audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const now = ctx.currentTime;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
      voice.osc.stop(now + 0.16);
    } catch { }
  };

  // Resolves screen coordinates to whichever key is actually rendered there —
  // this naturally accounts for the 90deg CSS rotation without any manual
  // matrix math, and correctly lets black keys take priority over the white
  // key beneath them.
  const keyAt = (x, y) => {
    const hitEl = document.elementFromPoint(x, y);
    if (!hitEl) return null;
    const keyEl = hitEl.closest && hitEl.closest("[data-semitone]");
    if (!keyEl || !containerRef.current || !containerRef.current.contains(keyEl)) return null;
    return { semitone: parseInt(keyEl.dataset.semitone, 10), el: keyEl };
  };
  const paintKey = (keyEl, pressed) => {
    if (!keyEl) return;
    const isBlack = keyEl.dataset.black === "1";
    keyEl.style.background = pressed
      ? (isBlack ? BLACK_KEY_BG_PRESSED : WHITE_KEY_BG_PRESSED)
      : (isBlack ? BLACK_KEY_BG : WHITE_KEY_BG);
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    const hit = keyAt(e.clientX, e.clientY);
    if (!hit) return;
    const voice = startVoice(hit.semitone);
    activeRef.current.set(e.pointerId, { semitone: hit.semitone, voice, keyEl: hit.el });
    paintKey(hit.el, true);
  };

  // Move/up are bound to window (not just the keyboard container) so a
  // finger that glissandos off the playable area — or is released anywhere —
  // still gets tracked and its note correctly stopped.
  useEffect(() => {
    const handleMove = (e) => {
      const entry = activeRef.current.get(e.pointerId);
      if (!entry) return;
      e.preventDefault();
      const hit = keyAt(e.clientX, e.clientY);
      const newSemitone = hit ? hit.semitone : null;
      if (newSemitone === entry.semitone) return;
      stopVoice(entry.voice);
      paintKey(entry.keyEl, false);
      if (hit) {
        const voice = startVoice(hit.semitone);
        activeRef.current.set(e.pointerId, { semitone: hit.semitone, voice, keyEl: hit.el });
        paintKey(hit.el, true);
      } else {
        activeRef.current.delete(e.pointerId);
      }
    };
    const handleUp = (e) => {
      const entry = activeRef.current.get(e.pointerId);
      if (!entry) return;
      stopVoice(entry.voice);
      paintKey(entry.keyEl, false);
      activeRef.current.delete(e.pointerId);
    };
    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    const handleVisibility = () => { if (document.visibilityState === "visible") ensureCtx(); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      document.removeEventListener("visibilitychange", handleVisibility);
      activeRef.current.forEach((v) => stopVoice(v.voice));
      activeRef.current.clear();
    };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, zIndex: 100, overflow: "hidden" }}>
      <div style={{
        position: "absolute", top: "50%", left: "50%", width: "100vh", height: "100vw",
        transform: "translate(-50%, -50%) rotate(90deg)",
        display: "flex", flexDirection: "column", fontFamily: FONT, color: C.text,
      }}>
        {/* header (appears along the right edge once rotated) */}
        <div style={{
          height: 60, flexShrink: 0, display: "flex", alignItems: "center",
          padding: "0 14px", borderBottom: `1px solid ${C.border}`, gap: 10, boxSizing: "border-box",
        }}>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}>
            <ChevronLeft size={22} />
          </button>
          <div style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>Keyboard</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={() => setOctaveStart(octaveStart - 1)}
              disabled={octaveStart <= 3}
              style={{
                width: 32, height: 32, borderRadius: "50%", border: `1px solid ${C.borderStrong}`,
                background: C.surface2, color: C.text, display: "flex", alignItems: "center", justifyContent: "center",
                opacity: octaveStart <= 3 ? 0.35 : 1,
              }}
            >
              <ChevronLeft size={15} />
            </button>
            <div style={{ fontSize: 13.5, fontWeight: 700, minWidth: 30, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
              C{octaveStart}
            </div>
            <button
              onClick={() => setOctaveStart(octaveStart + 1)}
              disabled={octaveStart >= 5}
              style={{
                width: 32, height: 32, borderRadius: "50%", border: `1px solid ${C.borderStrong}`,
                background: C.surface2, color: C.text, display: "flex", alignItems: "center", justifyContent: "center",
                opacity: octaveStart >= 5 ? 0.35 : 1,
              }}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>

        {/* keys */}
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          style={{ flex: 1, position: "relative", touchAction: "none" }}
        >
          <div style={{ position: "absolute", inset: 0, display: "flex" }}>
            {WHITE_KEYS.map((k) => (
              <div
                key={k.semitone}
                data-semitone={k.semitone}
                data-black="0"
                style={{
                  flex: 1, background: WHITE_KEY_BG, borderRight: `1px solid rgba(0,0,0,0.25)`,
                  display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 10,
                  boxSizing: "border-box",
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 600, color: "rgba(0,0,0,0.35)" }}>{k.name}{octaveStart}</span>
              </div>
            ))}
          </div>
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {BLACK_KEYS.map((k) => {
              const boundaryPct = ((k.afterWhiteIndex + 1) / 7) * 100;
              const widthPct = (0.62 / 7) * 100;
              const leftPct = boundaryPct - widthPct / 2;
              return (
                <div
                  key={k.semitone}
                  data-semitone={k.semitone}
                  data-black="1"
                  style={{
                    position: "absolute", top: 0, height: "58%",
                    left: `${leftPct}%`, width: `${widthPct}%`,
                    background: BLACK_KEY_BG, borderRadius: "0 0 4px 4px", pointerEvents: "auto",
                    boxShadow: "0 3px 6px rgba(0,0,0,0.5)",
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}


// Generates a short silent WAV as a data: URI, built purely in-browser (no
// network, no bundled asset needed). Looping this through a real <audio>
// element is the standard trick for getting iOS Safari to route audio
// through the "media playback" session instead of "ringer" — which is what
// lets Web Audio output keep playing even with the hardware silent switch on.
function createSilentWavDataUri(durationSeconds) {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  // sample bytes are already zero-initialized -> silence
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return "data:audio/wav;base64," + btoa(binary);
}

export default function App() {
  const [songs, persistSongs] = usePersistedList("songs", SEED_SONGS);
  const [setlists, persistSetlists] = usePersistedList("setlists", []);
  const [settings, persistSettings] = usePersistedObject("settings", DEFAULT_SETTINGS);

  // Prevent the screen from auto-locking while the app is open.
  useEffect(() => {
    if (!navigator.wakeLock) return;
    let sentinel = null;
    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      navigator.wakeLock.request("screen").then((s) => { sentinel = s; }).catch(() => { });
    };
    acquire();
    const handleVisibility = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      if (sentinel) sentinel.release().catch(() => { });
    };
  }, []);

  // iOS WebKit sometimes fails to reset the visual viewport's scroll offset
  // after the app is backgrounded and re-foregrounded (or after the on-screen
  // keyboard closes), leaving position:fixed content visibly shifted until a
  // manual scroll happens. Forcing a scroll-to-origin on resume works around it.
  useEffect(() => {
    const resetViewport = () => {
      window.scrollTo(0, 0);
      if (window.visualViewport) {
        window.scrollTo(0, 0);
      }
      document.documentElement.scrollLeft = 0;
      document.body.scrollLeft = 0;
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        // Two passes: immediately, and again after layout has settled.
        resetViewport();
        setTimeout(resetViewport, 50);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pageshow", resetViewport);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pageshow", resetViewport);
    };
  }, []);

  // Disable native iOS gestures (3-finger menu, double-tap zoom/magnifier, context selection)
  // and lock screen orientation to portrait
  useEffect(() => {
    const preventThreeFinger = (e) => {
      if (e.touches && e.touches.length >= 3) {
        e.preventDefault();
      }
    };
    const preventZoom = (e) => {
      if (e.scale !== undefined && e.scale !== 1) {
        e.preventDefault();
      }
    };
    const preventContextMenu = (e) => {
      const isInput = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";
      if (!isInput) {
        e.preventDefault();
      }
    };
    const clearSelection = () => {
      // Skip while a text/number field is focused — this listener exists to
      // stop the iOS long-press "select all" text-selection bubble from
      // appearing elsewhere in the UI, but calling removeAllRanges() while
      // typing fights Safari's own caret/selection handling inside inputs,
      // which is what made typing/deleting only register one character at
      // a time before the field needed to be re-tapped.
      const active = document.activeElement;
      const isEditable = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (isEditable) return;
      try {
        window.getSelection().removeAllRanges();
      } catch { }
    };
    const lockOrientation = () => {
      const lock = screen.orientation?.lock || screen.orientation?.lockOrientation ||
        screen.mozOrientation?.lock || screen.msOrientation?.lock;
      if (typeof lock === "function") {
        lock.call(screen.orientation, "portrait").catch(() => { });
      }
    };

    document.addEventListener("touchstart", preventThreeFinger, { passive: false });
    document.addEventListener("gesturestart", preventZoom, { passive: false });
    document.addEventListener("contextmenu", preventContextMenu, { passive: false });
    document.addEventListener("selectionchange", clearSelection);

    lockOrientation();
    window.addEventListener("orientationchange", lockOrientation);

    return () => {
      document.removeEventListener("touchstart", preventThreeFinger);
      document.removeEventListener("gesturestart", preventZoom);
      document.removeEventListener("contextmenu", preventContextMenu);
      document.removeEventListener("selectionchange", clearSelection);
      window.removeEventListener("orientationchange", lockOrientation);
    };
  }, []);

  const [tab, setTab] = useState("metronome");
  const [editingSong, setEditingSong] = useState(undefined); // undefined = closed, null = new, obj = edit
  const [stageIndex, setStageIndex] = useState(null); // null = not in stage mode
  const [stageAutoOpenPicker, setStageAutoOpenPicker] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [importToast, setImportToast] = useState(false);
  const [creatingSetlist, setCreatingSetlist] = useState(false);
  const [duplicateImportCount, setDuplicateImportCount] = useState(0);
  const showImportToast = () => { setImportToast(true); setTimeout(() => setImportToast(false), 2000); };

  const engine = useMetronomeEngine(settings);

  // Keeps a silent audio element looping in the background so iOS routes
  // this app's audio through the "media" session (which ignores the
  // hardware silent switch) instead of the "ringer" session. Needs a real
  // user gesture to start, so we hook the very first tap/touch anywhere.
  const silentAudioRef = useRef(null);
  useEffect(() => {
    const audio = document.createElement("audio");
    audio.src = createSilentWavDataUri(1);
    audio.loop = true;
    audio.setAttribute("playsinline", "true");
    audio.volume = 1;
    audio.style.display = "none";
    document.body.appendChild(audio);
    silentAudioRef.current = audio;

    const unlock = () => {
      if (audio.paused) audio.play().catch(() => { });
    };
    window.addEventListener("pointerdown", unlock, { once: true, passive: true });
    const handleVisibility = () => { if (document.visibilityState === "visible" && audio.paused) unlock(); };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("pointerdown", unlock);
      document.removeEventListener("visibilitychange", handleVisibility);
      audio.pause();
      audio.remove();
    };
  }, []);

  if (songs === null || setlists === null || settings === null) {
    return <div style={{ minHeight: "100vh", background: C.bg }} />;
  }

  const handleSaveSong = (data) => {
    if (editingSong) {
      persistSongs(songs.map((s) => (s.id === editingSong.id ? { ...s, ...data } : s)));
    } else {
      persistSongs([...songs, { id: `s-${Date.now()}`, ...data }]);
    }
    setEditingSong(undefined);
  };
  const handleDeleteSong = (id) => {
    persistSongs(songs.filter((s) => s.id !== id));
    persistSetlists(setlists.map((sl) => {
      const tempos = { ...(sl.tempos || {}) }; delete tempos[id];
      const accentOverrides = { ...(sl.accentOverrides || {}) }; delete accentOverrides[id];
      return { ...sl, songIds: sl.songIds.filter((sid) => sid !== id), tempos, accentOverrides };
    }));
    setEditingSong(undefined);
  };
  const handleLoadSong = (song) => { engine.loadSong(song); setTab("metronome"); };
  // Editing accents from the Metronome tab changes the song's default pattern everywhere.
  const handleUpdateSongAccents = (songId, accents) => {
    persistSongs(songs.map((s) => (s.id === songId ? { ...s, accents } : s)));
  };
  const handleUpdateSongSubdivision = (songId, subdivision) => {
    persistSongs(songs.map((s) => (s.id === songId ? { ...s, subdivision } : s)));
  };

  const handleCreateSetlist = (name) => {
    const next = [...setlists, { id: `sl-${Date.now()}`, name, songIds: [], tempos: {}, accentOverrides: {} }];
    persistSetlists(next);
    setStageAutoOpenPicker(true);
    setStageIndex(next.length - 1);
  };
  const handleDeleteSetlist = (id) => persistSetlists(setlists.filter((sl) => sl.id !== id));
  const handleUpdateSetlist = (updated) => persistSetlists(setlists.map((sl) => (sl.id === updated.id ? updated : sl)));

  const handleExportLibrary = async () => {
    // Export songs only — setlists are device-specific and excluded intentionally.
    const payload = { app: "SetlistMetronome", version: 1, exportedAt: new Date().toISOString(), songs };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const yyyy = now.getFullYear();
    const fileName = `Click_Songs_${dd}-${mm}-${yyyy}.json`;
    // Use the Web Share API (available on iOS Safari PWA) to open the native
    // share sheet directly, bypassing the browser's download-preview page.
    if (navigator.canShare && navigator.canShare({ files: [new File([blob], fileName, { type: "application/json" })] })) {
      try {
        await navigator.share({ files: [new File([blob], fileName, { type: "application/json" })], title: "Click Songs" });
      } catch (err) {
        // AbortError (or a plain cancel) means the user dismissed the share
        // sheet on purpose — treat that as "cancel the export", not as a
        // failure that should fall back to a raw file download.
      }
      return;
    }
    // Fallback: trigger a normal file download.
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportLibrary = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.songs)) throw new Error("This file doesn't look like a library export.");

        let duplicatesCount = 0;
        const newSongsToImport = [];

        data.songs.forEach((importedSong) => {
          const importedTitleClean = (importedSong.title || "").trim().toLowerCase();
          const importedArtistClean = (importedSong.artist || "").trim().toLowerCase();

          if (!importedTitleClean) return;

          const exists = songs.some((existingSong) => {
            return (existingSong.title || "").trim().toLowerCase() === importedTitleClean &&
              (existingSong.artist || "").trim().toLowerCase() === importedArtistClean;
          });

          if (exists) {
            duplicatesCount++;
          } else {
            newSongsToImport.push({
              ...importedSong,
              id: `s-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            });
          }
        });

        if (duplicatesCount > 0) {
          setDuplicateImportCount(duplicatesCount);
        }

        if (newSongsToImport.length > 0) {
          persistSongs([...songs, ...newSongsToImport]);
          showImportToast();
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsText(file);
  });

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: FONT }}>
      <style>{`
        .bpm-number-input::-webkit-outer-spin-button,
        .bpm-number-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        .bpm-number-input { -moz-appearance: textfield; outline: none; -webkit-tap-highlight-color: transparent; border-radius: 10px; }
        .bpm-number-input:focus { outline: none; box-shadow: 0 0 0 1.5px rgba(122, 84, 20, 0.55); }
        button { -webkit-tap-highlight-color: transparent; transition: transform 90ms ease, opacity 90ms ease; }
        button:active { transform: scale(0.94); opacity: 0.8; }
        * { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
        input, textarea { -webkit-user-select: text; user-select: text; }
        input:focus:not(.bpm-number-input), textarea:focus {
          outline: none;
          border-color: ${C.accent};
          box-shadow: 0 0 0 2px ${C.accentDim};
        }
        .no-scrollbar::-webkit-scrollbar { display: none; }
      `}</style>
      <div style={{ paddingBottom: 84 }}>
        {tab === "metronome" && (
          <MetronomeScreen
            engine={engine}
            onUpdateSongAccents={handleUpdateSongAccents}
            onUpdateSongSubdivision={handleUpdateSongSubdivision}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenKeyboard={() => setKeyboardOpen(true)}
            onLongPressTitle={() => setEditingSong(null)}
          />
        )}
        {tab === "songs" && (
          <SongsScreen
            songs={songs}
            onLoadSong={handleLoadSong}
            onAdd={() => setEditingSong(null)}
            onEdit={(s) => setEditingSong(s)}
          />
        )}
        {tab === "setlists" && (
          <SetlistsScreen
            setlists={setlists}
            onOpenStage={(id) => { setStageAutoOpenPicker(false); setStageIndex(setlists.findIndex((sl) => sl.id === id)); }}
            onCreate={handleCreateSetlist}
            onDelete={handleDeleteSetlist}
            creating={creatingSetlist}
            setCreating={setCreatingSetlist}
          />
        )}
      </div>

      {!creatingSetlist && <BottomNav active={tab} onChange={setTab} />}

      {editingSong !== undefined && (
        <SongForm
          initial={editingSong}
          onSave={handleSaveSong}
          onCancel={() => setEditingSong(undefined)}
          onDelete={handleDeleteSong}
          songs={songs}
          metronomeValues={{
            bpm: engine.bpm,
            timeSig: engine.timeSig,
            subdivision: engine.subdivision,
            accents: engine.accents
          }}
        />
      )}

      {stageIndex !== null && (
        <StageScreen
          setlists={setlists}
          songs={songs}
          index={stageIndex}
          onBack={() => setStageIndex(null)}
          engine={engine}
          onUpdateSetlist={handleUpdateSetlist}
          initialPickerOpen={stageAutoOpenPicker}
        />
      )}

      {settingsOpen && (
        <SettingsScreen
          settings={settings}
          onChange={persistSettings}
          onExport={handleExportLibrary}
          onImport={handleImportLibrary}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {keyboardOpen && <KeyboardScreen onClose={() => setKeyboardOpen(false)} />}

      {/* Duplicate-songs notice, styled like the rest of the app's menus (no native alert()) */}
      {duplicateImportCount > 0 && (
        <div style={{ position: "fixed", inset: 0, zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
          <div onClick={() => setDuplicateImportCount(0)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)" }} />
          <div style={{
            position: "relative", width: "100%", maxWidth: 320, background: C.surface2, borderRadius: 18,
            border: `1px solid ${C.borderStrong}`, padding: 22, fontFamily: FONT, color: C.text,
            boxShadow: "0 12px 32px rgba(0,0,0,0.6)", textAlign: "center",
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Duplicate Songs Skipped</div>
            <div style={{ fontSize: 13.5, color: C.textMuted, lineHeight: 1.5, marginBottom: 20 }}>
              {duplicateImportCount} duplicate song{duplicateImportCount === 1 ? "" : "s"} will not be imported.
            </div>
            <button onClick={() => setDuplicateImportCount(0)} style={{
              width: "100%", fontFamily: FONT, fontWeight: 700, fontSize: 15,
              padding: "13px 0", borderRadius: 12, border: "none", background: C.accent, color: "#000",
            }}>
              OK
            </button>
          </div>
        </div>
      )}

      {/* "Songs Added" import toast */}
      {importToast && (
        <div style={{
          position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 500, pointerEvents: "none",
        }}>
          <div style={{
            background: "#000", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12,
            padding: "10px 20px",
          }}>
            <span style={{ color: "#fff", fontSize: 13, fontFamily: FONT, fontWeight: 500 }}>Songs Added</span>
          </div>
        </div>
      )}
    </div>
  );
}