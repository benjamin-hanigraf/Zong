import { useState, useEffect, useRef, useCallback, Component } from "react";
import {
  Search, Plus, Pencil, Trash2, ChevronLeft, ChevronRight, ChevronDown, Play, Square,
  ListMusic, Layers, Minus, MoreVertical, AlignLeft, AlignCenter, AlignRight, Check, X,
  Settings as SettingsIcon, Upload, Download, ClipboardPaste, Copy,
} from "lucide-react";
import { syncLibrary } from "./bandSync";

/* =========================================================================
   Persistence — IndexedDB for songs/setlists, localStorage for small prefs.
   Inlined here (rather than a separate hooks file) so this stays a single
   self-contained component file.
   ========================================================================= */
const DB_NAME = "zong-db";
const DB_VERSION = 1;
const STORE_NAME = "kv";
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no indexeddb")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function useIndexedDbState(key, seed) {
  const [value, setValue] = useState(seed);
  useEffect(() => {
    let cancelled = false;
    idbGet(key).then((stored) => {
      if (cancelled) return;
      if (stored !== undefined) setValue(stored);
      else idbSet(key, seed).catch(() => { });
    }).catch(() => { });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const persist = useCallback((next) => {
    setValue((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      idbSet(key, resolved).catch(() => { });
      return resolved;
    });
  }, [key]);
  return [value, persist];
}
function useLocalStorageState(key, seed) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? JSON.parse(stored) : seed;
    } catch { return seed; }
  });
  const persist = useCallback((next) => {
    setValue((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      try { localStorage.setItem(key, JSON.stringify(resolved)); } catch { }
      return resolved;
    });
  }, [key]);
  return [value, persist];
}

/* =========================================================================
   MODES — Altar merges Click (metronome/drums) and Chords (chart/vocals)
   into three practice modes: Vocals, Drums, Chords. Each has its own accent
   colour; everything else (surfaces, text, layout) stays shared.
   ========================================================================= */
const MODES = ["vocals", "drums", "chords"]; // display order for the Settings tab-select
const MODE_META = {
  vocals: { label: "Vocals", accent: "#30D158", accentDim: "rgba(48,209,88,0.35)", accentSoft: "rgba(48,209,88,0.12)" },
  drums: { label: "Drums", accent: "#FFB020", accentDim: "rgba(255,176,32,0.35)", accentSoft: "rgba(255,176,32,0.12)" },
  chords: { label: "Chords", accent: "#0A84FF", accentDim: "rgba(10,132,255,0.35)", accentSoft: "rgba(10,132,255,0.12)" },
};
function colorsFor(mode) {
  const m = MODE_META[mode] || MODE_META.vocals;
  return {
    bg: "#000000",
    surface: "#121212",
    surface2: "#1C1C1E",
    surface3: "#2C2C2E",
    border: "rgba(255,255,255,0.08)",
    borderStrong: "rgba(255,255,255,0.18)",
    text: "#FFFFFF",
    textMuted: "#98989D",
    textFaint: "#4D4D50",
    accent: m.accent,
    accentDim: m.accentDim,
    accentSoft: m.accentSoft,
    danger: "#FF453A",
  };
}

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

const TIME_SIGS = [
  { beats: 2, unit: 4 }, { beats: 3, unit: 4 }, { beats: 4, unit: 4 },
  { beats: 6, unit: 4 }, { beats: 6, unit: 8 },
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
const DEFAULT_CLICK_SETTINGS = { clickTone: "classic", pan: "center" };

const DEFAULT_PIANO_SETTINGS = { pianoTone: "grand" };
const LANGUAGES = [
  { id: "English", label: "English" },
  { id: "Tamil", label: "தமிழ்" },
];

/* =========================================================================
   Chord-name transposition (letters, not the old Nashville-number system —
   Altar's chords are typed directly as [G], [Em], [C#m7] etc. in the lyric
   text, so transposing just shifts the spelled root by semitones).
   ========================================================================= */
const CHROMATIC_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const CHROMATIC_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const FLAT_KEYS = new Set(["F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"]);
const KEY_TO_SEMITONE = {
  C: 0, "B#": 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4,
  F: 5, "E#": 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10,
  Bb: 10, B: 11, Cb: 11,
};
const ALL_KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function spellNote(semitone, useFlats) {
  const s = ((semitone % 12) + 12) % 12;
  return useFlats ? CHROMATIC_FLAT[s] : CHROMATIC_SHARP[s];
}
function transposeKey(key, semitoneDelta) {
  const semitone = ((KEY_TO_SEMITONE[key] ?? 0) + semitoneDelta + 1200) % 12;
  return ALL_KEYS.find((k) => KEY_TO_SEMITONE[k] === semitone) || "C";
}
// Transposes one chord symbol, e.g. "C#m7/G#" -> shift by +2 -> "D#m7/A#".
// Only the root letters move; everything else (quality suffix) is kept as-is.
const CHORD_ROOT_RE = /^([A-G])([#b]?)/;
function transposeChordSymbol(symbol, semitoneDelta, useFlats) {
  if (!symbol) return symbol;
  const transposeOne = (part) => {
    const m = part.match(CHORD_ROOT_RE);
    if (!m) return part;
    const root = m[1] + m[2];
    const rest = part.slice(m[0].length);
    const semitone = (KEY_TO_SEMITONE[root] ?? 0) + semitoneDelta;
    return spellNote(semitone, useFlats) + rest;
  };
  return symbol.split("/").map(transposeOne).join("/");
}
const flatify = (str) => String(str ?? "").replace(/b/g, "\u266d").replace(/#/g, "\u266f");

/* =========================================================================
   Small helpers
   ========================================================================= */
const uid = () => "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
function toTitleCase(str) {
  return String(str || "").toLowerCase().replace(/(^|\s|-)\S/g, (c) => c.toUpperCase());
}
function parseTimeSig(str) {
  const m = String(str || "").match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return { beats: 4, unit: 4 };
  return { beats: parseInt(m[1], 10), unit: parseInt(m[2], 10) };
}
const formatTimeSig = (ts) => `${ts.beats}/${ts.unit}`;
const keyLabel = (song) => flatify(`${song.key}${song.keyQuality === "Minor" ? "m" : ""}`);
function decomposeKey(keyStr) {
  const natural = (keyStr || "C")[0];
  const suffix = (keyStr || "C").slice(1);
  const accidental = suffix === "b" ? "flat" : suffix === "#" ? "sharp" : "natural";
  return { natural, accidental };
}
const composeKey = (natural, accidental) => natural + (accidental === "flat" ? "b" : accidental === "sharp" ? "#" : "");
const KEY_ENHARMONIC_FIX = { "E#": "F", "B#": "C", Cb: "B", Fb: "E" };
function parseKeyPaste(raw) {
  const m = String(raw || "").trim().match(/^([A-Ga-g])\s*([#b])?\s*(maj(?:or)?|min(?:or)?|m)?\.?$/i);
  if (!m) return null;
  let natural = m[1].toUpperCase();
  let accChar = m[2] || "";
  const combo = natural + accChar;
  if (KEY_ENHARMONIC_FIX[combo]) { natural = KEY_ENHARMONIC_FIX[combo]; accChar = ""; }
  const accidental = accChar === "#" ? "sharp" : accChar === "b" ? "flat" : "natural";
  const qualityRaw = (m[3] || "").toLowerCase();
  const quality = (qualityRaw === "m" || qualityRaw.startsWith("mi")) ? "Minor" : "Major";
  return { natural, accidental, quality };
}
function downloadJSON(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
async function shareOrDownloadJSON(filename, payload) {
  const json = JSON.stringify(payload, null, 2);
  try {
    const file = new File([json], filename, { type: "application/json" });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return "shared";
    }
  } catch (err) {
    if (err && err.name === "AbortError") return "cancelled";
  }
  downloadJSON(filename, payload);
  return "downloaded";
}
function dedupeTitle(candidateTitle, artist, existingSongs) {
  let n = 0;
  let title = candidateTitle;
  const collides = (t) => existingSongs.some(
    (s) => s.title.toLowerCase() === t.toLowerCase() && (s.artist || "").toLowerCase() === (artist || "").toLowerCase()
  );
  while (collides(title)) { n += 1; title = `${candidateTitle} (${n})`; }
  return title;
}

/* =========================================================================
   Chord/drum tag parsing — "[G]Gre[Em]at Are [C]You Lord[D]" style text.
   A tag applies to the character immediately following it; a tag with no
   following character (end of line) is a trailing tag.
   ========================================================================= */
function tokenizeTaggedLine(rawLine) {
  const line = String(rawLine || "").replace(/^ +/, "");
  const tokens = [];
  let i = 0;
  let pendingTag = null;
  while (i < line.length) {
    if (line[i] === "[") {
      const end = line.indexOf("]", i);
      if (end === -1) { tokens.push({ ch: line[i], tag: pendingTag }); pendingTag = null; i++; continue; }
      pendingTag = line.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    tokens.push({ ch: line[i], tag: pendingTag });
    pendingTag = null;
    i++;
  }
  if (pendingTag !== null) tokens.push({ ch: null, tag: pendingTag });
  return tokens;
}
function transposeTaggedText(text, semitoneDelta, useFlats) {
  return String(text || "").replace(/\[([^\]]*)\]/g, (_, sym) => `[${transposeChordSymbol(sym, semitoneDelta, useFlats)}]`);
}
const NASHVILLE = ["1", "1#", "2", "2#", "3", "4", "4#", "5", "5#", "6", "6#", "7"];
function toNashville(symbol, currentKey) {
  if (!symbol) return symbol;
  const CHORD_ROOT_RE = /^([A-G])([#b]?)/;
  const baseSemi = KEY_TO_SEMITONE[currentKey] || 0;
  const convertOne = (part) => {
    const m = part.match(CHORD_ROOT_RE);
    if (!m) return part;
    const root = m[1] + m[2];
    const rest = part.slice(m[0].length);
    const semitone = KEY_TO_SEMITONE[root];
    if (semitone === undefined) return part;
    const diff = (semitone - baseSemi + 12) % 12;
    return NASHVILLE[diff] + rest;
  };
  return symbol.split("/").map(convertOne).join("/");
}
function nashvillizeTaggedText(text, songKey) {
  return String(text || "").replace(/\[([^\]]*)\]/g, (_, sym) => `[${toNashville(sym, songKey)}]`);
}

/* =========================================================================
   Seed data
   ========================================================================= */
const SEED_SONGS = [
  {
    id: "seed-1", title: "Oceans", artist: "Hillsong United", tempo: 72, timeSignature: "4/4", key: "D", keyQuality: "Major",
    description: "Benny's key: D | Sherly's key: G\nStyle: Rock Shuffle",
    accents: ["normal", "normal", "normal", "normal"], subdivision: 1,
    sections: [
      { id: uid(), label: "Verse", lyrics: "You call me out upon the waters\nThe great unknown where feet may fail", chords: "[D]You call me [G]out upon the [A]waters\nThe [Bm]great unknown where [G]feet may [A]fail", drums: "[Half-time]You call me out upon the waters\nThe great unknown where feet may fail" },
      { id: uid(), label: "Chorus", lyrics: "And I will call upon Your name\nAnd keep my eyes above the waves", chords: "[D]And I will [A]call upon Your [Bm]name\nAnd [G]keep my eyes a[A]bove the [D]waves", drums: "And I will call upon Your name\nAnd keep my eyes a[Double Kick]bove the waves" },
    ],
  },
  {
    id: "seed-2", title: "Way Maker", artist: "Sinach", tempo: 68, timeSignature: "4/4", key: "E", keyQuality: "Major",
    description: "Benny's key: D | Sherly's key: G\nStyle: Rock Shuffle",
    accents: ["normal", "normal", "normal", "normal"], subdivision: 1,
    sections: [
      { id: uid(), label: "Chorus", lyrics: "Way maker, miracle worker, promise keeper", chords: "[E]Way maker, [A]miracle worker, [C#m]promise [B]keeper", drums: "[Shuffle]Way maker, miracle worker, [Double Kick]promise keeper" },
    ],
  },
  {
    id: "seed-3", title: "Our God", artist: "Chris Tomlin", tempo: 105, timeSignature: "4/4", key: "A", keyQuality: "Major",
    description: "Benny's key: D | Sherly's key: G\nStyle: Rock Shuffle",
    accents: ["normal", "normal", "normal", "normal"], subdivision: 1,
    sections: [{ id: uid(), label: "Verse", lyrics: "Into the darkness You shine", chords: "[A]Into the [E]darkness You [F#m]shine", drums: "Into the darkness You [Double Kick]shine" }],
  },
];
const SEED_SETLISTS = [{
  id: "sl-1", name: "Sunday AM",
  entries: [{ songId: "seed-1", keyOverride: null }, { songId: "seed-2", keyOverride: "F" }],
}];

/* =========================================================================
   Shared bits
   ========================================================================= */
function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, letterSpacing: 1.5, color: "#4D4D50", marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}
function SectionLabel({ children }) {
  return <div style={{ fontSize: 11, letterSpacing: 1.5, color: "#4D4D50", marginBottom: 10, marginTop: 4, fontWeight: 700 }}>{children}</div>;
}
function ClearableInput({ value, onChangeText, placeholder, leftIcon, style, type, inputMode, autoFocus }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      {leftIcon}
      <input
        autoFocus={autoFocus} type={type} inputMode={inputMode} value={value}
        onChange={(e) => onChangeText(e.target.value)}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        placeholder={placeholder} style={style}
      />
      {focused && value ? (
        <button
          onPointerDown={(e) => { e.preventDefault(); onChangeText(""); }}
          style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", padding: 4, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <X size={14} color="#98989D" />
        </button>
      ) : null}
    </div>
  );
}

function TimeSigPicker({ value, onChange, fullWidth, height = 44, style, C }) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const btnRef = useRef(null);
  const DROPDOWN_HEIGHT = 220;
  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUpward(spaceBelow < DROPDOWN_HEIGHT && rect.top > spaceBelow);
    }
    setOpen((o) => !o);
  };
  return (
    <div style={{ position: "relative", width: fullWidth ? "100%" : undefined, boxSizing: "border-box", ...style }}>
      <button
        ref={btnRef} type="button" onClick={handleToggle}
        style={{
          fontFamily: FONT, fontSize: 16, fontWeight: 600, borderRadius: 10, boxSizing: "border-box",
          border: `1px solid ${C.border}`, background: C.surface2, color: value ? C.text : C.textFaint,
          width: fullWidth ? "100%" : undefined, textAlign: "center", height, padding: "0 10px",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        {value ? `${value.beats}/${value.unit}` : "—"}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 140 }} />
          <div style={{
            position: "absolute", ...(openUpward ? { bottom: "110%" } : { top: "110%" }),
            left: "50%", transform: "translateX(-50%)", zIndex: 150, minWidth: 84,
            background: C.surface3, border: `1px solid ${C.borderStrong}`, borderRadius: 12,
            overflow: "hidden", boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
          }}>
            {TIME_SIGS.map((ts) => {
              const active = value && ts.beats === value.beats && ts.unit === value.unit;
              return (
                <div key={`${ts.beats}/${ts.unit}`} onClick={() => { onChange(ts); setOpen(false); }} style={{
                  padding: "10px 16px", fontFamily: FONT, fontSize: 15, fontWeight: 500, textAlign: "center",
                  color: active ? C.accent : C.text, background: active ? C.accentSoft : "transparent",
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

const NATURALS = ["C", "D", "E", "F", "G", "A", "B"];
function NaturalDropdown({ value, onChange, C }) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const btnRef = useRef(null);
  const DROPDOWN_HEIGHT = 296;
  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUpward(spaceBelow < DROPDOWN_HEIGHT && rect.top > spaceBelow);
    }
    setOpen((o) => !o);
  };
  return (
    <div style={{ position: "relative" }}>
      <button ref={btnRef} type="button" onClick={handleToggle} style={{
        width: "100%", boxSizing: "border-box", height: 44, padding: "0 10px", borderRadius: 10,
        border: `1px solid ${C.border}`, background: C.surface2, color: C.text,
        fontFamily: FONT, fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <span>{value}</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 140 }} />
          <div style={{
            position: "absolute", ...(openUpward ? { bottom: "110%" } : { top: "110%" }),
            left: 0, right: 0, zIndex: 150,
            background: C.surface3, border: `1px solid ${C.borderStrong}`, borderRadius: 12,
            boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
          }}>
            {NATURALS.map((n) => {
              const active = n === value;
              return (
                <div key={n} onClick={() => { onChange(n); setOpen(false); }} style={{
                  padding: "12px 14px", fontFamily: FONT, fontSize: 15, fontWeight: 700, textAlign: "center",
                  color: active ? C.accent : C.text, background: active ? C.accentSoft : "transparent",
                }}>
                  {n}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function AccidentalButton({ variant, natural, value, onChange, C }) {
  const disabled = variant === "flat" ? (natural === "C" || natural === "F") : (natural === "E" || natural === "B");
  const active = value === variant;
  const icon = variant === "flat" ? "\u266d" : "\u266f";
  return (
    <button
      type="button" disabled={disabled} onClick={() => onChange(active ? "natural" : variant)}
      style={{
        width: "100%", height: 44, borderRadius: 10, fontFamily: FONT, fontSize: 17, fontWeight: 700,
        border: `1px solid ${active ? C.accent : C.border}`,
        background: active ? C.accentSoft : C.surface2,
        color: disabled ? C.textFaint : active ? C.accent : C.textMuted,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {icon}
    </button>
  );
}

function ToggleSwitch({ checked, onChange, offLabel, onLabel, C }) {
  return (
    <div
      role="switch" aria-checked={checked} tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(!checked); } }}
      style={{
        width: "100%", height: 44, boxSizing: "border-box", borderRadius: 10, border: `1px solid ${C.border}`,
        background: C.surface2, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px",
        cursor: "pointer",
      }}
    >
      <span style={{ fontFamily: FONT, fontSize: 14, fontWeight: 700, color: checked ? C.textFaint : C.accent }}>{offLabel}</span>
      <span style={{ position: "relative", width: 46, height: 26, borderRadius: 13, flexShrink: 0, margin: "0 10px", background: C.surface3, border: `1px solid ${C.borderStrong}`, boxSizing: "border-box" }}>
        <span style={{ position: "absolute", top: 2, left: checked ? 22 : 2, width: 20, height: 20, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.4)", transition: "left 150ms ease" }} />
      </span>
      <span style={{ fontFamily: FONT, fontSize: 14, fontWeight: 700, color: checked ? C.accent : C.textFaint }}>{onLabel}</span>
    </div>
  );
}

function TabSelect({ options, value, onChange, C }) {
  return (
    <div style={{ display: "flex", gap: 6, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 4 }}>
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button key={opt.id} onClick={() => onChange(opt.id)} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", fontFamily: FONT, fontSize: 13.5, fontWeight: 700, background: active ? C.accentSoft : "transparent", color: active ? C.accent : C.textMuted }}>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* =========================================================================
   Merge a section's plain lyrics with the tag positions already stored in
   its chords/drums field, so the Add/Edit form can show the lyric text as
   a fixed (uneditable) backdrop while still letting chords/notes be typed
   in between characters (spec #11).
   ========================================================================= */
function extractTagsByIndex(taggedText) {
  return String(taggedText || "").split("\n").map((line) => tokenizeTaggedLine(line).map((t) => t.tag || null));
}
function mergeLyricsWithTags(lyricsText, taggedText) {
  const lyricLines = String(lyricsText || "").split("\n");
  const tagLines = extractTagsByIndex(taggedText);
  return lyricLines.map((line, li) => {
    const tags = tagLines[li] || [];
    let out = "";
    for (let i = 0; i < line.length; i++) {
      if (tags[i]) out += `[${tags[i]}]`;
      out += line[i];
    }
    if (tags[line.length]) out += `[${tags[line.length]}]`;
    return out;
  }).join("\n");
}

/* =========================================================================
   Unified section content — a single string per section holds lyrics plus
   BOTH tag types inline: [Chord] for chords, <Drum> for drum notes, each
   attached to the character immediately following it. This lets the
   Add/Edit form store one canonical string per section ("<Basic>[G]All to
   [C]Jesus...") while Chords/Drums/Vocals modes each derive their own
   [Tag]-only view from it (reusing the existing ChordText/ tag pipeline).
   ========================================================================= */
function tokenizeContentLine(rawLine) {
  const line = String(rawLine || "").replace(/^ +/, "");
  const tokens = [];
  let i = 0;
  let pendingChord = null, pendingDrum = null;
  while (i < line.length) {
    if (line[i] === "[") {
      const end = line.indexOf("]", i);
      if (end === -1) { tokens.push({ ch: line[i], chordTag: pendingChord, drumTag: pendingDrum }); pendingChord = null; pendingDrum = null; i++; continue; }
      pendingChord = line.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (line[i] === "<") {
      const end = line.indexOf(">", i);
      if (end === -1) { tokens.push({ ch: line[i], chordTag: pendingChord, drumTag: pendingDrum }); pendingChord = null; pendingDrum = null; i++; continue; }
      pendingDrum = line.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    tokens.push({ ch: line[i], chordTag: pendingChord, drumTag: pendingDrum });
    pendingChord = null; pendingDrum = null;
    i++;
  }
  if (pendingChord !== null || pendingDrum !== null) tokens.push({ ch: null, chordTag: pendingChord, drumTag: pendingDrum });
  return tokens;
}
function contentToLyricsPlain(content) {
  return String(content || "").split("\n").map((line) => tokenizeContentLine(line).filter((t) => t.ch !== null).map((t) => t.ch).join("")).join("\n");
}
function contentToChordsTagged(content) {
  return String(content || "").split("\n").map((line) => {
    let out = "";
    tokenizeContentLine(line).forEach((t) => {
      if (t.chordTag) out += `[${t.chordTag}]`;
      if (t.ch !== null) out += t.ch;
    });
    return out;
  }).join("\n");
}
function contentToDrumsTagged(content) {
  return String(content || "").split("\n").map((line) => {
    let out = "";
    tokenizeContentLine(line).forEach((t) => {
      if (t.drumTag) out += `[${t.drumTag}]`;
      if (t.ch !== null) out += t.ch;
    });
    return out;
  }).join("\n");
}
function mergeLegacyToContent(lyricsText, chordsText, drumsText) {
  const lyricLines = String(lyricsText || "").split("\n");
  const chordTagLines = extractTagsByIndex(chordsText);
  const drumTagLines = extractTagsByIndex(drumsText);
  return lyricLines.map((line, li) => {
    const chordTags = chordTagLines[li] || [];
    const drumTags = drumTagLines[li] || [];
    let out = "";
    for (let i = 0; i < line.length; i++) {
      if (drumTags[i]) out += `<${drumTags[i]}>`;
      if (chordTags[i]) out += `[${chordTags[i]}]`;
      out += line[i];
    }
    if (drumTags[line.length]) out += `<${drumTags[line.length]}>`;
    if (chordTags[line.length]) out += `[${chordTags[line.length]}]`;
    return out;
  }).join("\n");
}
function resyncContentWithLyrics(content, newLyricsText) {
  const oldLines = String(content || "").split("\n");
  const newLines = String(newLyricsText || "").split("\n");
  const maxLen = Math.max(oldLines.length, newLines.length);
  const outLines = [];
  for (let li = 0; li < maxLen; li++) {
    const chordTags = [], drumTags = [];
    let idx = 0;
    tokenizeContentLine(oldLines[li] || "").forEach((t) => {
      if (t.chordTag) chordTags[idx] = t.chordTag;
      if (t.drumTag) drumTags[idx] = t.drumTag;
      if (t.ch !== null) idx++;
    });
    const newLine = newLines[li] || "";
    let out = "";
    for (let i = 0; i < newLine.length; i++) {
      if (drumTags[i]) out += `<${drumTags[i]}>`;
      if (chordTags[i]) out += `[${chordTags[i]}]`;
      out += newLine[i];
    }
    if (drumTags[newLine.length]) out += `<${drumTags[newLine.length]}>`;
    if (chordTags[newLine.length]) out += `[${chordTags[newLine.length]}]`;
    outLines.push(out);
  }
  return outLines.join("\n");
}

/* =========================================================================
   Piano tab (shown for Vocals + Chords modes)
   ========================================================================= */
function PianoIcon({ size = 20, color }) {
  return (
    <svg width={size} style={{ height: size, width: "auto" }} viewBox="0 0 24 24" fill="none">
      <rect x="4" y="6" width="16" height="12" rx="2" stroke={color} strokeWidth="1.5" />
      <path d="M9.5 6v7M14.5 6v7" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function GaugeIcon({ size = 20, color }) {
  return (
    <svg width={size} style={{ height: size, width: "auto" }} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15l3.5-5.5" /><circle cx="12" cy="15" r="1.3" fill={color} stroke="none" />
      <path d="M4 15a8 8 0 1 1 16 0" />
    </svg>
  );
}
function IosShareIcon({ size = 16, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 3v12" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 7.5 12 3l4.5 4.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 10.5H5A2 2 0 0 0 3 12.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2h-1" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
const PIANO_TONE_HARMONICS_GRAND = [0, 1, 0.55, 0.32, 0.22, 0.15, 0.1, 0.07, 0.05, 0.03];
const PIANO_TONE_ENV_GRAND = { attack: 0.008, decayTo: 0.4, filterOpen: 9, filterSustain: 1.4, tail: 7 };
function buildPianoWave(ctx) {
  const amps = PIANO_TONE_HARMONICS_GRAND;
  const numHarmonics = amps.length - 1;
  const real = new Float32Array(numHarmonics + 1);
  const imag = new Float32Array(numHarmonics + 1);
  for (let n = 1; n <= numHarmonics; n++) imag[n] = amps[n];
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}
const WHITE_KEY_BG = "#F2F1EC";
const WHITE_KEY_BG_PRESSED = null; // filled in per-mode below (needs accent colour)
const BLACK_KEY_BG = "#0A0A0A";
const BLACK_KEY_BG_PRESSED = null;
const WHITE_KEYS = [
  { name: "C", semitone: 0 }, { name: "D", semitone: 2 }, { name: "E", semitone: 4 },
  { name: "F", semitone: 5 }, { name: "G", semitone: 7 }, { name: "A", semitone: 9 }, { name: "B", semitone: 11 },
];
const BLACK_KEYS = [
  { name: "C#", semitone: 1, afterWhiteIndex: 0 },
  { name: "D#", semitone: 3, afterWhiteIndex: 1 },
  { name: "F#", semitone: 6, afterWhiteIndex: 3 },
  { name: "G#", semitone: 8, afterWhiteIndex: 4 },
  { name: "A#", semitone: 10, afterWhiteIndex: 5 },
];
function useIsLandscapeScreen() {
  const getIsLandscape = () => typeof window !== "undefined" && window.innerWidth > window.innerHeight;
  const [isLandscape, setIsLandscape] = useState(getIsLandscape);
  useEffect(() => {
    const update = () => setIsLandscape(getIsLandscape());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return isLandscape;
}
function LandscapeLock({ children }) {
  const outerRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const isLandscapeScreen = useIsLandscapeScreen();
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (isLandscapeScreen) {
    return (
      <div ref={outerRef} style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", background: "#000" }}>
        {children}
      </div>
    );
  }
  return (
    <div ref={outerRef} style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", background: "#000" }}>
      {size.w > 0 && size.h > 0 && (
        <div style={{ position: "absolute", top: "50%", left: "50%", width: size.h, height: size.w, transform: "translate(-50%, -50%) rotate(90deg)", transformOrigin: "center center" }}>
          {children}
        </div>
      )}
    </div>
  );
}
const SILENT_VIDEO_SRC = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAZWbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAwN0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAIAAAACAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAJ7bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAAMgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACJm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAeZzdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAIAAgBIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MBQsAK/+EAGGdCwArZH4iIwEQAAAMABAAAAwDIPEiZIAEABWjLg8sgAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAGuAAABrgAAAAGHN0dHMAAAAAAAAAAQAAABkAAAIAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAABMc3RzYwAAAAAAAAAFAAAAAQAAAAEAAAABAAAAAgAAAAMAAAABAAAABgAAAAQAAAABAAAABwAAAAMAAAABAAAACQAAAAIAAAABAAAAeHN0c3oAAAAAAAAAAAAAABkAAAKDAAAACQAAAAoAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAANHN0Y28AAAAAAAAACQAABpsAAAkiAAAJQgAACWEAAAmAAAAJnwAACccAAAnmAAAKBQAAAn10cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAA+gAAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAEAAABAAAAAAH1bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAfQAAAI0BVxAAAAAAALWhkbHIAAAAAAAAAAHNvdW4AAAAAAAAAAAAAAABTb3VuZEhhbmRsZXIAAAABoG1pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABZHN0YmwAAAB+c3RzZAAAAAAAAAABAAAAbm1wNGEAAAAAAAAAAQAAAAAAAAAAAAEAEAAAAAAfQAAAAAAANmVzZHMAAAAAA4CAgCUAAgAEgICAF0AVAAAAAAAfQAAAAXcFgICABRWIVuUABoCAgAECAAAAFGJ0cnQAAAAAAAAfQAAAAXcAAAAgc3R0cwAAAAAAAAACAAAACAAABAAAAAABAAADQAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAA4c3RzegAAAAAAAAAAAAAACQAAABUAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAADRzdGNvAAAAAAAAAAkAAAaGAAAJHgAACT4AAAldAAAJfAAACZsAAAnDAAAJ4gAACgEAAAAac2dwZAEAAAByb2xsAAAAAgAAAAH//wAAABxzYmdwAAAAAHJvbGwAAAABAAAACQAAAAEAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMAAAAAhmcmVlAAADmW1kYXTeAgBMYXZjNjAuMzEuMTAyAAIwQA4AAAJxBgX//23cRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAApliIQM8mKAALC+ARggBwAAAAVBmjgZ6gAAAAZBmlQGeoAAAAAFQZpgM9QBGCAHAAAABUGagDPUAAAABUGaoDPUAAAABUGawDPUARggBwAAAAVBmuAz1AAAAAVBmwAz1AAAAAVBmyAz1AEYIAcAAAAFQZtAM9QAAAAFQZtgM9QAAAAFQZuAM9QBGCAHAAAABUGboDPUAAAABUGbwDPUAAAABUGb4DPUAAAABUGaADPUARggBwAAAAVBmiAz1AAAAAVBmkAz1AAAAAVBmmAz1AEYIAcAAAAFQZqAM9QAAAAFQZqgM9QAAAAFQZrAL9QBGCAHAAAABUGa4C/UAAAABUGbACvU";

function PianoScreen({ C }) {
  const [octaveStart, setOctaveStartState] = useState(4);
  const octaveStartRef = useRef(4);
  const audioCtxRef = useRef(null);
  const masterCompRef = useRef(null);
  const pianoWaveRef = useRef(null);
  const activeRef = useRef(new Map());
  const containerRef = useRef(null);
  const silentVideoRef = useRef(null);
  const videoUnlockedRef = useRef(false);

  useEffect(() => { octaveStartRef.current = octaveStart; }, [octaveStart]);
  const setOctaveStart = (n) => setOctaveStartState(Math.min(5, Math.max(3, n)));

  const WHITE_PRESSED = C.accent;
  const BLACK_PRESSED = C.accent;

  const ensureCtx = () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-18, ctx.currentTime);
      comp.knee.setValueAtTime(24, ctx.currentTime);
      comp.ratio.setValueAtTime(6, ctx.currentTime);
      comp.attack.setValueAtTime(0.003, ctx.currentTime);
      comp.release.setValueAtTime(0.15, ctx.currentTime);
      comp.connect(ctx.destination);
      masterCompRef.current = comp;
      audioCtxRef.current = ctx;
    }
    if (!pianoWaveRef.current) {
      pianoWaveRef.current = buildPianoWave(audioCtxRef.current);
    }
    if (audioCtxRef.current.state === "suspended") audioCtxRef.current.resume().catch(() => { });
    if (!videoUnlockedRef.current && silentVideoRef.current) {
      videoUnlockedRef.current = true;
      silentVideoRef.current.play().catch(() => { videoUnlockedRef.current = false; });
    }
    return audioCtxRef.current;
  };
  const freqFor = (semitone) => {
    const midi = (octaveStartRef.current + 1) * 12 + semitone;
    return 440 * Math.pow(2, (midi - 69) / 12);
  };
  const startVoice = (semitone) => {
    const ctx = ensureCtx();
    const now = ctx.currentTime;
    const freq = freqFor(semitone);
    const env = PIANO_TONE_ENV_GRAND;
    const gain = ctx.createGain();
    const peak = 0.62;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + env.attack);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * env.decayTo), now + 0.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + env.tail);
    const t = Math.min(1, Math.max(0, (freq - 130) / (2000 - 130)));
    const openMult = env.filterOpen - t * (env.filterOpen * 0.65);
    const sustainMult = Math.max(1.4, openMult * env.filterSustain / env.filterOpen * 0.3 + env.filterSustain * 0.15);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.6;
    filter.frequency.setValueAtTime(Math.min(9000, freq * openMult), now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(500, freq * sustainMult), now + 2.2);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(pianoWaveRef.current);
    osc.frequency.value = freq;
    osc.connect(filter); filter.connect(gain); gain.connect(masterCompRef.current || ctx.destination);
    osc.onended = () => { try { osc.disconnect(); filter.disconnect(); gain.disconnect(); } catch { } };
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
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
      voice.osc.stop(now + 0.09);
    } catch { }
  };
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
    keyEl.style.background = pressed ? (isBlack ? BLACK_PRESSED : WHITE_PRESSED) : (isBlack ? BLACK_KEY_BG : WHITE_KEY_BG);
  };
  const handlePointerDown = (e) => {
    e.preventDefault();
    const hit = keyAt(e.clientX, e.clientY);
    if (!hit) return;
    const voice = startVoice(hit.semitone);
    activeRef.current.set(e.pointerId, { semitone: hit.semitone, voice, keyEl: hit.el });
    paintKey(hit.el, true);
  };

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
    const handleVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      activeRef.current.forEach((v) => stopVoice(v.voice));
      activeRef.current.clear();
      if (audioCtxRef.current && audioCtxRef.current.state === "running") audioCtxRef.current.suspend().catch(() => { });
    };
    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      document.removeEventListener("visibilitychange", handleVisibility);
      activeRef.current.forEach((v) => stopVoice(v.voice));
      activeRef.current.clear();
      if (audioCtxRef.current && audioCtxRef.current.state === "running") audioCtxRef.current.suspend().catch(() => { });
    };
  }, []);

  // Close AudioContext fully on unmount so pitch/sample-rate state doesn't accumulate
  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close(); } catch { }
        audioCtxRef.current = null;
        masterCompRef.current = null;
        pianoWaveRef.current = null;
      }
    };
  }, []);

  const pianoBody = (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", fontFamily: FONT, color: C.text }}>
      <div style={{ height: 56, flexShrink: 0, display: "flex", alignItems: "center", padding: "0 16px", borderBottom: `1px solid ${C.border}`, gap: 10, boxSizing: "border-box", justifyContent: "space-between" }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Piano</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={() => setOctaveStart(octaveStart - 1)} disabled={octaveStart <= 3} style={{
            width: 32, height: 32, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, background: C.surface2,
            color: C.text, display: "flex", alignItems: "center", justifyContent: "center", opacity: octaveStart <= 3 ? 0.35 : 1,
          }}>
            <ChevronLeft size={15} />
          </button>
          <div style={{ fontSize: 13.5, fontWeight: 700, minWidth: 26, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{octaveStart - 4 === 0 ? "0" : octaveStart - 4 > 0 ? `+${octaveStart - 4}` : `${octaveStart - 4}`}</div>
          <button onClick={() => setOctaveStart(octaveStart + 1)} disabled={octaveStart >= 5} style={{
            width: 32, height: 32, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, background: C.surface2,
            color: C.text, display: "flex", alignItems: "center", justifyContent: "center", opacity: octaveStart >= 5 ? 0.35 : 1,
          }}>
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      <div ref={containerRef} onPointerDown={handlePointerDown} style={{ flex: 1, position: "relative", touchAction: "none" }}>
        <div style={{ position: "absolute", inset: 0, display: "flex" }}>
          {WHITE_KEYS.map((k) => (
            <div key={k.semitone} data-semitone={k.semitone} data-black="0" style={{
              flex: 1, background: WHITE_KEY_BG, borderRight: "1px solid rgba(0,0,0,0.25)",
              display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 10, boxSizing: "border-box",
            }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "rgba(0,0,0,0.35)" }}>{k.name}</span>
            </div>
          ))}
        </div>
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          {BLACK_KEYS.map((k) => {
            const boundaryPct = ((k.afterWhiteIndex + 1) / 7) * 100;
            const widthPct = (0.62 / 7) * 100;
            const leftPct = boundaryPct - widthPct / 2;
            return (
              <div key={k.semitone} data-semitone={k.semitone} data-black="1" style={{
                position: "absolute", top: 0, height: "58%", left: `${leftPct}%`, width: `${widthPct}%`,
                background: BLACK_KEY_BG, borderRadius: "0 0 4px 4px", pointerEvents: "auto", boxShadow: "0 3px 6px rgba(0,0,0,0.5)",
                display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 8, boxSizing: "border-box",
              }}>
                <span style={{ fontSize: 9.5, fontWeight: 600, color: "rgba(255,255,255,0.55)" }}>{k.name}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ height: "100%" }}>
      <video
        ref={silentVideoRef}
        src={SILENT_VIDEO_SRC}
        loop
        playsInline
        muted={false}
        volume={0.01}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
      />
      <LandscapeLock>{pianoBody}</LandscapeLock>
    </div>
  );
}

/* =========================================================================
   Metronome engine (drums mode + song-view bottom bar)
   ========================================================================= */
function defaultAccents(beats) { return Array.from({ length: beats }, () => "normal"); }

function useMetronomeEngine(settings) {
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
  const [playing, setPlaying] = useState(false);
  const [flashBeat, setFlashBeat] = useState(-1);
  const [loadedSong, setLoadedSong] = useState(null);

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

  const ensureMasterChain = (ctx) => {
    if (!masterCompRef.current || masterCompRef.current.context !== ctx) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-18, ctx.currentTime);
      comp.knee.setValueAtTime(24, ctx.currentTime);
      comp.ratio.setValueAtTime(6, ctx.currentTime);
      comp.attack.setValueAtTime(0.003, ctx.currentTime);
      comp.release.setValueAtTime(0.15, ctx.currentTime);
      comp.connect(ctx.destination);
      masterCompRef.current = comp;
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
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== "visible" || !audioCtxRef.current) return;
      if (audioCtxRef.current.state === "closed") {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      } else if (audioCtxRef.current.state === "suspended" || audioCtxRef.current.state === "interrupted") {
        audioCtxRef.current.resume().catch(() => { });
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  const setBpm = (v, keepSong = false) => {
    const clamped = Math.min(300, Math.max(30, Math.round(v)));
    setBpmState(clamped);
    if (!keepSong) setLoadedSong(null);
    if (playing) {
      bpmRef.current = clamped;
      stop();
      start();
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

  const playClick = (state, time) => {
    if (state === "mute") return;
    const ctx = audioCtxRef.current;
    const isAccent = state === "accent";
    const tone = clickToneRef.current;
    const master = ensureMasterChain(ctx);
    let dest = master;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(panValue(), time);
      panner.connect(master);
      dest = panner;
    }
    if (tone === "cowbell") {
      const dur = 0.12;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(isAccent ? 0.42 : 0.24, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 1.1;
      gain.connect(bp); bp.connect(dest);
      [800, 540].forEach((f) => {
        const osc = ctx.createOscillator();
        osc.type = "square"; osc.frequency.value = isAccent ? f * 1.05 : f;
        osc.connect(gain); osc.start(time); osc.stop(time + dur);
      });
      return;
    }
    if (tone === "wood") {
      const dur = 0.045;
      const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
      const noise = ctx.createBufferSource(); noise.buffer = buffer;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = isAccent ? 1600 : 1100; bp.Q.value = 6;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.7, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
      noise.connect(bp); bp.connect(gain); gain.connect(dest);
      noise.start(time); noise.stop(time + dur);
      return;
    }
    if (tone === "digital") {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = "square"; osc.frequency.value = isAccent ? 1800 : 1200;
      gain.gain.setValueAtTime(isAccent ? 0.5 : 0.28, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
      osc.connect(gain); gain.connect(dest);
      osc.start(time); osc.stop(time + 0.03);
      return;
    }
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.frequency.value = isAccent ? 1500 : 1000;
    gain.gain.setValueAtTime(isAccent ? 0.7 : 0.4, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    osc.connect(gain); gain.connect(dest);
    osc.start(time); osc.stop(time + 0.05);
  };

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
        if (k === 0) scheduleClick(beatIndex, t);
        else if (beatState !== "mute") playClick("normal", t);
      }
      nextNoteTimeRef.current += beatDur;
      beatRef.current = (beatIndex + 1) % timeSigRef.current.beats;
    }
  };

  const start = async () => {
    clearInterval(schedulerRef.current);
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
  const stop = () => { clearInterval(schedulerRef.current); setPlaying(false); setFlashBeat(-1); };
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
    const beats = parseTimeSig(song.timeSignature).beats || 4;
    const unit = parseTimeSig(song.timeSignature).unit || 4;
    setBpmState(song.tempo || 120);
    setTimeSigState({ beats, unit });
    const effBeats = (beats === 6 && unit === 8) ? 4 : beats;
    setAccentsState(song.accents && song.accents.length === effBeats ? song.accents : defaultAccents(effBeats));
    setSubdivisionState(song.subdivision || 1);
    beatRef.current = 0;
  };
  const loadSongAndPlay = (song) => {
    const beats = parseTimeSig(song.timeSignature).beats || 4;
    const unit = parseTimeSig(song.timeSignature).unit || 4;
    const effBeats = (beats === 6 && unit === 8) ? 4 : beats;
    const pattern = song.accents && song.accents.length === effBeats ? song.accents : defaultAccents(effBeats);
    const sub = song.subdivision || 1;
    bpmRef.current = song.tempo || 120;
    timeSigRef.current = { beats: effBeats, unit };
    accentsRef.current = pattern;
    subdivisionRef.current = sub;
    setLoadedSong(song);
    setBpmState(song.tempo || 120);
    setTimeSigState({ beats, unit });
    setAccentsState(pattern);
    setSubdivisionState(sub);
    beatRef.current = 0;
    start();
  };

  return {
    bpm, setBpm, timeSig, setTimeSig, accents, setAccents, subdivision, setSubdivision,
    playing, toggle, start, stop, flashBeat, tapTempo, loadedSong, loadSong, loadSongAndPlay,
  };
}

const DEG_PER_BPM = 6;
const KNOB_TOUCH_PAD = 28;
function Knob({ value, min = 30, max = 300, onChange, size = 220, playing, onToggle, C }) {
  const knobRef = useRef(null);
  const rectRef = useRef(null);
  const lastAngleRef = useRef(0);
  const downPosRef = useRef({ x: 0, y: 0 });
  const runningValueRef = useRef(value);
  const [spin, setSpin] = useState(0);
  const [dragging, setDragging] = useState(false);

  const angleFromPointer = (clientX, clientY) => {
    const rect = rectRef.current;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx; const dy = clientY - cy;
    return Math.atan2(dx, -dy) * (180 / Math.PI);
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
    const moved = Math.hypot(e.clientX - downPosRef.current.x, e.clientY - downPosRef.current.y);
    if (moved < 6 && rectRef.current) {
      const centerX = rectRef.current.left + rectRef.current.width / 2;
      const step = e.clientX < centerX ? -1 : 1;
      onChange(Math.min(max, Math.max(min, value + step)));
    }
  };
  const ticks = Array.from({ length: 40 });
  return (
    <div ref={knobRef} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
      style={{ width: size + KNOB_TOUCH_PAD * 2, height: size + KNOB_TOUCH_PAD * 2, margin: -KNOB_TOUCH_PAD, position: "relative", touchAction: "none", userSelect: "none", cursor: "grab" }}>
      <div style={{
        position: "absolute", inset: KNOB_TOUCH_PAD, borderRadius: "50%",
        background: `radial-gradient(circle at 50% 38%, ${C.surface3}, ${C.surface2} 70%)`,
        boxShadow: `inset 0 2px 6px rgba(0,0,0,0.6), inset 0 -1px 0 rgba(255,255,255,0.04), 0 8px 24px rgba(0,0,0,0.5)`,
        border: `1px solid ${C.border}`, pointerEvents: "none",
      }}>
        <div style={{ position: "absolute", inset: 0, transform: `rotate(${spin}deg)` }}>
          <svg width={size} height={size} style={{ position: "absolute", inset: 0 }}>
            {ticks.map((_, i) => {
              const t = (i / ticks.length) * 360;
              const rad = (t * Math.PI) / 180;
              const r1 = size / 2 - 13; const r2 = size / 2 - 7;
              const cx = size / 2, cy = size / 2;
              const x1 = cx + r1 * Math.sin(rad), y1 = cy - r1 * Math.cos(rad);
              const x2 = cx + r2 * Math.sin(rad), y2 = cy - r2 * Math.cos(rad);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.border} strokeWidth={1.5} strokeLinecap="round" />;
            })}
          </svg>
          <div style={{ position: "absolute", top: "50%", left: "50%", width: 4, height: size * 0.32, background: C.accent, borderRadius: 2, transformOrigin: "top center", transform: "translate(-50%, 0)", boxShadow: `0 0 6px ${C.accent}99` }} />
        </div>
        <div style={{ position: "absolute", inset: size * 0.14, borderRadius: "50%", background: `linear-gradient(180deg, ${C.surface2}, #0A0A0A)`, border: `1px solid ${C.border}`, pointerEvents: "none" }}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "38%", display: "flex", alignItems: "center", justifyContent: "flex-start", paddingLeft: size * 0.09 }}>
            <ChevronLeft size={size * 0.1} color={C.textFaint} />
          </div>
          <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "38%", display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: size * 0.09 }}>
            <ChevronRight size={size * 0.1} color={C.textFaint} />
          </div>
          <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onToggle(); }} style={{
            position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            width: size * 0.34, height: size * 0.34, borderRadius: "50%", border: "none", background: "transparent", pointerEvents: "auto",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {playing ? <Square size={size * 0.13} color="#fff" fill="#fff" /> : <Play size={size * 0.14} color="#fff" fill="#fff" style={{ marginLeft: size * 0.015 }} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function dotColor(state, lit, C) {
  if (state === "mute") return "transparent";
  if (state === "accent") return lit ? C.accent : C.accentDim;
  return lit ? "#fff" : C.surface3;
}
function BeatAccentControl({ count, flashBeat, accents, onChange, size = 9, openUpwardOnly, C }) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [hAlign, setHAlign] = useState("center"); // "center" | "left" | "right" — keeps the popup on-screen horizontally
  const btnRef = useRef(null);
  const POPUP_HEIGHT = 76;
  const POPUP_WIDTH = 220;
  const pattern = accents && accents.length === count ? accents : defaultAccents(count);
  const cycleBeat = (i) => {
    const order = ["normal", "accent", "mute"];
    const next = order[(order.indexOf(pattern[i] || "normal") + 1) % order.length];
    const nextPattern = pattern.slice();
    nextPattern[i] = next;
    onChange(nextPattern);
  };
  const handleOpen = () => {
    if (openUpwardOnly) {
      setOpenUpward(true);
    } else if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setOpenUpward(spaceBelow < POPUP_HEIGHT + 12 && spaceAbove > spaceBelow);
      const centerX = rect.left + rect.width / 2;
      if (centerX - POPUP_WIDTH / 2 < 8) setHAlign("left");
      else if (centerX + POPUP_WIDTH / 2 > window.innerWidth - 8) setHAlign("right");
      else setHAlign("center");
    }
    setOpen(true);
  };
  const hAlignStyle = hAlign === "left" ? { left: 0 } : hAlign === "right" ? { right: 0 } : { left: "50%", transform: "translateX(-50%)" };
  return (
    <div style={{ position: "relative" }} ref={btnRef}>
      <button onClick={handleOpen} style={{ display: "flex", gap: 8, justifyContent: "center", background: "none", border: "none", padding: 6, cursor: "pointer" }}>
        {pattern.map((state, i) => (
          <div key={i} style={{ width: size, height: size, borderRadius: "50%", background: dotColor(state, flashBeat === i, C), border: state === "mute" ? `1.5px solid ${C.textFaint}` : "none", boxSizing: "border-box", transition: "background 60ms linear" }} />
        ))}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 140 }} />
          <div style={{
            position: "absolute", ...(openUpward ? { bottom: "100%", marginBottom: 10 } : { top: "100%", marginTop: 10 }),
            ...hAlignStyle, zIndex: 150, background: C.surface3, border: `1px solid ${C.borderStrong}`, borderRadius: 16, padding: "16px 18px",
            boxShadow: "0 12px 32px rgba(0,0,0,0.6)", display: "flex", alignItems: "center", gap: 14, minWidth: POPUP_WIDTH, justifyContent: "center",
            maxWidth: "calc(100vw - 16px)", boxSizing: "border-box",
          }}>
            {pattern.map((state, i) => (
              <button key={i} onClick={() => cycleBeat(i)} style={{ background: "none", border: "none", padding: 4, cursor: "pointer" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: state === "mute" ? "transparent" : state === "accent" ? C.accent : "#fff", border: state === "mute" ? `2px solid ${C.textFaint}` : "none", boxSizing: "border-box" }} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SubdivisionIcon({ value, size = 18, color }) {
  if (value === 1) {
    return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none"><ellipse cx="7.5" cy="18" rx="4" ry="3" fill={color} /><line x1="11.3" y1="18" x2="11.3" y2="4" stroke={color} strokeWidth="2" strokeLinecap="round" /></svg>);
  }
  if (value === 2) {
    return (<svg width={size * 1.15} height={size} viewBox="0 0 28 24" fill="none"><ellipse cx="6.5" cy="19" rx="3.4" ry="2.6" fill={color} /><ellipse cx="21.5" cy="19" rx="3.4" ry="2.6" fill={color} /><line x1="9.7" y1="19" x2="9.7" y2="6" stroke={color} strokeWidth="2" strokeLinecap="round" /><line x1="24.7" y1="19" x2="24.7" y2="6" stroke={color} strokeWidth="2" strokeLinecap="round" /><line x1="9.7" y1="6" x2="24.7" y2="6" stroke={color} strokeWidth="2.2" strokeLinecap="round" /></svg>);
  }
  return (
    <svg width={size * 1.5} height={size} viewBox="0 0 40 24" fill="none">
      <text x="20" y="5.5" fontSize="7" fontWeight="700" fill={color} textAnchor="middle" fontFamily={FONT}>3</text>
      <ellipse cx="6" cy="19" rx="3" ry="2.3" fill={color} /><ellipse cx="20" cy="19" rx="3" ry="2.3" fill={color} /><ellipse cx="34" cy="19" rx="3" ry="2.3" fill={color} />
      <line x1="9" y1="19" x2="9" y2="8" stroke={color} strokeWidth="1.8" strokeLinecap="round" /><line x1="23" y1="19" x2="23" y2="8" stroke={color} strokeWidth="1.8" strokeLinecap="round" /><line x1="37" y1="19" x2="37" y2="8" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <line x1="9" y1="8" x2="37" y2="8" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
const stepBtnStyle = (C) => ({ width: 40, height: 40, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, background: C.surface2, color: C.text, fontSize: 20, fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 });
const bigStepBtnStyle = (C) => ({ width: 56, height: 56, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, background: C.surface2, color: C.text, fontSize: 26, fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 });

function useHoldRepeat(step) {
  const timeoutRef = useRef(null);
  const startTimeRef = useRef(0);
  const activeRef = useRef(false);
  const stepRef = useRef(step);
  stepRef.current = step;
  const clear = () => { activeRef.current = false; if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; } };
  const scheduleNext = () => {
    if (!activeRef.current) return;
    const heldSeconds = (performance.now() - startTimeRef.current) / 1000;
    const minInterval = 35, startInterval = 300, tau = 0.55;
    const interval = minInterval + (startInterval - minInterval) * Math.exp(-heldSeconds / tau);
    timeoutRef.current = setTimeout(() => { stepRef.current(); scheduleNext(); }, interval);
  };
  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    clear(); activeRef.current = true; startTimeRef.current = performance.now();
    stepRef.current();
    timeoutRef.current = setTimeout(scheduleNext, 380);
  };
  useEffect(() => () => clear(), []);
  return { onPointerDown, onPointerUp: clear, onPointerLeave: clear, onPointerCancel: clear };
}

/* =========================================================================
   Metronome tab (Drums mode's first page). Settings/Piano buttons removed
   per Altar spec — Settings now lives only in the bottom-nav Settings tab.
   ========================================================================= */
function MetronomeScreen({ engine, onUpdateSongAccents, onUpdateSongSubdivision, onLongPressTitle, C }) {
  const { bpm, setBpm, timeSig, setTimeSig, accents, setAccents, subdivision, setSubdivision, playing, toggle, flashBeat, tapTempo, loadedSong } = engine;
  const [editingBpm, setEditingBpm] = useState(false);
  const [bpmDraft, setBpmDraft] = useState("");
  const longPressTimerRef = useRef(null);

  const startTitleTouch = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => { if (onLongPressTitle) onLongPressTitle(); }, 500);
  };
  const clearTitleTouch = () => { if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; } };

  const changeAccents = (next) => { setAccents(next); if (loadedSong) onUpdateSongAccents(loadedSong.id, next); };
  const cycleSubdivision = () => {
    const next = (subdivision % 3) + 1;
    setSubdivision(next);
    if (loadedSong) onUpdateSongSubdivision(loadedSong.id, next);
  };

  const NAV_H = "calc(55px + max(36px, 8px + env(safe-area-inset-bottom, 0px)))";
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, paddingBottom: NAV_H, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-evenly", padding: `28px 20px calc(${NAV_H})`, boxSizing: "border-box", overflowY: "auto" }}>
      <div onTouchStart={startTitleTouch} onTouchMove={clearTitleTouch} onTouchEnd={clearTitleTouch} onTouchCancel={clearTitleTouch}
        onMouseDown={startTitleTouch} onMouseUp={clearTitleTouch} onMouseLeave={clearTitleTouch}
        style={{ textAlign: "center", height: 40, display: "flex", flexDirection: "column", justifyContent: "center", cursor: "pointer" }}>
        {loadedSong ? (
          <>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{loadedSong.title}</div>
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{loadedSong.artist}</div>
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
          type="tel" inputMode="numeric" value={editingBpm ? bpmDraft : String(Math.round(bpm))}
          onFocus={() => { setEditingBpm(true); setBpmDraft(""); }}
          onChange={(e) => setBpmDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
          onBlur={() => { const n = parseInt(bpmDraft, 10); if (!isNaN(n)) setBpm(n, true); setEditingBpm(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          className="bpm-number-input"
          style={{ fontSize: 60, fontWeight: 600, fontFamily: FONT, color: C.accent, fontVariantNumeric: "tabular-nums", lineHeight: "42px", background: "transparent", border: "none", textAlign: "center", width: 150, padding: 0, caretColor: "transparent" }}
        />
        <div style={{ fontSize: 11, letterSpacing: 2, color: C.textMuted, marginTop: 6 }}>BPM</div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", maxWidth: 320 }}>
        <BeatAccentControl count={(timeSig.beats === 6 && timeSig.unit === 8) ? 4 : timeSig.beats} flashBeat={flashBeat} accents={accents} onChange={changeAccents} C={C} />
      </div>

      <Knob value={bpm} onChange={(v) => setBpm(v, true)} size={268} playing={playing} onToggle={toggle} C={C} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", maxWidth: 320 }}>
        <TimeSigPicker value={timeSig} onChange={setTimeSig} fullWidth height={58} style={{ flex: 1, alignSelf: "stretch" }} C={C} />
        <button onClick={cycleSubdivision} style={{ flex: 1, height: 58, boxSizing: "border-box", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <SubdivisionIcon value={subdivision} size={19} color={C.text} />
        </button>
        <button onPointerDown={tapTempo} style={{ flex: 1, height: 58, boxSizing: "border-box", fontFamily: FONT, fontSize: 14, letterSpacing: 1, fontWeight: 600, borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, display: "flex", alignItems: "center", justifyContent: "center" }}>
          TAP
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   ChordText — renders (and, when editable, lets you tag) lyric text with
   [Chord]/[Note] markers positioned exactly above the character they
   precede. Used for the Drums/Chords tabs of the Add/Edit Song form and
   for the song-view chart itself.
   ========================================================================= */
function ChordText({ text, onChange, editable, dim, brightTags, showLyrics = true, showTags = true, textAlign = "left", fontSize = 22, lineHeightMult = 1.75, tagFontSize, accent, C, emptyHint, bold, lyricsBold, notesBold, flattenTags = false }) {
  const [editorFor, setEditorFor] = useState(null); // { line, index } | null
  const [draft, setDraft] = useState("");
  const lines = String(text || "").split("\n").map((l) => l.replace(/^ +/, ""));
  const hasAnyContent = String(text || "").trim().length > 0;
  const tagSize = Math.max(9, tagFontSize != null ? tagFontSize : fontSize * 0.62);
  const tagGap = Math.max(4, tagSize * 0.28);
  const topPad = showTags ? tagSize + tagGap : 0;
  // lyricsBold/notesBold let callers control lyric-character and chord-label weight
  // independently; `bold` is kept as a legacy fallback that drives both.
  const lyricWeightBold = lyricsBold != null ? lyricsBold : bold;
  const noteWeightBold = notesBold != null ? notesBold : bold;

  const commitTag = (lineIdx, tokenIdx, value) => {
    const lns = String(text || "").split("\n");
    const tokens = tokenizeTaggedLine(lns[lineIdx] || "");
    if (tokenIdx >= tokens.length) tokens.push({ ch: null, tag: null });
    tokens[tokenIdx] = { ...tokens[tokenIdx], tag: value.trim() ? value.trim() : null };
    const rebuilt = tokens.map((t) => (t.tag ? `[${t.tag}]` : "") + (t.ch ?? "")).join("");
    lns[lineIdx] = rebuilt;
    onChange(lns.join("\n"));
  };

  const openEditor = (lineIdx, tokenIdx, currentTag) => {
    if (!editable) return;
    setEditorFor({ line: lineIdx, index: tokenIdx });
    setDraft(currentTag || "");
  };
  const closeEditor = (commit) => {
    if (commit && editorFor) commitTag(editorFor.line, editorFor.index, draft);
    setEditorFor(null); setDraft("");
  };

  if (!hasAnyContent && !editable) {
    return <div style={{ color: C.textFaint, fontSize, fontFamily: MONO }}>{emptyHint || "\u2014"}</div>;
  }

  return (
    <div style={{ fontFamily: MONO, fontSize, lineHeight: `${lineHeightMult}em`, textAlign, whiteSpace: "pre-wrap", wordBreak: "keep-all", overflowWrap: "normal", letterSpacing: "normal", hyphens: "none", maxWidth: "100%", boxSizing: "border-box", overflowX: "hidden" }}>
      {lines.map((line, li) => {
        const tokens = tokenizeTaggedLine(line);
        if (tokens.length === 0) tokens.push({ ch: null, tag: null });

        // Group tokens into words (runs of non-space characters) and
        // individual space units, so each word can be wrapped in a
        // non-breaking span — this guarantees a line never breaks mid-word
        // and never starts with a space or punctuation, matching the plain
        // <pre> text-flow behaviour used in Vocals mode exactly.
        const groups = [];
        let current = [];
        tokens.forEach((tok, ti) => {
          const isSpace = tok.ch === " " || tok.ch === null;
          if (isSpace) {
            if (current.length) { groups.push({ type: "word", items: current }); current = []; }
            groups.push({ type: "space", items: [{ tok, ti }] });
          } else {
            current.push({ tok, ti });
          }
        });
        if (current.length) groups.push({ type: "word", items: current });

        const renderChar = ({ tok, ti }) => {
          const isEditingThis = editable && editorFor && editorFor.line === li && editorFor.index === ti;
          return (
            <span
              key={ti}
              onClick={editable ? () => openEditor(li, ti, tok.tag) : undefined}
              style={{
                position: "relative", display: "inline-block", paddingTop: topPad,
                cursor: editable ? "pointer" : "default", width: "1ch",
                lineHeight: `${lineHeightMult}em`,
              }}
            >
              {/* Chord/tag slot — shows inline input when editing, otherwise chord label */}
              {!showTags ? null : isEditingThis ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => closeEditor(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.currentTarget.blur(); }
                    if (e.key === "Escape") closeEditor(false);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: "absolute", top: 0, left: 0,
                    width: Math.max(tagSize * 3, 40), fontSize: tagSize,
                    fontFamily: MONO, fontWeight: 800,
                    color: brightTags ? "#FFFFFF" : accent,
                    background: "transparent", border: "none", outline: "none",
                    padding: 0, margin: 0, lineHeight: 1,
                    caretColor: accent,
                  }}
                />
              ) : tok.tag ? (
                <span style={{
                  position: "absolute", top: 0, left: 0, whiteSpace: "nowrap",
                  fontSize: tagSize, fontWeight: noteWeightBold ? 800 : 600,
                  color: brightTags ? "#FFFFFF" : accent,
                  opacity: 1,
                }}>
                  {flattenTags ? flatify(tok.tag) : tok.tag}
                </span>
              ) : editable ? (
                /* Empty slot tap target — shows a faint + when in edit mode */
                <span style={{
                  position: "absolute", top: 0, left: 0,
                  fontSize: tagSize, fontWeight: 800,
                  color: `${accent}44`,
                  lineHeight: 1,
                  userSelect: "none",
                }}>+</span>
              ) : null}
              <span style={{ color: showLyrics ? (dim ? "rgba(255,255,255,0.4)" : C.text) : "transparent", visibility: showLyrics ? "visible" : (tok.ch ? "hidden" : "visible"), fontWeight: lyricWeightBold ? 700 : 400 }}>
                {tok.ch === null ? "\u00A0" : tok.ch === " " ? "\u00A0" : tok.ch}
              </span>
            </span>
          );
        };

        return (
          <div key={li} style={{ minHeight: fontSize * lineHeightMult, marginBottom: Math.max(fontSize * 0.5, fontSize * (lineHeightMult - 1.2)), lineHeight: `${lineHeightMult}em` }}>
            {groups.map((g, gi) => (
              g.type === "word" ? (
                <span key={gi} style={{ display: "inline-block", whiteSpace: "nowrap" }}>
                  {g.items.map(renderChar)}
                </span>
              ) : (
                <span key={gi}>
                  {g.items.map(renderChar)}
                  <wbr />
                </span>
              )
            ))}
          </div>
        );
      })}
    </div>
  );
}

/* =========================================================================
   Swipe hooks
   ========================================================================= */
function useEdgeSwipeBack(onBack) {
  const touchStartRef = useRef(null);
  const [dragX, setDragX] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const handleTouchStart = (e) => {
    if (leaving) return;
    const x = e.touches[0].clientX;
    if (x > 24) { touchStartRef.current = null; return; }
    touchStartRef.current = { x, y: e.touches[0].clientY };
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
    if (dragX > 30) { setLeaving(true); setDragX(window.innerWidth); setTimeout(onBack, 200); }
    else setDragX(0);
  };
  return { dragX, leaving, handlers: { onTouchStart: handleTouchStart, onTouchMove: handleTouchMove, onTouchEnd: handleTouchEnd, onTouchCancel: handleTouchEnd } };
}

function useSetlistSongSwipe(onPrev, onNext) {
  const draggingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0 });
  const dxRef = useRef(0);
  const directionRef = useRef(null);
  const handleTouchStart = (e) => {
    if (e.touches.length !== 1) return;
    startRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    directionRef.current = null; dxRef.current = 0; draggingRef.current = true;
  };
  const handleTouchMove = (e) => {
    if (!draggingRef.current) return;
    const dx = e.touches[0].clientX - startRef.current.x;
    const dy = e.touches[0].clientY - startRef.current.y;
    if (directionRef.current === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      directionRef.current = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    }
    if (directionRef.current === "y") return;
    dxRef.current = dx;
  };
  const handleTouchEnd = () => {
    const wasHorizontal = directionRef.current === "x";
    const dx = dxRef.current;
    draggingRef.current = false; directionRef.current = null; dxRef.current = 0;
    if (wasHorizontal) {
      if (dx > 140 && onPrev) onPrev();
      else if (dx < -140 && onNext) onNext();
    }
  };
  return { dragX: 0, handlers: { onTouchStart: handleTouchStart, onTouchMove: handleTouchMove, onTouchEnd: handleTouchEnd, onTouchCancel: handleTouchEnd } };
}

/* =========================================================================
   Modal / SwipeToDelete / Kebab menu
   ========================================================================= */
function Modal({ title, onClose, children, C }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "flex-end" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)" }} />
      <div className="scroll-list" style={{ position: "relative", width: "100%", background: C.surface2, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 32, fontFamily: FONT, color: C.text, maxHeight: "80vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{title}</div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}><X size={18} color={C.textMuted} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

const SWIPE_REVEAL = 76;
function SwipeToDelete({ id, openId, onOpenIdChange, onDelete, children, icon: RevealIcon = Trash2, C }) {
  const [translateX, setTranslateX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0); const startYRef = useRef(0); const startTranslateRef = useRef(0);
  const movedRef = useRef(false); const directionRef = useRef(null);
  const isOpen = openId === id;
  useEffect(() => { if (!isOpen) setTranslateX(0); }, [isOpen]);
  const handleTouchStart = (e) => {
    if (openId !== null && openId !== id) onOpenIdChange(null);
    startXRef.current = e.touches[0].clientX; startYRef.current = e.touches[0].clientY;
    startTranslateRef.current = translateX; movedRef.current = false; directionRef.current = null;
    setDragging(true);
  };
  const handleTouchMove = (e) => {
    const dx = e.touches[0].clientX - startXRef.current;
    const dy = e.touches[0].clientY - startYRef.current;
    if (directionRef.current === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      directionRef.current = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    }
    if (directionRef.current === "y") return;
    e.stopPropagation();
    if (Math.abs(dx) > 6) movedRef.current = true;
    setTranslateX(Math.min(0, Math.max(-SWIPE_REVEAL, startTranslateRef.current + dx)));
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
    if (isOpen) { e.stopPropagation(); setTranslateX(0); onOpenIdChange(null); }
  };
  return (
    <div style={{ position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: SWIPE_REVEAL, display: "flex", alignItems: "stretch", justifyContent: "center", background: "#161618" }}>
        <button onClick={() => { onDelete(); setTranslateX(0); onOpenIdChange(null); }} style={{ width: "100%", background: "none", border: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <RevealIcon size={18} color={C.danger} />
        </button>
      </div>
      <div onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} onClickCapture={handleContentClickCapture}
        style={{ transform: `translateX(${translateX}px)`, transition: dragging ? "none" : "transform 200ms ease", background: C.bg, touchAction: "pan-y" }}>
        {children}
      </div>
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger, C }) {
  return (
    <button onClick={onClick} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: "transparent", border: "none", fontFamily: FONT, fontSize: 14.5, fontWeight: 600, color: danger ? C.danger : C.text, textAlign: "left", whiteSpace: "nowrap" }}>
      <Icon size={15} color={danger ? C.danger : C.textMuted} />
      {label}
    </button>
  );
}
function KebabMenu({ onEdit, onShare, onDelete, isInSetlist, onRemoveFromSetlist, deleteConfirmMessage = "Delete this song?", C }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} style={{ width: 34, height: 34, borderRadius: "50%", border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <MoreVertical size={16} color={C.text} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 110 }} />
          <div style={{ position: "absolute", top: "110%", right: 0, zIndex: 120, width: "max-content", background: C.surface3, border: `1px solid ${C.borderStrong}`, borderRadius: 12, overflow: "hidden", boxShadow: "0 12px 32px rgba(0,0,0,0.6)" }}>
            <MenuItem icon={Pencil} label="Edit" onClick={() => { setOpen(false); onEdit(); }} C={C} />
            <MenuItem icon={IosShareIcon} label="Share" onClick={() => { setOpen(false); onShare(); }} C={C} />
            {isInSetlist ? (
              <MenuItem icon={X} label="Remove" danger onClick={() => { setOpen(false); if (window.confirm("Remove this song from the setlist?")) onRemoveFromSetlist(); }} C={C} />
            ) : (
              <MenuItem icon={Trash2} label="Delete" danger onClick={() => { setOpen(false); if (window.confirm(deleteConfirmMessage)) onDelete(); }} C={C} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* =========================================================================
   SectionChordEditor — lets users edit chords/notes inline on the same line
   as the lyrics between characters. The lyric characters are read-only,
   and users can navigate/type only in the slots between/before/after them.
   ========================================================================= */
function parseLine(taggedLine, plainLyricsLine) {
  const lyrics = plainLyricsLine || "";
  const insertions = Array(lyrics.length + 1).fill("");
  const tokens = tokenizeTaggedLine(taggedLine);
  let lyricIndex = 0;
  tokens.forEach((t) => {
    if (t.tag) {
      insertions[lyricIndex] = t.tag;
    }
    if (t.ch !== null) {
      lyricIndex++;
    }
  });
  return { lyrics, insertions };
}

function serializeLine(lyrics, insertions) {
  let out = "";
  for (let i = 0; i < lyrics.length; i++) {
    if (insertions[i]) {
      out += `[${insertions[i]}]`;
    }
    out += lyrics[i];
  }
  if (insertions[lyrics.length]) {
    out += `[${insertions[lyrics.length]}]`;
  }
  return out;
}

function SectionChordEditor({ content, onChangeContent, tagType, C, accent, fontSize = 15, tagFontSize = 13, lyricsBold = false, notesBold = false, textAlign = "left" }) {
  const lines = String(content || "").split("\n");
  const [activeCell, setActiveCell] = useState(null); // { lineIdx, charIdx }

  const handleUpdate = (lineIdx, charIdx, value) => {
    const nextLines = lines.map((line, li) => {
      if (li !== lineIdx) return line;
      const chordTags = [], drumTags = [];
      let idx = 0;
      const chars = [];
      tokenizeContentLine(line).forEach((t) => {
        if (t.chordTag) chordTags[idx] = t.chordTag;
        if (t.drumTag) drumTags[idx] = t.drumTag;
        if (t.ch !== null) { chars.push(t.ch); idx++; }
      });
      if (tagType === "chords") chordTags[charIdx] = value; else drumTags[charIdx] = value;
      let out = "";
      for (let i = 0; i < chars.length; i++) {
        if (drumTags[i]) out += `<${drumTags[i]}>`;
        if (chordTags[i]) out += `[${chordTags[i]}]`;
        out += chars[i];
      }
      if (drumTags[chars.length]) out += `<${drumTags[chars.length]}>`;
      if (chordTags[chars.length]) out += `[${chordTags[chars.length]}]`;
      return out;
    });
    onChangeContent(nextLines.join("\n"));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, fontFamily: MONO, fontSize, fontWeight: lyricsBold ? 700 : 400, lineHeight: 1.75, textAlign, letterSpacing: "normal" }}>
      {lines.map((line, li) => {
        const chordTags = [], drumTags = [];
        let idx = 0;
        const chars = [];
        tokenizeContentLine(line).forEach((t) => {
          if (t.chordTag) chordTags[idx] = t.chordTag;
          if (t.drumTag) drumTags[idx] = t.drumTag;
          if (t.ch !== null) { chars.push(t.ch); idx++; }
        });
        const activeTagsArr = tagType === "chords" ? chordTags : drumTags;

        return (
          <div key={li} style={{ whiteSpace: "pre-wrap", wordBreak: "keep-all", overflowWrap: "normal", hyphens: "none" }}>
            {Array.from({ length: chars.length + 1 }).map((_, ci) => {
              const isEditing = activeCell && activeCell.lineIdx === li && activeCell.charIdx === ci;
              const value = activeTagsArr[ci] || "";
              const hasVal = value !== "";
              const char = chars[ci] || ""; // character after this slot

              return (
                <span key={ci} style={{ position: "relative" }}>
                  {isEditing ? (
                    <input
                      autoFocus
                      type="text"
                      value={value}
                      size={Math.max(1, value.length || 1)}
                      onChange={(e) => handleUpdate(li, ci, e.target.value)}
                      onBlur={() => setActiveCell(null)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === "Escape") {
                          e.preventDefault();
                          setActiveCell(null);
                        } else if (e.key === "ArrowLeft" && e.target.selectionStart === 0) {
                          e.preventDefault();
                          if (ci > 0) setActiveCell({ lineIdx: li, charIdx: ci - 1 });
                        } else if (e.key === "ArrowRight" && e.target.selectionEnd === e.target.value.length) {
                          e.preventDefault();
                          if (ci < chars.length) setActiveCell({ lineIdx: li, charIdx: ci + 1 });
                        } else if (e.key === "Backspace" && e.target.value === "") {
                          e.preventDefault();
                          handleUpdate(li, ci, "");
                          if (ci > 0) setActiveCell({ lineIdx: li, charIdx: ci - 1 });
                        }
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        outline: "none",
                        boxShadow: "none",
                        color: accent,
                        caretColor: accent,
                        fontFamily: MONO,
                        fontWeight: lyricsBold ? 700 : 400,
                        fontSize,
                        padding: 0,
                        margin: 0,
                        letterSpacing: "normal",
                        verticalAlign: "baseline",
                        lineHeight: "inherit",
                      }}
                    />
                  ) : hasVal ? (
                    <span
                      onClick={(e) => { e.stopPropagation(); setActiveCell({ lineIdx: li, charIdx: ci }); }}
                      style={{ color: accent, fontWeight: lyricsBold ? 700 : 400, cursor: "pointer", userSelect: "none" }}
                    >
                      {tagType === "chords" ? flatify(value) : value}
                    </span>
                  ) : (
                    <span
                      onClick={(e) => { e.stopPropagation(); setActiveCell({ lineIdx: li, charIdx: ci }); }}
                      style={{ cursor: "text" }}
                    >
                      {"\u200B"}
                    </span>
                  )}
                  {char && (
                    <span
                      onClick={() => setActiveCell({ lineIdx: li, charIdx: ci + 1 })}
                      style={{ color: C.textMuted, cursor: "text", userSelect: "none" }}
                    >
                      {char === " " ? "\u00A0" : char}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* =========================================================================
   Song form — the Chords app's Add/Edit Song page is the norm for Altar,
   with a Lyrics/Drums/Chords tab-select added under "Sections" (spec #7/#8).
   ========================================================================= */
const SECTION_TABS = [
  { id: "lyrics", label: "Lyrics" },
  { id: "chords", label: "Chords" },
  { id: "drums", label: "Drums" },
];
function AutoGrowTextarea({ value, onChange, style, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={onChange}
      style={{ ...style, overflow: "hidden", resize: "none" }}
      {...rest}
    />
  );
}

function SongForm({ initial, onSave, onCancel, onDelete, onDuplicate, songs, mode, fontSize = 22, chordFontSize = 16, lyricsBold = false, notesBold = false, lineSpacing = 1.75, textAlign = "left", C }) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [artist, setArtist] = useState(initial?.artist ?? "");
  const [tempo, setTempo] = useState(initial?.tempo ?? "");
  const [timeSig, setTimeSig] = useState(() => (initial?.timeSignature ? parseTimeSig(initial.timeSignature) : { beats: 4, unit: 4 }));
  const initialDecomposed = decomposeKey(initial?.key ?? "C");
  const [keyNatural, setKeyNatural] = useState(initialDecomposed.natural);
  const [keyAccidental, setKeyAccidental] = useState(initialDecomposed.accidental);
  const [keyQuality, setKeyQuality] = useState(initial?.keyQuality ?? "Major");
  const [language, setLanguage] = useState(initial?.language ?? "English");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [sections, setSections] = useState(initial?.sections?.map((s) => {
    const content = s.content ?? mergeLegacyToContent(s.lyrics ?? "", s.chords ?? "", s.drums ?? "");
    return { id: s.id, label: s.label, content, lyrics: s.lyrics ?? "", drums: s.drums ?? "", chords: s.chords ?? "" };
  }) ?? [{ id: uid(), label: "Verse", content: "", lyrics: "", drums: "", chords: "" }]);
  const [accents, setAccents] = useState(initial?.accents ?? defaultAccents(4));
  const [subdivision, setSubdivision] = useState(initial?.subdivision ?? 1);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const [sectionTab, setSectionTab] = useState("lyrics");

  const { dragX, leaving, handlers } = useEdgeSwipeBack(onCancel);

  const handlePasteFromClipboard = async () => {
    try {
      const raw = await navigator.clipboard.readText();
      if (!raw || !raw.trim()) { setError("Clipboard is empty"); return; }
      const lines = raw.replace(/\r\n/g, "\n").split("\n");
      const fieldMap = { title: "title", artist: "artist", tempo: "tempo", "time signature": "timeSignature", key: "key", description: "description" };
      const fields = {};
      const parsedSections = [];
      let current = null; let inSections = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!inSections && trimmed.startsWith("/")) {
          const body = trimmed.slice(1);
          const colonIdx = body.indexOf(":");
          if (colonIdx === -1) continue;
          const name = body.slice(0, colonIdx).trim().toLowerCase();
          const value = body.slice(colonIdx + 1).trim();
          if (name === "sections") { inSections = true; continue; }
          const key = fieldMap[name];
          if (key && value) fields[key] = value;
          continue;
        }
        if (!inSections) continue;
        if (trimmed.startsWith("#")) { current = { id: uid(), label: trimmed.slice(1).trim(), lyrics: "", drums: "", chords: "" }; parsedSections.push(current); }
        else if (trimmed) { if (!current) { current = { id: uid(), label: "", lyrics: "", drums: "", chords: "" }; parsedSections.push(current); } current.lyrics = current.lyrics ? current.lyrics + "\n" + trimmed : trimmed; }
      }
      if (fields.title !== undefined) setTitle(fields.title);
      if (fields.artist !== undefined) setArtist(fields.artist);
      if (fields.tempo !== undefined) { const digits = fields.tempo.replace(/[^\d]/g, ""); if (digits) setTempo(digits); }
      if (fields.timeSignature !== undefined) { const m = fields.timeSignature.match(/^(\d+)\s*\/\s*(\d+)$/); if (m) setTimeSig({ beats: parseInt(m[1], 10), unit: parseInt(m[2], 10) }); }
      if (fields.key !== undefined) { const pk = parseKeyPaste(fields.key); if (pk) { setKeyNatural(pk.natural); setKeyAccidental(pk.accidental); setKeyQuality(pk.quality); } }
      if (fields.description !== undefined) setDescription(fields.description);
      if (parsedSections.length) setSections(parsedSections.map((s) => ({ ...s, content: mergeLegacyToContent(s.lyrics, s.chords, s.drums) })));
      setError("");
    } catch {
      setError("Couldn't read clipboard");
    }
  };

  const handleNaturalChange = (n) => {
    setKeyNatural(n);
    if (keyAccidental === "sharp" && (n === "E" || n === "B")) setKeyAccidental("natural");
    if (keyAccidental === "flat" && (n === "C" || n === "F")) setKeyAccidental("natural");
  };
  const handleTimeSigChange = (ts) => { setTimeSig(ts); const effBeats = (ts.beats === 6 && ts.unit === 8) ? 4 : ts.beats; setAccents(defaultAccents(effBeats)); };

  const updateSection = (id, field, value) => setSections((secs) => secs.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  const updateSectionLyrics = (id, newLyrics) => setSections((secs) => secs.map((s) => {
    if (s.id !== id) return s;
    const content = resyncContentWithLyrics(s.content, newLyrics);
    return { ...s, content, lyrics: newLyrics, chords: contentToChordsTagged(content), drums: contentToDrumsTagged(content) };
  }));
  const updateSectionContent = (id, newContent) => setSections((secs) => secs.map((s) => (
    s.id === id ? { ...s, content: newContent, lyrics: contentToLyricsPlain(newContent), chords: contentToChordsTagged(newContent), drums: contentToDrumsTagged(newContent) } : s
  )));
  const removeSection = (id) => setSections((secs) => secs.filter((s) => s.id !== id));
  const addSection = () => setSections((secs) => [...secs, { id: uid(), label: "", content: "", lyrics: "", drums: "", chords: "" }]);

  const handleSave = () => {
    const cleanTitle = toTitleCase(title.trim());
    const cleanArtist = toTitleCase(artist.trim());
    const isDuplicate = songs.some((s) => {
      if (initial && s.id === initial.id) return false;
      return s.title.toLowerCase() === cleanTitle.toLowerCase() && (s.artist || "").toLowerCase() === cleanArtist.toLowerCase();
    });
    if (!cleanTitle) return;
    if (isDuplicate) { setError("Song already exists"); return; }
    onSave({
      title: cleanTitle, artist: cleanArtist, tempo: tempo === "" ? "" : Number(tempo), timeSignature: formatTimeSig(timeSig),
      key: composeKey(keyNatural, keyAccidental), keyQuality, language, description, accents, subdivision,
      sections: sections.length ? sections : [{ id: uid(), label: "Verse", content: "", lyrics: "", drums: "", chords: "" }],
    });
  };
  const canSave = title.trim().length > 0;

  return (
    <div className="scroll-list" style={{ position: "fixed", inset: 0, zIndex: 150, background: C.bg, color: C.text, fontFamily: FONT, overflowY: "auto", boxSizing: "border-box", paddingTop: "env(safe-area-inset-top, 0px)", transform: `translateX(${dragX}px)`, transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none" }} {...handlers}>
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 5, background: C.bg }}>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}><ChevronLeft size={22} /></button>
        <div style={{ fontSize: 17, fontWeight: 600 }}>{initial ? "Edit Song" : "Add Song"}</div>
        <div style={{ flex: 1 }} />
        <button onClick={handlePasteFromClipboard} title="Paste song from clipboard" style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}><ClipboardPaste size={20} /></button>
      </div>

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18, paddingBottom: 60, maxWidth: 800, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
        <Field label="TITLE"><ClearableInput autoFocus={!initial} value={title} onChangeText={(v) => { setTitle(v); setError(""); }} placeholder="Song title" style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box", paddingRight: title ? 36 : 14 }} /></Field>
        <Field label="ARTIST"><ClearableInput value={artist} onChangeText={(v) => { setArtist(v); setError(""); }} placeholder="Artist" style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box", paddingRight: artist ? 36 : 14 }} /></Field>

        <div style={{ display: "flex", gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}><Field label="TIME SIGNATURE"><TimeSigPicker value={timeSig} onChange={handleTimeSigChange} fullWidth C={C} /></Field></div>
          <div style={{ flex: 1, minWidth: 0 }}><Field label="TEMPO">
            <input type="number" inputMode="numeric" value={tempo} onChange={(e) => setTempo(e.target.value)} className="bpm-number-input" placeholder="—"
              style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontFamily: FONT, boxSizing: "border-box", fontSize: 18, fontVariantNumeric: "tabular-nums", textAlign: "center", height: 44, padding: "0 14px" }} />
          </Field></div>
        </div>

        <div style={{ display: "flex", gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}><Field label="KEY">
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}><NaturalDropdown value={keyNatural} onChange={handleNaturalChange} C={C} /></div>
              <div style={{ flex: 1, minWidth: 0 }}><AccidentalButton variant="flat" natural={keyNatural} value={keyAccidental} onChange={setKeyAccidental} C={C} /></div>
              <div style={{ flex: 1, minWidth: 0 }}><AccidentalButton variant="sharp" natural={keyNatural} value={keyAccidental} onChange={setKeyAccidental} C={C} /></div>
            </div>
          </Field></div>
          <div style={{ flex: 1, minWidth: 0 }}><Field label="SCALE"><TabSelect options={[{ id: "Major", label: "Major" }, { id: "Minor", label: "Minor" }]} value={keyQuality} onChange={setKeyQuality} C={C} /></Field></div>
        </div>

        <Field label="LANGUAGE"><TabSelect options={LANGUAGES} value={language} onChange={setLanguage} C={C} /></Field>

        <Field label="DESCRIPTION">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={"Benny's key: D | Sherly's key: G\nStyle: Rock Shuffle"}
            style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box", height: "auto", padding: "12px 14px", minHeight: 62, resize: "vertical" }} />
        </Field>

        <Field label="SECTIONS">
          <div style={{ display: "flex", gap: 6, marginBottom: 12, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 4 }}>
            {SECTION_TABS.map((t) => {
              const active = sectionTab === t.id;
              return (
                <button key={t.id} onClick={() => setSectionTab(t.id)} style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: "none", fontFamily: FONT, fontSize: 13.5, fontWeight: 700, background: active ? C.accentSoft : "transparent", color: active ? C.accent : C.textMuted }}>
                  {t.label}
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {sections.map((sec) => (
              <div key={sec.id} style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <input value={sec.label} onChange={(e) => updateSection(sec.id, "label", e.target.value)} placeholder="Verse, Chorus, Bridge&hellip;"
                    style={{ width: "100%", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box" }} />
                  <button onClick={() => removeSection(sec.id)} style={{ width: 32, height: 32, borderRadius: 8, background: "none", border: "none", color: C.danger, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <X size={16} color={C.danger} />
                  </button>
                </div>

                {sectionTab === "lyrics" ? (
                  <AutoGrowTextarea value={sec.lyrics} onChange={(e) => updateSectionLyrics(sec.id, e.target.value)}
                    placeholder={"Type the lyrics for this section&hellip;"}
                    style={{ width: "100%", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontFamily: MONO, fontSize: 15, fontWeight: lyricsBold ? 700 : 400, lineHeight: 1.75, textAlign, boxSizing: "border-box", padding: "12px 14px", minHeight: 90, whiteSpace: "pre-wrap", wordBreak: "keep-all", overflowWrap: "normal", hyphens: "none" }} />
                ) : (
                  <div style={{ width: "100%", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 10, boxSizing: "border-box", padding: "12px 14px", minHeight: 90, overflowX: "hidden" }}>
                    <SectionChordEditor
                      content={sec.content}
                      tagType={sectionTab}
                      onChangeContent={(next) => updateSectionContent(sec.id, next)}
                      C={C}
                      accent={C.accent}
                      fontSize={15}
                      tagFontSize={13}
                      lyricsBold={lyricsBold}
                      notesBold={notesBold}
                      textAlign={textAlign}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
          <button onClick={addSection} style={{ width: "100%", marginTop: 10, padding: "12px 0", borderRadius: 10, border: `1px dashed ${C.borderStrong}`, background: "transparent", color: C.textMuted, fontFamily: FONT, fontSize: 14, fontWeight: 600 }}>
            + Add section
          </button>
        </Field>

        {error && <div style={{ color: C.danger, fontSize: 13, textAlign: "center", fontWeight: 500 }}>{error}</div>}

        {confirmDelete ? (
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button onClick={() => setConfirmDelete(false)} style={{ flex: 1, fontFamily: FONT, fontWeight: 600, fontSize: 14, padding: "14px 0", borderRadius: 12, border: `1px solid ${C.borderStrong}`, background: "transparent", color: C.textMuted }}>Cancel</button>
            <button onClick={() => onDelete(initial.id)} style={{ flex: 2, fontFamily: FONT, fontWeight: 700, fontSize: 14, padding: "14px 0", borderRadius: 12, border: "none", background: C.danger, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><Trash2 size={16} color="#fff" />Confirm Delete</button>
          </div>
        ) : initial ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
            <button disabled={!canSave} onClick={handleSave} style={{ fontFamily: FONT, fontWeight: 700, fontSize: 15, padding: "16px 0", borderRadius: 14, border: "none", background: canSave ? C.accent : C.surface2, color: canSave ? "#fff" : C.textFaint, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <Check size={17} color={canSave ? "#fff" : C.textFaint} />SAVE
            </button>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setConfirmDelete(true)} style={{ flex: 1, fontFamily: FONT, fontWeight: 600, fontSize: 13, padding: "14px 0", borderRadius: 12, border: `1px solid ${C.border}`, background: "transparent", color: C.danger, display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
                <Trash2 size={15} color={C.danger} />Delete
              </button>
              <button onClick={() => onDuplicate(initial)} style={{ flex: 1, fontFamily: FONT, fontWeight: 600, fontSize: 13, padding: "14px 0", borderRadius: 12, border: `1px solid ${C.border}`, background: "transparent", color: C.text, display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
                <Copy size={15} color={C.text} />Duplicate
              </button>
            </div>
          </div>
        ) : (
          <button disabled={!canSave} onClick={handleSave} style={{ marginTop: 8, fontFamily: FONT, fontWeight: 700, fontSize: 15, padding: "16px 0", borderRadius: 14, border: "none", background: canSave ? C.accent : C.surface2, color: canSave ? "#fff" : C.textFaint, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <Check size={17} color={canSave ? "#fff" : C.textFaint} />SAVE
          </button>
        )}
      </div>
    </div>
  );
}

/* =========================================================================
   Songs list (no time signature shown per spec #6)
   ========================================================================= */
function PositionedActionMenu({ x, y, onEdit, onShare, onDelete, onClose, deleteConfirmMessage = "Delete this song?", C }) {
  const MENU_WIDTH = 170;
  const clampedX = Math.min(Math.max(x, MENU_WIDTH / 2 + 8), window.innerWidth - MENU_WIDTH / 2 - 8);
  const openUpward = y > window.innerHeight - 160;
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 210 }} />
      <div style={{
        position: "fixed", left: clampedX, top: openUpward ? y - 10 : y + 10,
        transform: openUpward ? "translate(-50%, -100%)" : "translate(-50%, 0)",
        zIndex: 220, width: "max-content", minWidth: MENU_WIDTH,
        background: C.surface3, border: `1px solid ${C.borderStrong}`, borderRadius: 12, overflow: "hidden",
        boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
      }}>
        <MenuItem icon={Pencil} label="Edit" onClick={() => { onClose(); onEdit(); }} C={C} />
        <MenuItem icon={IosShareIcon} label="Share" onClick={() => { onClose(); onShare(); }} C={C} />
        <MenuItem icon={Trash2} label="Delete" danger onClick={() => { onClose(); if (window.confirm(deleteConfirmMessage)) onDelete(); }} C={C} />
      </div>
    </>
  );
}
function SongRow({ song, onOpen, onEdit, onShare, onDelete, mode, C }) {
  const longPressTimerRef = useRef(null);
  const firedLongPressRef = useRef(false);
  const [menuPos, setMenuPos] = useState(null); // { x, y } | null
  const startPress = (e) => {
    firedLongPressRef.current = false;
    const point = e.touches ? e.touches[0] : e;
    const x = point.clientX, y = point.clientY;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => { firedLongPressRef.current = true; setMenuPos({ x, y }); if (navigator.vibrate) navigator.vibrate(15); }, 500);
  };
  const cancelPress = () => { if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; } };
  const handleClick = () => { if (firedLongPressRef.current) { firedLongPressRef.current = false; return; } onOpen(song); };
  const badgeText = mode === "drums" ? (song.tempo !== "" && song.tempo != null ? `${song.tempo}` : "—") : keyLabel(song);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", position: "relative" }}
      onClick={handleClick} onTouchStart={startPress} onTouchMove={cancelPress} onTouchEnd={cancelPress} onTouchCancel={cancelPress}
      onMouseDown={startPress} onMouseUp={cancelPress} onMouseLeave={cancelPress}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.artist || "Unknown"}</div>
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color: C.accent, border: `1px solid ${C.accentDim}`, borderRadius: 6, padding: "3px 7px", flexShrink: 0 }}>{badgeText}</span>
      {menuPos && (
        <PositionedActionMenu
          x={menuPos.x} y={menuPos.y}
          onEdit={() => onEdit(song)}
          onShare={() => onShare(song)}
          onDelete={() => onDelete(song.id)}
          onClose={() => setMenuPos(null)}
          C={C}
        />
      )}
    </div>
  );
}
function SongsScreen({ songs, onOpen, onAdd, onEdit, onShare, onDelete, mode, C }) {
  const [query, setQuery] = useState("");
  const [langFilter, setLangFilter] = useState("All");
  const filtered = songs
    .filter((s) => (s.title + " " + s.artist).toLowerCase().includes(query.toLowerCase()))
    .filter((s) => langFilter === "All" || s.language === langFilter)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 auto", padding: "22px 20px 14px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div><div style={{ fontSize: 26, fontWeight: 700 }}>Songs</div><div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{songs.length} songs</div></div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setLangFilter(f => f === "All" ? "English" : f === "English" ? "Tamil" : "All")} style={{ height: 34, padding: "0 14px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontFamily: FONT, fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
              {langFilter === "All" ? "All" : (LANGUAGES.find(l => l.id === langFilter)?.label || langFilter)}
            </button>
            <button onClick={onAdd} style={{ width: 34, height: 34, borderRadius: "50%", border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Plus size={17} color={C.accent} /></button>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <ClearableInput value={query} onChangeText={setQuery} placeholder="Search title or artist"
            leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
            style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box", paddingLeft: 36, paddingRight: query ? 36 : 14 }} />
        </div>
      </div>
      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", padding: "0 20px 14px", boxSizing: "border-box" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>{songs.length === 0 ? "No songs yet." : "No matches."}</div>
        ) : filtered.map((s) => <SongRow key={s.id} song={s} onOpen={onOpen} onEdit={onEdit} onShare={onShare} onDelete={onDelete} mode={mode} C={C} />)}
      </div>
    </div>
  );
}

function SongPickerScreen({ songs, selectedIds, onToggle, onClose, setlistName, onRenameSetlist, C }) {
  const [query, setQuery] = useState("");
  const [nameDraft, setNameDraft] = useState(setlistName ?? "");
  const filtered = songs.filter((s) => (s.title + " " + s.artist).toLowerCase().includes(query.toLowerCase()));
  const commitName = () => { const trimmed = nameDraft.trim(); if (trimmed && onRenameSetlist) onRenameSetlist(trimmed); else setNameDraft(setlistName ?? ""); };
  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 150, display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top, 0px)", boxSizing: "border-box" }}>
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onClose} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}><ChevronLeft size={22} /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <input className="no-ring" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onBlur={commitName} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            style={{ width: "100%", boxSizing: "border-box", fontFamily: FONT, fontSize: 17, fontWeight: 600, background: "transparent", border: "none", color: C.text, padding: 0, outline: "none" }} />
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", fontFamily: FONT, fontSize: 15.5, fontWeight: 700, color: C.accent, padding: "6px 4px" }}>Done</button>
      </div>
      <div style={{ padding: "14px 20px 6px" }}>
        <ClearableInput autoFocus value={query} onChangeText={setQuery} placeholder="Search title or artist"
          leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
          style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box", paddingLeft: 36, paddingRight: query ? 36 : 14 }} />
      </div>
      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", padding: "6px 20px 40px" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>{songs.length === 0 ? "No songs in your library yet." : "No matches."}</div>
        ) : filtered.map((s) => {
          const checked = selectedIds.includes(s.id);
          return (
            <div key={s.id} onClick={() => onToggle(s.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
              <div style={{ width: 21, height: 21, borderRadius: "50%", border: `1.5px solid ${checked ? C.accent : C.borderStrong}`, background: checked ? C.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {checked && <Check size={14} color="#fff" />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 15.5, fontWeight: 600 }}>{s.title}</div><div style={{ fontSize: 12.5, color: C.textMuted }}>{s.artist || "Unknown"}</div></div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.accent }}>{keyLabel(s)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SongExportPicker({ songs, onClose, onExport, C }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const filtered = songs.filter((s) => (s.title + " " + s.artist).toLowerCase().includes(query.toLowerCase()));
  const allSelected = filtered.length > 0 && filtered.every((s) => selected.has(s.id));
  const toggle = (id) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const toggleAll = () => setSelected((prev) => { const next = new Set(prev); if (allSelected) filtered.forEach((s) => next.delete(s.id)); else filtered.forEach((s) => next.add(s.id)); return next; });
  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 150, display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top, 0px)", boxSizing: "border-box" }}>
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onClose} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}><ChevronLeft size={22} /></button>
        <div style={{ flex: 1, fontSize: 17, fontWeight: 600 }}>Send Songs</div>
        <button onClick={toggleAll} style={{ background: "none", border: "none", fontFamily: FONT, fontSize: 14, fontWeight: 700, color: C.accent }}>{allSelected ? "None" : "All"}</button>
      </div>
      <div style={{ padding: "14px 20px 6px" }}>
        <ClearableInput autoFocus value={query} onChangeText={setQuery} placeholder="Search title or artist"
          leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
          style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box", paddingLeft: 36, paddingRight: query ? 36 : 14 }} />
      </div>
      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", padding: "6px 20px 40px" }}>
        {filtered.map((s) => {
          const checked = selected.has(s.id);
          return (
            <div key={s.id} onClick={() => toggle(s.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
              <div style={{ width: 21, height: 21, borderRadius: "50%", border: `1.5px solid ${checked ? C.accent : C.borderStrong}`, background: checked ? C.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {checked && <Check size={14} color="#fff" />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 15.5, fontWeight: 600 }}>{s.title}</div><div style={{ fontSize: 12.5, color: C.textMuted }}>{s.artist || "Unknown"}</div></div>
            </div>
          );
        })}
      </div>
      <div style={{ padding: 20 }}>
        <button disabled={selected.size === 0} onClick={() => onExport([...selected])} style={{ width: "100%", fontFamily: FONT, fontWeight: 700, fontSize: 15, padding: "14px 0", borderRadius: 12, border: "none", background: selected.size ? C.accent : C.surface3, color: selected.size ? "#fff" : C.textFaint }}>
          Send {selected.size || ""}
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   Song detail / chart viewer.
   ========================================================================= */
function SongDetailScreen({ song, contextKey, onKeyChange, onBack, onEdit, onDelete, onShare, fontSize, textAlign, lyricsBold, notesBold, lineSpacing, chordFontSize, isInSetlist, onRemoveFromSetlist, onPrevSong, onNextSong, mode, engine, C }) {
  const [viewKey, setViewKey] = useState(contextKey ?? song.key);
  const [descOpen, setDescOpen] = useState(false);
  const [showLyrics, setShowLyrics] = useState(true);
  const [nashvilleMode, setNashvilleMode] = useState(true);

  const showBottomBar = mode === "drums" && !!engine;

  useEffect(() => { setViewKey(contextKey ?? song.key); }, [song.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (showBottomBar) engine.loadSong(song); }, [song.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const cycleSubdivision = () => engine && engine.setSubdivision((engine.subdivision % 3) + 1);
  const decBpmHold = useHoldRepeat(() => engine && engine.setBpm(engine.bpm - 1, true));
  const incBpmHold = useHoldRepeat(() => engine && engine.setBpm(engine.bpm + 1, true));

  const edgeBack = useEdgeSwipeBack(onBack);
  const setlistSwipe = useSetlistSongSwipe(onPrevSong, onNextSong);
  const { dragX, leaving, handlers } = isInSetlist ? { dragX: setlistSwipe.dragX, leaving: false, handlers: setlistSwipe.handlers } : edgeBack;

  const stepKey = (delta) => { const next = transposeKey(viewKey, delta); setViewKey(next); if (onKeyChange) onKeyChange(next); };
  const semitoneDelta = ((KEY_TO_SEMITONE[viewKey] ?? 0) - (KEY_TO_SEMITONE[song.key] ?? 0) + 1200) % 12;
  const wrappedDelta = semitoneDelta > 6 ? semitoneDelta - 12 : semitoneDelta;
  const useFlats = FLAT_KEYS.has(viewKey);

  const labelFontSize = Math.max(10, Math.min(18, Math.round(fontSize * 0.5)));
  const badgeStyle = { fontSize: 12.5, color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 10px", fontWeight: 600, whiteSpace: "nowrap" };
  const chevronBtn = { width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", color: C.text, flexShrink: 0 };
  const keyButtonStyle = { minWidth: 56, height: 30, padding: "0 10px", borderRadius: 8, fontFamily: FONT, fontWeight: 800, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: `1px solid ${C.border}`, background: C.surface2, color: C.text };
  const lyricsToggleStyle = (on) => ({ height: 30, padding: "0 12px", borderRadius: 8, fontFamily: FONT, fontWeight: 700, fontSize: 12.5, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: `1px solid ${on ? C.accentDim : C.border}`, background: on ? C.accentSoft : C.surface2, color: on ? C.accent : C.textMuted });

  const isVocals = mode === "vocals";
  const sectionField = mode === "drums" ? "drums" : mode === "chords" ? "chords" : "lyrics";

  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 100, display: "flex", flexDirection: "column", overflow: "hidden", paddingTop: "env(safe-area-inset-top, 0px)", boxSizing: "border-box", transform: `translateX(${dragX}px)`, transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none", touchAction: "pan-y" }} {...handlers}>
      <div style={{ flex: "0 0 auto", padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}`, position: "relative", zIndex: 2, background: C.bg }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}><ChevronLeft size={22} /></button>
        <div style={{ flex: 1, minWidth: 0, textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</div>
          {song.artist && <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.artist}</div>}
        </div>
        {song.description ? (
          <button onClick={() => setDescOpen((o) => !o)} style={chevronBtn}>
            <ChevronDown size={16} style={{ transform: descOpen ? "rotate(180deg)" : "none", transition: "transform 150ms ease" }} />
          </button>
        ) : (
          <div style={{ width: 30, height: 30, flexShrink: 0 }} />
        )}
      </div>

      {mode === "chords" && (
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 6, padding: "10px 14px", borderBottom: `1px solid ${C.border}`, flexWrap: "nowrap", overflow: "hidden" }}>
          <button onClick={() => setShowLyrics((s) => !s)} style={lyricsToggleStyle(showLyrics)}>Lyrics</button>
          {song.timeSignature && <span style={badgeStyle}>{song.timeSignature}</span>}
          {song.tempo !== "" && song.tempo != null && <span style={badgeStyle}>{song.tempo} BPM</span>}
          <div style={{ flex: 1 }} />
          <button onClick={() => stepKey(-1)} disabled={nashvilleMode} style={{ ...chevronBtn, cursor: nashvilleMode ? "default" : "pointer" }}><ChevronLeft size={16} /></button>
          <button onClick={() => setNashvilleMode(!nashvilleMode)} style={{ ...keyButtonStyle, border: `1px solid ${!nashvilleMode ? C.accentDim : C.border}`, background: !nashvilleMode ? C.accentSoft : C.surface2, color: !nashvilleMode ? C.accent : C.text }}>
            {flatify(`${viewKey}${song.keyQuality === "Minor" ? "m" : ""}`)}
          </button>
          <button onClick={() => stepKey(1)} disabled={nashvilleMode} style={{ ...chevronBtn, cursor: nashvilleMode ? "default" : "pointer" }}><ChevronRight size={16} /></button>
        </div>
      )}

      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "16px 20px 40px" }}>
        {descOpen && song.description && (
          <div style={{ marginBottom: 18, padding: "11px 13px", background: C.surface2, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.accent}`, borderRadius: 8, fontSize: 13.5, color: C.textMuted, whiteSpace: "pre-wrap" }}>
            {song.description}
          </div>
        )}
        {song.sections.map((sec, idx) => {
          const raw = sec[sectionField] || (sectionField !== "lyrics" ? sec.lyrics : "");
          let displayText = raw;
          if (mode === "chords") {
            if (nashvilleMode) displayText = nashvillizeTaggedText(raw, song.key);
            else if (wrappedDelta !== 0) displayText = transposeTaggedText(raw, wrappedDelta, useFlats);
          }
          return (
            <div key={sec.id} style={{ marginBottom: 20, paddingTop: idx > 0 ? 16 : 0, borderTop: idx > 0 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ fontSize: labelFontSize, letterSpacing: 1.5, textTransform: "uppercase", color: C.accent, marginBottom: 8, textAlign }}>{sec.label || "Section"}</div>
              {isVocals ? (
                <ChordText text={sec.lyrics} editable={false} showLyrics showTags={false} textAlign={textAlign} fontSize={fontSize} lineHeightMult={lineSpacing} accent={C.accent} lyricsBold={lyricsBold} C={C} emptyHint="\u2014" />
              ) : (
                <ChordText text={displayText} editable={false} dim showLyrics={showLyrics} brightTags textAlign={textAlign} fontSize={fontSize} tagFontSize={chordFontSize} lineHeightMult={lineSpacing} accent={C.accent} lyricsBold={lyricsBold} notesBold={notesBold} flattenTags={mode === "chords"} C={C} />
              )}
            </div>
          );
        })}
      </div>

      {showBottomBar && (
        <div style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", gap: 8, padding: "10px 16px max(20px, calc(10px + env(safe-area-inset-bottom, 0px)))", background: "#0B0B0C", borderTop: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <BeatAccentControl count={(engine.timeSig.beats === 6 && engine.timeSig.unit === 8) ? 4 : engine.timeSig.beats} flashBeat={engine.flashBeat} accents={engine.accents} onChange={engine.setAccents} openUpwardOnly size={7} C={C} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, justifySelf: "start" }}>
              <TimeSigPicker value={engine.timeSig} onChange={engine.setTimeSig} height={40} C={C} />
              <button onClick={cycleSubdivision} style={{ width: 40, height: 40, borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <SubdivisionIcon value={engine.subdivision} size={16} color={C.text} />
              </button>
            </div>
            <button onClick={engine.toggle} style={{ width: 56, height: 44, borderRadius: 12, border: "none", background: "#1F1F1F", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, justifySelf: "center" }}>
              {engine.playing ? <Square size={20} color={C.accent} fill={C.accent} /> : <Play size={20} color={C.accent} fill={C.accent} style={{ marginLeft: 2 }} />}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 8, justifySelf: "end" }}>
              <button {...decBpmHold} style={{ width: 36, height: 36, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, background: C.surface2, color: C.text, fontSize: 18, fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
              <div style={{ fontSize: 17, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: C.text, minWidth: 32, textAlign: "center" }}>{Math.round(engine.bpm)}</div>
              <button {...incBpmHold} style={{ width: 36, height: 36, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, background: C.surface2, color: C.text, fontSize: 18, fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* =========================================================================
   Setlist song row
   ========================================================================= */
function SetlistSongRow({ song, keyOverride, style, handlers, onClick, mode, C }) {
  const badgeText = mode === "drums"
    ? (song.tempo !== "" && song.tempo != null ? `${song.tempo}` : "—")
    : flatify(`${keyOverride || song.key}${song.keyQuality === "Minor" ? "m" : ""}`);
  return (
    <div onClick={onClick} {...handlers} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 28px 12px 20px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", position: "relative", touchAction: "pan-y", ...style }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</div>
        <div style={{ fontSize: 12, color: C.textMuted }}>{song.artist || "Unknown"}</div>
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.accent }}>{badgeText}</div>
    </div>
  );
}

/* =========================================================================
   Setlist stage — merges Click's Stage (bottom metronome bar, only shown
   in Drums mode per spec #11) with Chords' setlist stage (reorder, swipe
   to delete, song picker).
   ========================================================================= */
function SetlistStageScreen({ setlist, songs, onBack, onUpdateSetlist, onOpenSong, onShare, onDeleteSetlist, initialPickerOpen, mode, C }) {
  const [pickerOpen, setPickerOpen] = useState(!!initialPickerOpen);
  const [openSwipeId, setOpenSwipeId] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const nameLongPressTimerRef = useRef(null);
  const { dragX, leaving, handlers } = useEdgeSwipeBack(onBack);

  const [activeDragIndex, setActiveDragIndex] = useState(null);
  const [dragY, setDragY] = useState(0);
  const dragTimerRef = useRef(null);
  const startYRef = useRef(0);
  const justDraggedRef = useRef(false);

  const commitName = () => { const trimmed = nameDraft.trim(); if (trimmed) onUpdateSetlist({ ...setlist, name: trimmed }); setEditingName(false); };
  const startNameLongPress = () => { if (nameLongPressTimerRef.current) clearTimeout(nameLongPressTimerRef.current); nameLongPressTimerRef.current = setTimeout(() => { setNameDraft(setlist.name); setEditingName(true); }, 500); };
  const cancelNameLongPress = () => { if (nameLongPressTimerRef.current) { clearTimeout(nameLongPressTimerRef.current); nameLongPressTimerRef.current = null; } };

  const setlistSongs = setlist.entries.map((e) => {
    const song = songs.find((s) => s.id === e.songId);
    return song ? { song, keyOverride: e.keyOverride } : null;
  }).filter(Boolean);

  const removeFromStage = (songId) => onUpdateSetlist({ ...setlist, entries: setlist.entries.filter((e) => e.songId !== songId) });
  const toggleSong = (songId) => {
    const has = setlist.entries.some((e) => e.songId === songId);
    onUpdateSetlist({ ...setlist, entries: has ? setlist.entries.filter((e) => e.songId !== songId) : [...setlist.entries, { songId, keyOverride: null }] });
  };

  const handleSongTouchStart = (idx, e) => {
    if (e.touches.length !== 1) return;
    startYRef.current = e.touches[0].clientY;
    if (dragTimerRef.current) clearTimeout(dragTimerRef.current);
    dragTimerRef.current = setTimeout(() => { setActiveDragIndex(idx); setDragY(0); if (navigator.vibrate) navigator.vibrate(15); }, 400);
  };
  const handleSongTouchMove = (idx, e) => {
    if (e.touches.length !== 1) return;
    const clientY = e.touches[0].clientY;
    if (activeDragIndex === null) { if (Math.abs(clientY - startYRef.current) > 10) clearTimeout(dragTimerRef.current); }
    else {
      e.preventDefault(); e.stopPropagation();
      const deltaY = clientY - startYRef.current;
      setDragY(deltaY);
      const rowHeight = 60; const total = setlistSongs.length;
      if (deltaY > rowHeight / 2 && idx < total - 1) {
        const next = [...setlist.entries];[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
        onUpdateSetlist({ ...setlist, entries: next });
        startYRef.current += rowHeight; setActiveDragIndex(idx + 1); setDragY(clientY - startYRef.current);
      } else if (deltaY < -rowHeight / 2 && idx > 0) {
        const next = [...setlist.entries];[next[idx], next[idx - 1]] = [next[idx - 1], next[idx]];
        onUpdateSetlist({ ...setlist, entries: next });
        startYRef.current -= rowHeight; setActiveDragIndex(idx - 1); setDragY(clientY - startYRef.current);
      }
    }
  };
  const handleSongTouchEnd = () => { if (dragTimerRef.current) clearTimeout(dragTimerRef.current); if (activeDragIndex !== null) justDraggedRef.current = true; setActiveDragIndex(null); setDragY(0); };

  const bottomInset = "calc(55px + max(36px, 8px + env(safe-area-inset-bottom, 0px)))";

  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: bottomInset, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 80, display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top, 0px)", boxSizing: "border-box", transform: `translateX(${dragX}px)`, transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none" }} {...handlers}>
      <div style={{ padding: "16px 16px 12px", display: "flex", alignItems: "center", gap: 6 }}>
        <button onClick={onBack} style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", color: C.textMuted, flexShrink: 0 }}><ChevronLeft size={22} /></button>
        {editingName ? (
          <input className="no-ring" autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onBlur={commitName} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            style={{ flex: 1, fontFamily: FONT, fontSize: 16, fontWeight: 700, background: "transparent", border: "none", color: C.text, textAlign: "center", padding: "6px 10px", textTransform: "uppercase", letterSpacing: 0.5, outline: "none" }} />
        ) : (
          <button onTouchStart={startNameLongPress} onTouchMove={cancelNameLongPress} onTouchEnd={cancelNameLongPress} onTouchCancel={cancelNameLongPress}
            onMouseDown={startNameLongPress} onMouseUp={cancelNameLongPress} onMouseLeave={cancelNameLongPress}
            style={{ flex: 1, textAlign: "center", fontSize: 16, fontWeight: 700, padding: "0 4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: 0.5, background: "none", border: "none", color: C.text }}>
            {setlist.name}
          </button>
        )}
        <KebabMenu onEdit={() => setPickerOpen(true)} onShare={onShare} onDelete={() => { onDeleteSetlist(setlist.id); onBack(); }} deleteConfirmMessage="Delete this setlist?" C={C} />
      </div>

      <div className="scroll-list" style={{ flex: 1, overflowY: activeDragIndex !== null ? "hidden" : "auto", padding: "8px 0 12px", touchAction: activeDragIndex !== null ? "none" : "pan-y" }}>
        {setlistSongs.length === 0 ? (
          <div style={{ textAlign: "center", padding: "36px 20px", color: C.textFaint, fontSize: 13 }}>No songs added yet.</div>
        ) : setlistSongs.map(({ song: s, keyOverride }, idx) => {
          const isDraggingThis = activeDragIndex === idx;
          return (
            <SwipeToDelete key={s.id} id={s.id} openId={openSwipeId} onOpenIdChange={setOpenSwipeId} onDelete={() => removeFromStage(s.id)} icon={X} C={C}>
              <SetlistSongRow
                song={s} keyOverride={keyOverride} mode={mode} C={C}
                onClick={() => {
                  if (justDraggedRef.current) { justDraggedRef.current = false; return; }
                  if (activeDragIndex === null) onOpenSong(s);
                }}
                handlers={{
                  onTouchStart: (e) => handleSongTouchStart(idx, e),
                  onTouchMove: (e) => handleSongTouchMove(idx, e),
                  onTouchEnd: handleSongTouchEnd,
                  onTouchCancel: handleSongTouchEnd,
                }}
                style={{
                  transform: isDraggingThis ? `translateY(${dragY}px)` : "none", zIndex: isDraggingThis ? 100 : 1,
                  background: isDraggingThis ? C.surface3 : C.bg, boxShadow: isDraggingThis ? "0 8px 24px rgba(0,0,0,0.6)" : "none",
                  transition: isDraggingThis ? "none" : "transform 0.15s ease, background 0.15s ease",
                }}
              />
            </SwipeToDelete>
          );
        })}
      </div>

      {pickerOpen && (
        <SongPickerScreen songs={songs} selectedIds={setlist.entries.map((e) => e.songId)} onToggle={toggleSong} onClose={() => setPickerOpen(false)} setlistName={setlist.name} onRenameSetlist={(name) => onUpdateSetlist({ ...setlist, name })} C={C} />
      )}
    </div>
  );
}

function SetlistsScreen({ setlists, onOpenStage, onCreate, onDelete, C }) {
  const [query, setQuery] = useState("");
  const [openSwipeId, setOpenSwipeId] = useState(null);
  const filtered = setlists.filter((sl) => sl.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 auto", padding: "22px 20px 14px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div><div style={{ fontSize: 26, fontWeight: 700 }}>Setlists</div><div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{setlists.length} setlists</div></div>
          <button onClick={onCreate} style={{ width: 34, height: 34, borderRadius: "50%", border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Plus size={17} color={C.accent} /></button>
        </div>
        <div style={{ marginTop: 16 }}>
          <ClearableInput value={query} onChangeText={setQuery} placeholder="Search setlists"
            leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
            style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box", paddingLeft: 36, paddingRight: query ? 36 : 14 }} />
        </div>
      </div>
      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", padding: "0 20px 14px", boxSizing: "border-box" }}>
        {filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>{setlists.length === 0 ? "No setlists yet." : "No matches."}</div>
        )}
        {[...filtered].reverse().map((sl) => (
          <SwipeToDelete key={sl.id} id={sl.id} openId={openSwipeId} onOpenIdChange={setOpenSwipeId} onDelete={() => onDelete(sl.id)} C={C}>
            <div onClick={() => onOpenStage(sl.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 16, fontWeight: 600 }}>{sl.name}</div><div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>{sl.entries.length} song{sl.entries.length === 1 ? "" : "s"}</div></div>
            </div>
          </SwipeToDelete>
        ))}
      </div>
    </div>
  );
}

function SettingsScreen({ mode, setMode, fontSize, setFontSize, chordFontSize, setChordFontSize, textAlign, setTextAlign, lyricsBold, setLyricsBold, notesBold, setNotesBold, lineSpacing, setLineSpacing, clickSettings, setClickSettings, onImportFile, onExportOpen, onConfigureSync, syncStatus, C }) {
  const fileRef = useRef(null);
  const [toneIndex, setToneIndex] = useState(() => Math.max(0, CLICK_TONES.findIndex((t) => t.id === clickSettings.clickTone)));
  const alignOptions = [{ id: "left", Icon: AlignLeft }, { id: "center", Icon: AlignCenter }, { id: "right", Icon: AlignRight }];
  const labelFontSize = Math.max(10, Math.min(18, Math.round(fontSize * 0.5)));
  const rowBtnStyle = { display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "14px 16px", borderRadius: 12, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontFamily: FONT, fontSize: 15, fontWeight: 600 };

  const cycleTone = (dir) => {
    const next = (toneIndex + dir + CLICK_TONES.length) % CLICK_TONES.length;
    setToneIndex(next);
    setClickSettings({ ...clickSettings, clickTone: CLICK_TONES[next].id });
  };
  const decLyricsSizeHold = useHoldRepeat(() => setFontSize((f) => Math.max(14, f - 1)));
  const incLyricsSizeHold = useHoldRepeat(() => setFontSize((f) => Math.min(80, f + 1)));
  const decNotesSizeHold = useHoldRepeat(() => setChordFontSize((f) => Math.max(8, f - 1)));
  const incNotesSizeHold = useHoldRepeat(() => setChordFontSize((f) => Math.min(80, f + 1)));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 auto", padding: "22px 20px 14px", boxSizing: "border-box" }}>
        <div style={{ fontSize: 26, fontWeight: 700, width: "100%", margin: "0 auto" }}>Settings</div>
      </div>
      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", padding: "0 20px 40px", boxSizing: "border-box" }}>
        <div style={{ width: "100%", margin: "0 auto", display: "flex", flexDirection: "column" }}>

          <SectionLabel>MODE</SectionLabel>
          <div style={{ display: "flex", gap: 8, marginBottom: 26, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 4 }}>
            {MODES.map((m) => {
              const active = mode === m;
              const meta = MODE_META[m];
              return (
                <button key={m} onClick={() => setMode(m)} style={{ flex: 1, padding: "12px 0", borderRadius: 9, border: "none", fontFamily: FONT, fontSize: 14, fontWeight: 700, background: active ? meta.accentSoft : "transparent", color: active ? meta.accent : C.textMuted }}>
                  {meta.label}
                </button>
              );
            })}
          </div>

          <SectionLabel>DISPLAY</SectionLabel>
          <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 26, display: "flex", flexDirection: "column", gap: 18 }}>
            <Field label="LYRICS SIZE">
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1, height: 44, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 10, padding: "0 4px" }}>
                  <button {...decLyricsSizeHold} style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Minus size={16} color={C.text} /></button>
                  <div style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fontSize}px</div>
                  <button {...incLyricsSizeHold} style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Plus size={16} color={C.text} /></button>
                </div>
                <button onClick={() => setLyricsBold((b) => !b)} style={{ width: 44, height: 44, borderRadius: 10, flexShrink: 0, border: `1px solid ${lyricsBold ? C.accent : C.border}`, background: lyricsBold ? C.accentSoft : C.surface3, color: lyricsBold ? C.accent : C.text, fontFamily: FONT, fontSize: 16, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>B</button>
              </div>
            </Field>
            <Field label="NOTES SIZE">
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1, height: 44, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 10, padding: "0 4px" }}>
                  <button {...decNotesSizeHold} style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Minus size={16} color={C.text} /></button>
                  <div style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{chordFontSize}px</div>
                  <button {...incNotesSizeHold} style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Plus size={16} color={C.text} /></button>
                </div>
                <button onClick={() => setNotesBold((b) => !b)} style={{ width: 44, height: 44, borderRadius: 10, flexShrink: 0, border: `1px solid ${notesBold ? C.accent : C.border}`, background: notesBold ? C.accentSoft : C.surface3, color: notesBold ? C.accent : C.text, fontFamily: FONT, fontSize: 16, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>B</button>
              </div>
            </Field>
            <Field label="LINE SPACING">
              <div style={{ height: 44, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 10, padding: "0 4px" }}>
                <button onClick={() => setLineSpacing((f) => Math.max(1.1, Math.round((f - 0.15) * 100) / 100))} style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Minus size={16} color={C.text} /></button>
                <div style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{lineSpacing.toFixed(2)}</div>
                <button onClick={() => setLineSpacing((f) => Math.min(3, Math.round((f + 0.15) * 100) / 100))} style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Plus size={16} color={C.text} /></button>
              </div>
            </Field>
            <Field label="TEXT ALIGNMENT">
              <div style={{ display: "flex", gap: 8 }}>
                {alignOptions.map(({ id, Icon }) => {
                  const active = textAlign === id;
                  return (
                    <button key={id} onClick={() => setTextAlign(id)} style={{ flex: 1, height: 44, borderRadius: 10, border: `1px solid ${active ? C.accent : C.border}`, background: active ? C.accentSoft : C.surface3, color: active ? C.accent : C.text, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Icon size={16} />
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="PREVIEW">
              <div style={{ background: "#000000", border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, overflowX: "hidden" }}>
                <div style={{ fontSize: labelFontSize, letterSpacing: 1.5, textTransform: "uppercase", color: C.accent, marginBottom: 8, textAlign }}>Chorus</div>
                {mode === "vocals" ? (
                  <ChordText
                    text={"Way maker, miracle worker,\npromise keeper, light in the darkness"}
                    editable={false} showLyrics showTags={false}
                    textAlign={textAlign} fontSize={fontSize} lineHeightMult={lineSpacing}
                    accent={C.accent} lyricsBold={lyricsBold} C={C}
                  />
                ) : mode === "drums" ? (
                  <ChordText
                    text={"[Half-time]Way maker, miracle worker,\npromise keeper, [Double Kick]light in the darkness"}
                    editable={false} dim={true} showLyrics={true} brightTags={true}
                    textAlign={textAlign} fontSize={fontSize} tagFontSize={chordFontSize} lineHeightMult={lineSpacing}
                    accent={C.accent} lyricsBold={lyricsBold} notesBold={notesBold} C={C}
                  />
                ) : (
                  <ChordText
                    text={"[E]Way maker, [A]miracle worker,\n[C#m]promise keeper, [B]light in the [E]darkness"}
                    editable={false} dim={true} showLyrics={true} brightTags={true} flattenTags
                    textAlign={textAlign} fontSize={fontSize} tagFontSize={chordFontSize} lineHeightMult={lineSpacing}
                    accent={C.accent} lyricsBold={lyricsBold} notesBold={notesBold} C={C}
                  />
                )}
              </div>
            </Field>
          </div>

          {mode === "drums" ? (
            <>
              <SectionLabel>CLICK</SectionLabel>
              <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 26, display: "flex", flexDirection: "column", gap: 18 }}>
                <Field label="CLICK TONE">
                  <div style={{ height: 48, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 10, padding: "0 6px" }}>
                    <button onClick={() => cycleTone(-1)} style={{ background: "none", border: "none", padding: 10, display: "flex" }}><ChevronLeft size={20} color={C.text} /></button>
                    <div style={{ fontSize: 16, fontWeight: 600, textAlign: "center", flex: 1 }}>{CLICK_TONES[toneIndex]?.name}</div>
                    <button onClick={() => cycleTone(1)} style={{ background: "none", border: "none", padding: 10, display: "flex" }}><ChevronRight size={20} color={C.text} /></button>
                  </div>
                </Field>
                <Field label="AUDIO OUTPUT">
                  <div style={{ display: "flex", gap: 8 }}>
                    {PAN_OPTIONS.map((p) => {
                      const active = clickSettings.pan === p.id;
                      return (
                        <button key={p.id} onClick={() => setClickSettings({ ...clickSettings, pan: p.id })} style={{ flex: 1, height: 48, boxSizing: "border-box", borderRadius: 10, fontFamily: FONT, fontSize: 15, fontWeight: 700, border: `1px solid ${active ? C.accent : C.border}`, background: active ? C.accentSoft : C.surface3, color: active ? C.accent : C.text }}>
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                </Field>
              </div>
            </>
          ) : null}

          <SectionLabel>LIBRARY</SectionLabel>
          <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 26 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => fileRef.current?.click()} style={{ ...rowBtnStyle, flex: 1, justifyContent: "center" }}><Download size={16} color={C.accent} /> Import</button>
              <input ref={fileRef} type="file" accept="application/json" onChange={(e) => { if (e.target.files[0]) onImportFile(e.target.files[0]); e.target.value = ""; }} style={{ display: "none" }} />
              <button onClick={onExportOpen} style={{ ...rowBtnStyle, flex: 1, justifyContent: "center" }}><Upload size={16} color={C.accent} /> Export</button>
            </div>
          </div>

          <SectionLabel>BAND SYNC</SectionLabel>
          <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 26 }}>
            <button onClick={onConfigureSync} style={{ ...rowBtnStyle, justifyContent: "space-between" }}><span>Shared library</span><span style={{ color: C.accent, fontSize: 12 }}>{syncStatus}</span></button>
          </div>

          <div style={{ textAlign: "center", fontSize: 11.5, color: C.textFaint, paddingTop: 12 }}>Created by Benjamin Hanigraf</div>
        </div>
      </div>
    </div>
  );
}

function Toast({ message, C }) {
  if (!message) return null;
  return (
    <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", bottom: 100, background: C.surface3, border: `1px solid ${C.borderStrong}`, padding: "10px 18px", borderRadius: 999, fontSize: 13.5, fontWeight: 600, zIndex: 300, whiteSpace: "nowrap", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
      {message}
    </div>
  );
}

function BottomNav({ active, onChange, mode, C }) {
  const firstTab = mode === "drums" ? { id: "practice", label: "Metronome", icon: GaugeIcon } : { id: "practice", label: "Piano", icon: PianoIcon };
  const items = [firstTab, { id: "songs", label: "Songs", icon: ListMusic }, { id: "setlists", label: "Setlists", icon: Layers }, { id: "settings", label: "Settings", icon: SettingsIcon }];
  return (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 30 }}>
      <div style={{ display: "flex", background: "#000000", paddingTop: 18, paddingBottom: "max(36px, calc(8px + env(safe-area-inset-bottom, 0px)))" }}>
        {items.map(({ id, label, icon: Icon }) => {
          const isActive = active === id;
          return (
            <button key={id} onClick={() => onChange(id)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "0 0 6px", background: "none", border: "none", fontFamily: FONT, cursor: "pointer" }}>
              <Icon size={18} color={isActive ? C.accent : C.textMuted} strokeWidth={isActive ? 2.3 : 1.8} />
              <span style={{ fontSize: 8, color: isActive ? C.accent : C.textMuted, fontWeight: isActive ? 600 : 400 }}>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* =========================================================================
   Root
   ========================================================================= */
/* =========================================================================
   Error boundary — a JS error thrown during render (e.g. from an audio
   glitch after playing the metronome/piano) previously unmounted the whole
   React tree, which also removed the <style> tag that paints html/body,
   leaving a blank grey page behind. This catches render errors and shows
   a small recoverable fallback instead of going blank.
   ========================================================================= */
class AppErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error, info) { console.error("Altar crashed:", error, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          position: "fixed", inset: 0, background: "#000", color: "#fff",
          fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 16, padding: 24, textAlign: "center", boxSizing: "border-box",
        }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Something went wrong</div>
          <div style={{ fontSize: 13.5, color: "#98989D" }}>A playback glitch interrupted the app. Tap below to recover.</div>
          <button
            onClick={() => this.setState({ hasError: false })}
            style={{ padding: "12px 24px", borderRadius: 12, border: "none", background: "#0A84FF", color: "#fff", fontFamily: "inherit", fontSize: 15, fontWeight: 700 }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppInner() {
  const [songs, setSongs] = useIndexedDbState("songs", SEED_SONGS);
  const [setlists, setSetlists] = useIndexedDbState("setlists", SEED_SETLISTS);
  const [fontSize, setFontSize] = useLocalStorageState("altar:font-size", 22);
  const [chordFontSize, setChordFontSize] = useLocalStorageState("altar:chord-font-size", 16);
  const [textAlign, setTextAlign] = useLocalStorageState("altar:text-align", "left");
  const [lyricsBold, setLyricsBold] = useLocalStorageState("altar:lyrics-bold", false);
  const [notesBold, setNotesBold] = useLocalStorageState("altar:notes-bold", false);
  const [lineSpacing, setLineSpacing] = useLocalStorageState("altar:line-spacing", 1.75);
  const [mode, setMode] = useLocalStorageState("altar:mode", "vocals");
  const [clickSettings, setClickSettings] = useLocalStorageState("altar:click-settings", DEFAULT_CLICK_SETTINGS);
  const [bandKey, setBandKey] = useState(() => localStorage.getItem("zong:access-key") || "");
  const [syncStatus, setSyncStatus] = useState(() => bandKey ? "Ready" : "Not connected");
  const syncRevision = useRef(Number(localStorage.getItem("zong:revision") || 0));
  const syncDirty = useRef(false);
  const syncing = useRef(false);

  const C = colorsFor(mode);
  const engine = useMetronomeEngine(clickSettings);

  const [tab, setTab] = useState("practice");
  const [editingSong, setEditingSong] = useState(undefined);
  const [viewing, setViewing] = useState(null);
  const [stageIndex, setStageIndex] = useState(null);
  const [stageAutoOpenPicker, setStageAutoOpenPicker] = useState(false);
  const [exportPickerOpen, setExportPickerOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState("");

  const saveSongs = (next) => { syncDirty.current = true; setSongs(next); };
  const saveSetlists = (next) => { syncDirty.current = true; setSetlists(next); };

  const performSync = useCallback(async (force = false) => {
    if (!bandKey || !navigator.onLine || syncing.current) return;
    syncing.current = true; setSyncStatus("Syncing…");
    try {
      const result = await syncLibrary({ key: bandKey, state: { songs, setlists }, revision: syncRevision.current, changed: force || syncDirty.current });
      syncRevision.current = result.revision;
      localStorage.setItem("zong:revision", String(result.revision));
      if (result.conflict) {
        localStorage.setItem("zong:conflict-backup", JSON.stringify({ savedAt: new Date().toISOString(), remoteSongs: result.state?.songs, remoteSetlists: result.state?.setlists }));

        const mergedSongs = [...songs];
        (result.state?.songs || []).forEach(rs => {
          if (!mergedSongs.find(ls => ls.id === rs.id)) mergedSongs.push(rs);
        });

        const mergedSetlists = [...setlists];
        (result.state?.setlists || []).forEach(rs => {
          if (!mergedSetlists.find(ls => ls.id === rs.id)) mergedSetlists.push(rs);
        });

        setSongs(mergedSongs);
        setSetlists(mergedSetlists);
        syncDirty.current = true;
        setSyncStatus("Conflict merged");
        flash("Sync conflict: remote additions were merged with your local library.");

      } else if (result.pulled) {
        setSongs(result.state?.songs || []); setSetlists(result.state?.setlists || []); syncDirty.current = false; setSyncStatus("Up to date");
      } else { syncDirty.current = false; setSyncStatus("Up to date"); }
    } catch (error) { setSyncStatus(navigator.onLine ? error.message : "Offline"); }
    finally { syncing.current = false; }
  }, [bandKey, songs, setlists]);

  useEffect(() => {
    const online = () => performSync();
    window.addEventListener("online", online);
    const timer = window.setInterval(() => performSync(), 30000);
    return () => { window.removeEventListener("online", online); window.clearInterval(timer); };
  }, [performSync]);

  const configureSync = () => {
    const key = window.prompt("Enter your band’s shared sync code (leave blank to disconnect):", bandKey);
    if (key === null) return;
    const clean = key.trim(); localStorage.setItem("zong:access-key", clean); localStorage.removeItem("zong:revision"); syncRevision.current = 0; setBandKey(clean);
    if (!clean) { setSyncStatus("Not connected"); return; }
    syncDirty.current = true;
  };

  const rootRef = useRef(null);
  const isLandscapeScreen = useIsLandscapeScreen();

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
  useEffect(() => {
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

  const flash = (msg) => { setToastMsg(msg); setTimeout(() => setToastMsg(""), 2000); };

  const viewingSong = viewing ? songs.find((s) => s.id === viewing.songId) : null;
  const viewingSetlist = viewing?.fromSetlistId ? setlists.find((sl) => sl.id === viewing.fromSetlistId) : null;
  const viewingEntry = viewingSetlist ? viewingSetlist.entries.find((e) => e.songId === viewing.songId) : null;
  const viewingSetlistIndex = viewingSetlist ? viewingSetlist.entries.findIndex((e) => e.songId === viewing.songId) : -1;
  const prevSetlistSongId = viewingSetlist && viewingSetlistIndex > 0 ? viewingSetlist.entries[viewingSetlistIndex - 1].songId : null;
  const nextSetlistSongId = viewingSetlist && viewingSetlistIndex >= 0 && viewingSetlistIndex < viewingSetlist.entries.length - 1 ? viewingSetlist.entries[viewingSetlistIndex + 1].songId : null;

  const handleTabChange = (next) => { setTab(next); setStageIndex(null); setViewing(null); };

  const handleSaveSong = (data) => {
    if (editingSong) saveSongs(songs.map((s) => (s.id === editingSong.id ? { ...s, ...data } : s)));
    else {
      const newSong = { id: uid(), ...data };
      saveSongs([...songs, newSong]);
      setViewing({ songId: newSong.id, fromSetlistId: null });
    }
    setEditingSong(undefined);
  };
  const handleDeleteSong = (id) => {
    saveSongs(songs.filter((s) => s.id !== id));
    saveSetlists(setlists.map((sl) => ({ ...sl, entries: sl.entries.filter((e) => e.songId !== id) })));
    setEditingSong(undefined);
    if (viewing?.songId === id) setViewing(null);
  };
  const handleDuplicateSong = (song) => {
    const base = song.title.replace(/\s*\(\d+\)\s*$/, "").trim();
    let n = 2;
    let candidate = `${base} (${n})`;
    const nameExists = (t) => songs.some((s) => s.title.toLowerCase() === t.toLowerCase() && (s.artist || "").toLowerCase() === (song.artist || "").toLowerCase());
    while (nameExists(candidate)) { n += 1; candidate = `${base} (${n})`; }
    const newSong = { ...song, id: uid(), title: candidate, sections: song.sections.map((sec) => ({ ...sec, id: uid() })) };
    saveSongs([...songs, newSong]);
    setEditingSong(undefined);
    setViewing({ songId: newSong.id, fromSetlistId: null });
    flash(`Duplicated as "${candidate}"`);
  };
  const handleCreateSetlist = () => {
    let n = 1;
    while (setlists.some((sl) => sl.name.toLowerCase() === `setlist ${n}`.toLowerCase())) n += 1;
    const next = [...setlists, { id: uid(), name: `Setlist ${n}`, entries: [] }];
    saveSetlists(next);
    setStageAutoOpenPicker(true);
    setStageIndex(next.length - 1);
  };
  const handleDeleteSetlist = (id) => saveSetlists(setlists.filter((sl) => sl.id !== id));
  const handleUpdateSetlist = (updated) => saveSetlists(setlists.map((sl) => (sl.id === updated.id ? updated : sl)));
  const handleRemoveSongFromSetlist = (setlistId, songId) => {
    saveSetlists(setlists.map((sl) => (sl.id !== setlistId ? sl : { ...sl, entries: sl.entries.filter((e) => e.songId !== songId) })));
    setViewing(null);
  };
  const handleKeyOverrideChange = (setlistId, songId, newKey) => {
    saveSetlists(setlists.map((sl) => (sl.id !== setlistId ? sl : { ...sl, entries: sl.entries.map((e) => (e.songId === songId ? { ...e, keyOverride: newKey } : e)) })));
  };
  const handleUpdateSongAccents = (songId, accents) => saveSongs(songs.map((s) => (s.id === songId ? { ...s, accents } : s)));
  const handleUpdateSongSubdivision = (songId, subdivision) => saveSongs(songs.map((s) => (s.id === songId ? { ...s, subdivision } : s)));

  const exportSongsByIds = async (ids) => {
    const chosen = songs.filter((s) => ids.includes(s.id));
    const result = await shareOrDownloadJSON(`Songs_Export.json`, { type: "songs", exportedAt: new Date().toISOString(), songs: chosen });
    if (result === "cancelled") return;
    flash(result === "shared" ? `Shared ${chosen.length} song${chosen.length === 1 ? "" : "s"}` : `Downloaded ${chosen.length} song${chosen.length === 1 ? "" : "s"}`);
  };
  const exportSingleSong = async (song) => {
    const result = await shareOrDownloadJSON(`${song.title}.json`, { type: "songs", exportedAt: new Date().toISOString(), songs: [song] });
    if (result === "cancelled") return;
    flash(result === "shared" ? "Shared song" : "Downloaded song");
  };
  const exportSetlist = async (setlist) => {
    const entries = setlist.entries.map((e) => ({ song: songs.find((s) => s.id === e.songId), keyOverride: e.keyOverride })).filter((e) => e.song);
    const result = await shareOrDownloadJSON(`${setlist.name}.json`, { type: "setlist", exportedAt: new Date().toISOString(), setlist: { name: setlist.name, entries } });
    if (result === "cancelled") return;
    flash(result === "shared" ? `Shared setlist "${setlist.name}"` : `Downloaded setlist "${setlist.name}"`);
  };

  const importSongsBatch = (rawSongs) => {
    const working = [...songs];
    rawSongs.forEach((raw) => {
      const title = toTitleCase(raw.title || "Untitled");
      const artist = toTitleCase(raw.artist || "");
      const finalTitle = dedupeTitle(title, artist, working);
      working.push({ ...raw, id: uid(), title: finalTitle, artist });
    });
    saveSongs(working);
    flash(`Imported ${rawSongs.length} song${rawSongs.length === 1 ? "" : "s"}`);
  };
  const importSetlistPackage = (pkg) => {
    const working = [...songs];
    const newEntries = [];
    (pkg.entries || []).forEach((e) => {
      const raw = e.song;
      if (!raw) return;
      const title = toTitleCase(raw.title || "Untitled");
      const artist = toTitleCase(raw.artist || "");
      const existing = working.find((s) => s.title.toLowerCase() === title.toLowerCase() && (s.artist || "").toLowerCase() === artist.toLowerCase());
      let songId;
      if (existing) songId = existing.id;
      else { const finalTitle = dedupeTitle(title, artist, working); const song = { ...raw, id: uid(), title: finalTitle, artist }; working.push(song); songId = song.id; }
      newEntries.push({ songId, keyOverride: e.keyOverride ?? null });
    });
    saveSongs(working);
    saveSetlists([...setlists, { id: uid(), name: pkg.name || "Imported Setlist", entries: newEntries }]);
    flash(`Imported setlist "${pkg.name || "Imported Setlist"}"`);
  };
  const importFile = async (file) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (parsed.type === "songs" && Array.isArray(parsed.songs)) importSongsBatch(parsed.songs);
      else if (parsed.type === "setlist" && parsed.setlist) importSetlistPackage(parsed.setlist);
      else if (Array.isArray(parsed.songs)) importSongsBatch(parsed.songs);
      else flash("Import failed: unrecognized file");
    } catch {
      flash("Import failed: invalid file");
    }
  };

  return (
    <div ref={rootRef} style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0, height: "100dvh", width: "100%", maxWidth: "none",
      margin: "0 auto", background: C.bg, color: C.text, fontFamily: FONT, overflow: "hidden",
      border: "none", boxSizing: "border-box", touchAction: "pan-x pan-y",
      paddingTop: "env(safe-area-inset-top, 0px)",
    }}>
      <style>{`
        html, body { position: fixed; inset: 0; overflow: hidden; overscroll-behavior: none; touch-action: none; background: ${C.bg}; width: 100%; height: 100%; }
        #root { position: fixed; inset: 0; overflow: hidden; width: 100%; height: 100%; }
        .bpm-number-input::-webkit-outer-spin-button, .bpm-number-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        .bpm-number-input { -moz-appearance: textfield; }
        button { -webkit-tap-highlight-color: transparent; transition: transform 90ms ease, opacity 90ms ease; -webkit-touch-callout: none; }
        button:active { transform: scale(0.94); opacity: 0.8; }
        input:focus, textarea:focus { outline: none; border-color: ${C.accent}; box-shadow: 0 0 0 2px ${C.accentDim}; }
        input.no-ring:focus, textarea.no-ring:focus { border-color: transparent; box-shadow: none; }
        input::placeholder, textarea::placeholder { color: ${C.textFaint}; opacity: 1; }
        * { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
        input, textarea { -webkit-user-select: text; user-select: text; touch-action: auto; }
        textarea { touch-action: pan-y; }
        .scroll-list { -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain; touch-action: pan-y; }
        *::-webkit-scrollbar { display: none; }
        * { scrollbar-width: none; -ms-overflow-style: none; }
      `}</style>

      <div style={{ paddingBottom: "calc(55px + max(36px, 8px + env(safe-area-inset-bottom, 0px)))", height: "100%", overflow: "hidden", boxSizing: "border-box" }}>
        {tab === "practice" && (
          mode === "drums"
            ? <MetronomeScreen engine={engine} onUpdateSongAccents={handleUpdateSongAccents} onUpdateSongSubdivision={handleUpdateSongSubdivision} onLongPressTitle={() => setEditingSong(null)} C={C} />
            : <PianoScreen C={C} />
        )}
        {tab === "songs" && (
          <SongsScreen songs={songs} onOpen={(s) => setViewing({ songId: s.id, fromSetlistId: null })} onAdd={() => setEditingSong(null)} onEdit={(s) => setEditingSong(s)} onShare={exportSingleSong} onDelete={handleDeleteSong} mode={mode} C={C} />
        )}
        {tab === "setlists" && (
          <SetlistsScreen setlists={setlists} onOpenStage={(id) => { setStageAutoOpenPicker(false); setStageIndex(setlists.findIndex((sl) => sl.id === id)); }} onCreate={handleCreateSetlist} onDelete={handleDeleteSetlist} C={C} />
        )}
        {tab === "settings" && (
          <SettingsScreen
            mode={mode} setMode={setMode}
            fontSize={fontSize} setFontSize={setFontSize}
            chordFontSize={chordFontSize} setChordFontSize={setChordFontSize}
            textAlign={textAlign} setTextAlign={setTextAlign}
            lyricsBold={lyricsBold} setLyricsBold={setLyricsBold}
            notesBold={notesBold} setNotesBold={setNotesBold}
            lineSpacing={lineSpacing} setLineSpacing={setLineSpacing}
            clickSettings={clickSettings} setClickSettings={setClickSettings}
            onImportFile={importFile} onExportOpen={() => setExportPickerOpen(true)} onConfigureSync={configureSync} syncStatus={syncStatus}
            C={C}
          />
        )}
      </div>

      <BottomNav active={tab} onChange={handleTabChange} mode={mode} C={C} />

      {editingSong !== undefined && (
        <SongForm initial={editingSong} onSave={handleSaveSong} onCancel={() => setEditingSong(undefined)} onDelete={handleDeleteSong} onDuplicate={handleDuplicateSong} songs={songs} mode={mode} fontSize={fontSize} chordFontSize={chordFontSize} lyricsBold={lyricsBold} notesBold={notesBold} lineSpacing={lineSpacing} textAlign={textAlign} C={C} />
      )}

      {viewingSong && (
        <SongDetailScreen
          key={viewingSong.id}
          song={viewingSong}
          contextKey={viewingEntry ? (viewingEntry.keyOverride ?? viewingSong.key) : viewingSong.key}
          onKeyChange={viewing?.fromSetlistId ? (newKey) => handleKeyOverrideChange(viewing.fromSetlistId, viewingSong.id, newKey) : null}
          onBack={() => setViewing(null)}
          onEdit={(s) => { setViewing(null); setEditingSong(s); }}
          onDelete={handleDeleteSong}
          onShare={exportSingleSong}
          isInSetlist={!!viewing?.fromSetlistId}
          onRemoveFromSetlist={viewing?.fromSetlistId ? () => handleRemoveSongFromSetlist(viewing.fromSetlistId, viewingSong.id) : null}
          onPrevSong={viewing?.fromSetlistId && prevSetlistSongId ? () => setViewing({ songId: prevSetlistSongId, fromSetlistId: viewing.fromSetlistId }) : null}
          onNextSong={viewing?.fromSetlistId && nextSetlistSongId ? () => setViewing({ songId: nextSetlistSongId, fromSetlistId: viewing.fromSetlistId }) : null}
          fontSize={fontSize} textAlign={textAlign} lyricsBold={lyricsBold} notesBold={notesBold} lineSpacing={lineSpacing} chordFontSize={chordFontSize}
          mode={mode} engine={engine}
          C={C}
        />
      )}

      {stageIndex !== null && setlists[stageIndex] && (
        <SetlistStageScreen
          setlist={setlists[stageIndex]} songs={songs}
          onBack={() => setStageIndex(null)}
          onUpdateSetlist={handleUpdateSetlist}
          onOpenSong={(s) => setViewing({ songId: s.id, fromSetlistId: setlists[stageIndex].id })}
          onShare={() => exportSetlist(setlists[stageIndex])}
          onDeleteSetlist={handleDeleteSetlist}
          initialPickerOpen={stageAutoOpenPicker}
          mode={mode} C={C}
        />
      )}

      {exportPickerOpen && (
        <SongExportPicker songs={songs} onClose={() => setExportPickerOpen(false)} onExport={(ids) => { exportSongsByIds(ids); setExportPickerOpen(false); }} C={C} />
      )}

      <Toast message={toastMsg} C={C} />
    </div>
  );
}

/* On-screen crash reporter — shows JS errors directly on the page so they
   can be read without any dev tools (e.g. on a phone). Catches both React
   render errors and any other uncaught runtime/promise errors. */
class CrashReporter extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("Altar crashed:", error, info);
  }
  componentDidMount() {
    window.addEventListener("error", this.handleWindowError);
    window.addEventListener("unhandledrejection", this.handleRejection);
  }
  componentWillUnmount() {
    window.removeEventListener("error", this.handleWindowError);
    window.removeEventListener("unhandledrejection", this.handleRejection);
  }
  handleWindowError = (e) => {
    this.setState({ error: e.error || new Error(e.message) });
  };
  handleRejection = (e) => {
    this.setState({ error: e.reason instanceof Error ? e.reason : new Error(String(e.reason)) });
  };
  render() {
    if (this.state.error) {
      const err = this.state.error;
      return (
        <div style={{
          position: "fixed", inset: 0, background: "#1a0000", color: "#ffb3b3",
          fontFamily: "monospace", fontSize: 13, padding: 20, overflow: "auto",
          whiteSpace: "pre-wrap", boxSizing: "border-box", zIndex: 999999,
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#ff6b6b", marginBottom: 12 }}>
            Altar crashed — copy this text to fix it:
          </div>
          <div>{String(err && err.message ? err.message : err)}</div>
          <div style={{ marginTop: 12, fontSize: 11, opacity: 0.8 }}>{err && err.stack}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <CrashReporter>
      <AppInner />
    </CrashReporter>
  );
}