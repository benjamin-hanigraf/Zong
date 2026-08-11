import { useState, useEffect, useRef } from "react";
import { useIndexedDbState, useLocalStorageState } from "./hooks/usePersistentState";
import {
  Search, Plus, Pencil, Trash2, ChevronLeft, ChevronRight, ChevronDown, Check, X,
  ListMusic, Layers, Minus, MoreVertical, AlignLeft, AlignCenter, AlignRight,
  Settings as SettingsIcon, Upload, Download, ClipboardPaste,
} from "lucide-react";

/* =========================================================================
   Design tokens
   ========================================================================= */
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
  accent: "#0A84FF",
  accentDim: "rgba(10,132,255,0.35)",
  accentSoft: "rgba(10,132,255,0.12)",
  danger: "#FF453A",
};

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

const TIME_SIGS = [
  { beats: 2, unit: 4 }, { beats: 3, unit: 4 }, { beats: 4, unit: 4 },
  { beats: 6, unit: 4 }, { beats: 6, unit: 8 },
];
const KEY_QUALITIES = ["Major", "Minor"];

/* =========================================================================
   Nashville Number System <-> Chord conversion, major AND minor aware
   ========================================================================= */
const CHROMATIC_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const CHROMATIC_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const FLAT_KEYS = new Set(["F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"]);
const KEY_TO_SEMITONE = {
  C: 0, "B#": 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4,
  F: 5, "E#": 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10,
  Bb: 10, B: 11, Cb: 11,
};
const MAJOR_SCALE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE_OFFSETS = [0, 2, 3, 5, 7, 8, 10]; // natural minor
// Diatonic triad quality for each scale degree (1-7), used whenever a number
// has no explicit quality/accidental of its own — e.g. plain "6" in a major
// key is the vi chord, which is minor (so it becomes "Em" in the key of G,
// not "E"). Major key: I ii iii IV V vi vii°. Natural-minor key: i ii° III
// iv v VI VII.
const MAJOR_KEY_DEGREE_QUALITIES = ["", "m", "m", "", "", "m", "dim"];
const MINOR_KEY_DEGREE_QUALITIES = ["m", "dim", "", "m", "m", "", ""];
// Explicit "force major" suffixes a user can type on a normally-minor/dim
// degree (e.g. "6M", "6maj") to get the major triad instead. Lowercase "m"
// is intentionally excluded — that already means "minor" everywhere else.
const MAJOR_OVERRIDE_SUFFIXES = new Set(["M", "Maj", "maj", "major", "Major"]);
const ALL_KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function spellNote(semitone, useFlats) {
  const s = ((semitone % 12) + 12) % 12;
  return useFlats ? CHROMATIC_FLAT[s] : CHROMATIC_SHARP[s];
}
function tokenToChord(token, key, quality) {
  if (!token) return token;
  const trimmed = token.trim();
  if (!trimmed) return token;
  const semitoneRoot = KEY_TO_SEMITONE[key] ?? 0;
  const useFlats = FLAT_KEYS.has(key);
  const scaleOffsets = quality === "Minor" ? MINOR_SCALE_OFFSETS : MAJOR_SCALE_OFFSETS;
  const degreeQualities = quality === "Minor" ? MINOR_KEY_DEGREE_QUALITIES : MAJOR_KEY_DEGREE_QUALITIES;
  const re = /^([b#]?)([1-7])((?:(?!\/)[^\s])*)(?:\/([b#]?)([1-7]))?$/;
  const m = trimmed.match(re);
  if (!m) return token;
  const [, acc, degreeStr, qualitySuffix, bassAcc, bassDegreeStr] = m;
  const degree = parseInt(degreeStr, 10);
  const accShift = acc === "b" ? -1 : acc === "#" ? 1 : 0;
  const rootSemitone = semitoneRoot + scaleOffsets[degree - 1] + accShift;
  const rootUseFlats = acc === "b" ? true : acc === "#" ? false : useFlats;
  // Church convention: a bare "7" in a Major key is voiced as 5/7 (the V
  // chord over scale-degree-7 in the bass) instead of the default vii°.
  // Explicit overrides (e.g. "7dim", or a manually-typed slash like "7/3")
  // are left alone — this only fires when the user wrote a plain "7".
  if (degree === 7 && quality !== "Minor" && !acc && !qualitySuffix && !bassDegreeStr) {
    const fiveSemitone = semitoneRoot + scaleOffsets[4]; // scale degree 5
    const sevenSemitone = semitoneRoot + scaleOffsets[6]; // scale degree 7 (bass)
    return spellNote(fiveSemitone, useFlats) + "/" + spellNote(sevenSemitone, useFlats);
  }
  // Only fall back to the diatonic default when the number is unaltered
  // (no leading b/#) and the user hasn't already written their own quality
  // — an accidental signals a deliberate chromatic/borrowed chord, whose
  // "correct" default quality isn't well-defined, so those are left as-is.
  const defaultSuffix = acc ? "" : degreeQualities[degree - 1];
  // "6M", "6maj", "6major", etc. force a plain major triad on a degree that
  // would otherwise default to minor/diminished (e.g. vi -> VI, vii° -> VII).
  const isMajorOverride = qualitySuffix && MAJOR_OVERRIDE_SUFFIXES.has(qualitySuffix);
  const finalSuffix = isMajorOverride ? "" : (qualitySuffix || defaultSuffix);
  let chord = spellNote(rootSemitone, rootUseFlats) + finalSuffix;
  if (bassDegreeStr) {
    const bassDegree = parseInt(bassDegreeStr, 10);
    const bassShift = bassAcc === "b" ? -1 : bassAcc === "#" ? 1 : 0;
    const bassSemitone = semitoneRoot + scaleOffsets[bassDegree - 1] + bassShift;
    const bassUseFlats = bassAcc === "b" ? true : bassAcc === "#" ? false : useFlats;
    chord += "/" + spellNote(bassSemitone, bassUseFlats);
  }
  return chord;
}
function lineToChords(line, key, quality) {
  if (!line) return "";
  return line.split(/(\s+)/).map((p) => (/\s/.test(p) ? p : tokenToChord(p, key, quality))).join("");
}
function blockToChords(text, key, quality) {
  if (!text) return "";
  return text.split("\n").map((line) => lineToChords(line, key, quality)).join("\n");
}
const NUMBER_TOKEN_RE = /^([b#]?)([1-7])((?:(?!\/)[^\s])*)(?:\/([b#]?)([1-7]))?$/;
function renderNumberTokens(text) {
  if (!text) return "\u2014";
  const nodes = [];
  const lines = text.split("\n");
  lines.forEach((line, li) => {
    line.split(/(\s+)/).forEach((part, pi) => {
      if (part === "") return;
      if (/^\s+$/.test(part)) { nodes.push(part); return; }
      const isNumber = NUMBER_TOKEN_RE.test(part.trim());
      nodes.push(<span key={`${li}-${pi}`} style={isNumber ? undefined : { color: C.textMuted }}>{flatify(part)}</span>);
    });
    if (li < lines.length - 1) nodes.push("\n");
  });
  return nodes;
}
function transposeKey(key, semitoneDelta) {
  const semitone = ((KEY_TO_SEMITONE[key] ?? 0) + semitoneDelta + 1200) % 12;
  return ALL_KEYS.find((k) => KEY_TO_SEMITONE[k] === semitone) || "C";
}

/* Unicode flat/sharp glyphs everywhere on display; people still type
   'b' / '#' when editing — this only ever touches what's rendered. */
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
  if (!keyStr) return { natural: "C", accidental: "natural" };
  const natural = keyStr[0];
  const suffix = keyStr.slice(1);
  const accidental = suffix === "b" ? "flat" : suffix === "#" ? "sharp" : "natural";
  return { natural, accidental };
}
const composeKey = (natural, accidental) => natural + (accidental === "flat" ? "b" : accidental === "sharp" ? "#" : "");

// The UI only allows sharp on naturals other than E/B, and flat on naturals
// other than C/F (those are handled by the neighboring natural instead), so
// a pasted key spelled outside that set needs to fall back to its enharmonic
// equivalent (e.g. "E#" -> "F", "Cb" -> "B") rather than being dropped.
const KEY_ENHARMONIC_FIX = { "E#": "F", "B#": "C", Cb: "B", Fb: "E" };

// Parses a "/Key:" value like "B", "C#m", "Bbm", "F# Minor" into the natural
// letter, accidental, and quality the Add/Edit Song form's Key controls use.
// The natural + accidental spelling is kept exactly as typed (so "C#m" stays
// "C sharp", it is not renormalized to "Db") except for the four combos the
// form's Key controls don't support, which map to their enharmonic natural.
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

// Parses clipboard text of the form:
//   /Title: ...
//   /Artist: ...
//   /Tempo: ...
//   /Time Signature: 4/4
//   /Key: C#m
//   /Description: ...
//   /Sections:
//   #Intro
//   1 - 5 - 6 5 - 4 (2)
//   #Chorus
//   ...
// Fields ("/Name: value") missing from the text are simply left out of the
// returned `fields` object, so callers only apply what's actually present.
function parseSongClipboardText(raw) {
  const lines = String(raw || "").replace(/\r\n/g, "\n").split("\n");
  const fieldMap = { title: "title", artist: "artist", tempo: "tempo", "time signature": "timeSignature", key: "key", description: "description" };
  const fields = {};
  const sections = [];
  let currentSection = null;
  let inSections = false;

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
    if (trimmed.startsWith("#")) {
      currentSection = { id: uid(), label: trimmed.slice(1).trim(), numbers: "" };
      sections.push(currentSection);
    } else if (trimmed) {
      if (!currentSection) { currentSection = { id: uid(), label: "", numbers: "" }; sections.push(currentSection); }
      currentSection.numbers = currentSection.numbers ? currentSection.numbers + "\n" + trimmed : trimmed;
    }
  }
  return { fields, sections };
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

// Tries the native share sheet first (Web Share API level 2, files).
// Many in-app browsers / WebViews (including embedded chat apps) don't
// implement navigator.share for files, or don't implement it at all —
// in that case this silently falls back to a normal file download.
// Returns "shared", "downloaded", or "cancelled".
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
    // fall through to download for any other failure (e.g. share sheet unsupported here)
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
   Seed data — setlists store {songId, keyOverride} entries, not plain ids,
   so a temporary in-setlist key change can be tracked per song.
   ========================================================================= */
const SEED_SONGS = [
  {
    id: "seed-1", title: "Oceans", artist: "Hillsong United", tempo: 72, timeSignature: "4/4", key: "D", keyQuality: "Major",
    description: "Benny's key: D | Sherly's key: G\nStyle: Rock Shuffle",
    sections: [
      { id: uid(), label: "Verse", numbers: "1        4\n6m       4" },
      { id: uid(), label: "Chorus", numbers: "1  5  6m  4\n1  5  4" },
      { id: uid(), label: "Bridge", numbers: "6m  4  1  5\n6m  4  5sus4  5" },
    ],
  },
  {
    id: "seed-2", title: "Way Maker", artist: "Sinach", tempo: 68, timeSignature: "4/4", key: "E", keyQuality: "Major",
    description: "Benny's key: D | Sherly's key: G\nStyle: Rock Shuffle",
    sections: [
      { id: uid(), label: "Intro", numbers: "1  .  .  .  |  4  .  .  .  |  5  .  .  .  |  1  .  .  ." },
      { id: uid(), label: "Chorus", numbers: "1     4\n6m    5\n1     4  5  1" },
    ],
  },
  {
    id: "seed-3", title: "Our God", artist: "Chris Tomlin", tempo: 105, timeSignature: "4/4", key: "A", keyQuality: "Major",
    description: "Benny's key: D | Sherly's key: G\nStyle: Rock Shuffle",
    sections: [{ id: uid(), label: "Verse", numbers: "1  5  6m  4" }, { id: uid(), label: "Chorus", numbers: "4  1  5  6m\n4  1  5" }],
  },
];
const SEED_SETLISTS = [{
  id: "sl-1", name: "Sunday AM",
  entries: [{ songId: "seed-1", keyOverride: null }, { songId: "seed-2", keyOverride: "F" }],
}];

/* =========================================================================
   Shared bits
   ========================================================================= */
const inputStyle = {
  width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10,
  padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box",
};
const iconBtnStyle = {
  width: 32, height: 32, borderRadius: 8, border: "none", background: "transparent",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};
const circleBtnStyle = {
  width: 34, height: 34, borderRadius: "50%", border: `1px solid ${C.border}`, background: C.surface2,
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
function SectionLabel({ children }) {
  return <div style={{ fontSize: 11, letterSpacing: 1.5, color: C.textFaint, marginBottom: 10, marginTop: 4, fontWeight: 700 }}>{children}</div>;
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
          <X size={14} color={C.textMuted} />
        </button>
      ) : null}
    </div>
  );
}

// Time-signature dropdown, used in the song form. Auto-flips upward if
// there isn't room below.
function TimeSigPicker({ value, onChange, fullWidth }) {
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
    <div style={{ position: "relative", width: fullWidth ? "100%" : undefined }}>
      <button
        ref={btnRef}
        type="button"
        onClick={handleToggle}
        style={{
          fontFamily: FONT, fontSize: 16, fontWeight: 600, borderRadius: 10, boxSizing: "border-box",
          border: `1px solid ${C.border}`, background: C.surface2, color: value ? C.text : C.textFaint,
          width: fullWidth ? "100%" : undefined, textAlign: "center", height: 44, padding: "0 10px",
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

// Natural-letter dropdown for the Key field (first of the two Key controls).
function NaturalDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const btnRef = useRef(null);
  const DROPDOWN_HEIGHT = 296; // 7 rows, no internal scroll — must show in full

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
      <button
        ref={btnRef}
        type="button"
        onClick={handleToggle}
        style={{
          width: "100%", boxSizing: "border-box", height: 44, padding: "0 10px", borderRadius: 10,
          border: `1px solid ${C.border}`, background: C.surface2, color: C.text,
          fontFamily: FONT, fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
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

// Accidental toggle for the Key field (second of the two Key controls).
// Tapping an active button again reverts to natural; tapping the other
// button switches straight over. Sharp/flat options that don't correspond
// to a real black key for the current natural (E#, Fb, B#, Cb) are disabled.
function AccidentalButton({ variant, natural, value, onChange }) {
  const disabled = variant === "flat" ? (natural === "C" || natural === "F") : (natural === "E" || natural === "B");
  const active = value === variant;
  const icon = variant === "flat" ? "\u266d" : "\u266f";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(active ? "natural" : variant)}
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

// iOS-style pill toggle switch, used for Scale (Major/Minor). The track
// stays neutral; the active side's label turns blue to show selection.
function ToggleSwitch({ checked, onChange, offLabel, onLabel }) {
  return (
    <div
      role="switch"
      aria-checked={checked}
      tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(!checked); } }}
      style={{
        width: "100%", height: 44, boxSizing: "border-box", borderRadius: 10, border: `1px solid ${C.border}`,
        background: C.surface2, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px",
        cursor: "pointer",
      }}
    >
      <span style={{ fontFamily: FONT, fontSize: 14, fontWeight: 700, color: checked ? C.textFaint : C.accent }}>{offLabel}</span>
      <span style={{
        position: "relative", width: 46, height: 26, borderRadius: 13, flexShrink: 0, margin: "0 10px",
        background: C.surface3, border: `1px solid ${C.borderStrong}`, boxSizing: "border-box",
      }}>
        <span style={{
          position: "absolute", top: 2, left: checked ? 22 : 2, width: 20, height: 20, borderRadius: "50%",
          background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.4)", transition: "left 150ms ease",
        }} />
      </span>
      <span style={{ fontFamily: FONT, fontSize: 14, fontWeight: 700, color: checked ? C.accent : C.textFaint }}>{onLabel}</span>
    </div>
  );
}

/* =========================================================================
   Piano tab
   ========================================================================= */
function PianoIcon({ size = 20, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="4" y="6" width="16" height="12" rx="2" stroke={color} strokeWidth="1.5" />
      <path d="M9.5 6v7M14.5 6v7" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
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

function buildPianoWave(ctx) {
  const numHarmonics = 9;
  const real = new Float32Array(numHarmonics + 1);
  const imag = new Float32Array(numHarmonics + 1);
  const amps = [0, 1, 0.55, 0.32, 0.22, 0.15, 0.1, 0.07, 0.05, 0.03];
  for (let n = 1; n <= numHarmonics; n++) imag[n] = amps[n];
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}
const WHITE_KEY_BG = "#F2F1EC";
const WHITE_KEY_BG_PRESSED = C.accent;
const BLACK_KEY_BG = "#0A0A0A";
const BLACK_KEY_BG_PRESSED = C.accent;
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

// True when the viewport itself is wider than it is tall — a real desktop
// browser window, or an iPad/tablet turned to landscape. Used to (a) let
// the app fill the actual screen width instead of the normal phone-width
// column, and (b) let the Piano render upright instead of using the
// rotate-90 trick that exists specifically for a *portrait* phone screen.
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

// Measures its portrait slot and rotates a swapped-dimension inner box
// 90deg clockwise into it, so the piano is always landscape no matter the
// device orientation or this tab's own portrait shape.
function LandscapeLock({ children }) {
  const outerRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={outerRef} style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", background: C.bg }}>
      {size.w > 0 && size.h > 0 && (
        <div style={{
          position: "absolute", top: "50%", left: "50%",
          width: size.h, height: size.w,
          transform: "translate(-50%, -50%) rotate(90deg)",
          transformOrigin: "center center",
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

// iOS Safari/WebViews default web audio (both <audio> and the Web Audio
// API) to the "ambient" audio session category, which the hardware mute
// switch silences. Playing a <video> element (even a silent one) is one
// of the few ways from plain web content to nudge the session into the
// "playback" category, which iOS does *not* silence — this then applies
// to the Web Audio API context used by the piano below too. This is a
// best-effort workaround, not a guarantee: exact behavior can vary by
// iOS version and by the specific WebView (e.g. an embedded in-app
// browser may behave differently than Safari itself).
const SILENT_VIDEO_SRC = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAZWbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAwN0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAIAAAACAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAJ7bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAAMgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACJm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAeZzdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAIAAgBIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MBQsAK/+EAGGdCwArZH4iIwEQAAAMABAAAAwDIPEiZIAEABWjLg8sgAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAGuAAABrgAAAAGHN0dHMAAAAAAAAAAQAAABkAAAIAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAABMc3RzYwAAAAAAAAAFAAAAAQAAAAEAAAABAAAAAgAAAAMAAAABAAAABgAAAAQAAAABAAAABwAAAAMAAAABAAAACQAAAAIAAAABAAAAeHN0c3oAAAAAAAAAAAAAABkAAAKDAAAACQAAAAoAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAANHN0Y28AAAAAAAAACQAABpsAAAkiAAAJQgAACWEAAAmAAAAJnwAACccAAAnmAAAKBQAAAn10cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAA+gAAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAEAAABAAAAAAH1bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAfQAAAI0BVxAAAAAAALWhkbHIAAAAAAAAAAHNvdW4AAAAAAAAAAAAAAABTb3VuZEhhbmRsZXIAAAABoG1pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABZHN0YmwAAAB+c3RzZAAAAAAAAAABAAAAbm1wNGEAAAAAAAAAAQAAAAAAAAAAAAEAEAAAAAAfQAAAAAAANmVzZHMAAAAAA4CAgCUAAgAEgICAF0AVAAAAAAAfQAAAAXcFgICABRWIVuUABoCAgAECAAAAFGJ0cnQAAAAAAAAfQAAAAXcAAAAgc3R0cwAAAAAAAAACAAAACAAABAAAAAABAAADQAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAA4c3RzegAAAAAAAAAAAAAACQAAABUAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAADRzdGNvAAAAAAAAAAkAAAaGAAAJHgAACT4AAAldAAAJfAAACZsAAAnDAAAJ4gAACgEAAAAac2dwZAEAAAByb2xsAAAAAgAAAAH//wAAABxzYmdwAAAAAHJvbGwAAAABAAAACQAAAAEAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMAAAAAhmcmVlAAADmW1kYXTeAgBMYXZjNjAuMzEuMTAyAAIwQA4AAAJxBgX//23cRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAApliIQM8mKAALC+ARggBwAAAAVBmjgZ6gAAAAZBmlQGeoAAAAAFQZpgM9QBGCAHAAAABUGagDPUAAAABUGaoDPUAAAABUGawDPUARggBwAAAAVBmuAz1AAAAAVBmwAz1AAAAAVBmyAz1AEYIAcAAAAFQZtAM9QAAAAFQZtgM9QAAAAFQZuAM9QBGCAHAAAABUGboDPUAAAABUGbwDPUAAAABUGb4DPUAAAABUGaADPUARggBwAAAAVBmiAz1AAAAAVBmkAz1AAAAAVBmmAz1AEYIAcAAAAFQZqAM9QAAAAFQZqgM9QAAAAFQZrAL9QBGCAHAAAABUGa4C/UAAAABUGbACvU";

function PianoScreen() {
  const [octaveStart, setOctaveStartState] = useState(4);
  const octaveStartRef = useRef(4);
  const audioCtxRef = useRef(null);
  const pianoWaveRef = useRef(null);
  const activeRef = useRef(new Map());
  const containerRef = useRef(null);
  const silentVideoRef = useRef(null);
  const videoUnlockedRef = useRef(false);

  useEffect(() => { octaveStartRef.current = octaveStart; }, [octaveStart]);
  const setOctaveStart = (n) => setOctaveStartState(Math.min(5, Math.max(3, n)));

  const ensureCtx = () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
      pianoWaveRef.current = buildPianoWave(audioCtxRef.current);
    }
    if (audioCtxRef.current.state === "suspended") audioCtxRef.current.resume().catch(() => { });
    // Unlock the silent video once (a key-press is a user gesture) rather
    // than on every note — repeatedly calling .play() on every keypress
    // was the actual source of the audible latency, since hidden/offscreen
    // videos get auto-paused by the browser and each .play() call kicks
    // off a real (non-instant) media pipeline round-trip.
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
    const gain = ctx.createGain();
    const peak = 0.68;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.4), now + 0.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 7);
    // Real piano strings carry proportionally fewer strong upper partials as
    // pitch rises — a treble note is naturally purer/closer to a sine than a
    // bass note. Opening the filter to a flat "9x the fundamental" for every
    // note (regardless of register) lets high notes keep disproportionately
    // loud high-frequency content relative to their own pitch, which is what
    // reads as reedy/brassy up top. Taper the opening from wide (9x) at the
    // bottom of the keyboard down to narrow (3x) at the top instead.
    const t = Math.min(1, Math.max(0, (freq - 130) / (2000 - 130))); // ~C3 to ~B6
    const openMult = 9 - t * 6; // 9x at the bottom, 3x at the top
    const sustainMult = Math.max(1.4, openMult * 0.3);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.6;
    filter.frequency.setValueAtTime(Math.min(9000, freq * openMult), now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(500, freq * sustainMult), now + 2.2);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(pianoWaveRef.current);
    osc.frequency.value = freq;
    osc.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
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
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
      voice.osc.stop(now + 0.16);
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
    keyEl.style.background = pressed ? (isBlack ? BLACK_KEY_BG_PRESSED : WHITE_KEY_BG_PRESSED) : (isBlack ? BLACK_KEY_BG : WHITE_KEY_BG);
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
    // A PWA getting backgrounded (home button, app switcher, swipe-away)
    // mid-keypress frequently does NOT fire a matching pointerup/pointercancel
    // — the webview is just suspended. Without this, that voice's oscillator
    // is left running (never explicitly .stop()ed) and, since iOS commonly
    // *resumes* a suspended PWA rather than reloading it, that stuck near-
    // silent voice is still live and still summed into ctx.destination when
    // you reopen. Enough leaked voices piling up across sessions comb-filter
    // against new notes and reinforce upper harmonics, which is what reads
    // as the tone "turning brassy" the more times the app is reopened.
    // visibilitychange fires reliably on backgrounding, regardless of
    // whether a clean pointer-up ever happened, so we use it to force-stop
    // everything and fully close the context rather than leaving it suspended.
    const handleVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      activeRef.current.forEach((v) => stopVoice(v.voice));
      activeRef.current.clear();
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        audioCtxRef.current.close().catch(() => { });
      }
      audioCtxRef.current = null;
      pianoWaveRef.current = null;
      videoUnlockedRef.current = false;
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
      // Without this, leaving the Piano tab (which unmounts this component)
      // and coming back creates a brand-new AudioContext every time without
      // ever releasing the old one. Each leftover context keeps its own
      // real-time audio thread alive in the background, so the longer the
      // app stays open and the more times this tab is revisited, the more
      // contexts pile up — which is what was showing up as growing
      // touch-to-sound latency (and would eventually hit the browser's hard
      // cap on concurrent AudioContexts).
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        audioCtxRef.current.close().catch(() => { });
      }
      audioCtxRef.current = null;
      pianoWaveRef.current = null;
      videoUnlockedRef.current = false;
    };
  }, []);

  const isLandscapeScreen = useIsLandscapeScreen();

  const pianoBody = (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", fontFamily: FONT, color: C.text }}>
      <div style={{ height: 60, flexShrink: 0, display: "flex", alignItems: "center", padding: "0 20px", borderBottom: `1px solid ${C.border}`, gap: 10, boxSizing: "border-box" }}>
        <div style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>Piano</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => setOctaveStart(octaveStart - 1)} disabled={octaveStart <= 3} style={{
            width: 32, height: 32, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, background: C.surface2,
            color: C.text, display: "flex", alignItems: "center", justifyContent: "center", opacity: octaveStart <= 3 ? 0.35 : 1,
          }}>
            <ChevronLeft size={15} />
          </button>
          <div style={{ fontSize: 13.5, fontWeight: 700, minWidth: 30, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>C{octaveStart}</div>
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
              <div key={k.semitone} data-semitone={k.semitone} data-black="1" style={{
                position: "absolute", top: 0, height: "58%", left: `${leftPct}%`, width: `${widthPct}%`,
                background: BLACK_KEY_BG, borderRadius: "0 0 4px 4px", pointerEvents: "auto", boxShadow: "0 3px 6px rgba(0,0,0,0.5)",
              }} />
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
      {isLandscapeScreen ? pianoBody : <LandscapeLock>{pianoBody}</LandscapeLock>}
    </div>
  );
}

/* =========================================================================
   Edge-swipe-back hook — only arms when the touch starts within 24px of
   the left screen edge, so scrolling mid-page never triggers a close.
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

  return {
    dragX, leaving,
    handlers: { onTouchStart: handleTouchStart, onTouchMove: handleTouchMove, onTouchEnd: handleTouchEnd, onTouchCancel: handleTouchEnd },
  };
}

/* =========================================================================
   Setlist song-nav swipe hook — swipe anywhere (not just the edge) left<->
   right to move to the previous/next song in the setlist. Direction-locks
   after ~8px of movement: if the gesture turns out to be more vertical than
   horizontal, it's treated as a scroll and nav is skipped for the rest of
   that touch, so scrolling through lyrics never accidentally flips songs.
   Unlike edge-swipe-back, this never visually drags the page along with the
   finger (which would reveal the setlist stage behind it) — it just snaps
   straight to the next/previous song once the swipe clears the threshold.
   ========================================================================= */
function useSetlistSongSwipe(onPrev, onNext) {
  const draggingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0 });
  const dxRef = useRef(0);
  const directionRef = useRef(null); // null | "x" | "y"

  const handleTouchStart = (e) => {
    if (e.touches.length !== 1) return;
    startRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    directionRef.current = null;
    dxRef.current = 0;
    draggingRef.current = true;
  };
  const handleTouchMove = (e) => {
    if (!draggingRef.current) return;
    const dx = e.touches[0].clientX - startRef.current.x;
    const dy = e.touches[0].clientY - startRef.current.y;
    if (directionRef.current === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      directionRef.current = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    }
    if (directionRef.current === "y") return; // already scrolling — leave nav alone
    dxRef.current = dx;
  };
  const handleTouchEnd = () => {
    const wasHorizontal = directionRef.current === "x";
    const dx = dxRef.current;
    draggingRef.current = false;
    directionRef.current = null;
    dxRef.current = 0;
    if (wasHorizontal) {
      if (dx > 70 && onPrev) onPrev();
      else if (dx < -70 && onNext) onNext();
    }
  };

  return {
    dragX: 0,
    handlers: { onTouchStart: handleTouchStart, onTouchMove: handleTouchMove, onTouchEnd: handleTouchEnd, onTouchCancel: handleTouchEnd },
  };
}

/* =========================================================================
   Song form — slide-in-from-right, edge-swipe-to-cancel.
   ========================================================================= */
function SongForm({ initial, onSave, onCancel, onDelete, songs }) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [artist, setArtist] = useState(initial?.artist ?? "");
  const [tempo, setTempo] = useState(initial?.tempo ?? "");
  const [timeSig, setTimeSig] = useState(() => (initial?.timeSignature ? parseTimeSig(initial.timeSignature) : null));
  const initialDecomposed = decomposeKey(initial?.key ?? "C");
  const [keyNatural, setKeyNatural] = useState(initialDecomposed.natural);
  const [keyAccidental, setKeyAccidental] = useState(initialDecomposed.accidental);
  const [keyQuality, setKeyQuality] = useState(initial?.keyQuality ?? "Major");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [sections, setSections] = useState(initial?.sections?.map((s) => ({ ...s })) ?? [{ id: uid(), label: "Verse", numbers: "" }]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");

  const { dragX, leaving, handlers } = useEdgeSwipeBack(onCancel);

  // Applies parsed clipboard text to the form. Every field the clipboard
  // text actually contains fully overwrites whatever is currently in the
  // form (sections are replaced wholesale, not appended to); fields absent
  // from the clipboard text are simply left as-is.
  const applyClipboardText = (text) => {
    if (!text || !text.trim()) return false;
    const { fields, sections: parsedSections } = parseSongClipboardText(text);
    if (fields.title !== undefined) setTitle(fields.title);
    if (fields.artist !== undefined) setArtist(fields.artist);
    if (fields.tempo !== undefined) {
      const digits = fields.tempo.replace(/[^\d]/g, "");
      if (digits) setTempo(digits);
    }
    if (fields.timeSignature !== undefined) {
      const m = fields.timeSignature.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (m) setTimeSig({ beats: parseInt(m[1], 10), unit: parseInt(m[2], 10) });
    }
    if (fields.key !== undefined) {
      const parsedKey = parseKeyPaste(fields.key);
      if (parsedKey) {
        setKeyNatural(parsedKey.natural);
        setKeyAccidental(parsedKey.accidental);
        setKeyQuality(parsedKey.quality);
      }
    }
    if (fields.description !== undefined) setDescription(fields.description);
    if (parsedSections.length) setSections(parsedSections); // full replace, never appended
    setError("");
    return true;
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!applyClipboardText(text)) setError("Clipboard is empty");
    } catch (err) {
      setError("Couldn't read clipboard");
    }
  };

  const handleNaturalChange = (n) => {
    setKeyNatural(n);
    if (keyAccidental === "sharp" && (n === "E" || n === "B")) setKeyAccidental("natural");
    if (keyAccidental === "flat" && (n === "C" || n === "F")) setKeyAccidental("natural");
  };

  const updateSection = (id, field, value) => setSections((secs) => secs.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  const removeSection = (id) => setSections((secs) => secs.filter((s) => s.id !== id));
  const addSection = () => setSections((secs) => [...secs, { id: uid(), label: "", numbers: "" }]);

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
      title: cleanTitle, artist: cleanArtist, tempo: tempo === "" ? "" : Number(tempo), timeSignature: timeSig ? formatTimeSig(timeSig) : "",
      key: composeKey(keyNatural, keyAccidental), keyQuality, description,
      sections: sections.length ? sections : [{ id: uid(), label: "Verse", numbers: "" }],
    });
  };
  const canSave = title.trim().length > 0;

  return (
    <div
      className="scroll-list"
      style={{
        position: "fixed", inset: 0, zIndex: 150, background: C.bg, color: C.text, fontFamily: FONT,
        overflowY: "auto", boxSizing: "border-box", paddingTop: "env(safe-area-inset-top, 0px)",
        transform: `translateX(${dragX}px)`,
        transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none",
      }}
      {...handlers}
    >
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, background: C.bg }}>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}>
          <ChevronLeft size={22} />
        </button>
        <div style={{ fontSize: 17, fontWeight: 600 }}>{initial ? "Edit Song" : "Add Song"}</div>
        <div style={{ flex: 1 }} />
        <button onClick={handlePasteFromClipboard} title="Paste song from clipboard" style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}>
          <ClipboardPaste size={20} />
        </button>
      </div>

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18, paddingBottom: 60 }}>
        <Field label="TITLE">
          <ClearableInput autoFocus={!initial} value={title} onChangeText={(v) => { setTitle(v); setError(""); }} placeholder="Song title" style={{ ...inputStyle, paddingRight: title ? 36 : 14 }} />
        </Field>
        <Field label="ARTIST">
          <ClearableInput value={artist} onChangeText={(v) => { setArtist(v); setError(""); }} placeholder="Artist" style={{ ...inputStyle, paddingRight: artist ? 36 : 14 }} />
        </Field>
        <div style={{ display: "flex", gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Field label="TIME SIGNATURE">
              <TimeSigPicker value={timeSig} onChange={setTimeSig} fullWidth />
            </Field>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Field label="TEMPO">
              <input type="number" inputMode="numeric" value={tempo} onChange={(e) => setTempo(e.target.value)} className="bpm-number-input"
                placeholder="—"
                style={{ ...inputStyle, fontSize: 18, fontVariantNumeric: "tabular-nums", textAlign: "center", height: 44, boxSizing: "border-box" }} />
            </Field>
          </div>
        </div>

        <div style={{ display: "flex", gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Field label="KEY">
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <NaturalDropdown value={keyNatural} onChange={handleNaturalChange} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <AccidentalButton variant="flat" natural={keyNatural} value={keyAccidental} onChange={setKeyAccidental} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <AccidentalButton variant="sharp" natural={keyNatural} value={keyAccidental} onChange={setKeyAccidental} />
                </div>
              </div>
            </Field>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Field label="SCALE">
              <ToggleSwitch
                checked={keyQuality === "Minor"}
                onChange={(isMinor) => setKeyQuality(isMinor ? "Minor" : "Major")}
                offLabel="Maj"
                onLabel="Min"
              />
            </Field>
          </div>
        </div>

        <Field label="DESCRIPTION">
          <textarea
            value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder={"Benny's key: D | Sherly's key: G\nStyle: Rock Shuffle"}
            style={{ ...inputStyle, height: "auto", padding: "12px 14px", minHeight: 62, resize: "vertical" }}
          />
        </Field>

        <Field label="SECTIONS">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {sections.map((sec) => (
              <div key={sec.id} style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <input value={sec.label} onChange={(e) => updateSection(sec.id, "label", e.target.value)} placeholder="Verse, Chorus, Bridge&hellip;"
                    style={{ ...inputStyle, background: C.surface3 }} />
                  <button onClick={() => removeSection(sec.id)} style={{ width: 32, height: 32, borderRadius: 8, background: "none", border: "none", color: C.danger, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <X size={16} color={C.danger} />
                  </button>
                </div>
                <textarea value={sec.numbers} onChange={(e) => updateSection(sec.id, "numbers", e.target.value)}
                  placeholder={"1        4\n6m       4"}
                  style={{ ...inputStyle, height: "auto", padding: "12px 14px", background: C.surface3, fontFamily: MONO, minHeight: 90, resize: "vertical" }} />
              </div>
            ))}
          </div>
          <button onClick={addSection} style={{
            width: "100%", marginTop: 10, padding: "12px 0", borderRadius: 10, border: `1px dashed ${C.borderStrong}`,
            background: "transparent", color: C.textMuted, fontFamily: FONT, fontSize: 14, fontWeight: 600,
          }}>
            + Add section
          </button>
        </Field>

        {error && <div style={{ color: C.danger, fontSize: 13, textAlign: "center", fontWeight: 500 }}>{error}</div>}

        <button disabled={!canSave} onClick={handleSave} style={{
          marginTop: 8, fontFamily: FONT, fontWeight: 700, fontSize: 15, padding: "16px 0", borderRadius: 14, border: "none",
          background: canSave ? C.accent : C.surface2, color: canSave ? "#fff" : C.textFaint,
        }}>
          SAVE
        </button>

        {initial && (
          confirmDelete ? (
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setConfirmDelete(false)} style={{ flex: 1, fontFamily: FONT, fontWeight: 600, fontSize: 14, padding: "14px 0", borderRadius: 12, border: `1px solid ${C.borderStrong}`, background: "transparent", color: C.textMuted }}>Cancel</button>
              <button onClick={() => onDelete(initial.id)} style={{ flex: 1, fontFamily: FONT, fontWeight: 700, fontSize: 14, padding: "14px 0", borderRadius: 12, border: "none", background: C.danger, color: "#fff" }}>Confirm Delete</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} style={{ fontFamily: FONT, fontWeight: 600, fontSize: 14, padding: "14px 0", borderRadius: 12, border: `1px solid ${C.border}`, background: "transparent", color: C.danger }}>Delete Song</button>
          )
        )}
      </div>
    </div>
  );
}

/* =========================================================================
   Song row — tap to view, long-press to edit.
   ========================================================================= */
function SongRow({ song, onOpen, onEdit }) {
  const longPressTimerRef = useRef(null);
  const firedLongPressRef = useRef(false);
  const startPress = () => {
    firedLongPressRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => { firedLongPressRef.current = true; onEdit(song); }, 500);
  };
  const cancelPress = () => { if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; } };
  const handleClick = () => { if (firedLongPressRef.current) { firedLongPressRef.current = false; return; } onOpen(song); };

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}
      onClick={handleClick}
      onTouchStart={startPress} onTouchMove={cancelPress} onTouchEnd={cancelPress} onTouchCancel={cancelPress}
      onMouseDown={startPress} onMouseUp={cancelPress} onMouseLeave={cancelPress}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.artist || "Unknown"}</div>
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color: C.accent, border: `1px solid ${C.accentDim}`, borderRadius: 6, padding: "3px 7px", flexShrink: 0 }}>{keyLabel(song)}</span>
    </div>
  );
}

function SongsScreen({ songs, onOpen, onAdd, onEdit }) {
  const [query, setQuery] = useState("");
  const filtered = songs
    .filter((s) => (s.title + " " + s.artist).toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 auto", padding: "22px 20px 14px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700 }}>Songs</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{songs.length} songs</div>
          </div>
          <button onClick={onAdd} style={circleBtnStyle}>
            <Plus size={17} color={C.accent} />
          </button>
        </div>
        <div style={{ marginTop: 16 }}>
          <ClearableInput
            value={query} onChangeText={setQuery} placeholder="Search title or artist"
            leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
            style={{ ...inputStyle, paddingLeft: 36, paddingRight: query ? 36 : 14 }}
          />
        </div>
      </div>
      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", padding: "0 20px 14px", boxSizing: "border-box" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>
            {songs.length === 0 ? "No songs yet." : "No matches."}
          </div>
        ) : filtered.map((s) => <SongRow key={s.id} song={s} onOpen={onOpen} onEdit={onEdit} />)}
      </div>
    </div>
  );
}

/* =========================================================================
   Song picker — add/remove songs from a Setlist.
   ========================================================================= */
function SongPickerScreen({ songs, selectedIds, onToggle, onClose, setlistName, onRenameSetlist }) {
  const [query, setQuery] = useState("");
  const [nameDraft, setNameDraft] = useState(setlistName ?? "");
  const filtered = songs.filter((s) => (s.title + " " + s.artist).toLowerCase().includes(query.toLowerCase()));
  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && onRenameSetlist) onRenameSetlist(trimmed);
    else setNameDraft(setlistName ?? "");
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 150, display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top, 0px)", boxSizing: "border-box" }}>
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onClose} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}><ChevronLeft size={22} /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onBlur={commitName}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            style={{ width: "100%", boxSizing: "border-box", fontFamily: FONT, fontSize: 17, fontWeight: 600, background: "transparent", border: "none", color: C.text, padding: 0, outline: "none" }}
          />
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", fontFamily: FONT, fontSize: 15.5, fontWeight: 700, color: C.accent, padding: "6px 4px" }}>Done</button>
      </div>
      <div style={{ padding: "14px 20px 6px" }}>
        <ClearableInput
          autoFocus value={query} onChangeText={setQuery} placeholder="Search title or artist"
          leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
          style={{ ...inputStyle, paddingLeft: 36, paddingRight: query ? 36 : 14 }}
        />
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
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15.5, fontWeight: 600 }}>{s.title}</div>
                <div style={{ fontSize: 12.5, color: C.textMuted }}>{s.artist || "Unknown"}</div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.accent }}>{keyLabel(s)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* =========================================================================
   "Send Songs" export picker — multi-select with Select All, downloads
   the chosen songs as one .json file.
   ========================================================================= */
function SongExportPicker({ songs, onClose, onExport }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const filtered = songs.filter((s) => (s.title + " " + s.artist).toLowerCase().includes(query.toLowerCase()));
  const allSelected = filtered.length > 0 && filtered.every((s) => selected.has(s.id));

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allSelected) filtered.forEach((s) => next.delete(s.id));
    else filtered.forEach((s) => next.add(s.id));
    return next;
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 150, display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top, 0px)", boxSizing: "border-box" }}>
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onClose} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}><ChevronLeft size={22} /></button>
        <div style={{ flex: 1, fontSize: 17, fontWeight: 600 }}>Send Songs</div>
        <button onClick={toggleAll} style={{ background: "none", border: "none", fontFamily: FONT, fontSize: 13.5, fontWeight: 700, color: C.accent }}>
          {allSelected ? "Deselect All" : "Select All"}
        </button>
      </div>
      <div style={{ padding: "14px 20px 6px" }}>
        <ClearableInput
          value={query} onChangeText={setQuery} placeholder="Search title or artist"
          leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
          style={{ ...inputStyle, paddingLeft: 36, paddingRight: query ? 36 : 14 }}
        />
      </div>
      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", padding: "6px 20px 110px" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>No matches.</div>
        ) : filtered.map((s) => {
          const checked = selected.has(s.id);
          return (
            <div key={s.id} onClick={() => toggle(s.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
              <div style={{ width: 21, height: 21, borderRadius: "50%", border: `1.5px solid ${checked ? C.accent : C.borderStrong}`, background: checked ? C.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {checked && <Check size={14} color="#fff" />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15.5, fontWeight: 600 }}>{s.title}</div>
                <div style={{ fontSize: 12.5, color: C.textMuted }}>{s.artist || "Unknown"}</div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.accent }}>{keyLabel(s)}</div>
            </div>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 20, right: 20, bottom: 24 }}>
        <button disabled={selected.size === 0} onClick={() => onExport([...selected])} style={{
          width: "100%", fontFamily: FONT, fontWeight: 700, fontSize: 15, padding: "15px 0", borderRadius: 14, border: "none",
          background: selected.size ? C.accent : C.surface2, color: selected.size ? "#fff" : C.textFaint,
        }}>
          Export{selected.size > 0 ? ` (${selected.size})` : ""}
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   Modal shell — bottom sheet.
   ========================================================================= */
function Modal({ title, onClose, children }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "flex-end" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)" }} />
      <div className="scroll-list" style={{ position: "relative", width: "100%", background: C.surface2, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 32, fontFamily: FONT, color: C.text, maxHeight: "80vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{title}</div>
          <button onClick={onClose} style={iconBtnStyle}><X size={18} color={C.textMuted} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* =========================================================================
   Swipe-to-delete row.
   ========================================================================= */
const SWIPE_REVEAL = 76;
function SwipeToDelete({ id, openId, onOpenIdChange, onDelete, children, icon: RevealIcon = Trash2 }) {
  const [translateX, setTranslateX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startTranslateRef = useRef(0);
  const movedRef = useRef(false);
  const directionRef = useRef(null);
  const isOpen = openId === id;

  useEffect(() => { if (!isOpen) setTranslateX(0); }, [isOpen]);

  const handleTouchStart = (e) => {
    if (openId !== null && openId !== id) onOpenIdChange(null);
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
      <div
        onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} onClickCapture={handleContentClickCapture}
        style={{ transform: `translateX(${translateX}px)`, transition: dragging ? "none" : "transform 200ms ease", background: C.bg, touchAction: "pan-y" }}
      >
        {children}
      </div>
    </div>
  );
}

/* =========================================================================
   3-dot menu used in the Song detail header.
   ========================================================================= */
function MenuItem({ icon: Icon, label, onClick, danger }) {
  return (
    <button onClick={onClick} style={{
      width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: "transparent",
      border: "none", fontFamily: FONT, fontSize: 14.5, fontWeight: 600, color: danger ? C.danger : C.text,
      textAlign: "left", whiteSpace: "nowrap",
    }}>
      <Icon size={15} color={danger ? C.danger : C.textMuted} />
      {label}
    </button>
  );
}
function KebabMenu({ onEdit, onShare, onDelete, isInSetlist, onRemoveFromSetlist, deleteConfirmMessage = "Delete this song?" }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} style={circleBtnStyle}>
        <MoreVertical size={16} color={C.text} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 110 }} />
          <div style={{
            position: "absolute", top: "110%", right: 0, zIndex: 120, width: "max-content",
            background: C.surface3, border: `1px solid ${C.borderStrong}`, borderRadius: 12,
            overflow: "hidden", boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
          }}>
            <MenuItem icon={Pencil} label="Edit" onClick={() => { setOpen(false); onEdit(); }} />
            <MenuItem icon={IosShareIcon} label="Share" onClick={() => { setOpen(false); onShare(); }} />
            {isInSetlist ? (
              <MenuItem icon={X} label="Remove" danger onClick={() => { setOpen(false); if (window.confirm("Remove this song from the setlist?")) onRemoveFromSetlist(); }} />
            ) : (
              <MenuItem icon={Trash2} label="Delete" danger onClick={() => { setOpen(false); if (window.confirm(deleteConfirmMessage)) onDelete(); }} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* =========================================================================
   Song detail / chart viewer.
   - Header: back / title+artist / 3-dot menu (Edit, Share, Delete)
   - Index row (frozen): time sig, tempo, key button (tap toggles
     Numbers<->Chords) with semitone chevrons either side, description
     dropdown toggle
   - Only the description + chart scroll; header and index row stay put
   - Key changes here never touch the song's stored key. If opened from a
     setlist, changes are written to that setlist entry instead and persist
     there until the song is removed from the setlist.
   ========================================================================= */
function SongDetailScreen({ song, contextKey, onKeyChange, onBack, onEdit, onDelete, onShare, fontSize, textAlign, bold, isInSetlist, onRemoveFromSetlist, onPrevSong, onNextSong }) {
  const [viewKey, setViewKey] = useState(contextKey ?? song.key);
  const [mode, setMode] = useState("numbers");
  const [descOpen, setDescOpen] = useState(false);

  useEffect(() => { setViewKey(contextKey ?? song.key); }, [song.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Inside a setlist, the back arrow button already covers "leave this
  // song" — edge-swipe-back is disabled there so it doesn't compete with
  // swiping to the previous/next song in the setlist instead. Outside a
  // setlist there's no prev/next to go to, so edge-swipe-back is kept.
  const edgeBack = useEdgeSwipeBack(onBack);
  const setlistSwipe = useSetlistSongSwipe(onPrevSong, onNextSong);
  const { dragX, leaving, handlers } = isInSetlist
    ? { dragX: setlistSwipe.dragX, leaving: false, handlers: setlistSwipe.handlers }
    : edgeBack;

  const stepKey = (delta) => {
    const next = transposeKey(viewKey, delta);
    setViewKey(next);
    if (onKeyChange) onKeyChange(next);
  };

  const labelFontSize = Math.max(10, Math.min(18, Math.round(fontSize * 0.5)));
  const badgeStyle = { fontSize: 12.5, color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 10px", fontWeight: 600, whiteSpace: "nowrap" };
  const chevronBtn = { width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", color: C.text, flexShrink: 0 };
  const isChordsMode = mode === "chords";
  const keyButtonStyle = {
    minWidth: 56, height: 30, padding: "0 10px", borderRadius: 8, fontFamily: FONT, fontWeight: 800, fontSize: 14,
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    border: `1px solid ${isChordsMode ? C.accentDim : C.border}`,
    background: isChordsMode ? C.accentSoft : C.surface2,
    color: isChordsMode ? C.accent : C.text,
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 100,
        display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top, 0px)", boxSizing: "border-box",
        transform: `translateX(${dragX}px)`,
        transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none",
        touchAction: "pan-y",
      }}
      {...handlers}
    >
      <div style={{ flex: "0 0 auto", padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}><ChevronLeft size={22} /></button>
        <div style={{ flex: 1, minWidth: 0, textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</div>
          {song.artist && <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.artist}</div>}
        </div>
        <KebabMenu
          onEdit={() => onEdit(song)}
          onShare={() => onShare(song)}
          onDelete={() => onDelete(song.id)}
          isInSetlist={isInSetlist}
          onRemoveFromSetlist={onRemoveFromSetlist}
        />
      </div>

      <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
        {song.timeSignature && <span style={badgeStyle}>{song.timeSignature}</span>}
        {song.tempo !== "" && song.tempo != null && <span style={badgeStyle}>{song.tempo} BPM</span>}
        <div style={{ flex: 1 }} />
        <button onClick={() => stepKey(-1)} style={chevronBtn}><ChevronLeft size={16} /></button>
        <button onClick={() => setMode((m) => (m === "numbers" ? "chords" : "numbers"))} style={keyButtonStyle}>
          {flatify(`${viewKey}${song.keyQuality === "Minor" ? "m" : ""}`)}
        </button>
        <button onClick={() => stepKey(1)} style={chevronBtn}><ChevronRight size={16} /></button>
        {song.description && (
          <button onClick={() => setDescOpen((o) => !o)} style={chevronBtn}>
            <ChevronDown size={16} style={{ transform: descOpen ? "rotate(180deg)" : "none", transition: "transform 150ms ease" }} />
          </button>
        )}
      </div>

      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", padding: "16px 20px 40px" }}>
        {descOpen && song.description && (
          <div style={{ marginBottom: 18, padding: "11px 13px", background: C.surface2, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.accent}`, borderRadius: 8, fontSize: 13.5, color: C.textMuted, whiteSpace: "pre-wrap" }}>
            {song.description}
          </div>
        )}

        {song.sections.map((sec, idx) => (
          <div key={sec.id} style={{ marginBottom: 20, paddingTop: idx > 0 ? 16 : 0, borderTop: idx > 0 ? `1px solid ${C.border}` : "none" }}>
            <div style={{ fontSize: labelFontSize, letterSpacing: 1.5, textTransform: "uppercase", color: C.accent, marginBottom: 8, textAlign }}>
              {sec.label || "Section"}
            </div>
            <pre style={{ fontFamily: MONO, fontSize, fontWeight: bold ? 700 : 400, lineHeight: 1.75, whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, textAlign }}>
              {mode === "chords" ? flatify(blockToChords(sec.numbers, viewKey, song.keyQuality)) || "\u2014" : renderNumberTokens(sec.numbers)}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

/* =========================================================================
   Setlist song row — same visual layout as the Songs list, showing the
   in-setlist key (override if set, otherwise the song's own key).
   ========================================================================= */
function SetlistSongRow({ song, keyOverride, style, handlers, onClick }) {
  return (
    <div
      onClick={onClick}
      {...handlers}
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 28px 12px 20px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", position: "relative", ...style }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.artist || "Unknown"}</div>
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color: C.accent, border: `1px solid ${C.accentDim}`, borderRadius: 6, padding: "3px 7px", flexShrink: 0 }}>
        {flatify(`${keyOverride || song.key}${song.keyQuality === "Minor" ? "m" : ""}`)}
      </span>
    </div>
  );
}

/* =========================================================================
   Setlist stage — ordered song list, press-and-hold to reorder, swipe to
   remove. Positioned to leave the bottom nav visible (only Song detail
   hides it). Share button next to the pencil exports the whole setlist.
   ========================================================================= */
function SetlistStageScreen({ setlist, songs, onBack, onUpdateSetlist, onOpenSong, onShare, onDeleteSetlist, initialPickerOpen }) {
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

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed) onUpdateSetlist({ ...setlist, name: trimmed });
    setEditingName(false);
  };
  const startNameLongPress = () => {
    if (nameLongPressTimerRef.current) clearTimeout(nameLongPressTimerRef.current);
    nameLongPressTimerRef.current = setTimeout(() => { setNameDraft(setlist.name); setEditingName(true); }, 500);
  };
  const cancelNameLongPress = () => { if (nameLongPressTimerRef.current) { clearTimeout(nameLongPressTimerRef.current); nameLongPressTimerRef.current = null; } };

  const setlistSongs = setlist.entries.map((e) => {
    const song = songs.find((s) => s.id === e.songId);
    return song ? { song, keyOverride: e.keyOverride } : null;
  }).filter(Boolean);

  const removeFromStage = (songId) => onUpdateSetlist({ ...setlist, entries: setlist.entries.filter((e) => e.songId !== songId) });
  const toggleSong = (songId) => {
    const has = setlist.entries.some((e) => e.songId === songId);
    onUpdateSetlist({
      ...setlist,
      entries: has ? setlist.entries.filter((e) => e.songId !== songId) : [...setlist.entries, { songId, keyOverride: null }],
    });
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
    if (activeDragIndex === null) {
      if (Math.abs(clientY - startYRef.current) > 10) clearTimeout(dragTimerRef.current);
    } else {
      e.preventDefault(); e.stopPropagation();
      const deltaY = clientY - startYRef.current;
      setDragY(deltaY);
      const rowHeight = 60;
      const total = setlistSongs.length;
      if (deltaY > rowHeight / 2 && idx < total - 1) {
        const next = [...setlist.entries];
        [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
        onUpdateSetlist({ ...setlist, entries: next });
        startYRef.current += rowHeight; setActiveDragIndex(idx + 1); setDragY(clientY - startYRef.current);
      } else if (deltaY < -rowHeight / 2 && idx > 0) {
        const next = [...setlist.entries];
        [next[idx], next[idx - 1]] = [next[idx - 1], next[idx]];
        onUpdateSetlist({ ...setlist, entries: next });
        startYRef.current -= rowHeight; setActiveDragIndex(idx - 1); setDragY(clientY - startYRef.current);
      }
    }
  };
  const handleSongTouchEnd = () => {
    if (dragTimerRef.current) clearTimeout(dragTimerRef.current);
    if (activeDragIndex !== null) justDraggedRef.current = true;
    setActiveDragIndex(null); setDragY(0);
  };

  return (
    <div
      style={{
        position: "fixed", top: 0, left: 0, right: 0, bottom: "calc(55px + max(36px, 8px + env(safe-area-inset-bottom, 0px)))", background: C.bg, color: C.text, fontFamily: FONT, zIndex: 80,
        display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top, 0px)", boxSizing: "border-box",
        transform: `translateX(${dragX}px)`,
        transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none",
      }}
      {...handlers}
    >
      <div style={{ padding: "16px 16px 12px", display: "flex", alignItems: "center", gap: 6 }}>
        <button onClick={onBack} style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", color: C.textMuted, flexShrink: 0 }}>
          <ChevronLeft size={22} />
        </button>
        {editingName ? (
          <input autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onBlur={commitName}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            style={{ flex: 1, fontFamily: FONT, fontSize: 16, fontWeight: 700, background: "transparent", border: "none", color: C.text, textAlign: "center", padding: "6px 10px", textTransform: "uppercase", letterSpacing: 0.5, outline: "none" }} />
        ) : (
          <button onTouchStart={startNameLongPress} onTouchMove={cancelNameLongPress} onTouchEnd={cancelNameLongPress} onTouchCancel={cancelNameLongPress}
            onMouseDown={startNameLongPress} onMouseUp={cancelNameLongPress} onMouseLeave={cancelNameLongPress}
            style={{ flex: 1, textAlign: "center", fontSize: 16, fontWeight: 700, padding: "0 4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: 0.5, background: "none", border: "none", color: C.text }}>
            {setlist.name}
          </button>
        )}
        <KebabMenu
          onEdit={() => setPickerOpen(true)}
          onShare={onShare}
          onDelete={() => { onDeleteSetlist(setlist.id); onBack(); }}
          deleteConfirmMessage="Delete this setlist?"
        />
      </div>

      <div className="scroll-list" style={{ flex: 1, overflowY: activeDragIndex !== null ? "hidden" : "auto", padding: "8px 0 12px", touchAction: activeDragIndex !== null ? "none" : "pan-y" }}>
        {setlistSongs.length === 0 ? (
          <div style={{ textAlign: "center", padding: "36px 20px", color: C.textFaint, fontSize: 13 }}>No songs added yet.</div>
        ) : setlistSongs.map(({ song: s, keyOverride }, idx) => {
          const isDraggingThis = activeDragIndex === idx;
          return (
            <SwipeToDelete key={s.id} id={s.id} openId={openSwipeId} onOpenIdChange={setOpenSwipeId} onDelete={() => removeFromStage(s.id)} icon={X}>
              <SetlistSongRow
                song={s}
                keyOverride={keyOverride}
                onClick={() => { if (justDraggedRef.current) { justDraggedRef.current = false; return; } if (activeDragIndex === null) onOpenSong(s); }}
                handlers={{
                  onTouchStart: (e) => handleSongTouchStart(idx, e),
                  onTouchMove: (e) => handleSongTouchMove(idx, e),
                  onTouchEnd: handleSongTouchEnd,
                  onTouchCancel: handleSongTouchEnd,
                }}
                style={{
                  transform: isDraggingThis ? `translateY(${dragY}px)` : "none",
                  zIndex: isDraggingThis ? 100 : 1,
                  background: isDraggingThis ? C.surface3 : C.bg,
                  boxShadow: isDraggingThis ? "0 8px 24px rgba(0,0,0,0.6)" : "none",
                  transition: isDraggingThis ? "none" : "transform 0.15s ease, background 0.15s ease",
                }}
              />
            </SwipeToDelete>
          );
        })}
      </div>

      {pickerOpen && (
        <SongPickerScreen
          songs={songs} selectedIds={setlist.entries.map((e) => e.songId)} onToggle={toggleSong}
          onClose={() => setPickerOpen(false)} setlistName={setlist.name}
          onRenameSetlist={(name) => onUpdateSetlist({ ...setlist, name })}
        />
      )}
    </div>
  );
}

function SetlistsScreen({ setlists, onOpenStage, onCreate, onDelete, creating, setCreating }) {
  const [name, setName] = useState("");
  const [openSwipeId, setOpenSwipeId] = useState(null);
  const [query, setQuery] = useState("");

  const submit = () => { if (name.trim()) onCreate(name.trim()); setName(""); setCreating(false); };
  const filtered = setlists.filter((sl) => sl.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 auto", padding: "22px 20px 14px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700 }}>Setlists</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{setlists.length} setlist{setlists.length === 1 ? "" : "s"}</div>
          </div>
          <button onClick={() => setCreating(true)} style={circleBtnStyle}>
            <Plus size={17} color={C.accent} />
          </button>
        </div>
        <div style={{ marginTop: 16 }}>
          <ClearableInput
            value={query} onChangeText={setQuery} placeholder="Search setlists"
            leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
            style={{ ...inputStyle, paddingLeft: 36, paddingRight: query ? 36 : 14 }}
          />
        </div>
      </div>
      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", padding: "0 20px 14px", boxSizing: "border-box" }}>
        {filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>{setlists.length === 0 ? "No setlists yet." : "No matches."}</div>
        )}
        {[...filtered].reverse().map((sl) => (
          <SwipeToDelete key={sl.id} id={sl.id} openId={openSwipeId} onOpenIdChange={setOpenSwipeId} onDelete={() => onDelete(sl.id)}>
            <div onClick={() => onOpenStage(sl.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{sl.name}</div>
                <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>{sl.entries.length} song{sl.entries.length === 1 ? "" : "s"}</div>
              </div>
            </div>
          </SwipeToDelete>
        ))}
      </div>
      {creating && (
        <Modal title="New Setlist" onClose={() => setCreating(false)}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Setlist name" style={inputStyle} />
          <button onClick={submit} disabled={!name.trim()} style={{
            marginTop: 14, width: "100%", fontFamily: FONT, fontWeight: 700, fontSize: 15, padding: "14px 0", borderRadius: 12, border: "none",
            background: name.trim() ? C.accent : C.surface3, color: name.trim() ? "#fff" : C.textFaint,
          }}>
            CREATE
          </button>
        </Modal>
      )}
    </div>
  );
}

/* =========================================================================
   Settings — font size, text alignment, import/export.
   ========================================================================= */
function SettingsScreen({ fontSize, setFontSize, textAlign, setTextAlign, bold, setBold, onImportFile, onExportOpen }) {
  const fileRef = useRef(null);
  const alignOptions = [
    { id: "left", Icon: AlignLeft },
    { id: "center", Icon: AlignCenter },
    { id: "right", Icon: AlignRight },
  ];
  // Same formula the real Song View uses for its section-header size, so
  // this preview is a true 1:1 match, not an approximation.
  const labelFontSize = Math.max(10, Math.min(18, Math.round(fontSize * 0.5)));
  const rowBtnStyle = {
    display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "14px 16px", borderRadius: 12,
    border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontFamily: FONT, fontSize: 15, fontWeight: 600,
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 auto", padding: "22px 20px 14px", boxSizing: "border-box" }}>
        <div style={{ fontSize: 26, fontWeight: 700 }}>Settings</div>
      </div>
      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", padding: "0 20px 40px", boxSizing: "border-box", display: "flex", flexDirection: "column" }}>
        <SectionLabel>DISPLAY</SectionLabel>
        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 26, display: "flex", flexDirection: "column", gap: 18 }}>
          <Field label="TEXT SIZE">
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1, height: 44, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 10, padding: "0 4px" }}>
                <button onClick={() => setFontSize((f) => Math.max(14, f - 2))} style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Minus size={16} color={C.text} />
                </button>
                <div style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fontSize}px</div>
                <button onClick={() => setFontSize((f) => Math.min(40, f + 2))} style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Plus size={16} color={C.text} />
                </button>
              </div>
              <button onClick={() => setBold((b) => !b)} style={{
                width: 44, height: 44, borderRadius: 10, flexShrink: 0,
                border: `1px solid ${bold ? C.accent : C.border}`, background: bold ? C.accentSoft : C.surface3,
                color: bold ? C.accent : C.text, fontFamily: FONT, fontSize: 16, fontWeight: 800,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                B
              </button>
            </div>
          </Field>
          <Field label="TEXT ALIGNMENT">
            <div style={{ display: "flex", gap: 8 }}>
              {alignOptions.map(({ id, Icon }) => {
                const active = textAlign === id;
                return (
                  <button key={id} onClick={() => setTextAlign(id)} style={{
                    flex: 1, height: 44, borderRadius: 10, border: `1px solid ${active ? C.accent : C.border}`,
                    background: active ? C.accentSoft : C.surface3, color: active ? C.accent : C.text, display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <Icon size={16} />
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="PREVIEW">
            <div style={{ background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: labelFontSize, letterSpacing: 1.5, textTransform: "uppercase", color: C.accent, marginBottom: 8, textAlign }}>
                Chorus
              </div>
              <pre style={{
                margin: 0, fontFamily: MONO, fontSize, fontWeight: bold ? 700 : 400, textAlign,
                lineHeight: 1.75, whiteSpace: "pre-wrap", wordBreak: "break-word", color: C.text,
              }}>
                {"1        4\n6m       4"}
              </pre>
            </div>
          </Field>
        </div>

        <SectionLabel>LIBRARY</SectionLabel>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => fileRef.current?.click()} style={{ ...rowBtnStyle, flex: 1, justifyContent: "center" }}>
            <Download size={16} color={C.accent} /> Import
          </button>
          <input ref={fileRef} type="file" accept="application/json" onChange={(e) => { if (e.target.files[0]) onImportFile(e.target.files[0]); e.target.value = ""; }} style={{ display: "none" }} />
          <button onClick={onExportOpen} style={{ ...rowBtnStyle, flex: 1, justifyContent: "center" }}>
            <Upload size={16} color={C.accent} /> Export
          </button>
        </div>

        <div style={{ flex: 1 }} />
        <div style={{ textAlign: "center", fontSize: 11.5, color: C.textFaint, paddingTop: 24 }}>
          Created by Benjamin Hanigraf
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   Toast
   ========================================================================= */
function Toast({ message }) {
  if (!message) return null;
  return (
    <div style={{
      position: "absolute", left: "50%", transform: "translateX(-50%)", bottom: 100,
      background: C.surface3, border: `1px solid ${C.borderStrong}`, padding: "10px 18px", borderRadius: 999,
      fontSize: 13.5, fontWeight: 600, zIndex: 300, whiteSpace: "nowrap", boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
    }}>
      {message}
    </div>
  );
}

/* =========================================================================
   Bottom nav — Piano / Songs / Setlists / Settings.
   ========================================================================= */
function BottomNav({ active, onChange }) {
  const items = [
    { id: "piano", label: "Piano", icon: PianoIcon },
    { id: "songs", label: "Songs", icon: ListMusic },
    { id: "setlists", label: "Setlists", icon: Layers },
    { id: "settings", label: "Settings", icon: SettingsIcon },
  ];
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
export default function App() {
  const [songs, setSongs] = useIndexedDbState("songs", SEED_SONGS);
  const [setlists, setSetlists] = useIndexedDbState("setlists", SEED_SETLISTS);
  const [fontSize, setFontSize] = useLocalStorageState("setlist-click:font-size", 22);
  const [textAlign, setTextAlign] = useLocalStorageState("setlist-click:text-align", "left");
  const [bold, setBold] = useLocalStorageState("setlist-click:bold", false);

  const [tab, setTab] = useState("songs"); // default page is Songs
  const [editingSong, setEditingSong] = useState(undefined); // undefined = closed, null = new, obj = edit
  const [viewing, setViewing] = useState(null); // { songId, fromSetlistId } | null
  const [stageIndex, setStageIndex] = useState(null);
  const [stageAutoOpenPicker, setStageAutoOpenPicker] = useState(false);
  const [creatingSetlist, setCreatingSetlist] = useState(false);
  const [exportPickerOpen, setExportPickerOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState("");

  const rootRef = useRef(null);
  // On a real desktop browser window or an iPad turned to landscape, fill
  // the actual screen instead of staying capped at the phone-width column.
  // Portrait screens (phone or iPad) are left exactly as before.
  const isLandscapeScreen = useIsLandscapeScreen();

  // Disable pinch-zoom gestures (Safari gesture events + generic multi-touch).
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

  const flash = (msg) => { setToastMsg(msg); setTimeout(() => setToastMsg(""), 2000); };

  const viewingSong = viewing ? songs.find((s) => s.id === viewing.songId) : null;
  const viewingSetlist = viewing?.fromSetlistId ? setlists.find((sl) => sl.id === viewing.fromSetlistId) : null;
  const viewingEntry = viewingSetlist ? viewingSetlist.entries.find((e) => e.songId === viewing.songId) : null;
  const viewingSetlistIndex = viewingSetlist ? viewingSetlist.entries.findIndex((e) => e.songId === viewing.songId) : -1;
  const prevSetlistSongId = viewingSetlist && viewingSetlistIndex > 0 ? viewingSetlist.entries[viewingSetlistIndex - 1].songId : null;
  const nextSetlistSongId = viewingSetlist && viewingSetlistIndex >= 0 && viewingSetlistIndex < viewingSetlist.entries.length - 1
    ? viewingSetlist.entries[viewingSetlistIndex + 1].songId
    : null;

  const handleTabChange = (next) => { setTab(next); setStageIndex(null); setViewing(null); };

  const handleSaveSong = (data) => {
    if (editingSong) setSongs(songs.map((s) => (s.id === editingSong.id ? { ...s, ...data } : s)));
    else {
      const newSong = { id: uid(), ...data };
      setSongs([...songs, newSong]);
      setViewing({ songId: newSong.id, fromSetlistId: null });
    }
    setEditingSong(undefined);
  };
  const handleDeleteSong = (id) => {
    setSongs(songs.filter((s) => s.id !== id));
    setSetlists(setlists.map((sl) => ({ ...sl, entries: sl.entries.filter((e) => e.songId !== id) })));
    setEditingSong(undefined);
    if (viewing?.songId === id) setViewing(null);
  };
  const handleCreateSetlist = (name) => {
    const next = [...setlists, { id: uid(), name, entries: [] }];
    setSetlists(next);
    setStageAutoOpenPicker(true);
    setStageIndex(next.length - 1);
  };
  const handleDeleteSetlist = (id) => setSetlists(setlists.filter((sl) => sl.id !== id));
  const handleUpdateSetlist = (updated) => setSetlists(setlists.map((sl) => (sl.id === updated.id ? updated : sl)));
  const handleRemoveSongFromSetlist = (setlistId, songId) => {
    setSetlists(setlists.map((sl) => (sl.id !== setlistId ? sl : { ...sl, entries: sl.entries.filter((e) => e.songId !== songId) })));
    setViewing(null);
  };
  const handleKeyOverrideChange = (setlistId, songId, newKey) => {
    setSetlists(setlists.map((sl) => (sl.id !== setlistId ? sl : {
      ...sl, entries: sl.entries.map((e) => (e.songId === songId ? { ...e, keyOverride: newKey } : e)),
    })));
  };

  const exportSongsByIds = async (ids) => {
    const chosen = songs.filter((s) => ids.includes(s.id));
    const result = await shareOrDownloadJSON(`Songs_Export.json`, {
      type: "songs",
      exportedAt: new Date().toISOString(),
      instructions: "Import into the Songs library. Each song is added as-is; if its title + artist already exists on the importing device, a \" (n)\" suffix is appended to the title so both copies are kept.",
      songs: chosen,
    });
    if (result === "cancelled") return;
    flash(result === "shared" ? `Shared ${chosen.length} song${chosen.length === 1 ? "" : "s"}` : `Downloaded ${chosen.length} song${chosen.length === 1 ? "" : "s"}`);
  };
  const exportSingleSong = async (song) => {
    const result = await shareOrDownloadJSON(`${song.title}.json`, {
      type: "songs",
      exportedAt: new Date().toISOString(),
      instructions: "Import into the Songs library. If this title + artist already exists on the importing device, a \" (n)\" suffix is appended to the title so both copies are kept.",
      songs: [song],
    });
    if (result === "cancelled") return;
    flash(result === "shared" ? "Shared song" : "Downloaded song");
  };
  const exportSetlist = async (setlist) => {
    const entries = setlist.entries
      .map((e) => ({ song: songs.find((s) => s.id === e.songId), keyOverride: e.keyOverride }))
      .filter((e) => e.song);
    const result = await shareOrDownloadJSON(`${setlist.name}.json`, {
      type: "setlist",
      exportedAt: new Date().toISOString(),
      instructions: "Import this file as a new setlist automatically (do not open a plain song picker). For each song in `setlist.entries`: if a song with the same title + artist (case-insensitive) already exists on the importing device, reuse it as-is and do not create a duplicate. If it doesn't exist, add it to the Songs library with its original key exactly as included here, then add it to the new setlist. Each song's `keyOverride`, if any, only affects how it appears inside this setlist and should not change the song's own stored key.",
      setlist: { name: setlist.name, entries },
    });
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
    setSongs(working);
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
      const existing = working.find(
        (s) => s.title.toLowerCase() === title.toLowerCase() && (s.artist || "").toLowerCase() === artist.toLowerCase()
      );
      let songId;
      if (existing) {
        songId = existing.id;
      } else {
        const finalTitle = dedupeTitle(title, artist, working);
        const song = { ...raw, id: uid(), title: finalTitle, artist };
        working.push(song);
        songId = song.id;
      }
      newEntries.push({ songId, keyOverride: e.keyOverride ?? null });
    });
    setSongs(working);
    setSetlists([...setlists, { id: uid(), name: pkg.name || "Imported Setlist", entries: newEntries }]);
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
    <div
      ref={rootRef}
      style={{
        position: "fixed", top: 0, left: 0, right: 0, bottom: 0, height: "100dvh", width: "100%", maxWidth: isLandscapeScreen ? "none" : 390,
        margin: "0 auto", background: C.bg, color: C.text, fontFamily: FONT, overflow: "hidden",
        border: "none", boxSizing: "border-box", touchAction: "pan-x pan-y",
        paddingTop: "env(safe-area-inset-top, 0px)",
      }}
    >
      <style>{`
        html, body { position: fixed; inset: 0; overflow: hidden; overscroll-behavior: none; background: ${C.bg}; }
        .bpm-number-input::-webkit-outer-spin-button, .bpm-number-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        .bpm-number-input { -moz-appearance: textfield; }
        button { -webkit-tap-highlight-color: transparent; transition: transform 90ms ease, opacity 90ms ease; -webkit-touch-callout: none; }
        button:active { transform: scale(0.94); opacity: 0.8; }
        input:focus, textarea:focus { outline: none; border-color: ${C.accent}; box-shadow: 0 0 0 2px ${C.accentDim}; }
        input::placeholder, textarea::placeholder { color: ${C.textFaint}; opacity: 1; }
        * { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
        input, textarea { -webkit-user-select: text; user-select: text; }
        .scroll-list { -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain; }
        *::-webkit-scrollbar { display: none; }
        * { scrollbar-width: none; -ms-overflow-style: none; }
      `}</style>

      <div style={{ paddingBottom: "calc(55px + max(36px, 8px + env(safe-area-inset-bottom, 0px)))", height: "100%", overflow: "hidden", boxSizing: "border-box" }}>
        {tab === "piano" && <PianoScreen />}
        {tab === "songs" && (
          <SongsScreen songs={songs} onOpen={(s) => setViewing({ songId: s.id, fromSetlistId: null })} onAdd={() => setEditingSong(null)} onEdit={(s) => setEditingSong(s)} />
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
        {tab === "settings" && (
          <SettingsScreen
            fontSize={fontSize} setFontSize={setFontSize}
            textAlign={textAlign} setTextAlign={setTextAlign}
            bold={bold} setBold={setBold}
            onImportFile={importFile}
            onExportOpen={() => setExportPickerOpen(true)}
          />
        )}
      </div>

      {!creatingSetlist && <BottomNav active={tab} onChange={handleTabChange} />}

      {editingSong !== undefined && (
        <SongForm initial={editingSong} onSave={handleSaveSong} onCancel={() => setEditingSong(undefined)} onDelete={handleDeleteSong} songs={songs} />
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
          fontSize={fontSize}
          textAlign={textAlign}
          bold={bold}
        />
      )}

      {stageIndex !== null && setlists[stageIndex] && (
        <SetlistStageScreen
          setlist={setlists[stageIndex]}
          songs={songs}
          onBack={() => setStageIndex(null)}
          onUpdateSetlist={handleUpdateSetlist}
          onOpenSong={(s) => setViewing({ songId: s.id, fromSetlistId: setlists[stageIndex].id })}
          onShare={() => exportSetlist(setlists[stageIndex])}
          onDeleteSetlist={handleDeleteSetlist}
          initialPickerOpen={stageAutoOpenPicker}
        />
      )}

      {exportPickerOpen && (
        <SongExportPicker songs={songs} onClose={() => setExportPickerOpen(false)} onExport={(ids) => { exportSongsByIds(ids); setExportPickerOpen(false); }} />
      )}

      <Toast message={toastMsg} />
    </div>
  );
}