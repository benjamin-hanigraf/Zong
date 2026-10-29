import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  Search, Plus, Pencil, Trash2, ChevronLeft, ChevronRight, ChevronDown, Play, Square,
  ListMusic, Layers, Minus, AlignLeft, AlignCenter, AlignRight, Check, X,
  Settings as SettingsIcon, Copy, Save, RefreshCw, AlertTriangle,
} from "lucide-react";
import {
  syncLibrary, subscribeToChanges, isSupabaseConfigured, leaveTeam, checkIsOnlyTeamMember, ensureTeamRow,
  recordDeletedSongId, recordDeletedSpellingKey, markSongsDirty, markSpellingDirty,
  markSharedPending, markSharedDeleted, getPendingSharedIds, getDeletedSharedIds, getDirtySongIds,
  getDirtySpellingKeys, clearSharedQueues,
} from "./supabaseSync";
import { isNativePlatform, nativeMetronome, nativePiano } from "./nativeMetronome";

function getDeviceId() {
  if (typeof localStorage === "undefined") return "dev_default";
  let id = localStorage.getItem("zong:device-id");
  if (!id) {
    id = "dev_" + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
    localStorage.setItem("zong:device-id", id);
  }
  return id;
}

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
  const [ready, setReady] = useState(false);
  const loadedRef = useRef(false);
  const writableRef = useRef(false);   // true only once the stored value was read successfully
  const queuedRef = useRef([]);        // updates requested before the stored value was read
  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const finish = (stored, ok) => {
      if (cancelled || settled) return;
      settled = true;
      let base = stored !== undefined ? stored : seed;
      loadedRef.current = true;
      writableRef.current = ok;
      // Apply anything requested while loading ON TOP of the stored data, so an early
      // update (e.g. a sync result) can never overwrite what was saved on this device.
      const queued = queuedRef.current;
      queuedRef.current = [];
      queued.forEach((next) => { base = typeof next === "function" ? next(base) : next; });
      setValue(base);
      setReady(true);
      if (ok && (stored === undefined || queued.length)) idbSet(key, base).catch(() => { });
    };
    idbGet(key).then((stored) => finish(stored, true), () => finish(undefined, false));
    // If storage never answers, carry on in memory — but never write in that case, so the
    // data already stored on the device cannot be overwritten by an incomplete copy.
    const timeout = setTimeout(() => finish(undefined, false), 15000);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const persist = useCallback((next) => {
    if (!loadedRef.current) { queuedRef.current.push(next); return; }
    setValue((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      if (writableRef.current) idbSet(key, resolved).catch(() => { });
      return resolved;
    });
  }, [key]);
  return [value, persist, ready];
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
const MODES = ["vocals", "chords", "drums"]; // display order for the Settings tab-select
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
  { id: "sharp", name: "Sharp" },
  { id: "cowbell", name: "Cowbell" },
];
// Per-song beat subdivision stored on-device (Requirement 9: saved on-device per song across all modes and events, single beat online)
const SONG_SUBDIVISIONS_KEY = "zong:song-subdivisions";
// Per-song beat accents stored on-device (device-local, not synced to Supabase).
const SONG_ACCENTS_KEY = "zong:song-accents";

function getSongSubdivision(songId) {
  if (!songId) return 1;
  try {
    const map = JSON.parse(localStorage.getItem(SONG_SUBDIVISIONS_KEY) || "{}");
    return Number(map[songId]) || 1;
  } catch {
    return 1;
  }
}

function setSongSubdivision(songId, sub) {
  if (!songId) return;
  try {
    const map = JSON.parse(localStorage.getItem(SONG_SUBDIVISIONS_KEY) || "{}");
    map[songId] = Number(sub) || 1;
    localStorage.setItem(SONG_SUBDIVISIONS_KEY, JSON.stringify(map));
  } catch { }
}

function getSongAccents(songId, beats) {
  if (!songId) return defaultAccents(beats ?? 4);
  try {
    const map = JSON.parse(localStorage.getItem(SONG_ACCENTS_KEY) || "{}");
    const stored = map[songId];
    if (Array.isArray(stored) && (!beats || stored.length === beats)) return stored;
  } catch { }
  return defaultAccents(beats ?? 4);
}

function setSongAccentsLocal(songId, accents) {
  if (!songId) return;
  try {
    const map = JSON.parse(localStorage.getItem(SONG_ACCENTS_KEY) || "{}");
    map[songId] = accents;
    localStorage.setItem(SONG_ACCENTS_KEY, JSON.stringify(map));
  } catch { }
}
const PAN_OPTIONS = [
  { id: "left", label: "Left" },
  { id: "center", label: "Centre" },
  { id: "right", label: "Right" },
];
const DEFAULT_CLICK_SETTINGS = { clickTone: "classic", pan: "center" };

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
function isSingleChordSymbol(word) {
  // Allow optional leading 'b' for flat-prefix notation (bA = Ab, bE = Eb)
  let s = String(word || "").trim();
  if (!s) return false;
  // Handle flat-prefix: bA, bE, bB etc.
  if (/^b[A-G]/.test(s)) s = s[1] + "b" + s.slice(2); // bA → Ab for further matching
  // Must start with a note letter (A-G) followed by optional accidental
  if (!/^[A-G]/.test(s)) return false;
  // Strip the root (letter + optional accidental)
  const rootMatch = s.match(/^([A-G][#b]?)/);
  if (!rootMatch) return false;
  const suffix = s.slice(rootMatch[0].length);
  // Empty suffix = bare chord like "G", "Ab" — always a chord
  if (!suffix) return true;
  // Slash chord: suffix starts with '/' then an optional root
  // Check if the suffix looks like a known chord quality or is short
  // Reject anything with 4+ consecutive plain letters that look like a word
  // (e.g. "Good", "Great") — but allow known quality keywords.
  const QUALITY_KEYWORDS = /^(?:m(?:in(?:or)?)?|M(?:aj(?:or)?)?|maj(?:or)?|dim|°|aug|\+|sus\d?|add\d+|dom)?\d*(?:\/[A-G][#b]?)?$/i;
  // Exception: block long plain-word suffixes that aren't musical (≥4 non-digit, non-slash chars)
  const plainLetters = suffix.replace(/[\d/]/g, "");
  if (plainLetters.length >= 4 && !QUALITY_KEYWORDS.test(suffix)) return false;
  return true;
};
function flatify(str) {
  let s = String(str ?? "");
  // A flat immediately followed by a sharp (or vice versa) on the same note
  // cancels out to a natural — just the bare letter/digit, no symbol.
  s = s.replace(/([A-G0-9])([b#])([b#])/g, (m, base, a1, a2) => (a1 !== a2 ? base : m));
  // Accidental attached to a note letter (A-G) — e.g. "Bb" -> B♭, "F#" -> F♯.
  s = s.replace(/([A-G])b/g, "$1\u266d");
  s = s.replace(/([A-G])#/g, "$1\u266f");
  // Accidental attached to a Nashville-number digit — e.g. "b7" -> ♭7, "5#9" -> 5♯9.
  s = s.replace(/\bb(?=[0-9])/g, "\u266d");
  s = s.replace(/([0-9])b/g, "$1\u266d");
  s = s.replace(/#(?=[0-9])/g, "\u266f");
  s = s.replace(/([0-9])#/g, "$1\u266f");
  return s;
}

/* =========================================================================
   Small helpers
   ========================================================================= */
const uid = () => "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
function toTitleCase(str) {
  return String(str || "").replace(/(^|[\s.\-_/])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}
function parseTimeSig(str) {
  const m = String(str || "").match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return { beats: 4, unit: 4 };
  return { beats: parseInt(m[1], 10), unit: parseInt(m[2], 10) };
}
const formatTimeSig = (ts) => `${ts.beats}/${ts.unit}`;
const keyLabel = (song) => {
  if (!song.key || song.key === "") return "–";
  return flatify(`${song.key}${song.keyQuality === "Minor" ? "m" : ""}`);
};
function decomposeKey(keyStr) {
  if (!keyStr) return { natural: "", accidental: "natural" };
  const natural = keyStr[0];
  const suffix = keyStr.slice(1);
  const accidental = suffix === "b" ? "flat" : suffix === "#" ? "sharp" : "natural";
  return { natural, accidental };
}
const composeKey = (natural, accidental) => natural ? natural + (accidental === "flat" ? "b" : accidental === "sharp" ? "#" : "") : "";
/* =========================================================================
   Tanglish transliteration engine — offline Tamil-script → Latin-script
   conversion. Works at the tokenized [Tag]/character level (reusing the
   same tokenizeTaggedLine parser the chord/drum renderer uses), so every
   [Chord]/[Note] tag gets re-anchored to the exact transliterated position
   of the Tamil character it was originally attached to — including tags
   planted mid-word (e.g. a chord change mid-syllable), not just ones
   sitting before a whole word.

   Tamil script under-specifies pronunciation: க/ச/ட/த/ப each cover BOTH an
   unvoiced sound (k/ch/t/th/p) and a voiced one (g/j/d/dh/b) depending on
   position — the letter alone can't tell you which. We resolve this with:
     1. A reliable positional rule: these consonants voice when they follow
        their own class of nasal in the same cluster (அன்பு "anbu",
        தம்பி "thambi", சொந்தம் "sondham") — this pattern is consistent and
        safe to automate. Elsewhere (word-start, between plain vowels) they
        default to unvoiced, matching how most Tamil hymn/song sheets are
        conventionally transliterated (e.g. "Paavam", "Thuthi", "Parisutha").
     2. An exception dictionary (TANGLISH_EXCEPTIONS) for common words whose
        real pronunciation doesn't follow that default (பயம் "Bayam",
        தேவன் "Devan", தயவு "Dhayavu") — checked whole-word, before the
        positional rule runs. Extend this list any time a specific word
        comes out wrong; it always wins over the algorithm. It only applies
        when the word carries no internal tag (or at most one right at the
        very start) — a tag genuinely mid-word bypasses the dictionary in
        favour of the algorithm, which can always place a tag exactly.
   ========================================================================= */
const TAMIL_RANGE_RE = /[\u0B80-\u0BFF]/;
const TAMIL_COMBINING_RE = /[\u0BBE-\u0BCD]/;
const TANGLISH_PULLI = "\u0BCD";
// ஈ -> "ee" (not "ii"), ஏ -> "ae" (not "ee"), ஓ -> "o" (single letter, not
// "oo"), ஊ -> "oo" (not "uu" — e.g. பூமி -> "Boomi", not "Buumi").
const TANGLISH_VOWELS = {
  "\u0B85": "a", "\u0B86": "aa", "\u0B87": "i", "\u0B88": "ee", "\u0B89": "u", "\u0B8A": "oo",
  "\u0B8E": "e", "\u0B8F": "ae", "\u0B90": "ai", "\u0B92": "o", "\u0B93": "o", "\u0B94": "ou",
  "\u0B83": "h",
};
// Base (unvoiced) forms — used at word-start, when geminated (doubled), and
// anywhere the voicing rule below doesn't apply.
// ச defaults to the "s" sound ("s" is the norm; "ch" is only an exception,
// handled via TANGLISH_EXCEPTIONS for the specific words that need it).
const TANGLISH_CONSONANTS = {
  "\u0B95": "k", "\u0B99": "ng", "\u0B9A": "s", "\u0B9C": "j", "\u0B9E": "nj",
  "\u0B9F": "t", "\u0BA3": "n", "\u0BA4": "th", "\u0BA8": "n", "\u0BA9": "n",
  "\u0BAA": "p", "\u0BAE": "m", "\u0BAF": "y", "\u0BB0": "r", "\u0BB2": "l",
  "\u0BB5": "v", "\u0BB4": "zh", "\u0BB3": "l", "\u0BB1": "r",
  "\u0BB7": "sh", "\u0BB8": "s", "\u0BB9": "h",
};
const TANGLISH_VOWEL_SIGNS = {
  "\u0BBE": "aa", "\u0BBF": "i", "\u0BC0": "ee", "\u0BC1": "u", "\u0BC2": "oo",
  "\u0BC6": "e", "\u0BC7": "ae", "\u0BC8": "ai", "\u0BCA": "o", "\u0BCB": "o", "\u0BCC": "ou",
};
const TANGLISH_DIGITS = {
  "\u0BE6": "0", "\u0BE7": "1", "\u0BE8": "2", "\u0BE9": "3", "\u0BEA": "4",
  "\u0BEB": "5", "\u0BEC": "6", "\u0BED": "7", "\u0BEE": "8", "\u0BEF": "9",
};
// Common worship-song words whose everyday spelling doesn't follow the positional rule above
// (mostly word-initial voicing). Extend freely.
// Entries that were dropped from the built-in list because the transliteration rules already give the
// same spelling; copies saved on a device are cleaned up once (only if the user did not change them).
const REMOVED_SEED_WORDS = {
  "கர்த்தர்": "Karthar",
  "பரிசுத்த": "Parisutha",
  "ஆவியானவர்": "Aaviyaanavar",
  "கிருபை": "Kirubai",
  "கிருபையால்": "Kirubaiyaal",
  "வல்லமை": "Vallamai",
  "ஆராதனை": "Aaraadhanai",
  "ஆராதிக்கிறோம்": "Aaraadhikkirom",
  "நன்றி": "Nandri",
  "மகிழ்ச்சி": "Magizhchi",
  "சமாதானம்": "Samaadhaanam",
  "நித்தியம்": "Nithiyam",
  "பாடுவோம்": "Paaduvom",
  "பாராட்டு": "Paaraattu",
};
const TANGLISH_EXCEPTIONS = {
  "தேவன்": "Devan", "தேவனே": "Devaney", "தேவா": "Deva", "தேவனுடைய": "Devanudaiya",
  "தேவனை": "Devanai", "தேவனிடம்": "Devanidam", "தேவனுக்கு": "Devanukku", "தேவி": "Devi",
  "இயேசு": "Yesu", "இயேசுவே": "Yesuve", "இயேசுவின்": "Yesuvin", "கிறிஸ்து": "Kiristhu",
  "கர்த்தாவே": "Karthave", "கர்த்தரே": "Karthare", "பயம்": "Bayam", "பயமே": "Bayame",
  "பயந்து": "Bayandhu", "தயவு": "Dhayavu", "தயவாய்": "Dhayavaai", "தயவுடன்": "Dhayavudan",
  "கிருபையே": "Kirubaiye", "ஸ்தோத்திரம்": "Sthothiram", "ஸ்தோத்திரிப்போம்": "Sthothirippom", "மகிமை": "Mahimai",
  "மகிமையே": "Mahimaiye", "துதி": "Thuthi", "துதிப்பாய்": "Thuthippaai", "துதிப்போம்": "Thuthippom",
  "கௌரவம்": "Gouravam",
};
// Runtime-mutable copy — replaced by the persisted user dictionary at startup
// and kept in sync whenever the user edits the Spelling Chart.
let activeTanglishExceptions = { ...TANGLISH_EXCEPTIONS };
function setActiveTanglishExceptions(map) { activeTanglishExceptions = map; }
// Transliterates one clean (tag-free) Tamil word into Tanglish, while also
// recording — for every input character index — the output-string offset
// at that exact point. That lets a tag anchored to a specific input
// character later be spliced into the precise corresponding spot in the
// transliterated output, even mid-syllable (between a consonant and its
// own vowel sign).
const KA = "\u0B95";          // க
const NGA = "\u0B99";         // ங
const SA = "\u0B9A";          // ச
const NYA = "\u0B9E";         // ஞ
const TA_RETROFLEX = "\u0B9F"; // ட
const THA = "\u0BA4";         // த
const NNNA = "\u0BA9";        // ன
const PA = "\u0BAA";          // ப
const YA = "\u0BAF";          // ய
const RA_HARD = "\u0BB1";     // ற

// Returns true if the word ends with ச் (ச + pulli, with nothing after).
function wordEndsWithSachPulli(word) {
  const len = word.length;
  return len >= 2 && word[len - 2] === SA && word[len - 1] === TANGLISH_PULLI;
}

function transliterateTamilWordWithOffsets(word, prevWordEndedWithSach = false) {
  let out = "";
  let prevConsonant = "";
  let prevHadPulli = false;
  const offsets = new Array(word.length + 1);
  let i = 0;

  while (i < word.length) {
    offsets[i] = out.length;
    const ch = word[i];

    if (TANGLISH_CONSONANTS[ch]) {
      const next = word[i + 1];
      const isPulli = next === TANGLISH_PULLI;
      const isGeminate = isPulli && word[i + 2] === ch;
      const isAfterTwinPulli = prevConsonant === ch && prevHadPulli;
      const isWordStart = i === 0;

      // Special cluster checks:
      const isGeminateRa = isGeminate && ch === RA_HARD;
      const isNgaCluster = ch === NGA && isPulli && word[i + 2] === KA;
      const isNjaCluster = ch === NYA && isPulli && word[i + 2] === SA;
      const isNraCluster = ch === NNNA && isPulli && word[i + 2] === RA_HARD;
      const isDotaSa = ch === SA && prevConsonant === TA_RETROFLEX && prevHadPulli;
      const isAfterNja = ch === SA && prevConsonant === NYA && prevHadPulli;
      const isAfterNra = ch === RA_HARD && prevConsonant === NNNA && prevHadPulli;
      const isSaAfterSach = ch === SA && isWordStart && prevWordEndedWithSach;
      const isSaWordFinal = ch === SA && isPulli && i + 2 === word.length;
      const isYaPulli = ch === YA && isPulli;

      let base = "";

      if (isPulli) {
        // --- PURE CONSONANT WITH PULLI (Mei Ezhuthu) ---
        if (isGeminate && (ch === SA || ch === THA)) {
          // ச்ச and த்த: suppress the leading pulli so the second twin consonant
          // produces the full clean cluster (e.g. பச்சை -> pachai, பத்து -> pathu).
          // `base` is already "" here.
        } else if (isGeminateRa) {
          base = "t"; // ற் in ற்ற carries a "t" sound -> "tri"
        } else if (isNgaCluster || isNjaCluster || isNraCluster) {
          base = "n"; // ங் in ங்க, ஞ் in ஞ்ச, ன் in ன்ற emit clean "n"
        } else if (isSaWordFinal) {
          base = "ch";
        } else if (isYaPulli) {
          // ய் is the "i" offglide ("iy" when another ய follows: செய்யும் -> seiyyum), but never
          // doubles an "i" that is already there: மைய்யா -> maiyyaa, not maiiyyaa.
          const afterI = out.endsWith("i");
          base = afterI ? "y" : (word[i + 2] === YA ? "iy" : "i");
        } else {
          base = TANGLISH_CONSONANTS[ch] || "";
        }
      } else {
        // --- CONSONANT WITH VOWEL OR STANDALONE CONSONANT (Uyirmei Ezhuthu) ---
        if (ch === KA) {
          // க: word-start or after twin pulli க் -> "k"; middle/end without க் -> "g"
          base = (isWordStart || isAfterTwinPulli) ? "k" : "g";
        } else if (ch === SA) {
          // ச: after twin pulli ச் (ச்ச) -> "ch"; after ட் (ட்ச) -> "ch";
          // after ஞ் (ஞ்ச) -> "j"; word-start -> "s"; middle/end without ச் -> "s"
          if (isAfterNja) {
            base = "j";
          } else if (isAfterTwinPulli || isDotaSa || isSaAfterSach) {
            base = "ch";
          } else {
            base = "s";
          }
        } else if (ch === PA) {
          // ப: word-start or after twin pulli ப் -> "p"; middle/end without ப் -> "b"
          base = (isWordStart || isAfterTwinPulli) ? "p" : "b";
        } else if (ch === TA_RETROFLEX) {
          // ட: word-start or after twin pulli ட் -> "t"; middle/end without ட் -> "d"
          base = (isWordStart || isAfterTwinPulli) ? "t" : "d";
        } else if (ch === THA) {
          // த: word-start or after twin pulli த் -> "th"; middle/end without த் -> "dh"
          base = (isWordStart || isAfterTwinPulli) ? "th" : "dh";
        } else if (ch === RA_HARD) {
          // ற: after ன் (ன்ற) -> "dr" (e.g. நன்றி -> nandri, என்று -> endru)
          base = isAfterNra ? "dr" : "r";
        } else {
          base = TANGLISH_CONSONANTS[ch] || "";
        }
      }

      if (isYaPulli) {
        out += base;
        offsets[i + 1] = out.length;
        prevConsonant = YA;
        prevHadPulli = true;
        i += 2;
      } else if (isPulli) {
        out += base;
        offsets[i + 1] = out.length;
        prevConsonant = ch;
        prevHadPulli = true;
        i += 2;
      } else if (next && TANGLISH_VOWEL_SIGNS[next]) {
        out += base;
        offsets[i + 1] = out.length;
        out += TANGLISH_VOWEL_SIGNS[next];
        prevConsonant = ch;
        prevHadPulli = false;
        i += 2;
      } else {
        out += base + (base === "" ? "" : "a");
        prevConsonant = ch;
        prevHadPulli = false;
        i += 1;
      }
    } else if (TANGLISH_VOWELS[ch]) {
      out += TANGLISH_VOWELS[ch];
      prevConsonant = "";
      prevHadPulli = false;
      i += 1;
    } else if (TANGLISH_DIGITS[ch]) {
      out += TANGLISH_DIGITS[ch];
      prevConsonant = "";
      prevHadPulli = false;
      i += 1;
    } else {
      out += ch;
      prevConsonant = "";
      prevHadPulli = false;
      i += 1;
    }
  }

  offsets[word.length] = out.length;
  return { out, offsets };
}
// Transliterates one already-tokenized line (tokenizeTaggedLine's output),
// re-anchoring every tag to the exact output position of the Tamil
// character it was attached to. prevWordEndedWithSach is passed in from the
// caller so ச at the start of the next word can be forced to "cha".
function transliterateTaggedTokens(tokens, prevWordEndedWithSach = false) {
  let result = "";
  let i = 0;
  let sachFlag = prevWordEndedWithSach; // cross-word ச→cha context
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.ch != null && TAMIL_RANGE_RE.test(tok.ch)) {
      // Gather the full run of consecutive Tamil-script tokens as one word.
      const wordTokens = [];
      while (i < tokens.length && tokens[i].ch != null && TAMIL_RANGE_RE.test(tokens[i].ch)) {
        wordTokens.push(tokens[i]);
        i++;
      }
      const rawWord = wordTokens.map((t) => t.ch).join("");
      const tagHits = [];
      wordTokens.forEach((t, idx) => { if (t.tag) tagHits.push({ index: idx, tag: t.tag }); });

      // Dictionary Exception Match:
      // If the word exists in the spelling chart, use its curated Tanglish spelling.
      // If chords/notes tags are planted mid-word, scale character offsets to the
      // dictionary spelling so every tag lands precisely on its syllable!
      if (activeTanglishExceptions[rawWord]) {
        const dictWord = activeTanglishExceptions[rawWord];
        if (tagHits.length === 0) {
          result += dictWord;
        } else if (tagHits.length === 1 && tagHits[0].index === 0) {
          result += `[${tagHits[0].tag}]` + dictWord;
        } else {
          const { out, offsets } = transliterateTamilWordWithOffsets(rawWord, sachFlag);
          let spliced = dictWord;
          let shift = 0;
          tagHits.forEach(({ index, tag }) => {
            const rawRatio = out.length > 0 ? (offsets[index] / out.length) : 0;
            const insertAt = Math.min(dictWord.length, Math.max(0, Math.round(rawRatio * dictWord.length))) + shift;
            const marker = `[${tag}]`;
            spliced = spliced.slice(0, insertAt) + marker + spliced.slice(insertAt);
            shift += marker.length;
          });
          result += spliced;
        }
        sachFlag = wordEndsWithSachPulli(rawWord);
        continue;
      }

      // General path: algorithmic transliteration with exact per-character
      // output offsets, so every tag (however many, wherever placed) lands
      // precisely on the syllable it was attached to.
      const { out, offsets } = transliterateTamilWordWithOffsets(rawWord, sachFlag);
      sachFlag = wordEndsWithSachPulli(rawWord);
      let spliced = out;
      let shift = 0;
      tagHits.forEach(({ index, tag }) => {
        const insertAt = offsets[index] + shift;
        const marker = `[${tag}]`;
        spliced = spliced.slice(0, insertAt) + marker + spliced.slice(insertAt);
        shift += marker.length;
      });
      result += spliced;
      continue;
    }
    // Non-Tamil token (space, punctuation, English letter, digit, or a
    // trailing tag with no following character) — passes through as-is,
    // tag and all, in its original position.
    result += (tok.tag ? `[${tok.tag}]` : "") + (tok.ch ?? "");
    // A non-Tamil character between two Tamil words (usually a space) doesn't
    // reset the sach-flag — the rule persists across word-separating spaces.
    i++;
  }
  return result;
}
function transliterateTanglishLine(line) {
  const leading = (line.match(/^ +/) || [""])[0];
  return leading + transliterateTaggedTokens(tokenizeTaggedLine(line.slice(leading.length)));
}
function transliterateTanglish(input) {
  return String(input || "").split("\n").map(transliterateTanglishLine).join("\n");
}
// Capitalises the first Latin letter of every line — conventional for
// Tanglish song-sheet display.
function capitalizeTanglishLines(text) {
  return String(text || "").split("\n").map((line) => line.replace(/[a-z]/, (c) => c.toUpperCase())).join("\n");
}
// Capitalises the first letter of every Latin word — used for titles and
// artist names so they read as proper-cased (e.g. "Oru Naal Kaanom").
function capitalizeTanglishWords(text) {
  return String(text || "").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
// Runs transliteration only when Tanglish mode is on and the text actually
// contains Tamil script; otherwise passes the original text through
// untouched (English/mixed text, or Tanglish mode off).
// Tamil glyphs are drawn smaller than Latin ones at the same font-size. Measure, on this very
// device and font, the Latin x-height against the Tamil base-letter height (baseline to mean
// line) and publish the ratio as --ta-scale; <Tamil> uses it to size Tamil runs so both
// scripts look equally big. Works with whatever Tamil font the platform provides.
function measureTamilScale() {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `400 200px ${FONT}`;
    const latin = ctx.measureText("x").actualBoundingBoxAscent;
    const heights = ["ம", "ர", "ன", "ல", "வ", "ப", "க", "ட", "த", "ச"]
      .map((ch) => ctx.measureText(ch).actualBoundingBoxAscent)
      .filter((h) => h > 0)
      .sort((a, b) => a - b);
    if (!latin || !heights.length) return 1;
    const tamil = heights[Math.floor(heights.length / 2)];
    return Math.max(0.9, Math.min(1.5, latin / tamil));
  } catch { return 1; }
}
function applyTamilScale() {
  const scale = measureTamilScale();
  document.documentElement.style.setProperty("--ta-scale", scale.toFixed(3));
}
const TAMIL_RUN_RE = /([\u0B80-\u0BFF]+(?:[\s\u200c\u200d]+[\u0B80-\u0BFF]+)*)/;
function Tamil({ children }) {
  if (typeof children !== "string" || !/[\u0B80-\u0BFF]/.test(children)) return <>{children}</>;
  return (
    <>
      {children.split(TAMIL_RUN_RE).map((part, i) => (
        /[\u0B80-\u0BFF]/.test(part)
          ? <span key={i} style={{ fontSize: "calc(1em * var(--ta-scale, 1))" }}>{part}</span>
          : part
      ))}
    </>
  );
}
function maybeTanglish(text, tanglishMode) {
  if (!tanglishMode || !text) return text;
  return TAMIL_RANGE_RE.test(text) ? capitalizeTanglishLines(transliterateTanglish(text)) : text;
}
// Title/artist variant: capitalises every word instead of just every line-start.
function maybeTanglishTitle(text, tanglishMode) {
  if (!tanglishMode || !text) return text;
  return TAMIL_RANGE_RE.test(text) ? capitalizeTanglishWords(transliterateTanglish(text)) : text;
}
// Strip bracketed [Alt Title] groups from a title for display.
// The raw title field (e.g. "Way Maker [Camino Hacedor]") keeps the alt title
// for editing and search, but every display surface calls this so the alt is hidden.
// Alt titles are written in square or round brackets; a bare number like "(2)" is
// the duplicate-song counter, not an alt title, so it stays visible.
const ALT_TITLE_RE = /\s*(?:\[[^\]]*\]|\((?!\s*\d+\s*\))[^)]*\))/g;
function stripAltTitle(title) {
  return String(title || "").replace(ALT_TITLE_RE, "").trim();
}
// Extract all bracketed groups from a title as separate alt-title strings.
function getAltTitles(title) {
  const matches = [];
  String(title || "").replace(/\[([^\]]*)\]|\((?!\s*\d+\s*\))([^)]*)\)/g, (_, sq, rd) => { const inner = (sq ?? rd ?? "").trim(); if (inner) matches.push(inner); });
  return matches;
}
// Tanglish (Latin transliteration of Tamil) is harder to read letter-by-
// letter than either script alone, so we tighten tracking slightly whenever
// a given piece of text was actually transliterated. Checked against the
// original (pre-transliteration) source text.
function tanglishLetterSpacing(sourceText, tanglishMode) {
  return tanglishMode && sourceText && TAMIL_RANGE_RE.test(sourceText) ? "-0.02em" : "normal";
}
// Lets a Latin/Tanglish search query match Tamil-script song titles/artists
// by comparing the query against a transliterated version of the text too.
function songMatchesQuery(song, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  // Build a search corpus: main title (stripped) + all alt titles + artist.
  const altTitles = getAltTitles(song.title || "");
  const displayTitle = stripAltTitle(song.title || "");
  const corpus = [displayTitle, ...altTitles, song.artist || ""].join(" ").toLowerCase();
  if (corpus.includes(q)) return true;
  if (TAMIL_RANGE_RE.test(song.title || "") || TAMIL_RANGE_RE.test(song.artist || "")) {
    const translit = transliterateTanglish([displayTitle, ...altTitles, song.artist || ""].join(" ")).toLowerCase();
    if (translit.includes(q)) return true;
  }
  return false;
}

/* =========================================================================
   Song content model — each song now stores four plain-text blocks
   (lyricsText, chordsText, chartText, drumsText) instead of a sections
   array. Lines starting with "-" are section headers; [Tag] markers in the
   chords/chart/drums text position a chord/note label above the following
   character (parsed by ChordText's existing tokenizer).
   ========================================================================= */
/* -------------------------------------------------------------------------
   Drums text format. You write the drum notes as plain text and the lyrics inside square
   brackets; each note applies to the bracketed lyric chunk that follows it:
       Kick [Way maker] Snare [miracle worker]
   and the song view shows Kick above "Way maker" and Snare above "miracle worker" (notes embedded
   into the lyrics, as in the chart). A line with no brackets is a plain notes-only line.
   Stored drums text starts with an invisible marker so the new format is never confused with the
   old one ([note]lyrics, notes inside the brackets), which is converted automatically.
   ------------------------------------------------------------------------- */
const DRUMS_FORMAT_MARK = "\u2063";
const isNewDrumsText = (t) => String(t || "").startsWith(DRUMS_FORMAT_MARK);

// "Kick [Way maker] Snare [miracle]" -> "[Kick]Way maker [Snare]miracle" (the tagged form ChordText draws).
function drumsLineToTagged(line) {
  // A line with no brackets is notes only (kept bright): section heads ("-Verse") and blank lines stay as they are.
  if (!line.includes("[")) return line.trim() && !line.trimStart().startsWith("-") ? `[${line.trim()}]` : line;
  const parts = line.split(/\[([^\]]*)\]/);   // note, lyric, note, lyric, …, note
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    const note = parts[i];
    const lyric = parts[i + 1];
    const trimmed = note.trim();
    const gap = /\s/.test(note);   // whitespace between lyric chunks: a word break
    if (lyric === undefined) {      // trailing text after the last lyric chunk: a note with no lyric
      if (trimmed) out += (out && gap ? " " : "") + `[${trimmed}]`;
      break;
    }
    if (out && gap) out += " ";
    if (trimmed) out += `[${trimmed}]`;
    out += lyric;
  }
  return out;
}
// Old format "[Kick]Way maker [Snare]miracle" -> "Kick [Way maker] Snare [miracle]" (exact round trip).
function drumsLineOldToNew(line) {
  if (!/\[[^\]]*\]/.test(line)) return line;
  const runs = [];
  tokenizeTaggedLine(line).forEach((t) => {
    if (t.tag != null || runs.length === 0) runs.push({ note: t.tag ?? "", text: "" });
    if (t.ch != null) runs[runs.length - 1].text += t.ch;
  });
  let out = "";
  let prevTrailingSpace = false;
  runs.forEach((r, i) => {
    const chunk = r.text.trim();
    const gap = i > 0 && (prevTrailingSpace || /^\s/.test(r.text));
    const sep = gap ? " " : "";
    if (i > 0) out += sep;
    if (r.note) out += r.note + (i === 0 ? " " : sep);
    if (chunk) out += `[${chunk}]`;
    prevTrailingSpace = /\s$/.test(r.text);
  });
  return out.trimEnd();
}
const convertOldDrumsText = (text) => DRUMS_FORMAT_MARK + String(text || "").split("\n").map(drumsLineOldToNew).join("\n");
const drumsToEditor = (stored) => (isNewDrumsText(stored) ? String(stored).slice(DRUMS_FORMAT_MARK.length) : convertOldDrumsText(stored).slice(DRUMS_FORMAT_MARK.length));
const drumsFromEditor = (text) => (String(text || "").trim() ? DRUMS_FORMAT_MARK + text : "");
const drumsToTagged = (stored) => String(stored || "").slice(DRUMS_FORMAT_MARK.length).split("\n").map(drumsLineToTagged).join("\n");

function migrateSongShape(song) {
  if (!song) return song;
  const drums = song.drumsText ?? "";
  return {
    ...song,
    lyricsText: song.lyricsText ?? "",
    chordsText: song.chordsText ?? "",
    chartText: song.chartText ?? "",
    drumsText: drums && !isNewDrumsText(drums) ? convertOldDrumsText(drums) : drums,
  };
}
function parseTextIntoBlocks(text, stripTrailingBlanks = false) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let current = null;
  lines.forEach((rawLine) => {
    const trimmed = rawLine.trimStart();
    if (trimmed.startsWith("-")) {
      // Strip trailing empty lines from the previous block before starting a new section.
      if (stripTrailingBlanks && current) {
        while (current.lines.length > 0 && current.lines[current.lines.length - 1].trim() === "") {
          current.lines.pop();
        }
      }
      current = { label: trimmed.slice(1).trim(), lines: [] };
      blocks.push(current);
    } else {
      if (!current) { current = { label: null, lines: [] }; blocks.push(current); }
      current.lines.push(trimmed);
    }
  });
  // Strip trailing empty lines from the last block too.
  if (stripTrailingBlanks && current) {
    while (current.lines.length > 0 && current.lines[current.lines.length - 1].trim() === "") {
      current.lines.pop();
    }
  }
  return blocks;
}
// Splits a whitespace-delimited word into surrounding punctuation and the note
// itself, so "(Bb", "1)", "'4/1'" or "-5" are still read as notes. Interior
// characters (the slash in 4/1 or G/B) and accidentals/chord marks (# b + °)
// stay part of the note.
function splitNotePunct(word) {
  const w = String(word || "");
  const lead = w.match(/^[^A-Za-z0-9#]*/)[0].replace(/^$/, "");
  const rest = w.slice(lead.length);
  const trail = rest.match(/[^A-Za-z0-9#\u00B0+]*$/)[0];
  return { lead, core: rest.slice(0, rest.length - trail.length), trail };
}
// A lone "x" (as in "x2" repeat markers written "x 2") turns the note right after
// it into plain text. Only "x" does this; all other punctuation is ignored.
const isStandaloneX = (core) => core === "x" || core === "X";
// True when the text before `offset` ends with a standalone "x" (punctuation/space allowed between).
function precededByStandaloneX(text, offset) {
  return /(?:^|[^A-Za-z0-9#])[xX][^A-Za-z0-9#]*$/.test(String(text || "").slice(0, offset));
}
// Auto-brackets bare Nashville-number tokens typed in the Chords tab (e.g.
// typing "1 4 5" becomes "[1] [4] [5]") so they behave as real chord tags
// without the user needing to type the brackets themselves. Anything already
// inside [] is left alone. Surrounding punctuation (brackets, slashes, hyphens,
// quotes) doesn't stop a number being a chord, but a number right after a
// standalone "x" stays text.
function autoBracketNumbers(text) {
  const s = String(text || "");
  let out = "";
  let i = 0;
  let afterX = false;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "[") {
      const end = s.indexOf("]", i);
      if (end === -1) { out += s.slice(i); break; }
      out += s.slice(i, end + 1); i = end + 1; afterX = false; continue;
    }
    if (/\s/.test(ch)) { out += ch; i++; continue; }
    let j = i;
    while (j < s.length && !/[\s[]/.test(s[j])) j++;
    const { lead, core, trail } = splitNotePunct(s.slice(i, j));
    if (isStandaloneX(core)) { afterX = true; out += s.slice(i, j); }
    else if (!afterX && core && isValidNashvilleToken(core)) out += `${lead}[${core}]${trail}`;
    else { afterX = false; out += s.slice(i, j); }
    if (!isStandaloneX(core)) afterX = false;
    i = j;
  }
  return out;
}

/* =========================================================================
   Chord/drum tag parsing — "[G]Gre[Em]at Are [C]You Lord[D]" style text.
   A tag applies to the character immediately following it; a tag with no
   following character (end of line) is a trailing tag.
   ========================================================================= */
function tokenizeTaggedLine(rawLine) {
  const line = String(rawLine || "").trimStart();
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
/* =========================================================================
   Nashville Number System <-> Chord conversion, major AND minor aware.
   Chords are stored as NUMBER tokens (e.g. "6m", "b7", "4/1") — the same
   canonical, key-independent notation a Nashville number chart uses — and
   an actual chord letter name is derived on the fly for a given key via
   tokenToChord(). This means transposition is free: changing the viewed
   key just changes which letters tokenToChord spells out, with no
   semitone math needed on stored data.
   ========================================================================= */
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
const NUMBER_TOKEN_RE = /^([b#]?)([1-7])((?:(?!\/)[^\s])*)(?:\/([b#]?)([1-7]))?$/;
// Plain numbers above 13 are text (bar counts, verse numbers) — except the degree + 7th/9th
// shorthands: 37 = 3 with a 7th, 49 = 4 with a 9th.
const isPlainNumberText = (t) => /^[0-9]+$/.test(t) && parseInt(t, 10) > 13 && !/^[1-7][79]$/.test(t);
function isSingleNashvilleToken(trimmed) {
  if (isPlainNumberText(trimmed)) return false;
  return NUMBER_TOKEN_RE.test(trimmed);
}
// Hyphen-joined progressions ("1-2-3", "C-F/A-C") are several chords: returns the parts when
// every part satisfies `isOne`, otherwise null (an ordinary word such as "re-enter" stays text).
function splitChordSequence(token, isOne) {
  const s = String(token || "").trim();
  if (!s.includes("-")) return null;
  const parts = s.split("-");
  return parts.length >= 2 && parts.every((p) => p && isOne(p)) ? parts : null;
}
const isValidNashvilleToken = (t) => isSingleNashvilleToken(t) || !!splitChordSequence(t, isSingleNashvilleToken);
const isChordSymbol = (t) => isSingleChordSymbol(t) || !!splitChordSequence(t, isSingleChordSymbol);
function tokenToChord(token, key, quality) {
  if (!token) return token;
  const trimmed = token.trim();
  if (!trimmed) return token;
  const seq = splitChordSequence(trimmed, isSingleNashvilleToken);
  if (seq) return seq.map((part) => tokenToChord(part, key, quality)).join("-");
  // A bracket containing only digits (no letters/accidentals) that's above
  // 13 isn't a Nashville degree token at all (degrees only run 1-7) — treat
  // it as literal text (e.g. a bar count, a note number) rather than trying
  // to parse "14" as degree 1 with a "4" suffix.
  if (isPlainNumberText(trimmed)) return token;
  const semitoneRoot = KEY_TO_SEMITONE[key] ?? 0;
  const useFlats = FLAT_KEYS.has(key);
  const scaleOffsets = quality === "Minor" ? MINOR_SCALE_OFFSETS : MAJOR_SCALE_OFFSETS;
  const degreeQualities = quality === "Minor" ? MINOR_KEY_DEGREE_QUALITIES : MAJOR_KEY_DEGREE_QUALITIES;
  const m = trimmed.match(NUMBER_TOKEN_RE);
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
  // A bare 7th/9th extension (37, 67, 49 …) keeps the degree's own quality: 3 + 7th is the minor
  // seventh (Bm7 in G), while a major degree gives the dominant form (49 -> C9).
  const isExtensionOnly = qualitySuffix === "7" || qualitySuffix === "9";
  const finalSuffix = isMajorOverride ? "" : (isExtensionOnly && !acc && defaultSuffix ? defaultSuffix + qualitySuffix : (qualitySuffix || defaultSuffix));
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
// Reverse of tokenToChord: given a chord symbol typed in letter form (e.g.
// "D", "F#m7", "G/B"), works out which scale degree of `key`/`quality` it
// corresponds to and returns the equivalent Nashville-number token (e.g.
// "1", "3#m7", "4/6"). Falls back to returning the original symbol
// unchanged if it doesn't look like a chord symbol at all (so plain lyric
// text or already-numeric tokens pass through untouched).
function chordToNumberToken(symbol, key, quality) {
  if (!symbol) return symbol;
  const trimmed = symbol.trim();
  if (!trimmed) return symbol;
  const seq = splitChordSequence(trimmed, isSingleChordSymbol);
  if (seq) return seq.map((part) => chordToNumberToken(part, key, quality)).join("-");
  // Already a Nashville number — nothing to convert.
  if (NUMBER_TOKEN_RE.test(trimmed)) return symbol;
  const scaleOffsets = quality === "Minor" ? MINOR_SCALE_OFFSETS : MAJOR_SCALE_OFFSETS;
  const semitoneRoot = KEY_TO_SEMITONE[key] ?? 0;
  const convertOne = (part) => {
    const m = part.match(CHORD_ROOT_RE);
    if (!m) return null;
    const rootName = m[1] + m[2];
    const rootSemitone = KEY_TO_SEMITONE[rootName];
    if (rootSemitone == null) return null;
    const suffix = part.slice(m[0].length);
    // Find the closest diatonic degree (and any accidental needed) for this root.
    let bestDegree = 1, bestAcc = "", bestDist = 99;
    for (let d = 1; d <= 7; d++) {
      const diatonicSemitone = (semitoneRoot + scaleOffsets[d - 1]) % 12;
      let diff = ((rootSemitone - diatonicSemitone) % 12 + 12) % 12;
      if (diff > 6) diff -= 12; // shortest signed distance, e.g. -1 instead of 11
      if (Math.abs(diff) < bestDist) {
        bestDist = Math.abs(diff); bestDegree = d;
        bestAcc = diff === 0 ? "" : diff === 1 ? "#" : diff === -1 ? "b" : "";
      }
    }
    if (bestDist > 1) return null; // not close to any diatonic degree — bail out
    return bestAcc + String(bestDegree) + suffix;
  };
  const parts = trimmed.split("/").map(convertOne);
  if (parts.some((p) => p === null)) return symbol; // couldn't confidently map — leave as typed
  return parts.join("/");
}
// Applies chordToNumberToken to every bracketed tag in a tagged text block
// that isn't already a Nashville number, so chords typed in letter form
// (e.g. typing "[D]" while in the Chords tab) get stored in the canonical
// number form once saved.
function chordsTaggedToNumbersTagged(taggedText, key, quality) {
  return String(taggedText || "").replace(/\[([^\]]*)\]/g, (m, tok, off, whole) => (
    precededByStandaloneX(whole, off) ? tok : `[${chordToNumberToken(tok, key, quality)}]`
  ));
}
// Converts every [number] tag in a tagged (lyric-interleaved) text block
// into its derived [ChordLetter] for the given key/quality, leaving the
// lyric characters and non-number tags untouched.
function numbersTaggedToChordsTagged(taggedText, key, quality) {
  return String(taggedText || "").replace(/\[([^\]]*)\]/g, (_, tok, off, whole) => (
    precededByStandaloneX(whole, off) ? tok : `[${tokenToChord(tok, key, quality)}]`
  ));
}

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

function TimeSigPicker({ value, onChange, fullWidth, height = 44, fontSize, style, subtle, C }) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [openLeft, setOpenLeft] = useState(false);
  const btnRef = useRef(null);
  const DROPDOWN_HEIGHT = 220;
  const DROPDOWN_WIDTH = 70; // sized to the text it contains ("6/8" etc. plus padding), not a fixed min-width
  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUpward(spaceBelow < DROPDOWN_HEIGHT && rect.top > spaceBelow);
      // If centering the dropdown under the button would push its left edge
      // past the screen edge, anchor it to the button's left edge instead.
      const centerLeft = rect.left + rect.width / 2 - DROPDOWN_WIDTH / 2;
      setOpenLeft(centerLeft < 4);
    }
    setOpen((o) => !o);
  };
  return (
    <div style={{ position: "relative", width: fullWidth ? "100%" : undefined, boxSizing: "border-box", zIndex: open ? 500 : "auto", ...style }}>
      <button
        ref={btnRef} type="button" onClick={handleToggle}
        style={subtle ? {
          fontFamily: FONT, fontSize: fontSize ?? 11, fontWeight: 600, borderRadius: 6, boxSizing: "border-box",
          border: `1px solid ${C.border}`, background: "transparent", color: value ? C.textMuted : C.textFaint,
          width: fullWidth ? "100%" : undefined, textAlign: "center", height, padding: "0 7px",
          display: "flex", alignItems: "center", justifyContent: "center",
        } : {
          fontFamily: FONT, fontSize: fontSize ?? 16, fontWeight: 600, borderRadius: 10, boxSizing: "border-box",
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
            ...(openLeft ? { left: 0 } : { left: "50%", transform: "translateX(-50%)" }), zIndex: 500, width: DROPDOWN_WIDTH,
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
const NATURAL_OPTIONS = [
  { id: "", label: "–" },
  ...NATURALS.map((n) => ({ id: n, label: n }))
];
function NaturalDropdown({ value, onChange, C }) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const btnRef = useRef(null);
  const DROPDOWN_HEIGHT = 320;
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
        <span>{value || "–"}</span>
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
            {NATURAL_OPTIONS.map(({ id, label }) => {
              const active = id === (value || "");
              return (
                <div key={label} onClick={() => { onChange(id); setOpen(false); }} style={{
                  padding: "12px 14px", fontFamily: FONT, fontSize: 15, fontWeight: 700, textAlign: "center",
                  color: active ? C.accent : C.text, background: active ? C.accentSoft : "transparent", cursor: "pointer",
                }}>
                  {label}
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
  const disabled = !natural || (variant === "flat" ? (natural === "C" || natural === "F") : (natural === "E" || natural === "B"));
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

// Plain iOS-style switch — a single toggle knob with no embedded text
// labels, for rows where the label already lives outside the control
// (e.g. "Tamil Transliteration" ...... [ o--]).
function IosSwitch({ checked, onChange, C }) {
  return (
    <div
      role="switch" aria-checked={checked} tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(!checked); } }}
      style={{
        position: "relative", width: 51, height: 31, borderRadius: 16, flexShrink: 0, cursor: "pointer",
        boxSizing: "border-box", background: checked ? C.accent : C.surface3,
        border: `1px solid ${checked ? C.accent : C.borderStrong}`, transition: "background 150ms ease, border-color 150ms ease",
      }}
    >
      <span style={{ position: "absolute", top: 2, left: checked ? 22 : 2, width: 25, height: 25, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.4)", transition: "left 150ms ease" }} />
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
   Piano tab (shown for Vocals + Chords modes)
   ========================================================================= */
function PianoIcon({ size = 18, height, color, strokeWidth }) {
  // Simplified, refined piano icon with black keys only and matching line weight
  const h = height ?? size;
  const w = Math.round(h * 1.32);
  const sw = strokeWidth ? Math.min(strokeWidth * 0.72, 1.4) : 1.2;
  return (
    <svg width={w} height={h} style={{ display: "block" }} viewBox="0 0 24 18" fill="none">
      <rect x="1" y="1" width="22" height="16" rx="2.5" stroke={color} strokeWidth={sw} />
      {/* Clean black keys */}
      <rect x="5.5" y="1" width="2" height="8" fill={color} rx="0.5" />
      <rect x="11" y="1" width="2" height="8" fill={color} rx="0.5" />
      <rect x="16.5" y="1" width="2" height="8" fill={color} rx="0.5" />
    </svg>
  );
}
function MetronomeIcon({ size = 20, color, strokeWidth = 2 }) {
  // Outline from the supplied Metronome.svg, scaled into a 24-unit box like the
  // lucide icons beside it so size and stroke weight match (stroke is in 24-unit space).
  const k = 20 / 387.35;
  return (
    <svg width={size} height={size} style={{ display: "block" }} viewBox="0 0 24 24" fill="none">
      <g transform={`translate(12 12) scale(${k}) translate(-159.92 -193.675)`} stroke={color} strokeWidth={strokeWidth / k} strokeLinecap="round" strokeMiterlimit="10" fill="none">
        <path d="M220.23,93.03l-11.87-36.49c-15.85-48.73-84.79-48.73-100.64,0L21.77,320.79c-7.48,22.98,9.65,46.57,33.82,46.57h204.91c24.17,0,41.3-23.59,33.82-46.57l-32.81-100.86" />
        <line x1="157.59" y1="283.78" x2="299.84" y2="62.03" />
      </g>
    </svg>
  );
}

const WHITE_KEY_BG = "#F2F1EC";
 // filled in per-mode below (needs accent colour)
const BLACK_KEY_BG = "#0A0A0A";
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
// "phone" | "ipad" | "desktop". Phones are locked to portrait, iPads rotate
// freely, and desktops (Mac/PC) keep a fixed landscape-oriented UI.
function detectDevice() {
  if (typeof navigator === "undefined" || typeof window === "undefined") return "desktop";
  const ua = navigator.userAgent;
  const smallestDim = Math.min(window.screen?.width || 0, window.screen?.height || 0);
  const isIPad =
    /iPad/i.test(ua) ||
    ((navigator.platform === "MacIntel" || /Macintosh/i.test(ua)) && navigator.maxTouchPoints > 1);
  if (isIPad) return "ipad";
  if (/iPhone|iPod/i.test(ua) || (/Mobi|Android/i.test(ua) && smallestDim < 600)) return "phone";
  if (/Android/i.test(ua)) return "ipad"; // Android tablets rotate freely like iPad
  return "desktop";
}
const DEVICE_CLASS = detectDevice();

/* =========================================================================
   Phone orientation lock.
   iOS Safari / home-screen PWAs cannot lock the screen to portrait. When the phone is turned
   sideways the OS makes the viewport landscape, so on phones we turn the whole page back by 90°
   (the <body> is rotated and given the swapped width/height), which keeps the UI upright relative
   to the phone body — a rotation lock. Everything that depends on the page frame follows it:
     • sizes come from the body (never `100dvh` / `window.innerHeight`, which still describe the
       sideways viewport) — use uiWidth() / uiHeight();
     • the notch / home-indicator insets rotate with the page, exposed as --safe-top/-bottom/-left/-right.
   The native iOS app is locked to portrait by the OS, so none of this ever triggers there.
   ========================================================================= */
const uiFrame = { rotated: false, width: 0, height: 0 };
const uiWidth = () => (uiFrame.rotated ? uiFrame.width : window.innerWidth);

function startPhoneOrientationLock() {
  if (typeof document === "undefined") return () => { };
  window.screen?.orientation?.lock?.("portrait")?.catch?.(() => { });   // works on Android / installed PWAs
  const root = document.documentElement;
  const body = document.body;
  const SAFE_VARS = ["--safe-top", "--safe-bottom", "--safe-left", "--safe-right"];
  // Hidden probe whose padding is the real (screen-frame) safe-area inset, so the values can be read in px.
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  body.appendChild(probe);

  const reset = () => {
    ["top", "left", "right", "bottom", "width", "height", "transform", "transformOrigin"].forEach((prop) => { body.style[prop] = ""; });
    SAFE_VARS.forEach((v) => root.style.removeProperty(v));
    uiFrame.rotated = false;
  };
  const apply = () => {
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    if (iw <= ih) { reset(); return; }
    const angle = window.screen?.orientation?.angle ?? (typeof window.orientation === "number" ? window.orientation : 90);
    const clockwise = angle === 270 || angle === -90;     // device turned clockwise: counter-rotate the other way
    const rot = clockwise ? 90 : -90;
    Object.assign(body.style, {
      top: "50%", left: "50%", right: "auto", bottom: "auto",
      width: `${ih}px`, height: `${iw}px`,
      transformOrigin: "center center",
      transform: `translate(-50%, -50%) rotate(${rot}deg)`,
    });
    const cs = getComputedStyle(probe);
    const inset = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
    // Which screen edge each edge of the (rotated) portrait page now sits on.
    const m = clockwise
      ? { top: inset.right, bottom: inset.left, left: inset.top, right: inset.bottom }
      : { top: inset.left, bottom: inset.right, left: inset.bottom, right: inset.top };
    Object.entries(m).forEach(([edge, px]) => root.style.setProperty(`--safe-${edge}`, `${px}px`));
    uiFrame.rotated = true;
    uiFrame.width = ih;      // the page's own width  = the viewport's short side
    uiFrame.height = iw;     // the page's own height = the viewport's long side
  };
  // The OS updates innerWidth/innerHeight a moment after the rotation events, so re-check shortly after too.
  let timers = [];
  const schedule = () => {
    apply();
    timers.forEach(clearTimeout);
    timers = [setTimeout(apply, 120), setTimeout(apply, 400)];
  };
  apply();
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  window.screen?.orientation?.addEventListener?.("change", schedule);
  window.visualViewport?.addEventListener("resize", apply);
  return () => {
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    window.screen?.orientation?.removeEventListener?.("change", schedule);
    window.visualViewport?.removeEventListener("resize", apply);
    timers.forEach(clearTimeout);
    probe.remove();
    reset();
  };
}

function useIsLandscapeScreen() {
  // The piano rotates to face the wider edge. On phones the UI is always held
  // portrait (even if the OS reports a landscape viewport, we counter-rotate
  // the page), so the piano must always rotate itself on phones.
  const getIsLandscape = () => typeof window !== "undefined" && DEVICE_CLASS !== "phone" && window.innerWidth > window.innerHeight;
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

// Tracks how much of the bottom of the layout viewport is currently covered
// by the on-screen keyboard (0 when the keyboard is closed). Scroll-list
// containers add this as extra bottom padding so there's always room to
// scroll focused fields / bottom-of-list items up above the keyboard,
// since the app's fixed-height layout never natively shrinks for it.
function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      // A sideways (counter-rotated) phone page cannot map the keyboard onto its own bottom edge.
      const kb = uiFrame.rotated ? 0 : window.innerHeight - vv.height - vv.offsetTop;
      const next = kb > 60 ? Math.round(kb) : 0;
      setInset((prev) => (Math.abs(prev - next) < 2 ? prev : next));   // ignore sub-pixel jitter while typing/scrolling
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
    };
  }, []);
  return inset;
}

// On focus, nudges a field into view above the keyboard once it has finished
// animating open. Needed because the app's own scroll-pinning effect
// neutralises the browser's native "scroll focused input into view" step.
const scrollFieldIntoView = (e) => {
  const el = e.currentTarget;
  setTimeout(() => { el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, 320);
};
function LandscapeLock({ children }) {
  const outerRef = useRef(null);
  const [size, setSize] = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 0,
    h: typeof window !== "undefined" ? window.innerHeight : 0,
  }));
  const isLandscapeScreen = useIsLandscapeScreen();
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        setSize({ w, h });
      }
    };
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
  const w = size.w || (typeof window !== "undefined" ? window.innerWidth : 0);
  const h = size.h || (typeof window !== "undefined" ? window.innerHeight : 0);
  return (
    <div ref={outerRef} style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", background: "#000" }}>
      {w > 0 && h > 0 && (
        <div style={{ position: "absolute", top: "50%", left: "50%", width: h, height: w, transform: "translate(-50%, -50%) rotate(90deg)", transformOrigin: "center center" }}>
          {children}
        </div>
      )}
    </div>
  );
}
const SILENT_VIDEO_SRC = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAZWbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAwN0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAIAAAACAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAJ7bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAAMgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACJm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAeZzdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAIAAgBIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MBQsAK/+EAGGdCwArZH4iIwEQAAAMABAAAAwDIPEiZIAEABWjLg8sgAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAGuAAABrgAAAAGHN0dHMAAAAAAAAAAQAAABkAAAIAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAABMc3RzYwAAAAAAAAAFAAAAAQAAAAEAAAABAAAAAgAAAAMAAAABAAAABgAAAAQAAAABAAAABwAAAAMAAAABAAAACQAAAAIAAAABAAAAeHN0c3oAAAAAAAAAAAAAABkAAAKDAAAACQAAAAoAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAANHN0Y28AAAAAAAAACQAABpsAAAkiAAAJQgAACWEAAAmAAAAJnwAACccAAAnmAAAKBQAAAn10cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAA+gAAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAEAAABAAAAAAH1bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAfQAAAI0BVxAAAAAAALWhkbHIAAAAAAAAAAHNvdW4AAAAAAAAAAAAAAABTb3VuZEhhbmRsZXIAAAABoG1pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABZHN0YmwAAAB+c3RzZAAAAAAAAAABAAAAbm1wNGEAAAAAAAAAAQAAAAAAAAAAAAEAEAAAAAAfQAAAAAAANmVzZHMAAAAAA4CAgCUAAgAEgICAF0AVAAAAAAAfQAAAAXcFgICABRWIVuUABoCAgAECAAAAFGJ0cnQAAAAAAAAfQAAAAXcAAAAgc3R0cwAAAAAAAAACAAAACAAABAAAAAABAAADQAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAA4c3RzegAAAAAAAAAAAAAACQAAABUAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAADRzdGNvAAAAAAAAAAkAAAaGAAAJHgAACT4AAAldAAAJfAAACZsAAAnDAAAJ4gAACgEAAAAac2dwZAEAAAByb2xsAAAAAgAAAAH//wAAABxzYmdwAAAAAHJvbGwAAAABAAAACQAAAAEAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMAAAAAhmcmVlAAADmW1kYXTeAgBMYXZjNjAuMzEuMTAyAAIwQA4AAAJxBgX//23cRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAApliIQM8mKAALC+ARggBwAAAAVBmjgZ6gAAAAZBmlQGeoAAAAAFQZpgM9QBGCAHAAAABUGagDPUAAAABUGaoDPUAAAABUGawDPUARggBwAAAAVBmuAz1AAAAAVBmwAz1AAAAAVBmyAz1AEYIAcAAAAFQZtAM9QAAAAFQZtgM9QAAAAFQZuAM9QBGCAHAAAABUGboDPUAAAABUGbwDPUAAAABUGb4DPUAAAABUGaADPUARggBwAAAAVBmiAz1AAAAAVBmkAz1AAAAAVBmmAz1AEYIAcAAAAFQZqAM9QAAAAFQZqgM9QAAAAFQZrAL9QBGCAHAAAABUGa4C/UAAAABUGbACvU";

// Shared iOS audio-unlock hack: playing a muted silent video from within a
// user-gesture call stack unlocks WebAudio playback for the whole page
// (including when the ring/silent switch is on, or the app is opened
// standalone from the home screen). Previously only PianoScreen did this
// locally, so the metronome stayed silent until the user visited Piano and
// pressed a key. Calling this once, from any first gesture, unlocks audio
// for every audio-producing feature in the app.
let __sharedSilentVideoEl = null;
let __audioUnlocked = false;
function unlockAudioPlayback() {
  // The native app owns the audio session (AVAudioSession .playback); this
  // PWA-only workaround would only fight it.
  if (isNativePlatform()) return;
  if (__audioUnlocked) return;
  __audioUnlocked = true;
  try {
    if (!__sharedSilentVideoEl) {
      const v = document.createElement("video");
      v.src = SILENT_VIDEO_SRC;
      // Deliberately NOT muted: iOS only promotes the page's audio session
      // to the "playback" category (which ignores the hardware silent
      // switch) for an actually-playing, unmuted video element. A muted
      // video doesn't trigger that promotion, so the metronome/piano would
      // stay silent whenever the phone's silent switch was on — this was
      // the root cause of audio sometimes not playing.
      v.muted = false;
      v.volume = 0.01;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute("loop", "");
      v.setAttribute("playsinline", "");
      v.setAttribute("webkit-playsinline", "");
      v.style.position = "fixed";
      v.style.width = "1px";
      v.style.height = "1px";
      v.style.opacity = "0";
      v.style.pointerEvents = "none";
      // Belt-and-braces: if the loop attribute ever fails to hold (some
      // WebViews drop it after backgrounding/foregrounding), explicitly
      // restart on "ended" so the audio session never silently drops back
      // to a category the hardware mute switch can interrupt mid-session.
      v.addEventListener("ended", () => {
        v.currentTime = 0;
        v.play().catch(() => { });
      });
      document.body.appendChild(v);
      __sharedSilentVideoEl = v;
    }
    __sharedSilentVideoEl.loop = true;
    __sharedSilentVideoEl.play().catch(() => { __audioUnlocked = false; });
  } catch {
    __audioUnlocked = false;
  }
}

/* =========================================================================
   Shared Audio Assets & Loader (Piano samples & Metronome WAVs)
   ========================================================================= */
let _sharedAudioCtx = null;
function getSharedAudioContext() {
  if (!_sharedAudioCtx || _sharedAudioCtx.state === "closed") {
    const AudioCtxCls = window.AudioContext || window.webkitAudioContext;
    try {
      _sharedAudioCtx = new AudioCtxCls({ latencyHint: "interactive", sampleRate: 44100 });
    } catch {
      _sharedAudioCtx = new AudioCtxCls({ latencyHint: "interactive" });
    }
    // Safety net: whenever iOS interrupts the context and the app is on screen, bring it back.
    const ctx = _sharedAudioCtx;
    ctx.addEventListener("statechange", () => {
      if (ctx.state === "interrupted" && document.visibilityState === "visible") ctx.resume().catch(() => { });
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && ctx.state === "interrupted") ctx.resume().catch(() => { });
    });
  }
  return _sharedAudioCtx;
}

const PIANO_SAMPLE_DEFS = [
  { name: "C2", midi: 36 }, { name: "Ds2", midi: 39 }, { name: "Fs2", midi: 42 }, { name: "A2", midi: 45 },
  { name: "C3", midi: 48 }, { name: "Ds3", midi: 51 }, { name: "Fs3", midi: 54 }, { name: "A3", midi: 57 },
  { name: "C4", midi: 60 }, { name: "Ds4", midi: 63 }, { name: "Fs4", midi: 66 }, { name: "A4", midi: 69 },
];

let _nativeNoteId = 0;   // unique id per native piano voice
let _pianoBuffers = null; // { [name]: { buffer: AudioBuffer, midi: number } }
let _metronomeBuffers = null; // { hi: AudioBuffer, low: AudioBuffer }
let _audioLoadingPromise = null;

function loadAudioSamples(ctx) {
  if (_audioLoadingPromise) return _audioLoadingPromise;
  _audioLoadingPromise = (async () => {
    const pianoPromises = PIANO_SAMPLE_DEFS.map(async ({ name, midi }) => {
      try {
        const res = await fetch(`/tones/${name}.mp3`);
        const ab = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab);
        return { name, midi, buf };
      } catch (err) {
        return { name, midi, buf: null };
      }
    });

    const mHiPromise = fetch("/tones/m_hi.wav")
      .then(r => r.arrayBuffer())
      .then(ab => ctx.decodeAudioData(ab))
      .catch(() => null);

    const mLowPromise = fetch("/tones/m_low.wav")
      .then(r => r.arrayBuffer())
      .then(ab => ctx.decodeAudioData(ab))
      .catch(() => null);

    const [pianoResults, mHi, mLow] = await Promise.all([
      Promise.all(pianoPromises),
      mHiPromise,
      mLowPromise,
    ]);

    const pMap = {};
    pianoResults.forEach(({ name, midi, buf }) => {
      if (buf) pMap[name] = { buffer: buf, midi };
    });
    _pianoBuffers = pMap;
    _metronomeBuffers = { hi: mHi, low: mLow };
    return { piano: _pianoBuffers, metronome: _metronomeBuffers };
  })();
  return _audioLoadingPromise;
}

function findNearestPianoSample(midi) {
  if (!_pianoBuffers) return null;
  let best = null;
  let minDist = Infinity;
  for (const def of PIANO_SAMPLE_DEFS) {
    const entry = _pianoBuffers[def.name];
    if (!entry) continue;
    const dist = Math.abs(midi - def.midi);
    if (dist < minDist) {
      minDist = dist;
      best = entry;
    }
  }
  return best;
}

function PianoScreen({ C, mode, loadedQuality, onQualityChange, highlightSemitone = null }) {
  const [octaveStart, setOctaveStartState] = useState(4);
  const octaveStartRef = useRef(4);
  const masterCompRef = useRef(null);
  // pointerId -> { semitone, voice, padVoice, keyEl }
  const activeRef = useRef(new Map());
  const containerRef = useRef(null);
  const silentVideoRef = useRef(null);
  const videoUnlockedRef = useRef(false);
  const isVocals = mode === "vocals";
  const [chordQuality, setChordQuality] = useState(loadedQuality || "Major");
  const chordQualityRef = useRef(loadedQuality || "Major");


  useEffect(() => {
    if (loadedQuality && loadedQuality !== chordQuality) {
      setChordQuality(loadedQuality);
    }
  }, [loadedQuality]);

  useEffect(() => {
    chordQualityRef.current = chordQuality;
    if (onQualityChange) onQualityChange(chordQuality);
  }, [chordQuality]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { octaveStartRef.current = octaveStart; }, [octaveStart]);
  const setOctaveStart = (n) => setOctaveStartState(Math.min(5, Math.max(3, n)));

  const WHITE_PRESSED = C.accent;
  const BLACK_PRESSED = C.accent;

  const ensureCtx = () => {
    const ctx = getSharedAudioContext();
    if (!masterCompRef.current || masterCompRef.current.context !== ctx) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-12, ctx.currentTime);
      comp.knee.setValueAtTime(8, ctx.currentTime);
      comp.ratio.setValueAtTime(3.0, ctx.currentTime);
      comp.attack.setValueAtTime(0.006, ctx.currentTime);
      comp.release.setValueAtTime(0.22, ctx.currentTime);
      comp.connect(ctx.destination);
      masterCompRef.current = comp;
    }
    // iOS can leave the context "interrupted" (not just "suspended") after another audio
    // session — e.g. the native metronome, a call, a notification — took the output.
    // Resume from either state, otherwise the piano stays silent until iOS recovers by itself.
    if (ctx.state !== "running") ctx.resume().catch(() => { });
    if (!videoUnlockedRef.current && silentVideoRef.current) {
      videoUnlockedRef.current = true;
      silentVideoRef.current.play().catch(() => { videoUnlockedRef.current = false; });
    }
    return ctx;
  };

  useEffect(() => {
    // In the iOS app the native engine plays the piano: no Web Audio context is created at all.
    if (isNativePlatform()) return;
    const ctx = ensureCtx();
    if (!_pianoBuffers || Object.keys(_pianoBuffers).length === 0) loadAudioSamples(ctx).catch(() => { });
  }, []);

  const midiFor = (semitone) => (octaveStartRef.current + 1) * 12 + semitone;

  const releaseVoice = (voice) => {
    if (voice && voice.nativeId) { nativePiano.noteOff(voice.nativeId); return; }
    if (!voice || !voice.ctx) return;
    const { gainNode, source, ctx } = voice;
    const now = ctx.currentTime;
    try {
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(gainNode.gain.value, now);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
      try { source.stop(now + 0.32); } catch { }
    } catch { }
  };

  const startNote = (semitone) => {
    if (isNativePlatform()) {
      const nativeId = ++_nativeNoteId;
      nativePiano.noteOn(nativeId, midiFor(semitone));
      return { nativeId, semitone };
    }
    const ctx = ensureCtx();
    const now = ctx.currentTime;
    const dest = masterCompRef.current || ctx.destination;
    const midi = midiFor(semitone);
    const nearest = findNearestPianoSample(midi);

    const gainNode = ctx.createGain();
    const baseGain = isVocals ? 1.5 : 1.0;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(baseGain, now + 0.008);
    gainNode.connect(dest);

    if (nearest && nearest.buffer) {
      const semitoneDiff = midi - nearest.midi;
      const source = ctx.createBufferSource();
      source.buffer = nearest.buffer;
      source.playbackRate.value = Math.pow(2, semitoneDiff / 12);
      source.connect(gainNode);
      source.start(now);
      source.onended = () => {
        try { source.disconnect(); gainNode.disconnect(); } catch { }
      };
      return { source, gainNode, ctx, semitone, midi };
    } else {
      const osc = ctx.createOscillator();
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      osc.frequency.value = freq;
      osc.connect(gainNode);
      osc.start(now);
      osc.onended = () => {
        try { osc.disconnect(); gainNode.disconnect(); } catch { }
      };
      return { source: osc, gainNode, ctx, semitone, midi };
    }
  };

  // --- Warm pad chord voice for Vocals mode (High volume, clean harmonics) ---
  const startPadChord = (rootSemitone) => {
    if (isNativePlatform()) {
      const nativeId = ++_nativeNoteId;
      nativePiano.padOn(nativeId, rootSemitone, chordQualityRef.current === "Minor");
      return { nativeId };
    }
    const ctx = ensureCtx();
    const now = ctx.currentTime;
    const dest = masterCompRef.current || ctx.destination;
    const quality = chordQualityRef.current;

    const baseMidi = 48 + rootSemitone; // C3 to B3
    const thirdInterval = quality === "Minor" ? 3 : 4;

    const notes = [
      { midi: baseMidi, gain: 0.28, cutoff: 800, detune: 0 },
      { midi: baseMidi + 7, gain: 0.18, cutoff: 1600, detune: 5 },
      { midi: baseMidi + 12, gain: 0.32, cutoff: 1800, detune: 6 },
      { midi: baseMidi + 12 + thirdInterval, gain: 0.20, cutoff: 2000, detune: 5 },
    ];

    const masterFilter = ctx.createBiquadFilter();
    masterFilter.type = "lowpass";
    masterFilter.frequency.value = 2400;
    masterFilter.Q.value = 0.5;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0, now);
    // Vocals volume boost: 0.48 (clear, loud, doesn't clip)
    masterGain.gain.linearRampToValueAtTime(0.48, now + 0.08);
    masterFilter.connect(masterGain);
    masterGain.connect(dest);

    const panValues = [-0.30, 0.25, 0.00, 0.20];
    const oscs = [];

    notes.forEach(({ midi, gain: noteGainVal, cutoff, detune }, idx) => {
      const freq = 440 * Math.pow(2, (midi - 69) / 12);

      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = cutoff;
      filt.Q.value = 0.4;

      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (panner) panner.pan.value = panValues[idx] ?? 0;

      const noteGain = ctx.createGain();
      noteGain.gain.value = noteGainVal;

      if (panner) {
        filt.connect(panner);
        panner.connect(noteGain);
      } else {
        filt.connect(noteGain);
      }
      noteGain.connect(masterFilter);

      const detunes = detune > 0 ? [-detune / 2, detune / 2] : [0];
      detunes.forEach((dt) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        osc.detune.value = dt;
        osc.connect(filt);
        osc.start(now);
        oscs.push(osc);
      });

      if (idx > 0) {
        const airGain = ctx.createGain();
        airGain.gain.value = noteGainVal * 0.08;
        const airFilt = ctx.createBiquadFilter();
        airFilt.type = "lowpass";
        airFilt.frequency.value = Math.min(cutoff * 1.4, 3000);
        airFilt.Q.value = 0.4;
        const airOsc = ctx.createOscillator();
        airOsc.type = "sine";
        airOsc.frequency.value = freq * 2;
        airOsc.connect(airFilt);
        airFilt.connect(airGain);
        airGain.connect(masterFilter);
        airOsc.start(now);
        oscs.push(airOsc);
      }
    });

    return { masterGain, oscillators: oscs };
  };

  const stopPadChord = (padVoice) => {
    if (!padVoice) return;
    if (padVoice.nativeId) { nativePiano.noteOff(padVoice.nativeId); return; }
    const ctx = getSharedAudioContext();
    const now = ctx.currentTime;
    try {
      padVoice.masterGain.gain.cancelScheduledValues(now);
      padVoice.masterGain.gain.setValueAtTime(padVoice.masterGain.gain.value, now);
      padVoice.masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
      padVoice.oscillators.forEach((osc) => { try { osc.stop(now + 0.30); } catch { } });
    } catch { }
  };

  const keyAt = (x, y) => {
    const hitEl = document.elementFromPoint(x, y);
    if (!hitEl) return null;
    const keyEl = hitEl.closest && hitEl.closest("[data-semitone]");
    if (!keyEl || !containerRef.current || !containerRef.current.contains(keyEl)) return null;
    return { semitone: parseInt(keyEl.dataset.semitone, 10), el: keyEl };
  };

  const paintKeyRef = useRef(null);
  const paintKey = (keyEl, pressed) => {
    if (!keyEl) return;
    const isBlack = keyEl.dataset.black === "1";
    keyEl.style.background = pressed ? (isBlack ? BLACK_PRESSED : WHITE_PRESSED) : (isBlack ? BLACK_KEY_BG : WHITE_KEY_BG);
    keyEl.dataset.pressed = pressed ? "1" : "0";   // lets the highlighted label stay readable on the accent-coloured pressed key
  };
  // Keep a stable ref to paintKey so that the pointermove useEffect (which
  // only re-runs when isVocals changes) always calls the latest version and
  // never applies a stale accent colour from a previous mode render.
  paintKeyRef.current = paintKey;

  const handlePointerDown = (e) => {
    e.preventDefault();
    const hit = keyAt(e.clientX, e.clientY);
    if (!hit) return;
    unlockAudioPlayback();
    if (isVocals) {
      activeRef.current.forEach((entry) => {
        if (entry.padVoice) stopPadChord(entry.padVoice);
        else if (entry.voice) releaseVoice(entry.voice);
        paintKey(entry.keyEl, false);
      });
      activeRef.current.clear();

      const padVoice = startPadChord(hit.semitone);
      activeRef.current.set(e.pointerId, { semitone: hit.semitone, padVoice, voice: null, keyEl: hit.el });
    } else {
      const voice = startNote(hit.semitone);
      activeRef.current.set(e.pointerId, { semitone: hit.semitone, voice, padVoice: null, keyEl: hit.el });
    }
    paintKey(hit.el, true);
  };

  useEffect(() => {
    const activeVoices = activeRef.current;   // the Map is created once and never replaced
    const stopEntry = (entry) => {
      if (!entry) return;
      if (entry.padVoice) stopPadChord(entry.padVoice);
      else if (entry.voice) releaseVoice(entry.voice);
    };

    const handleMove = (e) => {
      const entry = activeRef.current.get(e.pointerId);
      if (!entry) return;
      e.preventDefault();
      const hit = keyAt(e.clientX, e.clientY);
      const newSemitone = hit ? hit.semitone : null;
      if (newSemitone === entry.semitone) return;
      stopEntry(entry);
      paintKeyRef.current(entry.keyEl, false);
      if (hit) {
        if (isVocals) {
          const padVoice = startPadChord(hit.semitone);
          activeRef.current.set(e.pointerId, { semitone: hit.semitone, padVoice, voice: null, keyEl: hit.el });
        } else {
          const voice = startNote(hit.semitone);
          activeRef.current.set(e.pointerId, { semitone: hit.semitone, voice, padVoice: null, keyEl: hit.el });
        }
        paintKeyRef.current(hit.el, true);
      } else {
        activeRef.current.delete(e.pointerId);
      }
    };

    const handleUp = (e) => {
      const entry = activeRef.current.get(e.pointerId);
      if (!entry) return;
      paintKeyRef.current(entry.keyEl, false);
      stopEntry(entry);
      activeRef.current.delete(e.pointerId);
    };

    const handleVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      activeRef.current.forEach((entry) => {
        if (entry.padVoice) stopPadChord(entry.padVoice);
        else if (entry.voice) releaseVoice(entry.voice);
      });
      activeRef.current.clear();
      if (isNativePlatform()) { nativePiano.allOff(); return; }
      const ctx = getSharedAudioContext();
      if (ctx && ctx.state === "running") ctx.suspend().catch(() => { });
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
      activeVoices.forEach((entry) => {
        if (entry.padVoice) stopPadChord(entry.padVoice);
        else if (entry.voice) releaseVoice(entry.voice);
      });
      activeVoices.clear();
    };
  }, [isVocals]);

  const renderOctaveKeys = () => (
    <>
      <div style={{ position: "absolute", inset: 0, display: "flex" }}>
        {WHITE_KEYS.map((k) => (
          <div key={k.semitone} data-semitone={k.semitone} data-black="0" style={{
            flex: 1, background: WHITE_KEY_BG, borderRight: "1px solid rgba(0,0,0,0.25)",
            display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 12, boxSizing: "border-box",
          }}>
            <span className={k.semitone === highlightSemitone ? "piano-hl" : undefined} style={{ fontSize: isVocals ? 14 : 12, fontWeight: 700, color: k.semitone === highlightSemitone ? C.accent : "rgba(0,0,0,0.42)" }}>{k.name}</span>
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
              display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 10, boxSizing: "border-box",
            }}>
              <span className={k.semitone === highlightSemitone ? "piano-hl" : undefined} style={{ fontSize: isVocals ? 11.5 : 10, fontWeight: 700, color: k.semitone === highlightSemitone ? C.accent : "rgba(255,255,255,0.70)" }}>{k.name}</span>
            </div>
          );
        })}
      </div>
    </>
  );

  const pianoBody = (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", fontFamily: FONT, color: C.text }}>
      <div style={{ height: 56, flexShrink: 0, display: "flex", alignItems: "center", padding: "0 16px", gap: 10, boxSizing: "border-box", justifyContent: "space-between" }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>
          {isVocals ? "Chord Piano" : "Piano"}
        </div>
        {isVocals ? (
          <div style={{ display: "flex", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 3, gap: 4 }}>
            {["Major", "Minor"].map((q) => {
              const active = chordQuality === q;
              return (
                <button
                  key={q}
                  onClick={() => setChordQuality(q)}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 7,
                    border: "none",
                    fontFamily: FONT,
                    fontSize: 13,
                    fontWeight: 700,
                    background: active ? C.accentSoft : "transparent",
                    color: active ? C.accent : C.textMuted,
                    cursor: "pointer",
                    transition: "all 150ms ease"
                  }}
                >
                  {q}
                </button>
              );
            })}
          </div>
        ) : (
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
        )}
      </div>

      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        style={{ flex: 1, position: "relative", touchAction: "none", overflow: "hidden" }}
      >
        {renderOctaveKeys()}
      </div>
    </div>
  );

  return (
    <div style={{ height: "100%" }}>
      {!isNativePlatform() && <video
        ref={silentVideoRef}
        src={SILENT_VIDEO_SRC}
        loop
        playsInline
        muted={false}
        volume={0.01}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
      />}
      <LandscapeLock>{pianoBody}</LandscapeLock>
    </div>
  );
}

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
function useFlashBeat() { return useSyncExternalStore(beatStore.subscribe, beatStore.get); }
// Same idea for "is the metronome playing": only the play/stop glyphs re-render on a toggle,
// not the entire app, so the button reacts at once.
const playingStore = {
  value: false,
  subs: new Set(),
  set(v) { if (v === this.value) return; this.value = v; this.subs.forEach((f) => f()); },
  subscribe: (f) => { playingStore.subs.add(f); return () => playingStore.subs.delete(f); },
  get: () => playingStore.value,
};
function usePlaying() { return useSyncExternalStore(playingStore.subscribe, playingStore.get); }
function PlayStopGlyph({ size, color, stopColor = color, playNudge = 0 }) {
  const playing = usePlaying();
  return playing
    ? <Square size={size * 0.93} color={stopColor} fill={stopColor} />
    : <Play size={size} color={color} fill={color} style={{ marginLeft: playNudge }} />;
}
function defaultAccents(beats) { return Array.from({ length: beats }, () => "normal"); }

// ---------------------------------------------------------------------------
// useMetronomeEngine — unified metronome hook.
// On native iOS (Capacitor) it delegates audio scheduling to the Swift
// NativeMetronomePlugin; on web it uses the existing Web Audio scheduler.
// The returned object is identical in both cases so all callers are unchanged.
// ---------------------------------------------------------------------------
function useMetronomeEngine(settings) {
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
  // Mute mode (long-press the beat dots): every beat goes silent but still flashes. A temporary override —
  // the saved accent pattern is untouched and comes straight back; not remembered across app launches.
  const [muted, setMutedState] = useState(false);
  const mutedRef = useRef(false);
  const toggleMuted = () => { mutedRef.current = !mutedRef.current; setMutedState(mutedRef.current); };

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
  };
  const setAccents = (arr) => {
    setAccentsState(arr);
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
    const state = mutedRef.current ? "silent" : (accentsRef.current[beatNum] || "normal");
    if (state !== "silent") playClick(state, time);
    if (state === "mute") return;
    const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    setTimeout(() => setFlashBeat(beatNum), delayMs);
  };

  const scheduler = () => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    while (nextNoteTimeRef.current < ctx.currentTime + 0.1) {
      const beatIndex = beatRef.current;
      const beatState = mutedRef.current ? "silent" : (accentsRef.current[beatIndex] || "normal");
      const sub = subdivisionRef.current;
      const beatDur = 60 / bpmRef.current;
      const subDur = beatDur / sub;
      for (let k = 0; k < sub; k++) {
        const t = nextNoteTimeRef.current + k * subDur;
        if (k === 0) scheduleClick(beatIndex, t);
        else if (beatState !== "mute" && beatState !== "silent") playClick("normal", t);
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
  const nativeSettings = () => ({
    bpm: bpmRef.current,
    beatsPerBar: timeSigRef.current.beats,
    accents: mutedRef.current ? accentsRef.current.map(() => "silent") : accentsRef.current,
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
  }, [isNative, bpm, timeSig, accents, subdivision, loadedSong, muted]);

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
    setSubdivisionState(sub);
    beatRef.current = 0;
    start();
  };

  return {
    bpm, setBpm, timeSig, setTimeSig, accents, setAccents, subdivision, setSubdivision,
    toggle, start, stop, tapTempo, loadedSong, loadSong, loadSongAndPlay, muted, toggleMuted,
  };
}

const DEG_PER_BPM = 6;
const KNOB_TOUCH_PAD = 28;
function Knob({ value, min = 30, max = 300, onChange, size = 220, onToggle, C }) {
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
          <button onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onToggle(); }} style={{
            position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            width: size * 0.34, height: size * 0.34, borderRadius: "50%", border: "none", background: "transparent", pointerEvents: "auto",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <PlayStopGlyph size={size * 0.14} color="#fff" playNudge={size * 0.015} />
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
function BeatAccentControl({ count, accents, onChange, size = 9, openUpwardOnly, muted = false, onToggleMuted, C }) {
  const flashBeat = useFlashBeat();
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
  // Long-press toggles mute mode; a normal tap opens the pattern editor (disabled while muted).
  const pressTimer = useRef(null);
  const longPressed = useRef(false);
  const pressOrigin = useRef({ x: 0, y: 0 });
  const clearPress = () => { clearTimeout(pressTimer.current); pressTimer.current = null; };
  useEffect(() => clearPress, []);
  const handleOpen = () => {
    if (longPressed.current) { longPressed.current = false; return; }
    if (muted) return;
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
    <div style={{ position: "relative", zIndex: 2 }} ref={btnRef}>
      <button
        onClick={handleOpen}
        onPointerDown={(e) => {
          if (!onToggleMuted) return;
          longPressed.current = false;
          pressOrigin.current = { x: e.clientX, y: e.clientY };
          clearPress();
          pressTimer.current = setTimeout(() => {
            pressTimer.current = null;
            longPressed.current = true;
            onToggleMuted();
            try { navigator.vibrate?.(15); } catch { }
          }, 500);
        }}
        onPointerMove={(e) => { if (pressTimer.current && Math.hypot(e.clientX - pressOrigin.current.x, e.clientY - pressOrigin.current.y) > 10) clearPress(); }}
        onPointerUp={clearPress}
        onPointerLeave={clearPress}
        onPointerCancel={clearPress}
        onContextMenu={(e) => e.preventDefault()}
        style={{ display: "flex", gap: 8, justifyContent: "center", background: "none", border: "none", padding: 6, cursor: "pointer", WebkitTouchCallout: "none", userSelect: "none" }}>
        {pattern.map((state, i) => (
          <div key={i} style={{ width: size, height: size, borderRadius: "50%", background: muted ? (flashBeat === i ? "#fff" : "transparent") : dotColor(state, flashBeat === i, C), border: muted || state === "mute" ? `1.5px solid ${muted && flashBeat === i ? "#fff" : C.textFaint}` : "none", boxSizing: "border-box", transition: "background 60ms linear" }} />
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
    // Shift the notehead right so it reads as centered within the bounding box
    return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none"><ellipse cx="13" cy="18" rx="4" ry="3" fill={color} /><line x1="16.8" y1="18" x2="16.8" y2="4" stroke={color} strokeWidth="2" strokeLinecap="round" /></svg>);
  }
  if (value === 2) {
    return (<svg width={size * 1.15} height={size} viewBox="0 0 28 24" fill="none"><ellipse cx="6.5" cy="19" rx="3.4" ry="2.6" fill={color} /><ellipse cx="21.5" cy="19" rx="3.4" ry="2.6" fill={color} /><line x1="9.7" y1="19" x2="9.7" y2="6" stroke={color} strokeWidth="2" strokeLinecap="round" /><line x1="24.7" y1="19" x2="24.7" y2="6" stroke={color} strokeWidth="2" strokeLinecap="round" /><line x1="9.7" y1="6" x2="24.7" y2="6" stroke={color} strokeWidth="2.2" strokeLinecap="round" /></svg>);
  }
  return (
    <svg width={size * 1.5} height={size} viewBox="0 0 40 24" fill="none">
      <text x="20" y="6" fontSize="9" fontWeight="700" fill={color} textAnchor="middle" fontFamily={FONT}>3</text>
      <ellipse cx="6" cy="19" rx="3" ry="2.3" fill={color} /><ellipse cx="20" cy="19" rx="3" ry="2.3" fill={color} /><ellipse cx="34" cy="19" rx="3" ry="2.3" fill={color} />
      <line x1="9" y1="19" x2="9" y2="8" stroke={color} strokeWidth="1.8" strokeLinecap="round" /><line x1="23" y1="19" x2="23" y2="8" stroke={color} strokeWidth="1.8" strokeLinecap="round" /><line x1="37" y1="19" x2="37" y2="8" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <line x1="9" y1="8" x2="37" y2="8" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function useHoldRepeat(step, { onStart, onEnd } = {}) {
  const timeoutRef = useRef(null);
  const startTimeRef = useRef(0);
  const activeRef = useRef(false);
  const stepRef = useRef(step);
  stepRef.current = step;
  const clear = () => {
    const wasActive = activeRef.current;
    activeRef.current = false;
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (wasActive && onEnd) onEnd();
  };
  const scheduleNext = () => {
    if (!activeRef.current) return;
    const heldSeconds = (performance.now() - startTimeRef.current) / 1000;
    const minInterval = 35, startInterval = 300, tau = 0.55;
    const interval = minInterval + (startInterval - minInterval) * Math.exp(-heldSeconds / tau);
    timeoutRef.current = setTimeout(() => { stepRef.current(); scheduleNext(); }, interval);
  };
  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    clear();
    if (onStart) onStart();
    activeRef.current = true; startTimeRef.current = performance.now();
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
  const { bpm, setBpm, timeSig, setTimeSig, accents, setAccents, subdivision, setSubdivision, toggle, tapTempo, loadedSong } = engine;
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
  };

  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-between", padding: "50px 20px 24px", boxSizing: "border-box", overflowY: "auto" }}>
      <div onTouchStart={startTitleTouch} onTouchMove={clearTitleTouch} onTouchEnd={clearTitleTouch} onTouchCancel={clearTitleTouch}
        onMouseDown={startTitleTouch} onMouseUp={clearTitleTouch} onMouseLeave={clearTitleTouch}
        style={{ textAlign: "center", minHeight: 44, display: "flex", flexDirection: "column", justifyContent: "center", cursor: "pointer", maxWidth: 260 }}>
        {loadedSong ? (
          <>
            <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.45, whiteSpace: "normal", wordBreak: "break-word" }}><Tamil>{stripAltTitle(loadedSong.title)}</Tamil></div>
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 10 }}>{loadedSong.artist}</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 22, fontWeight: 700 }}>Metronome</div>
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 3 }}>BH</div>
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
        <BeatAccentControl count={(timeSig.beats === 6 && timeSig.unit === 8) ? 4 : timeSig.beats} accents={accents} onChange={changeAccents} muted={engine.muted} onToggleMuted={engine.toggleMuted} C={C} />
      </div>

      <Knob value={bpm} onChange={(v) => setBpm(v, true)} size={268} onToggle={toggle} C={C} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, width: "100%", maxWidth: 320 }}>
        <TimeSigPicker value={timeSig} onChange={setTimeSig} fullWidth height={58} style={{ width: "100%" }} C={C} />
        <button onClick={cycleSubdivision} style={{ width: "100%", height: 58, boxSizing: "border-box", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <SubdivisionIcon value={subdivision} size={19} color={C.text} />
        </button>
        <button onPointerDown={tapTempo} style={{ width: "100%", height: 58, boxSizing: "border-box", fontFamily: FONT, fontSize: 14, letterSpacing: 1, fontWeight: 600, borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, display: "flex", alignItems: "center", justifyContent: "center" }}>
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
// When two tags land close together inside the same word (e.g. two chords a
// couple of letters apart), the first tag's label can render wider than the
// gap and visually overlap the second tag. Rather than reserving blank space
// (which is what the drums word-padding does), we insert a literal hyphen
// right before the lyric character the second tag sits on — this nudges the
// second tag's position over by one character, matching how chord charts are
// conventionally hand-written. Only used for read-only chord/chart display.
function insertOverlapHyphens(tokens, tagSize, fontSize, flattenTags) {
  const ratio = tagSize / fontSize;
  const out = [];
  let reservedUntil = null; // ch-position (within current word) the previous tag's label occupies through
  let pos = 0; // running ch-position within the current word
  tokens.forEach((tok) => {
    const isSpace = tok.ch === " " || tok.ch === null;
    if (isSpace) {
      out.push(tok);
      reservedUntil = null;
      pos = 0;
      return;
    }
    if (tok.tag) {
      const label = flatify(tok.tag);
      const labelWidthCh = (label ? label.length : 0) * ratio;
      if (reservedUntil !== null && pos < reservedUntil) {
        // A single hyphen only buys one extra character of width. When the
        // overlap is wider than that (e.g. a long chord/number crowding the
        // next tag), pad extra plain spaces around the hyphen so the total
        // gap actually clears the previous tag's label instead of still
        // overlapping it.
        const totalNeeded = Math.max(1, Math.ceil(reservedUntil - pos));
        const before = Math.floor((totalNeeded - 1) / 2);
        const after = Math.ceil((totalNeeded - 1) / 2);
        for (let i = 0; i < before; i++) { out.push({ ch: " ", tag: null }); pos += 1; }
        out.push({ ch: "-", tag: null });
        pos += 1;
        for (let i = 0; i < after; i++) { out.push({ ch: " ", tag: null }); pos += 1; }
      }
      out.push(tok);
      reservedUntil = pos + labelWidthCh;
      pos += 1;
    } else {
      out.push(tok);
      pos += 1;
    }
  });
  return out;
}

// Vocals mode shows plain lyrics (no chord tags), so it does not need ChordText's monospaced
// one-character grid. Plain text in the system font reads better, wraps naturally and keeps
// Tamil letters together. Lines keep ChordText's spacing so the layout matches the other modes.
function LyricsText({ text, textAlign = "left", fontSize = 22, lineHeightMult = 1.75, bold = false, letterSpacing }) {
  const lines = String(text || "").split("\n").map((l) => l.replace(/\[[^\]]*\]/g, "").replace(/^\s+/, ""));
  return (
    <div style={{ fontFamily: FONT, fontSize, lineHeight: `${lineHeightMult}em`, textAlign, whiteSpace: "pre-wrap", overflowWrap: "break-word", letterSpacing, fontWeight: bold ? 700 : 400, maxWidth: "100%", boxSizing: "border-box" }}>
      {lines.map((line, i) => (
        <div key={i} style={{ minHeight: fontSize * lineHeightMult, marginBottom: Math.max(fontSize * 0.5, fontSize * (lineHeightMult - 1.2)) }}>
          {line ? <Tamil>{line}</Tamil> : "\u00A0"}
        </div>
      ))}
    </div>
  );
}
function ChordText({ text, onChange, editable, dim, brightTags, dimTags, showLyrics = true, showTags = true, textAlign = "left", fontSize = 22, lineHeightMult = 1.75, tagFontSize, accent, C, emptyHint, bold, lyricsBold, notesBold, flattenTags = false, tagGapMult = 1, hyphenateOverlaps = false, padWordForTag = true, letterSpacing = "normal" }) {
  const [editorFor, setEditorFor] = useState(null); // { line, index } | null
  const [draft, setDraft] = useState("");
  const rootRef = useRef(null);
  // A note label wider than the lyric under it can run past the right edge and get cut off. After each
  // layout, slide any such label left just far enough to fit (it stays above its lyric).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || uiFrame.rotated) return undefined;
    const fit = () => {
      const tags = root.querySelectorAll("[data-tag]");
      tags.forEach((t) => { t.style.transform = ""; });
      const limit = root.getBoundingClientRect().right;
      tags.forEach((t) => {
        const over = t.getBoundingClientRect().right - limit;
        if (over > 0.5) t.style.transform = `translateX(${-Math.ceil(over)}px)`;
      });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  });
  const lines = String(text || "").split("\n").map((l) => l.replace(/^\s+/, ""));
  const hasAnyContent = String(text || "").trim().length > 0;
  const tagSize = Math.max(9, tagFontSize != null ? tagFontSize : fontSize * 0.62);
  const tagGap = Math.max(2, tagSize * 0.28 * tagGapMult);
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
    return emptyHint ? <div style={{ color: C.textFaint, fontSize, fontFamily: MONO }}>{emptyHint}</div> : null;
  }

  return (
    <div ref={rootRef} style={{ fontFamily: MONO, fontSize, lineHeight: `${lineHeightMult}em`, textAlign, whiteSpace: "pre-wrap", wordBreak: dimTags ? "break-word" : "keep-all", overflowWrap: dimTags ? "break-word" : "normal", letterSpacing, hyphens: "none", maxWidth: "100%", boxSizing: "border-box", overflowX: "hidden" }}>
      {lines.map((line, li) => {
        let tokens = tokenizeTaggedLine(line);
        if (tokens.length === 0) tokens.push({ ch: null, tag: null });
        if (hyphenateOverlaps && !editable) tokens = insertOverlapHyphens(tokens, tagSize, fontSize, flattenTags);
        // A line without any note/tag has nothing to put above its text, so it must not
        // reserve the empty "tag row" (that made plain lines look double-spaced).
        const rowPad = (editable || tokens.some((t) => t.tag)) ? topPad : 0;

        // Merge Tamil vowel-sign/pulli combining marks into the preceding
        // base consonant so each syllable shapes as one connected grapheme
        // instead of exploding into per-character boxes — a combining mark
        // rendered in visual isolation (its own box) has no base to attach
        // to, so the browser draws a dotted-circle placeholder instead of
        // shaping it onto the consonant. Editing/tagging still targets the
        // base token's original index (ti), so commitTag's independent
        // tokenizeTaggedLine indexing is unaffected. Non-Tamil text never
        // matches, so this is a no-op for English/other-script lyrics.
        const clustered = [];
        tokens.forEach((tok, ti) => {
          if (clustered.length && tok.ch != null && TAMIL_COMBINING_RE.test(tok.ch) && !tok.tag) {
            const base = clustered[clustered.length - 1];
            base.tok = { ...base.tok, ch: base.tok.ch + tok.ch };
          } else {
            clustered.push({ tok, ti });
          }
        });

        // Group tokens into words (runs of non-space characters) and
        // individual space units, so each word can be wrapped in a
        // non-breaking span — this guarantees a line never breaks mid-word
        // and never starts with a space or punctuation, matching the plain
        // <pre> text-flow behaviour used in Vocals mode exactly.
        const groups = [];
        let current = [];
        clustered.forEach(({ tok, ti }) => {
          const isSpace = tok.ch === " " || tok.ch === null;
          if (isSpace) {
            if (current.length) { groups.push({ type: "word", items: current }); current = []; }
            if (!editable) {
              const last = groups[groups.length - 1];
              if (last && last.type === "space") { last.items.push({ tok, ti }); return; }
            }
            groups.push({ type: "space", items: [{ tok, ti }] });
          } else {
            current.push({ tok, ti });
          }
        });
        if (current.length) groups.push({ type: "word", items: current });

        // If not editing, strip any leading space group before the first word,
        // transferring any attached tag to the first character of the word.
        if (!editable) {
          while (groups.length > 0 && groups[0].type === "space" && !groups[0].items.some((it) => it.tok.tag)) {
            groups.shift();
          }
          if (groups.length > 1 && groups[0].type === "space" && groups[1].type === "word") {
            const taggedSpaceItem = groups[0].items.find((it) => it.tok.tag);
            if (taggedSpaceItem) {
              groups[1].items[0].tok.tag = taggedSpaceItem.tok.tag;
            }
            groups.shift();
          }
        }

        const renderChar = ({ tok, ti }) => {
          const isEditingThis = editable && editorFor && editorFor.line === li && editorFor.index === ti;
          return (
            <span
              key={ti}
              onClick={editable ? () => openEditor(li, ti, tok.tag) : undefined}
              style={{
                position: "relative", display: "inline-block", paddingTop: rowPad,
                cursor: editable ? "pointer" : "default", width: tok.ch && (tok.ch.length > 1 || TAMIL_RANGE_RE.test(tok.ch)) ? undefined : "1ch",
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
                    color: brightTags ? C.text : accent,
                    background: "transparent", border: "none", outline: "none",
                    padding: 0, margin: 0, lineHeight: 1,
                    caretColor: accent,
                  }}
                />
              ) : tok.tag ? (
                <span data-tag={editable ? undefined : "1"} style={{
                  position: "absolute", top: 0, left: 0, whiteSpace: "nowrap",
                  fontSize: tagSize, fontWeight: noteWeightBold ? 800 : 600,
                  lineHeight: 1,
                  color: dimTags ? C.textFaint : brightTags ? C.text : accent,
                  opacity: 1,
                }}>
                  {flatify(tok.tag)}
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
              <span style={{ color: showLyrics ? (dimTags ? C.text : dim ? "#4D4D50" : C.text) : "transparent", visibility: showLyrics ? "visible" : (tok.ch ? "hidden" : "visible"), fontWeight: lyricWeightBold ? 700 : 400 }}>
                {tok.ch === null ? "\u00A0" : tok.ch === " " ? "\u00A0" : tok.ch}
              </span>
            </span>
          );
        };

        return (
          <div key={li} style={{ minHeight: fontSize * lineHeightMult, marginBottom: Math.max(fontSize * 0.5, fontSize * (lineHeightMult - 1.2), tagGap * 1.8), lineHeight: `${lineHeightMult}em` }}>
            {groups.map((g, gi) => {
              const maxTagLen = g.items.reduce((max, it) => {
                if (!it.tok.tag) return max;
                const label = flatify(it.tok.tag);
                return Math.max(max, label.length);
              }, 0);
              const tagDrivenWidth = maxTagLen * (tagSize / fontSize);
              if (g.type !== "word") {
                const repItem = g.items.find((it) => it.tok.tag) || g.items[0];
                const hasTag = Boolean(repItem?.tok?.tag);
                if (!hasTag && !editable) {
                  return (
                    <span key={gi} style={{ display: "inline", whiteSpace: "normal" }}>
                      {" "}
                    </span>
                  );
                }
                if (hasTag && !editable) {
                  const tagText = flatify(repItem.tok.tag);
                  return (
                    <span
                      key={gi}
                      style={{
                        display: "inline-block",
                        verticalAlign: "bottom",
                        margin: gi === 0 ? "0 0.35em 0 0" : "0 0.35em",
                        textAlign: "center",
                        lineHeight: 1,
                        paddingTop: rowPad,
                        position: "relative"
                      }}
                    >
                      <span
                        data-tag="1"
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          right: 0,
                          textAlign: "center",
                          fontSize: tagSize,
                          fontWeight: noteWeightBold ? 800 : 600,
                          color: dimTags ? C.textFaint : brightTags ? C.text : accent,
                          whiteSpace: "nowrap"
                        }}
                      >
                        {tagText}
                      </span>
                      <span
                        style={{
                          fontSize: tagSize,
                          fontWeight: noteWeightBold ? 800 : 600,
                          visibility: "hidden",
                          whiteSpace: "nowrap"
                        }}
                      >
                        {tagText}
                      </span>
                    </span>
                  );
                }
                const minWidthCh = Math.max(1, tagDrivenWidth);
                const minWidthVal = showTags ? `${minWidthCh}ch` : undefined;
                return (
                  <span key={gi} style={{ display: "inline-block", minWidth: minWidthVal }}>
                    {renderChar(repItem)}
                  </span>
                );
              }
              const hasTag = g.items.some((it) => Boolean(it.tok?.tag));
              let shouldPadForTag = padWordForTag && hasTag;
              if (shouldPadForTag) {
                const nextWordGroup = groups.slice(gi + 1).find((nextG) => nextG.type === "word");
                const nextWordHasTag = Boolean(nextWordGroup?.items?.some((it) => Boolean(it.tok?.tag)));
                if (!nextWordHasTag) {
                  shouldPadForTag = false;
                }
              }
              const minWidthCh = shouldPadForTag ? Math.max(g.items.length, tagDrivenWidth) : g.items.length;
              return (
                <span key={gi} style={{ display: "inline-block", whiteSpace: "normal", minWidth: showTags ? `${minWidthCh}ch` : undefined, maxWidth: "100%", wordBreak: "break-word" }}>
                  {/* A word stays on one line when it fits; a word wider than the line breaks inside
                      instead of running off the right edge. */}
                  <span style={{ display: "inline-block", whiteSpace: "normal" }}>
                    {g.items.map(renderChar)}
                  </span>
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
   Chords-only tab renderer (Chords mode -> Chords view)
   Displays pure chord progressions (Nashville numbers or letter chords)
   and plain text instructions without embedding onto lyric character grids.
   ========================================================================= */
function formatChordsOnlyToken(token, viewKey, keyQuality, nashvilleMode) {
  const trimmed = String(token || "").trim();
  if (!trimmed) return token;
  // Normalise flat-prefix notation: bA → Ab, bE → Eb, etc.
  const normTrimmed = /^b[A-G]/.test(trimmed) ? trimmed[1] + "b" + trimmed.slice(2) : trimmed;
  if (nashvilleMode) {
    if (isValidNashvilleToken(normTrimmed)) return flatify(normTrimmed);
    // With no key, can't reliably convert chord letters to numbers — show as-is.
    if (!viewKey) return flatify(normTrimmed);
    const asNumber = chordToNumberToken(normTrimmed, viewKey, keyQuality);
    return flatify(asNumber);
  } else {
    if (isValidNashvilleToken(normTrimmed)) {
      // With no key, can't derive chord names — show numbers as-is.
      if (!viewKey) return flatify(normTrimmed);
      return flatify(tokenToChord(normTrimmed, viewKey, keyQuality));
    }
    return flatify(normTrimmed);
  }
}

function parseChordsOnlyLine(rawLine, viewKey, keyQuality, nashvilleMode) {
  const line = String(rawLine || "");
  const segments = [];
  let i = 0;
  let afterX = false; // the note right after a standalone "x" is plain text

  while (i < line.length) {
    // Bracketed chord token: e.g. [1], [6m], [G], [4/1], [Ebm], [Bbmaj7]
    if (line[i] === "[") {
      const end = line.indexOf("]", i);
      if (end !== -1) {
        const inner = line.slice(i + 1, end).trim();
        if (isValidNashvilleToken(inner) || isChordSymbol(inner)) {
          if (afterX) segments.push({ type: "text", text: inner });
          else segments.push({ type: "chord", text: formatChordsOnlyToken(inner, viewKey, keyQuality, nashvilleMode) });
          afterX = false;
          i = end + 1;
          continue;
        }
      }
    }

    // Space run
    if (/\s/.test(line[i])) {
      let j = i;
      while (j < line.length && /\s/.test(line[j])) j++;
      segments.push({ type: "space", text: line.slice(i, j) });
      i = j;
      continue;
    }

    // Word / punctuation run
    let j = i;
    while (j < line.length && !/\s|\[/.test(line[j])) j++;
    const word = line.slice(i, j);
    const { lead, core, trail } = splitNotePunct(word);

    if (isStandaloneX(core)) {
      segments.push({ type: "text", text: word });
      afterX = true;
    } else {
      const isNote = core && (isValidNashvilleToken(core) || isChordSymbol(core));
      if (isNote && !afterX) {
        if (lead) segments.push({ type: "text", text: lead });
        segments.push({ type: "chord", text: formatChordsOnlyToken(core, viewKey, keyQuality, nashvilleMode) });
        if (trail) segments.push({ type: "text", text: trail });
      } else {
        segments.push({ type: "text", text: word });
      }
      afterX = false;
    }
    i = j;
  }

  return segments;
}

function ChordsOnlyBlock({ lines, viewKey, keyQuality, nashvilleMode, textAlign = "left", fontSize = 22, chordFontSize, lineSpacing = 1.75, lyricsBold, notesBold, tanglishMode, C }) {
  const cSize = chordFontSize != null ? chordFontSize : fontSize;
  const tSize = fontSize * 0.92;
  const cWeight = notesBold ? 800 : 700;
  const tWeight = lyricsBold ? 700 : 500;

  return (
    <div style={{ fontFamily: MONO, textAlign, whiteSpace: "pre-wrap", wordBreak: "keep-all", lineHeight: `${lineSpacing}em` }}>
      {lines.map((line, li) => {
        const segments = parseChordsOnlyLine(line, viewKey, keyQuality, nashvilleMode);
        return (
          <div key={li} style={{ minHeight: `${lineSpacing * 0.9}em`, marginBottom: Math.max(4, fontSize * 0.2) }}>
            {segments.map((seg, si) => {
              if (seg.type === "space") {
                return <span key={si}>{seg.text}</span>;
              }
              if (seg.type === "chord") {
                return (
                  <span
                    key={si}
                    style={{
                      display: "inline-block",
                      fontSize: cSize,
                      fontWeight: cWeight,
                      color: C.text,
                      fontFamily: MONO,
                      letterSpacing: 0.5,
                      padding: "0 1px",
                    }}
                  >
                    {seg.text}
                  </span>
                );
              }
              const displayText = maybeTanglish(seg.text, tanglishMode);
              return (
                <span
                  key={si}
                  style={{
                    display: "inline-block",
                    fontSize: tSize,
                    fontWeight: tWeight,
                    color: C.textMuted,
                    fontFamily: FONT,
                  }}
                >
                  {displayText}
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
   Swipe hooks
   ========================================================================= */
function useEdgeSwipeBack(onBack, edgeZone = 24) {
  const touchStartRef = useRef(null);
  const [dragX, setDragX] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const mouseActiveRef = useRef(false);
  const start = (x, y) => {
    if (leaving) return;
    if (x > edgeZone) { touchStartRef.current = null; return; }
    touchStartRef.current = { x, y };
  };
  const move = (x, y) => {
    if (!touchStartRef.current || leaving) return;
    const dx = x - touchStartRef.current.x;
    const dy = y - touchStartRef.current.y;
    if (dx > 0 && dx > Math.abs(dy)) setDragX(dx);
  };
  const end = () => {
    if (!touchStartRef.current) return;
    touchStartRef.current = null;
    if (dragX > 30) { setLeaving(true); setDragX(uiWidth()); setTimeout(onBack, 200); }
    else setDragX(0);
  };
  // Touches that begin inside a text field belong to the field (caret, selection, magnifier) — never a back-swipe.
  const inTextField = (e) => !!e.target?.closest?.("textarea, input, [contenteditable]");
  const handleTouchStart = (e) => { if (inTextField(e)) { touchStartRef.current = null; return; } start(e.touches[0].clientX, e.touches[0].clientY); };
  const handleTouchMove = (e) => move(e.touches[0].clientX, e.touches[0].clientY);
  const handleTouchEnd = () => end();
  const handleMouseDown = (e) => { if (inTextField(e)) return; mouseActiveRef.current = true; start(e.clientX, e.clientY); };
  useEffect(() => {
    const onMouseMove = (e) => { if (mouseActiveRef.current) move(e.clientX, e.clientY); };
    const onMouseUp = () => { if (mouseActiveRef.current) { mouseActiveRef.current = false; end(); } };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  });
  return { dragX, leaving, dragging: dragX > 0, handlers: { onTouchStart: handleTouchStart, onTouchMove: handleTouchMove, onTouchEnd: handleTouchEnd, onTouchCancel: handleTouchEnd, onMouseDown: handleMouseDown } };
}

// Swipe between the songs of a setlist.
//
// The page follows the finger (transform written straight to the element — no React
// re-render while dragging, so it tracks at full frame rate). On release the old page is
// copied into a "ghost" that slides out while the new song slides in from the other side,
// both with the same easing and distance so their edges stay flush: a clean push transition.
// Uses the Web Animations API (all current browsers, iOS Safari, desktop and the app).
const SWIPE_MS = 300;
const SWIPE_EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
function useSetlistSongSwipe(onPrev, onNext, cardRef, songId) {
  // cardRef = the song's scrolling content area (lyrics / chords / notes). Only that part slides;
  // the header, badges and bottom bars stay where they are and just update their text.
  const startRef = useRef({ x: 0, y: 0 });
  const dirRef = useRef(null);
  const shownRef = useRef(0);       // current horizontal offset of the card
  const velRef = useRef({ x: 0, t: 0, v: 0 });
  const activeRef = useRef(false);
  const busyRef = useRef(false);
  const pendingRef = useRef(null);  // enter animation to run once the new song has rendered
  const ghostRef = useRef(null);
  const mouseActiveRef = useRef(false);

  const setX = (x) => {
    shownRef.current = x;
    const el = cardRef.current;
    if (el) el.style.transform = x === 0 ? "" : `translate3d(${x}px,0,0)`;
  };

  const start = (x, y) => {
    if (busyRef.current) return;
    startRef.current = { x, y };
    velRef.current = { x, t: performance.now(), v: 0 };
    dirRef.current = null;
    activeRef.current = true;
  };
  const move = (x, y) => {
    if (!activeRef.current || busyRef.current) return;
    const dx = x - startRef.current.x;
    const dy = y - startRef.current.y;
    if (dirRef.current === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      dirRef.current = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    }
    if (dirRef.current !== "x") return;
    const now = performance.now();
    const dt = now - velRef.current.t;
    if (dt > 0) velRef.current = { x, t: now, v: (x - velRef.current.x) / dt };
    // Resistance when there is no song in that direction.
    const canGo = dx > 0 ? !!onPrev : !!onNext;
    setX(canGo ? dx : dx * 0.25);
  };

  const animateBack = () => {
    const el = cardRef.current;
    const from = shownRef.current;
    setX(0);
    if (el && el.animate && from !== 0) {
      el.animate([{ transform: `translate3d(${from}px,0,0)` }, { transform: "translate3d(0,0,0)" }], { duration: 240, easing: SWIPE_EASE });
    }
  };

  const commit = (dir) => {   // dir: -1 = next song (page moves left), 1 = previous
    const el = cardRef.current;
    const go = () => (dir < 0 ? onNext() : onPrev());
    if (!el || !el.animate) { setX(0); go(); return; }
    busyRef.current = true;
    const W = uiWidth();
    const from = shownRef.current;

    // Ghost copy of the outgoing content slides away, pinned exactly over the content area.
    const rect = el.getBoundingClientRect();   // includes the current drag offset
    const ghost = el.cloneNode(true);
    ghost.setAttribute("aria-hidden", "true");
    Object.assign(ghost.style, {
      position: "fixed", left: `${rect.left - from}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`, margin: "0", flex: "none",
      background: getComputedStyle(el.parentElement || document.body).backgroundColor,
      pointerEvents: "none", transform: "", zIndex: "101", willChange: "transform",
    });
    document.body.appendChild(ghost);
    ghost.scrollTop = el.scrollTop;
    ghostRef.current = ghost;
    const out = ghost.animate(
      [{ transform: `translate3d(${from}px,0,0)` }, { transform: `translate3d(${dir * W}px,0,0)` }],
      { duration: SWIPE_MS, easing: SWIPE_EASE, fill: "forwards" }
    );
    const removeGhost = () => { ghost.remove(); if (ghostRef.current === ghost) ghostRef.current = null; };
    out.onfinish = removeGhost; out.oncancel = removeGhost;

    // The real card waits off-screen on the opposite side until the new song is rendered.
    const enterFrom = from - dir * W;
    el.style.transform = `translate3d(${enterFrom}px,0,0)`;
    shownRef.current = 0;
    pendingRef.current = { enterFrom };
    go();
    // Safety net: if the song never changed, put the card back.
    setTimeout(() => {
      if (pendingRef.current) {
        pendingRef.current = null;
        if (cardRef.current) cardRef.current.style.transform = "";
        busyRef.current = false;
      }
    }, 800);
  };

  // New song has rendered (before the browser paints): slide it in.
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    const el = cardRef.current;
    if (!pending || !el) return;
    pendingRef.current = null;
    el.style.transform = "";
    if (!el.animate) { busyRef.current = false; return; }
    const enter = el.animate(
      [{ transform: `translate3d(${pending.enterFrom}px,0,0)` }, { transform: "translate3d(0,0,0)" }],
      { duration: SWIPE_MS, easing: SWIPE_EASE }
    );
    const done = () => { busyRef.current = false; };
    enter.onfinish = done; enter.oncancel = done;
  }, [songId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (ghostRef.current) ghostRef.current.remove(); }, []);

  const end = () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    const wasHorizontal = dirRef.current === "x";
    dirRef.current = null;
    if (!wasHorizontal) return;
    const dx = shownRef.current;
    const v = velRef.current.v;
    const threshold = Math.min(120, uiWidth() * 0.25);
    const flick = Math.abs(v) > 0.5 && Math.abs(dx) > 24;
    const far = Math.abs(dx) > threshold;
    if (dx > 0 && onPrev && (far || (flick && v > 0))) commit(1);
    else if (dx < 0 && onNext && (far || (flick && v < 0))) commit(-1);
    else animateBack();
  };

  const handleTouchStart = (e) => { if (e.touches.length !== 1) return; start(e.touches[0].clientX, e.touches[0].clientY); };
  const handleTouchMove = (e) => move(e.touches[0].clientX, e.touches[0].clientY);
  const handleTouchEnd = () => end();
  const handleMouseDown = (e) => { mouseActiveRef.current = true; start(e.clientX, e.clientY); };
  useEffect(() => {
    const onMouseMove = (e) => { if (mouseActiveRef.current) move(e.clientX, e.clientY); };
    const onMouseUp = () => { if (mouseActiveRef.current) { mouseActiveRef.current = false; end(); } };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  });

  return {
    handlers: { onTouchStart: handleTouchStart, onTouchMove: handleTouchMove, onTouchEnd: handleTouchEnd, onTouchCancel: handleTouchEnd, onMouseDown: handleMouseDown },
  };
}

const SWIPE_REVEAL = 76;
function SwipeToDelete({ id, openId, onOpenIdChange, onDelete, children, icon: RevealIcon = Trash2, elevated = false, C }) {
  const [translateX, setTranslateX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0); const startYRef = useRef(0); const startTranslateRef = useRef(0);
  const movedRef = useRef(false); const directionRef = useRef(null);
  const isOpen = openId === id;
  useEffect(() => { if (!isOpen) setTranslateX(0); }, [isOpen]);
  const mouseActiveRef = useRef(false);
  const startDrag = (x, y) => {
    if (openId !== null && openId !== id) onOpenIdChange(null);
    startXRef.current = x; startYRef.current = y;
    startTranslateRef.current = translateX; movedRef.current = false; directionRef.current = null;
    setDragging(true);
  };
  const moveDrag = (x, y, stopFn) => {
    const dx = x - startXRef.current;
    const dy = y - startYRef.current;
    if (directionRef.current === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      directionRef.current = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    }
    if (directionRef.current === "y") return;
    if (stopFn) stopFn();
    if (Math.abs(dx) > 6) movedRef.current = true;
    setTranslateX(Math.min(0, Math.max(-SWIPE_REVEAL, startTranslateRef.current + dx)));
  };
  const endDrag = (stopFn) => {
    setDragging(false);
    if (directionRef.current === "y") { directionRef.current = null; return; }
    if (stopFn) stopFn();
    const shouldOpen = translateX < -SWIPE_REVEAL / 2;
    setTranslateX(shouldOpen ? -SWIPE_REVEAL : 0);
    onOpenIdChange(shouldOpen ? id : null);
    directionRef.current = null;
  };
  const handleTouchStart = (e) => startDrag(e.touches[0].clientX, e.touches[0].clientY);
  const handleTouchMove = (e) => moveDrag(e.touches[0].clientX, e.touches[0].clientY, () => e.stopPropagation());
  const handleTouchEnd = (e) => endDrag(() => e.stopPropagation());
  const handleMouseDown = (e) => { mouseActiveRef.current = true; startDrag(e.clientX, e.clientY); };
  useEffect(() => {
    const onMouseMove = (e) => { if (mouseActiveRef.current) moveDrag(e.clientX, e.clientY); };
    const onMouseUp = () => { if (mouseActiveRef.current) { mouseActiveRef.current = false; endDrag(); } };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  });
  const handleContentClickCapture = (e) => {
    if (movedRef.current) { e.stopPropagation(); return; }
    if (isOpen) { e.stopPropagation(); setTranslateX(0); onOpenIdChange(null); }
  };
  return (
    <div style={{ position: "relative", overflow: elevated ? "visible" : "hidden", zIndex: elevated ? 100 : "auto" }}>
      <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: SWIPE_REVEAL, display: "flex", alignItems: "stretch", justifyContent: "center", background: "#161618" }}>
        <button onClick={() => { onDelete(); setTranslateX(0); onOpenIdChange(null); }} style={{ width: "100%", background: "none", border: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <RevealIcon size={18} color={C.danger} />
        </button>
      </div>
      <div onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} onMouseDown={handleMouseDown} onClickCapture={handleContentClickCapture}
        style={{ transform: `translateX(${translateX}px)`, transition: dragging ? "none" : "transform 200ms ease", background: C.bg, touchAction: "pan-y", cursor: "grab" }}>
        {children}
      </div>
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
  { id: "chart", label: "Chart" },
  { id: "drums", label: "Drums" },
];
const escapeHtml = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Where the caret sits inside a textarea, measured on an off-screen copy of it (the only
// reliable way: textareas expose no caret geometry). Returns { top, height } in the textarea's own box.
function measureCaret(ta) {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement("div");
  ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "whiteSpace", "wordBreak", "overflowWrap", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "boxSizing"].forEach((k) => { mirror.style[k] = cs[k]; });
  mirror.style.cssText += ";position:absolute;visibility:hidden;top:0;left:-9999px;border:0;";
  mirror.style.width = `${ta.clientWidth}px`;
  const upto = ta.value.slice(0, ta.selectionEnd);
  mirror.textContent = upto;
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  const height = marker.offsetHeight || parseFloat(cs.lineHeight) || 20;
  mirror.remove();
  return { top, height };
}
// Scrolls the nearest scrolling ancestor just enough that the caret line is visible — below the
// sticky header and above the on-screen keyboard. Never touches the textarea's own scroll.
function ensureCaretVisible(ta) {
  const scroller = ta.closest(".scroll-list");
  if (!scroller || document.activeElement !== ta) return;
  const { top, height } = measureCaret(ta);
  const caretTop = ta.getBoundingClientRect().top + top;
  const caretBottom = caretTop + height;
  const sRect = scroller.getBoundingClientRect();
  const header = scroller.querySelector("[data-sticky-header]");
  const topLimit = sRect.top + (header ? header.offsetHeight : 0) + 8;
  const vv = window.visualViewport;
  const bottomLimit = Math.min(sRect.bottom, vv && !uiFrame.rotated ? vv.offsetTop + vv.height : sRect.bottom) - 24;
  if (caretBottom > bottomLimit) scroller.scrollTop += caretBottom - bottomLimit;
  else if (caretTop < topLimit) scroller.scrollTop -= topLimit - caretTop;
}

// Text box with a highlighted backdrop: bracketed [tags] are tinted in the given accent colour
// as the user types, "-" lines are tinted as section heads, etc.
//
// How it is built (this is what keeps typing, Enter, selection and scrubbing stable on every platform):
//   • the backdrop is a normal in-flow block, so the browser itself sizes the box to the text —
//     no JavaScript height measuring, no collapse-to-auto flicker, no scroll jumps;
//   • the real <textarea> is stretched over it (absolute, same metrics, transparent text, visible caret),
//     so it never has anything of its own to scroll (any stray scroll is reset);
//   • after every edit the caret line is scrolled into view in the page, not in the box.
function HighlightedAutoGrowTextarea({ value, onChange, onBlur, onFocus, placeholder, wrapperStyle, textStyle, accent, drumMode, chartMode, C }) {
  const taRef = useRef(null);
  const raw = String(value || "");
  // Lines beginning with "-" are section heads. In drumMode, [bracketed] content is the lyrics (grey);
  // in chartMode the [chord] tags stay bright and the lyrics around them are grey.
  const html = useMemo(() => raw.split("\n").map((line) => {
    if (line.trimStart().startsWith("-")) return `<span style="color:${accent}">${escapeHtml(line)}</span>`;
    if (drumMode) return escapeHtml(line).replace(/\[([^\]]*)\]/g, (_, inner) => `<span style="color:#6A6A6E">[${inner}]</span>`);
    if (chartMode) {
      return line.split(/(\[[^\]]*\])/).map((part) => (
        !part ? "" : part.startsWith("[") && part.endsWith("]") ? escapeHtml(part) : `<span style="color:#6A6A6E">${escapeHtml(part)}</span>`
      )).join("");
    }
    return escapeHtml(line);
  }).join("\n") + (raw === "" || raw.endsWith("\n") ? "&#8203;" : ""), [raw, accent, drumMode, chartMode]);
  const baseTextStyle = { ...textStyle, margin: 0, border: "none", background: "transparent", boxSizing: "border-box", width: "100%", letterSpacing: "normal", fontKerning: "none", fontVariantLigatures: "none", fontFeatureSettings: '"kern" 0, "liga" 0, "calt" 0' };
  const followCaret = () => { const el = taRef.current; if (el) requestAnimationFrame(() => ensureCaretVisible(el)); };
  return (
    <div style={{ position: "relative", width: "100%", boxSizing: "border-box", ...wrapperStyle }}>
      <div
        aria-hidden="true"
        style={{ ...baseTextStyle, position: "relative", color: C.text, pointerEvents: "none", minHeight: "inherit" }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {!raw && placeholder ? (
        <div style={{ ...baseTextStyle, position: "absolute", top: 0, left: 0, right: 0, color: C.textFaint, pointerEvents: "none" }}>{placeholder}</div>
      ) : null}
      <textarea
        ref={taRef}
        className="no-ring"
        value={raw}
        rows={1}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        data-gramm="false"
        data-gramm_editor="false"
        data-enable-grammarly="false"
        onChange={(e) => { onChange(e); followCaret(); }}
        onKeyUp={(e) => { if (e.key.startsWith("Arrow") || e.key === "Enter" || e.key === "Backspace") followCaret(); }}
        onBlur={onBlur}
        onFocus={(e) => { onFocus?.(e); setTimeout(followCaret, 320); }}
        onScroll={(e) => { if (e.currentTarget.scrollTop !== 0) e.currentTarget.scrollTop = 0; }}
        style={{ ...baseTextStyle, position: "absolute", top: 0, left: 0, width: "100%", height: "100%", display: "block", color: "transparent", caretColor: C.text, resize: "none", overflow: "hidden", outline: "none", boxShadow: "none" }}
      />
    </div>
  );
}

function SongForm({ initial, seed, onSave, onCancel, onDelete, onDuplicate, songs, mode, fontSize = 22, chordFontSize = 16, lyricsBold = false, notesBold = false, lineSpacing = 1.75, textAlign = "left", C }) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [artist, setArtist] = useState(initial?.artist ?? "");
  const [tempo, setTempo] = useState(initial?.tempo ?? seed?.tempo ?? "");
  const [timeSig, setTimeSig] = useState(() => {
    if (initial?.timeSignature) return parseTimeSig(initial.timeSignature);
    if (seed?.timeSignature) return parseTimeSig(seed.timeSignature);
    return { beats: 4, unit: 4 };
  });
  const initialDecomposed = decomposeKey(initial?.key ?? (seed?.key ?? ""));
  const [keyNatural, setKeyNatural] = useState(initialDecomposed.natural);
  const [keyAccidental, setKeyAccidental] = useState(initialDecomposed.accidental);
  const [keyQuality, setKeyQuality] = useState(initial?.keyQuality ?? "Major");
  const [language, setLanguage] = useState(initial?.language ?? (/[\u0B80-\u0BFF]/.test(initial?.title ?? "") ? "Tamil" : "English"));
  const [description, setDescription] = useState(initial?.description ?? "");
  const migratedInitial = initial ? migrateSongShape(initial) : null;
  const [lyricsText, setLyricsText] = useState(migratedInitial?.lyricsText ?? "");
  const [chordsText, setChordsText] = useState(migratedInitial?.chordsText ?? "");
  const [chartText, setChartText] = useState(migratedInitial?.chartText ?? "");
  const [drumsText, setDrumsText] = useState(drumsToEditor(migratedInitial?.drumsText ?? ""));
  const [accents, setAccents] = useState(() => {
    if (initial?.id) return getSongAccents(initial.id, (() => { const { beats, unit } = parseTimeSig(initial.timeSignature || "4/4"); return (beats === 6 && unit === 8) ? 4 : beats; })());
    return seed?.accents ?? defaultAccents(4);
  });
  const [subdivision] = useState(() => (initial?.id ? getSongSubdivision(initial.id) : (seed?.subdivision ?? 1)));
  const [error, setError] = useState("");
  const [sectionTab, setSectionTab] = useState(() => mode === "drums" ? "drums" : mode === "chords" ? "chords" : "lyrics");

  const { dragX, leaving, dragging, handlers } = useEdgeSwipeBack(onCancel);
  const keyboardInset = useKeyboardInset();

  const handleTitleChange = (v) => {
    setTitle(v);
    setError("");
    if (/[\u0B80-\u0BFF]/.test(v)) {
      setLanguage("Tamil");
    }
  };

  const handleNaturalChange = (n) => {
    setKeyNatural(n);
    if (!n) {
      setKeyAccidental("natural");
      return;
    }
    if (keyAccidental === "sharp" && (n === "E" || n === "B")) setKeyAccidental("natural");
    if (keyAccidental === "flat" && (n === "C" || n === "F")) setKeyAccidental("natural");
  };
  const handleTimeSigChange = (ts) => { setTimeSig(ts); const effBeats = (ts.beats === 6 && ts.unit === 8) ? 4 : ts.beats; setAccents(defaultAccents(effBeats)); };

  const handleSave = () => {
    const cleanTitle = toTitleCase(title.trim());
    const cleanArtist = toTitleCase(artist.trim());
    const isDuplicate = songs.some((s) => {
      if (initial && s.id === initial.id) return false;
      return stripAltTitle(s.title).toLowerCase() === stripAltTitle(cleanTitle).toLowerCase() && (s.artist || "").toLowerCase() === cleanArtist.toLowerCase();
    });
    if (!cleanTitle) return;
    if (isDuplicate) { setError("A song with this title and artist already exists."); return; }
    const savedKey = composeKey(keyNatural, keyAccidental);
    const normalizedChordsText = chordsTaggedToNumbersTagged(autoBracketNumbers(chordsText), savedKey, keyQuality);
    // Persist accents & subdivision to device-local storage (not synced to Supabase).
    // We need the song id — for new songs onSave returns the id; for edits we have initial.id.
    // We save now for edits; for new songs the parent's onSave handler will call setSongAccentsLocal
    // with the newly-assigned id via the song object's accents field.
    if (initial?.id) {
      setSongAccentsLocal(initial.id, accents);
      setSongSubdivision(initial.id, subdivision);
    }
    onSave({
      title: cleanTitle, artist: cleanArtist, tempo: tempo === "" ? "" : Number(tempo), timeSignature: formatTimeSig(timeSig),
      key: savedKey, keyQuality, language, description, accents, subdivision,
      lyricsText, chordsText: normalizedChordsText, chartText, drumsText: drumsFromEditor(drumsText),
    });
  };
  // Save only lights up once something differs from the values the form opened with.
  const formSnapshot = JSON.stringify([title, artist, tempo, timeSig, keyNatural, keyAccidental, keyQuality, language, description, lyricsText, chordsText, chartText, drumsText, accents, subdivision]);
  const openedSnapshot = useRef(formSnapshot);
  const canSave = title.trim().length > 0 && formSnapshot !== openedSnapshot.current;
  const SECTION_TAB_VALUES = { lyrics: [lyricsText, setLyricsText], chords: [chordsText, setChordsText], chart: [chartText, setChartText], drums: [drumsText, setDrumsText] };
  const [activeSectionValue, setActiveSectionValue] = SECTION_TAB_VALUES[sectionTab];
  const SECTION_TAB_PLACEHOLDERS = {
    lyrics: "-Verse\nFirst line\nSecond line\n-Chorus\n…",
    chords: "-Verse\n1 4 5\n-Chorus\n…",
    chart: "-Verse\n[C]First line [G]of lyrics\n-Chorus\n…",
    drums: "-Verse\nKick [First line of lyrics]\nSnare [Second line]\n-Chorus\n…",
  };

  return (
    <div className="scroll-list" style={{ position: "fixed", inset: 0, zIndex: 150, background: C.bg, color: C.text, fontFamily: FONT, overflowY: dragging ? "hidden" : "auto", touchAction: dragging ? "none" : "pan-y", boxSizing: "border-box", paddingBottom: keyboardInset ? Math.max(60, keyboardInset + 60) : 60, transform: dragX ? `translateX(${dragX}px)` : "none", transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none" }} {...handlers}>
      <div data-sticky-header style={{ padding: "calc(16px + var(--safe-top)) 20px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 5, background: C.bg }}>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}><ChevronLeft size={22} /></button>
        <div style={{ fontSize: 17, fontWeight: 600 }}>{initial ? "Edit Song" : "Add Song"}</div>
        <div style={{ flex: 1 }} />
        <button disabled={!canSave} onClick={handleSave} style={{ height: 34, padding: "0 16px", borderRadius: 9, border: "none", background: canSave ? C.accent : C.surface2, color: canSave ? "#fff" : C.textFaint, fontFamily: FONT, fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
          Save
        </button>
      </div>

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18, paddingBottom: 60, width: "100%", boxSizing: "border-box" }}>
        {error && (
          <div style={{ color: C.danger, fontSize: 13.5, textAlign: "center", fontWeight: 600, padding: "10px 14px", background: "rgba(255, 69, 58, 0.12)", border: `1px solid ${C.danger}40`, borderRadius: 10 }}>
            {error}
          </div>
        )}
        <Field label="TITLE"><ClearableInput autoFocus={!initial} value={title} onChangeText={handleTitleChange} placeholder="Song title" style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box", paddingRight: title ? 36 : 14 }} /></Field>
        <Field label="ARTIST"><ClearableInput value={artist} onChangeText={(v) => { setArtist(toTitleCase(v)); setError(""); }} placeholder="Artist" style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box", paddingRight: artist ? 36 : 14 }} /></Field>

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
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} onFocus={scrollFieldIntoView} placeholder="Arrangement notes, keys, or style"
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

          <HighlightedAutoGrowTextarea
            value={activeSectionValue}
            onChange={(e) => setActiveSectionValue(e.target.value)}
            onBlur={() => { if (sectionTab === "chords") setChordsText((t) => autoBracketNumbers(t)); }}
            placeholder={SECTION_TAB_PLACEHOLDERS[sectionTab]}
            accent={C.accent}
            drumMode={sectionTab === "drums"}
            chartMode={sectionTab === "chart"}
            C={C}
            wrapperStyle={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, minHeight: 140 }}
            textStyle={{ fontFamily: FONT, fontSize: 16, fontWeight: lyricsBold ? 700 : 400, lineHeight: 1.4, textAlign: "left", padding: "12px 14px", whiteSpace: "pre-wrap", wordBreak: "keep-all", overflowWrap: "normal", hyphens: "none" }} />
        </Field>

        {initial ? (
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button onClick={() => onDelete(initial)} style={{ flex: 1, fontFamily: FONT, fontWeight: 600, fontSize: 13, padding: "14px 0", borderRadius: 12, border: `1px solid ${C.border}`, background: "transparent", color: C.danger, display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
              <Trash2 size={15} color={C.danger} />Delete
            </button>
            <button onClick={() => onDuplicate(initial)} style={{ flex: 1, fontFamily: FONT, fontWeight: 600, fontSize: 13, padding: "14px 0", borderRadius: 12, border: `1px solid ${C.border}`, background: "transparent", color: C.text, display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
              <Copy size={15} color={C.text} />Duplicate
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* =========================================================================
   Songs list
   ========================================================================= */
function SongRow({ song, onOpen, onEdit, onLoadToMetronome, onLoadToPiano, mode, tanglishMode, isSwipeOpen, lastScrollTimeRef, C }) {
  const longPressTimerRef = useRef(null);
  const firedLongPressRef = useRef(false);
  const swipeStartRef = useRef(null);
  const [swipeDx, setSwipeDx] = useState(0);
  const swipeFiredRef = useRef(false);
  // Track whether the delete swipe was already open when the gesture started.
  // If the row was open, we let the gesture close it but suppress the load-to-piano/metronome
  // action — the user must start a fresh swipe from the closed state to trigger load.
  const wasOpenRef = useRef(false);

  const isVocals = mode === "vocals";
  const isDrums = mode === "drums";
  const canSwipeRight = (isDrums && !!onLoadToMetronome) || (isVocals && !!onLoadToPiano);

  const startPress = (e) => {
    firedLongPressRef.current = false;
    // If the scroll list was scrolling within the last 400ms, don't start long-press.
    if (lastScrollTimeRef && Date.now() - (lastScrollTimeRef.current || 0) < 400) return;
    // Capture whether the delete panel was already exposed when this touch began.
    wasOpenRef.current = Boolean(isSwipeOpen);
    const point = e.touches ? e.touches[0] : e;
    const x = point.clientX, y = point.clientY;
    swipeStartRef.current = { x, y };
    swipeFiredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      firedLongPressRef.current = true;
      if (navigator.vibrate) navigator.vibrate(15);
      if (onEdit) onEdit(song);
    }, 500);
  };

  const movePress = (e) => {
    if (!swipeStartRef.current || firedLongPressRef.current) return;
    const point = e.touches ? e.touches[0] : e;
    const dx = point.clientX - swipeStartRef.current.x;
    const dy = point.clientY - swipeStartRef.current.y;
    // Cancel long-press if finger moved more than 8px in any direction.
    if (Math.hypot(dx, dy) > 8) {
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    }
    if (!canSwipeRight) return;
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) setSwipeDx(Math.min(dx, 120));
    }
  };

  const cancelPress = () => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    // Only fire the load action if the row was NOT already open (i.e. this is a fresh right-swipe,
    // not the gesture that closes the delete panel).
    if (swipeDx > 60 && !wasOpenRef.current) {
      swipeFiredRef.current = true;
      if (isDrums && onLoadToMetronome) onLoadToMetronome(song);
      else if (isVocals && onLoadToPiano) onLoadToPiano(song);
    }
    setSwipeDx(0);
    swipeStartRef.current = null;
    wasOpenRef.current = false;
  };

  const handleClick = () => {
    if (firedLongPressRef.current) { firedLongPressRef.current = false; return; }
    if (swipeFiredRef.current) { swipeFiredRef.current = false; return; }
    onOpen(song);
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    firedLongPressRef.current = true;
    if (onEdit) onEdit(song);
  };

  const badgeText = mode === "drums" ? (song.tempo !== "" && song.tempo != null ? `${song.tempo}` : "—") : keyLabel(song);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", position: "relative", transform: `translateX(${swipeDx}px)`, transition: swipeDx === 0 ? "transform 120ms ease" : "none", background: C.bg, zIndex: 1, userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
      onClick={handleClick} onTouchStart={startPress} onTouchMove={movePress} onTouchEnd={cancelPress} onTouchCancel={cancelPress}
      onMouseDown={startPress} onMouseMove={movePress} onMouseUp={cancelPress} onMouseLeave={cancelPress} onContextMenu={handleContextMenu}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Tamil>{maybeTanglishTitle(stripAltTitle(song.title), tanglishMode)}</Tamil></div>
        <div style={{ fontSize: 12.5, color: "#6A6A6E", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Tamil>{maybeTanglishTitle(song.artist, tanglishMode) || "Unknown"}</Tamil></div>
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color: C.accent, border: `1px solid ${C.accentDim}`, borderRadius: 6, padding: "3px 7px", flexShrink: 0 }}>{badgeText}</span>
    </div>
  );
}

function SongsScreen({ songs, onOpen, onAdd, onEdit, onDelete, onLoadToMetronome, onLoadToPiano, mode, tanglishMode, C }) {
  const [query, setQuery] = useState("");
  const [langFilter, setLangFilter] = useState("All");
  const [openSwipeId, setOpenSwipeId] = useState(null);
  const keyboardInset = useKeyboardInset();
  // Track last scroll time so SongRow can suppress long-press if user just scrolled
  const lastScrollTimeRef = useRef(0);
  // Total under the title follows the language filter (All / English / Tamil), not the search box.
  const languageSongCount = langFilter === "All" ? songs.length : songs.filter((s) => s.language === langFilter).length;
  const filtered = songs
    .filter((s) => songMatchesQuery(s, query))
    .filter((s) => langFilter === "All" || s.language === langFilter)
    .sort((a, b) => stripAltTitle(a.title).localeCompare(stripAltTitle(b.title), undefined, { sensitivity: "base" }));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 auto", padding: "22px 20px 14px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div><div style={{ fontSize: 26, fontWeight: 700 }}>Songs</div><div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{languageSongCount} songs</div></div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setLangFilter(f => f === "All" ? "English" : f === "English" ? "Tamil" : "All")} style={{ height: 34, padding: "0 14px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontFamily: FONT, fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
              {langFilter === "All" ? "All" : (langFilter === "Tamil" ? (tanglishMode ? "Tamil" : "தமிழ்") : (LANGUAGES.find(l => l.id === langFilter)?.label || langFilter))}
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
      <div className="scroll-list" onScroll={() => { lastScrollTimeRef.current = Date.now(); }} style={{ flex: 1, overflowY: "auto", padding: `0 20px ${14 + keyboardInset}px`, boxSizing: "border-box" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>{songs.length === 0 ? "No songs yet." : "No matches."}</div>
        ) : filtered.map((s) => (
          <SwipeToDelete key={s.id} id={s.id} openId={openSwipeId} onOpenIdChange={setOpenSwipeId} onDelete={() => onDelete(s.id)} C={C}>
            <SongRow song={s} onOpen={(song) => { setQuery(""); onOpen(song); }} onEdit={onEdit} onDelete={onDelete} onLoadToMetronome={onLoadToMetronome} onLoadToPiano={onLoadToPiano} mode={mode} tanglishMode={tanglishMode} isSwipeOpen={openSwipeId === s.id} lastScrollTimeRef={lastScrollTimeRef} C={C} />
          </SwipeToDelete>
        ))}
      </div>
    </div>
  );
}

function compareEnglishThenTamil(a, b) {
  const ta = (t) => /[\u0B80-\u0BFF]/.test(t);
  const titleA = stripAltTitle(a.title), titleB = stripAltTitle(b.title);
  const tamilA = ta(titleA), tamilB = ta(titleB);
  if (tamilA !== tamilB) return tamilA ? 1 : -1;
  return titleA.localeCompare(titleB, tamilA ? "ta" : undefined, { sensitivity: "base", numeric: true });
}
function SongPickerScreen({ songs, selectedIds, onToggle, onClose, setlistName, onRenameSetlist, isShared, onToggleShared, mode, tanglishMode, C }) {
  const [query, setQuery] = useState("");
  const [nameDraft, setNameDraft] = useState(setlistName ?? "");
  // English titles first (A–Z), then Tamil titles (in Tamil alphabetical order).
  const filtered = songs.filter((s) => songMatchesQuery(s, query)).sort(compareEnglishThenTamil);
  const commitName = () => { const trimmed = nameDraft.trim(); if (trimmed && onRenameSetlist) onRenameSetlist(trimmed); else setNameDraft(setlistName ?? ""); };
  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 150, display: "flex", flexDirection: "column", paddingTop: "var(--safe-top)", boxSizing: "border-box" }}>
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onClose} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}><ChevronLeft size={22} /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <input className="no-ring" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onBlur={commitName} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            style={{ width: "100%", boxSizing: "border-box", fontFamily: FONT, fontSize: 17, fontWeight: 600, background: "transparent", border: "none", color: C.text, padding: 0, outline: "none" }} />
        </div>
        {onToggleShared && (
          <button
            onClick={() => onToggleShared(!isShared)}
            style={{
              height: 30,
              padding: "0 10px",
              borderRadius: 8,
              fontFamily: FONT,
              fontWeight: 700,
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              border: `1px solid ${isShared ? C.accentDim : C.border}`,
              background: isShared ? C.accentSoft : C.surface2,
              color: isShared ? C.accent : C.text,
              cursor: "pointer"
            }}
          >
            {isShared ? "Shared" : "Share"}
          </button>
        )}
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
            <div key={s.id} onClick={() => { setQuery(""); onToggle(s.id); }} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
              <div style={{ width: 21, height: 21, borderRadius: "50%", border: `1.5px solid ${checked ? C.accent : C.borderStrong}`, background: checked ? C.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {checked && <Check size={14} color="#fff" />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 15.5, fontWeight: 600 }}><Tamil>{maybeTanglish(stripAltTitle(s.title), tanglishMode)}</Tamil></div><div style={{ fontSize: 12.5, color: C.textMuted }}><Tamil>{maybeTanglish(s.artist, tanglishMode) || "Unknown"}</Tamil></div></div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.accent }}>
                {mode === "drums" ? (s.tempo !== "" && s.tempo != null ? `${s.tempo}` : "—") : keyLabel(s)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* =========================================================================
   Song detail / chart viewer.
   ========================================================================= */
function SongDetailScreen({
  song, contextKey, onKeyChange, contextTempo, onTempoChange, onBack, onEdit, onDelete,
  fontSize, textAlign, lyricsBold, notesBold, lineSpacing, noteSpacing = 1, chordFontSize, sectionFontSize,
  isInSetlist, isSharedSetlist, syncedKeyOverride, syncedTempoOverride, onSaveOverrideToTeam,
  onRemoveFromSetlist, onPrevSong, onNextSong, mode, engine, tanglishMode, C
}) {
  const [viewKey, setViewKey] = useState(contextKey ?? song.key);
  const [descOpen, setDescOpen] = useState(false);
  const [chordsView, setChordsView] = useLocalStorageState("altar:song-view-chords-mode", "chords");
  const [nashvilleMode, setNashvilleMode] = useState(true);
  const [metroBarVisible, setMetroBarVisible] = useLocalStorageState("altar:song-view-metro-bar", false);
  const ms = migrateSongShape(song);

  const showBottomBar = mode === "drums" && !!engine && metroBarVisible;

  const scrollRef = useRef(null);
  // Layout effect: the reset must land before the new song is painted (it may be sliding in).
  useLayoutEffect(() => {
    setViewKey(contextKey ?? song.key);
    setDescOpen(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [song.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (mode === "drums" && engine) engine.loadSong({ ...song, tempo: contextTempo ?? song.tempo }); }, [song.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const cycleSubdivision = () => engine && engine.setSubdivision((engine.subdivision % 3) + 1);

  // Tempo changes made here (within a setlist) are saved back onto that
  // setlist's entry as a tempoOverride, mirroring how key changes are
  // scoped to the setlist rather than overwriting the song's own tempo.
  // Smoothly updates BPM without stopping/restarting or cranking the metronome.
  const stepBpm = (delta) => {
    if (!engine) return;
    const next = Math.min(300, Math.max(30, Math.round(engine.bpm + delta)));
    engine.setBpm(next, true);
    if (onTempoChange) onTempoChange(next);
  };
  const decBpmHold = useHoldRepeat(() => stepBpm(-1));
  const incBpmHold = useHoldRepeat(() => stepBpm(1));

  const edgeBack = useEdgeSwipeBack(onBack, isInSetlist ? 0 : 80);
  const setlistSwipe = useSetlistSongSwipe(onPrevSong, onNextSong, scrollRef, song.id);
  const { dragX, leaving, dragging, handlers, transitioning } = isInSetlist
    ? { dragX: 0, leaving: false, dragging: false, handlers: setlistSwipe.handlers, transitioning: false }
    : { ...edgeBack, transitioning: false };

  const stepKey = (delta) => { const next = transposeKey(viewKey, delta); setViewKey(next); if (onKeyChange) onKeyChange(next); };

  const titleLongPressRef = useRef(null);
  const startTitlePress = () => {
    if (titleLongPressRef.current) clearTimeout(titleLongPressRef.current);
    titleLongPressRef.current = setTimeout(() => { if (onEdit) onEdit(song); }, 500);
  };
  const cancelTitlePress = () => { if (titleLongPressRef.current) { clearTimeout(titleLongPressRef.current); titleLongPressRef.current = null; } };

  const labelFontSize = sectionFontSize != null ? sectionFontSize : Math.max(10, Math.min(18, Math.round(fontSize * 0.5)));
  const badgeStyle = { fontSize: 12.5, color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 10px", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 };
  const chevronBtn = { width: 28, height: 28, borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", color: C.text, flexShrink: 0 };
  const keyButtonStyle = { width: 44, minWidth: 44, height: 28, padding: 0, borderRadius: 8, fontFamily: FONT, fontWeight: 800, fontSize: 13.5, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: `1px solid ${C.border}`, background: C.surface2, color: C.text };
  const lyricsToggleStyle = (on) => ({ height: 28, minWidth: 56, padding: "0 8px", borderRadius: 8, fontFamily: FONT, fontWeight: 700, fontSize: 12.5, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: `1px solid ${on ? C.accentDim : C.border}`, background: on ? C.accentSoft : C.surface2, color: on ? C.accent : C.textMuted });

  const isVocals = mode === "vocals";
  const activeRawText = isVocals ? ms.lyricsText : mode === "drums" ? drumsToTagged(ms.drumsText) : (chordsView === "chords" ? ms.chordsText : ms.chartText);

  const hasKeyChanged = Boolean(isSharedSetlist && onSaveOverrideToTeam && viewKey !== (syncedKeyOverride ?? song.key));
  const currentBpm = engine ? Math.round(engine.bpm) : (contextTempo ?? song.tempo);
  const baseTempo = syncedTempoOverride ?? (song.tempo === "" || song.tempo == null ? 120 : song.tempo);
  const hasTempoChanged = Boolean(isSharedSetlist && onSaveOverrideToTeam && currentBpm !== Number(baseTempo));

  return (
    <>
    {/* Solid backdrop so the setlist page never shows through while the song card slides. */}
    {isInSetlist && <div style={{ position: "fixed", inset: 0, background: C.bg, zIndex: 99 }} />}
    <div style={{ position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 100, display: "flex", flexDirection: "column", overflow: "hidden", paddingTop: "var(--safe-top)", boxSizing: "border-box", transform: isInSetlist ? undefined : `translateX(${dragX}px)`, transition: isInSetlist ? "none" : ((leaving || transitioning) ? "transform 180ms ease-out" : dragging ? "none" : dragX === 0 ? "transform 180ms ease" : "none"), touchAction: "pan-y" }} {...handlers}>
      <div style={{ flex: "0 0 auto", padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}`, position: "relative", zIndex: 2, background: C.bg }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6, position: "relative", zIndex: 1 }}><ChevronLeft size={22} /></button>
        <div style={{ flex: 1, minWidth: 0 }} />
        <div
          onTouchStart={startTitlePress} onTouchMove={cancelTitlePress} onTouchEnd={cancelTitlePress} onTouchCancel={cancelTitlePress}
          onMouseDown={startTitlePress} onMouseUp={cancelTitlePress} onMouseLeave={cancelTitlePress}
          style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", maxWidth: "calc(100% - 140px)", textAlign: "center", cursor: "pointer" }}
        >
          <div style={{ fontSize: 15, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Tamil>{maybeTanglishTitle(stripAltTitle(song.title), tanglishMode)}</Tamil></div>
          {song.artist && <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Tamil>{maybeTanglishTitle(song.artist, tanglishMode)}</Tamil></div>}
        </div>
        {mode === "drums" && !!engine && song.description && (
          <button onClick={() => setMetroBarVisible((v) => !v)} style={{ ...chevronBtn, width: 30, height: 30, position: "relative", zIndex: 1, border: `1px solid ${metroBarVisible ? C.accentDim : C.border}`, background: metroBarVisible ? C.accentSoft : C.surface2, color: metroBarVisible ? C.accent : C.text }}>
            <MetronomeIcon size={16} color={metroBarVisible ? C.accent : C.text} />
          </button>
        )}
        {song.description ? (
          <button onClick={() => setDescOpen((o) => !o)} style={{ ...chevronBtn, width: 30, height: 30, position: "relative", zIndex: 1 }}>
            <ChevronDown size={16} style={{ transform: descOpen ? "rotate(180deg)" : "none", transition: "transform 150ms ease" }} />
          </button>
        ) : mode === "drums" && !!engine ? (
          <button onClick={() => setMetroBarVisible((v) => !v)} style={{ ...chevronBtn, width: 30, height: 30, position: "relative", zIndex: 1, border: `1px solid ${metroBarVisible ? C.accentDim : C.border}`, background: metroBarVisible ? C.accentSoft : C.surface2, color: metroBarVisible ? C.accent : C.text }}>
            <MetronomeIcon size={16} color={metroBarVisible ? C.accent : C.text} />
          </button>
        ) : (
          <div style={{ width: 30, height: 30, flexShrink: 0 }} />
        )}
      </div>

      {mode === "chords" && (
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 6, padding: "10px 14px", borderBottom: `1px solid ${C.border}`, flexWrap: "nowrap", overflow: "hidden" }}>
          <button onClick={() => setChordsView((v) => (v === "chords" ? "chart" : "chords"))} style={{ ...lyricsToggleStyle(true), minWidth: 60, width: 60 }}>{chordsView === "chords" ? "Chords" : "Chart"}</button>
          {song.timeSignature && <span style={badgeStyle}>{song.timeSignature}</span>}
          {song.tempo !== "" && song.tempo != null && <span style={badgeStyle}>{song.tempo} BPM</span>}
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            {hasKeyChanged && (
              <button
                onClick={() => onSaveOverrideToTeam?.({ keyOverride: viewKey })}
                title="Save key to Team"
                style={{ ...chevronBtn, border: `1px solid ${C.accentDim}`, background: C.accentSoft, color: C.accent }}
              >
                <Save size={14} color={C.accent} />
              </button>
            )}
            <button onClick={() => stepKey(-1)} style={chevronBtn}><ChevronLeft size={15} /></button>
            <button onClick={() => setNashvilleMode(!nashvilleMode)} style={{ ...keyButtonStyle, border: `1px solid ${!nashvilleMode ? C.accentDim : C.border}`, background: !nashvilleMode ? C.accentSoft : C.surface2, color: !nashvilleMode ? C.accent : C.text }}>
              {flatify(`${viewKey}${song.keyQuality === "Minor" ? "m" : ""}`)}
            </button>
            <button onClick={() => stepKey(1)} style={chevronBtn}><ChevronRight size={15} /></button>
          </div>
        </div>
      )}

      {mode === "drums" && !!engine && (
        <div style={{ flex: "0 0 auto", position: "relative", display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 6, padding: "10px 14px", borderBottom: `1px solid ${C.border}`, overflow: "visible", zIndex: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, justifySelf: "start", position: "relative", zIndex: 1 }}>
            <TimeSigPicker value={engine.timeSig} onChange={engine.setTimeSig} height={30} fontSize={12.5} C={C} />
            <button onClick={cycleSubdivision} style={{ ...chevronBtn, width: 30, height: 30 }}>
              <SubdivisionIcon value={engine.subdivision} size={14} color={C.text} />
            </button>
          </div>
          <div style={{ justifySelf: "center" }}>
            <BeatAccentControl count={(engine.timeSig.beats === 6 && engine.timeSig.unit === 8) ? 4 : engine.timeSig.beats} accents={engine.accents} onChange={engine.setAccents} size={7} muted={engine.muted} C={C} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, justifySelf: "end", position: "relative", zIndex: 1 }}>
            {hasTempoChanged && (
              <button
                onClick={() => onSaveOverrideToTeam?.({ tempoOverride: currentBpm })}
                title="Save tempo to Team"
                style={{ ...chevronBtn, width: 30, height: 30, border: `1px solid ${C.accentDim}`, background: C.accentSoft, color: C.accent }}
              >
                <Save size={15} color={C.accent} />
              </button>
            )}
            <div style={{ ...badgeStyle, width: 78, minWidth: 78, height: 30, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", fontVariantNumeric: "tabular-nums", padding: 0 }}>{Math.round(engine.bpm)} BPM</div>
          </div>
        </div>
      )}

      <div ref={scrollRef} className="scroll-list" style={{ flex: 1, overflowY: dragging ? "hidden" : "auto", overflowX: "hidden", padding: "16px 20px 40px", touchAction: dragging ? "none" : "pan-y", willChange: isInSetlist ? "transform" : undefined }}>
        {descOpen && song.description && (
          <div style={{ marginBottom: 18, padding: "11px 13px", background: C.surface2, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.accent}`, borderRadius: 8, fontSize: 13.5, color: C.textMuted, whiteSpace: "pre-wrap" }}>
            {maybeTanglish(song.description, tanglishMode)}
          </div>
        )}
        {(() => {
          if (mode === "chords" && chordsView === "chords") {
            const rawText = ms.chordsText;
            return parseTextIntoBlocks(rawText, true).map((block, idx) => (
              <div key={idx} style={{ marginBottom: 20, paddingTop: idx > 0 ? 16 : 0, borderTop: idx > 0 ? `1px solid ${C.border}` : "none" }}>
                {block.label && <div style={{ fontSize: labelFontSize, letterSpacing: 1.5, textTransform: "uppercase", color: C.accent, marginBottom: Math.max(6, labelFontSize * 0.7), textAlign }}>{block.label}</div>}
                <ChordsOnlyBlock
                  lines={block.lines}
                  viewKey={viewKey}
                  keyQuality={song.keyQuality}
                  nashvilleMode={nashvilleMode}
                  textAlign={textAlign}
                  fontSize={fontSize}
                  chordFontSize={chordFontSize}
                  lineSpacing={lineSpacing}
                  lyricsBold={lyricsBold}
                  notesBold={notesBold}
                  tanglishMode={tanglishMode}
                  C={C}
                />
              </div>
            ));
          }

          let displayText = activeRawText;
          if (mode === "chords" && !nashvilleMode) displayText = numbersTaggedToChordsTagged(displayText, viewKey, song.keyQuality);
          const letterSpacing = tanglishLetterSpacing(displayText, tanglishMode);
          displayText = maybeTanglish(displayText, tanglishMode);
          return parseTextIntoBlocks(displayText, true).map((block, idx) => (
            <div key={idx} style={{ marginBottom: 20, paddingTop: idx > 0 ? 16 : 0, borderTop: idx > 0 ? `1px solid ${C.border}` : "none" }}>
              {block.label && <div style={{ fontSize: labelFontSize, letterSpacing: 1.5, textTransform: "uppercase", color: C.accent, marginBottom: Math.max(6, labelFontSize * 0.7), textAlign }}>{block.label}</div>}
              {isVocals ? (
                <LyricsText text={block.lines.join("\n")} textAlign={textAlign} fontSize={fontSize} lineHeightMult={lineSpacing} bold={lyricsBold} letterSpacing={letterSpacing} />
              ) : (
                <ChordText text={block.lines.join("\n")} editable={false} dim showLyrics brightTags textAlign={textAlign} fontSize={fontSize} tagFontSize={chordFontSize} lineHeightMult={lineSpacing} accent={C.accent} lyricsBold={lyricsBold} notesBold={notesBold} flattenTags={mode === "chords" && !nashvilleMode} C={C} tagGapMult={noteSpacing} hyphenateOverlaps={mode === "chords"} padWordForTag={true} letterSpacing={letterSpacing} />
              )}
            </div>
          ));
        })()}
      </div>

      {showBottomBar && (
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "14px 16px max(20px, calc(10px + var(--safe-bottom)))", background: "#0B0B0C" }}>
          <button {...decBpmHold} style={{ width: 48, height: 48, borderRadius: "50%", border: "none", background: C.surface2, color: C.text, fontSize: 22, fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>−</button>
          <button onPointerDown={(e) => { e.preventDefault(); engine.toggle(); }} style={{ flex: "0 1 60%", height: 64, borderRadius: 18, border: "none", background: "#1F1F1F", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <PlayStopGlyph size={26} color={C.accent} playNudge={3} />
          </button>
          <button {...incBpmHold} style={{ width: 48, height: 48, borderRadius: "50%", border: "none", background: C.surface2, color: C.text, fontSize: 22, fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>+</button>
        </div>
      )}
    </div>
    </>
  );
}

/* =========================================================================
   Setlist song row
   ========================================================================= */
function SetlistSongRow({ song, keyOverride, tempoOverride, style, handlers, onClick, mode, tanglishMode, C }) {
  const effectiveTempo = tempoOverride ?? song.tempo;
  const badgeText = mode === "drums"
    ? (effectiveTempo !== "" && effectiveTempo != null ? `${effectiveTempo}` : "—")
    : flatify(`${keyOverride || song.key}${song.keyQuality === "Minor" ? "m" : ""}`);
  return (
    <div onClick={onClick} {...handlers} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", position: "relative", touchAction: "pan-y", ...style }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Tamil>{maybeTanglishTitle(stripAltTitle(song.title), tanglishMode)}</Tamil></div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Tamil>{maybeTanglishTitle(song.artist, tanglishMode) || "Unknown"}</Tamil></div>
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color: C.accent, border: `1px solid ${C.accentDim}`, borderRadius: 6, padding: "3px 7px", flexShrink: 0 }}>{badgeText}</span>
    </div>
  );
}

/* =========================================================================
   Setlist stage — merges Click's Stage (bottom metronome bar, only shown
   in Drums mode per spec #11) with Chords' setlist stage (reorder, swipe
   to delete, song picker).
   ========================================================================= */
function SetlistStageScreen({ setlist, songs, onBack, onCommit, onUpdateSetlist, onOpenSong, onDeleteSetlist, initialPickerOpen, mode, tanglishMode, C }) {
  const [pickerOpen, setPickerOpen] = useState(!!initialPickerOpen);
  const [openSwipeId, setOpenSwipeId] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const nameLongPressTimerRef = useRef(null);
  const { dragX, leaving, dragging, handlers } = useEdgeSwipeBack(onBack);

  const [activeDragIndex, setActiveDragIndex] = useState(null);
  const [dragY, setDragY] = useState(0);
  const dragTimerRef = useRef(null);
  const startYRef = useRef(0);
  const justDraggedRef = useRef(false);

  const commitName = () => { const trimmed = nameDraft.trim(); if (trimmed) { onUpdateSetlist({ ...setlist, name: trimmed }); onCommit?.(setlist.id); } setEditingName(false); };
  const startNameLongPress = () => { if (nameLongPressTimerRef.current) clearTimeout(nameLongPressTimerRef.current); nameLongPressTimerRef.current = setTimeout(() => { setPickerOpen(true); }, 500); };
  const cancelNameLongPress = () => { if (nameLongPressTimerRef.current) { clearTimeout(nameLongPressTimerRef.current); nameLongPressTimerRef.current = null; } };

  const [songToRemove, setSongToRemove] = useState(null);

  const setlistSongs = setlist.entries.map((e) => {
    const song = songs.find((s) => s.id === e.songId);
    return song ? { song, keyOverride: e.keyOverride, tempoOverride: e.tempoOverride } : null;
  }).filter(Boolean);

  const removeFromStage = (songId, commit = false) => {
    onUpdateSetlist({ ...setlist, entries: setlist.entries.filter((e) => e.songId !== songId) });
    if (commit) onCommit?.(setlist.id);
  };
  const requestRemoveFromStage = (songId) => {
    if (setlist.shared) {
      const s = songs.find((item) => item.id === songId);
      if (s) { setSongToRemove(s); return; }
    }
    removeFromStage(songId, true);
  };
  const toggleSong = (songId) => {
    const has = setlist.entries.some((e) => e.songId === songId);
    if (has && setlist.shared) {
      const s = songs.find((item) => item.id === songId);
      if (s) { setSongToRemove(s); return; }
    }
    onUpdateSetlist({ ...setlist, entries: has ? setlist.entries.filter((e) => e.songId !== songId) : [...setlist.entries, { songId, keyOverride: null, tempoOverride: null }] });
  };

  const mouseDragIdxRef = useRef(null);
  const startSongDrag = (idx, clientY) => {
    startYRef.current = clientY;
    if (dragTimerRef.current) clearTimeout(dragTimerRef.current);
    dragTimerRef.current = setTimeout(() => { setActiveDragIndex(idx); setDragY(0); if (navigator.vibrate) navigator.vibrate(15); }, 400);
  };
  const moveSongDrag = (idx, clientY, preventDefault) => {
    if (activeDragIndex === null) { if (Math.abs(clientY - startYRef.current) > 10) clearTimeout(dragTimerRef.current); }
    else {
      if (preventDefault) preventDefault();
      const deltaY = clientY - startYRef.current;
      setDragY(deltaY);
      const rowHeight = 60; const total = setlistSongs.length;
      if (deltaY > rowHeight / 2 && idx < total - 1) {
        const next = [...setlist.entries];[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
        onUpdateSetlist({ ...setlist, entries: next });
        startYRef.current += rowHeight; setActiveDragIndex(idx + 1); setDragY(clientY - startYRef.current);
        mouseDragIdxRef.current = idx + 1;
      } else if (deltaY < -rowHeight / 2 && idx > 0) {
        const next = [...setlist.entries];[next[idx], next[idx - 1]] = [next[idx - 1], next[idx]];
        onUpdateSetlist({ ...setlist, entries: next });
        startYRef.current -= rowHeight; setActiveDragIndex(idx - 1); setDragY(clientY - startYRef.current);
        mouseDragIdxRef.current = idx - 1;
      }
    }
  };
  const endSongDrag = () => { if (dragTimerRef.current) clearTimeout(dragTimerRef.current); if (activeDragIndex !== null) { justDraggedRef.current = true; onCommit?.(setlist.id); } setActiveDragIndex(null); setDragY(0); mouseDragIdxRef.current = null; };
  const handleSongTouchStart = (idx, e) => { if (e.touches.length !== 1) return; startSongDrag(idx, e.touches[0].clientY); };
  const handleSongTouchMove = (idx, e) => { if (e.touches.length !== 1) return; moveSongDrag(idx, e.touches[0].clientY, () => { e.preventDefault(); e.stopPropagation(); }); };
  const handleSongTouchEnd = () => endSongDrag();
  const handleSongMouseDown = (idx, e) => { mouseDragIdxRef.current = idx; startSongDrag(idx, e.clientY); };
  useEffect(() => {
    const onMouseMove = (e) => { if (mouseDragIdxRef.current !== null) moveSongDrag(mouseDragIdxRef.current, e.clientY); };
    const onMouseUp = () => { if (mouseDragIdxRef.current !== null) endSongDrag(); };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  });

  const bottomInset = "calc(55px + max(36px, 8px + var(--safe-bottom)))";

  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: bottomInset, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 80, display: "flex", flexDirection: "column", paddingTop: "var(--safe-top)", boxSizing: "border-box", transform: `translateX(${dragX}px)`, transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none" }} {...handlers}>
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
        <button onClick={() => setPickerOpen(true)} style={{ width: 34, height: 34, borderRadius: "50%", border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer" }}>
          <Pencil size={16} color={C.accent} />
        </button>
      </div>

      <div className="scroll-list" style={{ flex: 1, overflowY: (activeDragIndex !== null || dragging) ? "hidden" : "auto", padding: "0 20px 14px", boxSizing: "border-box", touchAction: (activeDragIndex !== null || dragging) ? "none" : "pan-y" }}>
        {setlistSongs.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>No songs added yet.</div>
        ) : setlistSongs.map(({ song: s, keyOverride, tempoOverride }, idx) => {
          const isDraggingThis = activeDragIndex === idx;
          return (
            <SwipeToDelete key={s.id} id={s.id} openId={openSwipeId} onOpenIdChange={setOpenSwipeId} onDelete={() => requestRemoveFromStage(s.id)} icon={X} C={C} elevated={isDraggingThis}>
              <SetlistSongRow
                song={s} keyOverride={keyOverride} tempoOverride={tempoOverride} mode={mode} tanglishMode={tanglishMode} C={C}
                onClick={() => {
                  if (justDraggedRef.current) { justDraggedRef.current = false; return; }
                  if (activeDragIndex === null) onOpenSong(s);
                }}
                handlers={{
                  onTouchStart: (e) => handleSongTouchStart(idx, e),
                  onTouchMove: (e) => handleSongTouchMove(idx, e),
                  onTouchEnd: handleSongTouchEnd,
                  onTouchCancel: handleSongTouchEnd,
                  onMouseDown: (e) => handleSongMouseDown(idx, e),
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
        <SongPickerScreen
          songs={songs}
          selectedIds={setlist.entries.map((e) => e.songId)}
          onToggle={toggleSong}
          onClose={() => { setPickerOpen(false); onCommit?.(setlist.id); }}
          setlistName={setlist.name}
          onRenameSetlist={(name) => onUpdateSetlist({ ...setlist, name })}
          isShared={Boolean(setlist.shared)}
          onToggleShared={(shared) => onUpdateSetlist({ ...setlist, shared })}
          mode={mode}
          tanglishMode={tanglishMode}
          C={C}
        />
      )}

      {songToRemove && (
        <RemoveSharedSongModal
          song={songToRemove}
          setlist={setlist}
          onConfirm={() => {
            removeFromStage(songToRemove.id, !pickerOpen);
            setSongToRemove(null);
          }}
          onCancel={() => setSongToRemove(null)}
          C={C}
        />
      )}
    </div>
  );
}

function SetlistsScreen({ setlists, onOpenStage, onCreate, onDelete, C }) {
  const [query, setQuery] = useState("");
  const [openSwipeId, setOpenSwipeId] = useState(null);
  const keyboardInset = useKeyboardInset();
  const filtered = setlists.filter((sl) => sl.name.toLowerCase().includes(query.toLowerCase()));

  // Sort setlists by last added or last opened first
  const sorted = [...filtered].sort((a, b) => {
    const timeA = a.lastOpenedAt || a.updatedAt || a.createdAt || 0;
    const timeB = b.lastOpenedAt || b.updatedAt || b.createdAt || 0;
    if (timeA !== timeB) return timeB - timeA;
    return setlists.indexOf(b) - setlists.indexOf(a);
  });

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 auto", padding: "22px 20px 14px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div><div style={{ fontSize: 26, fontWeight: 700 }}>Setlists</div><div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{setlists.length} setlist{setlists.length === 1 ? "" : "s"}</div></div>
          <button onClick={onCreate} style={{ width: 34, height: 34, borderRadius: "50%", border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Plus size={17} color={C.accent} /></button>
        </div>
        <div style={{ marginTop: 16 }}>
          <ClearableInput value={query} onChangeText={setQuery} placeholder="Search setlists"
            leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
            style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box", paddingLeft: 36, paddingRight: query ? 36 : 14 }} />
        </div>
      </div>
      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", padding: `0 20px ${14 + keyboardInset}px`, boxSizing: "border-box" }}>
        {sorted.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>{setlists.length === 0 ? "No setlists yet." : "No matches."}</div>
        )}
        {sorted.map((sl) => (
          <SwipeToDelete key={sl.id} id={sl.id} openId={openSwipeId} onOpenIdChange={setOpenSwipeId} onDelete={() => onDelete(sl.id)} C={C}>
            <div onClick={() => onOpenStage(sl.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{sl.name}</div>
                <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>{sl.entries.length} song{sl.entries.length === 1 ? "" : "s"}</div>
              </div>
              {sl.shared && (
                <span style={{ fontSize: 11, fontWeight: 700, color: C.accent, border: `1px solid ${C.accentDim}`, borderRadius: 6, padding: "2px 7px", flexShrink: 0 }}>
                  Shared
                </span>
              )}
            </div>
          </SwipeToDelete>
        ))}
      </div>
    </div>
  );
}

/* =========================================================================
   SpellingChartScreen — full-screen overlay listing every TANGLISH_EXCEPTIONS
   entry as a Tamil → Tanglish table, with inline add / edit / delete support.
   ========================================================================= */
function SpellingChartModal({ initialTamil = "", initialLatin = "", isNew = false, onSave, onDelete, onClose, C }) {
  const [tamil, setTamil] = useState(initialTamil);
  const [latin, setLatin] = useState(initialLatin);
  const [error, setError] = useState("");
  const keyboardInset = useKeyboardInset();
  const latinInputRef = useRef(null);

  const handleSave = () => {
    const t = tamil.trim();
    const l = latin.trim();
    if (!t) {
      setError("Please enter a Tamil word");
      return;
    }
    if (!l) {
      setError("Please enter its Tanglish transliteration");
      return;
    }
    onSave(t, l);
  };

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 300,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
        paddingBottom: keyboardInset ? `${keyboardInset + 20}px` : 20,
        transition: "padding-bottom 150ms ease-out",
        overflowY: "auto",
        boxSizing: "border-box"
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 360, background: C.surface2,
          border: `1px solid ${C.borderStrong}`, borderRadius: 16,
          padding: "22px 20px 20px", boxSizing: "border-box",
          boxShadow: "0 20px 48px rgba(0,0,0,0.7)", fontFamily: FONT
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
          {isNew ? <Plus size={18} color={C.accent} /> : <Pencil size={17} color={C.accent} />}
          {isNew ? "Add Spelling Override" : "Edit Spelling Override"}
        </div>

        {error && (
          <div style={{ color: C.danger, fontSize: 13, fontWeight: 600, padding: "8px 12px", background: "rgba(255, 69, 58, 0.12)", border: `1px solid ${C.danger}40`, borderRadius: 8, marginBottom: 14 }}>
            {error}
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6 }}>
            Tamil Word
          </label>
          <input
            autoFocus
            value={tamil}
            onChange={(e) => { setTamil(e.target.value); setError(""); }}
            placeholder="e.g. இயேசு"
            style={{
              width: "100%", height: 42, background: C.surface3,
              border: `1px solid ${C.border}`, borderRadius: 10,
              padding: "0 12px", color: C.text, fontFamily: FONT,
              fontSize: 15, fontWeight: 500, boxSizing: "border-box", outline: "none"
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") latinInputRef.current?.focus();
            }}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6 }}>
            Transliteration (Tanglish)
          </label>
          <input
            ref={latinInputRef}
            value={latin}
            onChange={(e) => { setLatin(e.target.value); setError(""); }}
            placeholder="e.g. Yesu"
            style={{
              width: "100%", height: 42, background: C.surface3,
              border: `1px solid ${C.border}`, borderRadius: 10,
              padding: "0 12px", color: C.text, fontFamily: FONT,
              fontSize: 15, fontWeight: 500, boxSizing: "border-box", outline: "none"
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
            }}
          />
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {!isNew && onDelete && (
            <button
              onClick={() => onDelete(initialTamil)}
              style={{
                width: 40, height: 40, borderRadius: 10,
                border: `1px solid ${C.danger ?? "#FF453A"}40`,
                background: "rgba(255, 69, 58, 0.12)",
                color: C.danger ?? "#FF453A",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", flexShrink: 0
              }}
              aria-label="Delete override"
            >
              <Trash2 size={16} />
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              flex: 1, height: 40, borderRadius: 10,
              border: `1px solid ${C.border}`, background: "transparent",
              color: C.text, fontFamily: FONT, fontSize: 14, fontWeight: 600,
              cursor: "pointer"
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={{
              flex: 1, height: 40, borderRadius: 10, border: "none",
              background: C.accent, color: "#fff",
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center"
            }}
          >
            {isNew ? "Add" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function SpellingChartRow({ tamilKey, value, isFirst, onClick, C }) {
  const rowBorder = isFirst ? "none" : `1px solid ${C.border}`;
  return (
    <button
      onClick={() => onClick(tamilKey, value)}
      style={{
        width: "100%", display: "grid", gridTemplateColumns: "1fr 1fr",
        alignItems: "center", gap: 0, padding: "13px 14px",
        borderTop: rowBorder, background: "none", border: "none",
        textAlign: "left", cursor: "pointer", boxSizing: "border-box"
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 500, color: C.text, paddingRight: 8 }}>{tamilKey}</div>
      <div style={{ fontSize: 14, fontWeight: 500, color: C.textMuted, paddingRight: 8 }}>{value}</div>
    </button>
  );
}

function SpellingChartScreen({ chart, onSave, onBack, C }) {
  const [modalData, setModalData] = useState(null); // null | { isNew: boolean, origTamil?: string, tamil: string, latin: string }
  const { dragX, leaving, dragging, handlers } = useEdgeSwipeBack(onBack);

  // User-added entries on top (newest-first), then seed entries below.
  const seedKeys = Object.keys(TANGLISH_EXCEPTIONS);
  const userKeys = Object.keys(chart).filter((k) => !seedKeys.includes(k)).reverse();
  const presentSeedKeys = seedKeys.filter((k) => k in chart);
  const rows = [...userKeys, ...presentSeedKeys];

  const handleSaveModal = (newTamil, newLatin) => {
    if (!modalData) return;
    if (modalData.isNew) {
      onSave({ [newTamil]: newLatin, ...chart });
    } else {
      const origTamil = modalData.origTamil;
      const next = { ...chart };
      if (origTamil && origTamil !== newTamil) {
        recordDeletedSpellingKey(origTamil);
        delete next[origTamil];
      }
      next[newTamil] = newLatin;
      onSave(next);
    }
    setModalData(null);
  };

  const handleDeleteModal = (tamilKey) => {
    recordDeletedSpellingKey(tamilKey);
    const next = { ...chart };
    delete next[tamilKey];
    onSave(next);
    setModalData(null);
  };

  return (
    <div
      className="scroll-list"
      style={{
        position: "fixed", inset: 0, zIndex: 150,
        background: C.bg, color: C.text, fontFamily: FONT,
        overflowY: dragging ? "hidden" : "auto",
        touchAction: dragging ? "none" : "pan-y",
        boxSizing: "border-box",
        paddingBottom: "max(40px, var(--safe-bottom))",
        transform: `translateX(${dragX}px)`,
        transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none"
      }}
      {...handlers}
    >
      {/* Sticky Header matching SongForm */}
      <div style={{ padding: "calc(16px + var(--safe-top)) 20px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 5, background: C.bg }}>
        <button
          onClick={onBack}
          style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6, marginLeft: -6, cursor: "pointer" }}
        >
          <ChevronLeft size={22} />
        </button>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Spelling Chart</div>
      </div>

      <div style={{ padding: 20, width: "100%", boxSizing: "border-box" }}>
        {/* Subtitle */}
        <div style={{ padding: "0 0 12px", fontSize: 12.5, color: C.textMuted, lineHeight: 1.5 }}>
          Custom transliteration overrides. Tap any row to edit.
        </div>

        {/* Rows with Add Word at the TOP */}
        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 24 }}>
          {/* Add Word top button */}
          <button
            onClick={() => setModalData({ isNew: true, tamil: "", latin: "" })}
            style={{ width: "100%", display: "grid", gridTemplateColumns: "1fr 1fr", alignItems: "center", gap: 0, padding: "13px 14px", background: "none", border: "none", textAlign: "left", cursor: "pointer", boxSizing: "border-box" }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, color: C.accent, display: "flex", alignItems: "center", gap: 6 }}>
              <Plus size={15} /> Add word...
            </div>
            <div style={{ fontSize: 13, color: C.textFaint }}>Custom transliteration</div>
          </button>

          {rows.map((key, idx) => (
            <SpellingChartRow
              key={key}
              tamilKey={key}
              value={chart[key]}
              isFirst={false}
              onClick={(tKey, val) => setModalData({ isNew: false, origTamil: tKey, tamil: tKey, latin: val })}
              C={C}
            />
          ))}
        </div>
      </div>

      {modalData && (
        <SpellingChartModal
          initialTamil={modalData.tamil}
          initialLatin={modalData.latin}
          isNew={modalData.isNew}
          onSave={handleSaveModal}
          onDelete={handleDeleteModal}
          onClose={() => setModalData(null)}
          C={C}
        />
      )}
    </div>
  );
}

// Display settings. One − / + control (10–100 px) sets the lyrics size; notes and section headers
// follow in fixed ratios. The three spacing presets set line spacing and note gap together.
const MIN_TEXT_SIZE = 10;
const MAX_TEXT_SIZE = 100;
const NOTES_SIZE_RATIO = 0.9;
const HEADER_SIZE_RATIO = 0.75;
const SPACING_PRESETS = [
  { id: "tight", label: "Tight", line: 1.2, note: 0.15, iconGap: 4 },
  { id: "normal", label: "Normal", line: 1.4, note: 0.30, iconGap: 6.5 },
  { id: "airy", label: "Airy", line: 1.7, note: 0.60, iconGap: 9 },
];
// Three text lines with the preset's line gap, drawn in the button's colour.
function SpacingIcon({ gap, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <line x1="5" y1={12 - gap} x2="19" y2={12 - gap} />
      <line x1="5" y1="12" x2="19" y2="12" />
      <line x1="5" y1={12 + gap} x2="19" y2={12 + gap} />
    </svg>
  );
}

function SettingsScreen({ mode, setMode, fontSize, setFontSize, chordFontSize, setChordFontSize, sectionFontSize, setSectionFontSize, textAlign, setTextAlign, lyricsBold, setLyricsBold, notesBold, setNotesBold, lineSpacing, setLineSpacing, noteSpacing = 1, setNoteSpacing, clickSettings, setClickSettings, tanglishMode, setTanglishMode, onOpenSpellingChart, onConfigureSync, onForceSync, bandKey, syncStatus, C }) {
  const [toneIndex, setToneIndex] = useState(() => Math.max(0, CLICK_TONES.findIndex((t) => t.id === clickSettings.clickTone)));
  const alignOptions = [{ id: "left", Icon: AlignLeft }, { id: "center", Icon: AlignCenter }, { id: "right", Icon: AlignRight }];
  const labelFontSize = sectionFontSize;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const applyTextSize = (size) => {
    const v = Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, size));
    fontSizeRef.current = v;
    setFontSize(v);
    setChordFontSize(Math.min(100, Math.max(8, Math.round(v * NOTES_SIZE_RATIO))));
    setSectionFontSize(Math.min(30, Math.max(9, Math.round(v * HEADER_SIZE_RATIO))));
  };
  const decSizeHold = useHoldRepeat(() => applyTextSize(fontSizeRef.current - 1));
  const incSizeHold = useHoldRepeat(() => applyTextSize(fontSizeRef.current + 1));
  const activeSpacing = SPACING_PRESETS.find((p) => Math.abs(p.line - lineSpacing) <= 0.1)?.id ?? null;
  const applySpacing = (preset) => { setLineSpacing(preset.line); setNoteSpacing(preset.note); };

  const cycleTone = (dir) => {
    const next = (toneIndex + dir + CLICK_TONES.length) % CLICK_TONES.length;
    setToneIndex(next);
    setClickSettings({ ...clickSettings, clickTone: CLICK_TONES[next].id });
  };
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

          <SectionLabel>TAMIL</SectionLabel>
          <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 26 }}>
            <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${C.border}` }}>
              <div>
                <div style={{ fontFamily: FONT, fontSize: 15, fontWeight: 600, color: C.text }}>Transliteration</div>
                <div style={{ fontFamily: FONT, fontSize: 12, color: C.textMuted, marginTop: 2 }}>(த → tha)</div>
              </div>
              <IosSwitch checked={tanglishMode} onChange={setTanglishMode} C={C} />
            </div>
            <button
              onClick={onOpenSpellingChart}
              style={{ width: "100%", padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", fontFamily: FONT, fontSize: 15, fontWeight: 600, color: C.text, cursor: "pointer", boxSizing: "border-box" }}
            >
              <span>Spelling Chart</span>
              <ChevronRight size={16} color={C.textMuted} />
            </button>
          </div>

          <SectionLabel>DISPLAY</SectionLabel>
          <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 26, display: "flex", flexDirection: "column", gap: 18 }}>
            <Field label="TEXT SIZE">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0, height: 44, boxSizing: "border-box", display: "flex", alignItems: "stretch", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                  <button {...decSizeHold} aria-label="Smaller text" style={{ flex: "1 1 0", minWidth: 0, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Minus size={16} color={C.text} /></button>
                  <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums", borderLeft: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}` }}>{fontSize}px</div>
                  <button {...incSizeHold} aria-label="Larger text" style={{ flex: "1 1 0", minWidth: 0, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Plus size={16} color={C.text} /></button>
                </div>
                {(() => {
                  const boldOn = lyricsBold && notesBold;
                  return (
                    <button onClick={() => { setLyricsBold(!boldOn); setNotesBold(!boldOn); }} aria-label="Bold" aria-pressed={boldOn}
                      style={{ width: 44, height: 44, borderRadius: 10, flexShrink: 0, border: `1px solid ${boldOn ? C.accent : C.border}`, background: boldOn ? C.accentSoft : C.surface3, color: boldOn ? C.accent : C.text, fontFamily: FONT, fontSize: 16, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>B</button>
                  );
                })()}
              </div>
            </Field>
            <Field label="LINE SPACING">
              <div style={{ display: "flex", gap: 8 }}>
                {SPACING_PRESETS.map((preset) => {
                  const active = activeSpacing === preset.id;
                  return (
                    <button key={preset.id} onClick={() => applySpacing(preset)} aria-label={`${preset.label} line spacing`} style={{ flex: 1, height: 44, borderRadius: 10, border: `1px solid ${active ? C.accent : C.border}`, background: active ? C.accentSoft : C.surface3, color: active ? C.accent : C.text, fontFamily: FONT, fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                      <SpacingIcon gap={preset.iconGap} size={22} />
                    </button>
                  );
                })}
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
              <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, overflowX: "hidden" }}>
                <div style={{ fontSize: labelFontSize, letterSpacing: 1.5, textTransform: "uppercase", color: C.accent, marginBottom: 8, textAlign }}>Chorus</div>
                {mode === "vocals" ? (
                  <LyricsText
                    text={"Way maker, miracle worker,\npromise keeper, light in the darkness"}
                    textAlign={textAlign} fontSize={fontSize} lineHeightMult={lineSpacing} bold={lyricsBold}
                  />
                ) : mode === "drums" ? (
                  <ChordText
                    text={"[Half-time]Way maker, miracle worker,\npromise keeper, [Double Kick]light in the darkness"}
                    editable={false} dim={true} showLyrics={true} brightTags={true}
                    textAlign={textAlign} fontSize={fontSize} tagFontSize={chordFontSize} lineHeightMult={lineSpacing}
                    accent={C.accent} lyricsBold={lyricsBold} notesBold={notesBold} C={C} tagGapMult={noteSpacing}
                    padWordForTag={false}
                  />
                ) : (
                  <ChordText
                    text={numbersTaggedToChordsTagged("[1]Way maker, [4]miracle worker,\n[6]promise keeper, [5]light in the [1]darkness", "E", "Major")}
                    editable={false} dim={true} showLyrics={true} brightTags={true} flattenTags
                    textAlign={textAlign} fontSize={fontSize} tagFontSize={chordFontSize} lineHeightMult={lineSpacing}
                    accent={C.accent} lyricsBold={lyricsBold} notesBold={notesBold} C={C} tagGapMult={noteSpacing}
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
          <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 26 }}>
            <div style={{ display: "flex", alignItems: "center", padding: "6px 8px 6px 16px" }}>
              <button
                onClick={onConfigureSync}
                style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", color: C.text, fontFamily: FONT, fontSize: 15, fontWeight: 600, cursor: "pointer", padding: "10px 0", textAlign: "left" }}
              >
                <span>Team</span>
                <span style={{ color: bandKey ? C.accent : C.textMuted, fontSize: 13, fontWeight: 700 }}>
                  {bandKey || "Public only"}
                </span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onForceSync(); }}
                title="Sync library now"
                style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface3, color: C.accent, display: "flex", alignItems: "center", justifyContent: "center", marginLeft: 12, flexShrink: 0, cursor: "pointer" }}
              >
                <RefreshCw size={15} color={C.accent} />
              </button>
            </div>
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
    <div style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: "calc(55px + max(36px, 8px + var(--safe-bottom)) + 16px)", background: C.surface3, border: `1px solid ${C.borderStrong}`, padding: "10px 18px", borderRadius: 999, fontSize: 13.5, fontWeight: 600, zIndex: 300, whiteSpace: "nowrap", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
      {message}
    </div>
  );
}

function BottomNav({ active, onChange, mode, C }) {
  const firstTab = mode === "drums" ? { id: "practice", label: "Metronome", icon: MetronomeIcon } : { id: "practice", label: "Piano", icon: PianoIcon };
  const items = [firstTab, { id: "songs", label: "Songs", icon: ListMusic }, { id: "setlists", label: "Setlists", icon: Layers }, { id: "settings", label: "Settings", icon: SettingsIcon }];
  return (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 30 }}>
      <div style={{ display: "flex", background: C.bg, paddingTop: 18, paddingBottom: "max(36px, calc(8px + var(--safe-bottom)))" }}>
        {items.map(({ id, label, icon: Icon }) => {
          const isActive = active === id;
          const isPiano = Icon === PianoIcon;
          return (
            <button key={id} onClick={() => onChange(id)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", gap: 3, padding: "0 0 6px", background: "none", border: "none", fontFamily: FONT, cursor: "pointer" }}>
              {/* Allow the piano icon to be naturally balanced; constrain height */}
              <div style={{ height: 18, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon size={isPiano ? 16 : 18} height={isPiano ? 16 : undefined} color={isActive ? C.accent : C.textMuted} strokeWidth={isActive ? 2.3 : 1.8} />
              </div>
              <span style={{ fontSize: 8, color: isActive ? C.accent : C.textMuted, fontWeight: isActive ? 600 : 400 }}>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DeleteSongModal({ song, onConfirm, onCancel, C }) {
  const [input, setInput] = useState("");
  const keyboardInset = useKeyboardInset();
  const isMatch = input.trim().toLowerCase() === "delete";
  if (!song) return null;
  return createPortal(
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 300,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
        paddingBottom: keyboardInset ? `${keyboardInset + 20}px` : 20,
        transition: "padding-bottom 150ms ease-out",
        overflowY: "auto",
        boxSizing: "border-box"
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 360, background: C.surface2,
          border: `1px solid ${C.borderStrong}`, borderRadius: 16,
          padding: "22px 20px 20px", boxSizing: "border-box",
          boxShadow: "0 20px 48px rgba(0,0,0,0.7)", fontFamily: FONT
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <Trash2 size={18} color={C.danger ?? "#FF453A"} /> Delete Song
        </div>
        <div style={{ fontSize: 13.5, color: C.textMuted, lineHeight: 1.45, marginBottom: 12 }}>
          Delete <strong style={{ color: C.text }}>"{song.title}"</strong> permanently for the team?
        </div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 8 }}>
          Type <span style={{ color: C.danger ?? "#FF453A", fontWeight: 700 }}>delete</span> to confirm:
        </div>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Type "delete"'
          style={{
            width: "100%", height: 42, background: C.surface3,
            border: `1px solid ${isMatch ? (C.danger ?? "#FF453A") : C.border}`,
            borderRadius: 10, padding: "0 12px", color: C.text,
            fontFamily: FONT, fontSize: 15, fontWeight: 600,
            boxSizing: "border-box", outline: "none", marginBottom: 16
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isMatch) onConfirm();
          }}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1, height: 40, borderRadius: 10,
              border: `1px solid ${C.border}`, background: "transparent",
              color: C.text, fontFamily: FONT, fontSize: 14, fontWeight: 600,
              cursor: "pointer"
            }}
          >
            Cancel
          </button>
          <button
            disabled={!isMatch}
            onClick={onConfirm}
            style={{
              flex: 1, height: 40, borderRadius: 10, border: "none",
              background: isMatch ? (C.danger ?? "#FF453A") : C.surface3,
              color: isMatch ? "#fff" : C.textFaint,
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: isMatch ? "pointer" : "default",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6
            }}
          >
            <Trash2 size={15} color={isMatch ? "#fff" : C.textFaint} /> Delete
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function DeleteSetlistModal({ setlist, onConfirm, onCancel, C }) {
  const [input, setInput] = useState("");
  const keyboardInset = useKeyboardInset();
  const isMatch = input.trim().toLowerCase() === "delete";
  if (!setlist) return null;
  return createPortal(
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 300,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
        paddingBottom: keyboardInset ? `${keyboardInset + 20}px` : 20,
        transition: "padding-bottom 150ms ease-out",
        overflowY: "auto",
        boxSizing: "border-box"
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 360, background: C.surface2,
          border: `1px solid ${C.borderStrong}`, borderRadius: 16,
          padding: "22px 20px 20px", boxSizing: "border-box",
          boxShadow: "0 20px 48px rgba(0,0,0,0.7)", fontFamily: FONT
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <Trash2 size={18} color={C.danger ?? "#FF453A"} /> Delete Setlist
        </div>
        <div style={{ fontSize: 13.5, color: C.textMuted, lineHeight: 1.45, marginBottom: 12 }}>
          Delete <strong style={{ color: C.text }}>"{setlist.name}"</strong> permanently for the team?
        </div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 8 }}>
          Type <span style={{ color: C.danger ?? "#FF453A", fontWeight: 700 }}>delete</span> to confirm:
        </div>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Type "delete"'
          style={{
            width: "100%", height: 42, background: C.surface3,
            border: `1px solid ${isMatch ? (C.danger ?? "#FF453A") : C.border}`,
            borderRadius: 10, padding: "0 12px", color: C.text,
            fontFamily: FONT, fontSize: 15, fontWeight: 600,
            boxSizing: "border-box", outline: "none", marginBottom: 16
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isMatch) onConfirm();
          }}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1, height: 40, borderRadius: 10,
              border: `1px solid ${C.border}`, background: "transparent",
              color: C.text, fontFamily: FONT, fontSize: 14, fontWeight: 600,
              cursor: "pointer"
            }}
          >
            Cancel
          </button>
          <button
            disabled={!isMatch}
            onClick={onConfirm}
            style={{
              flex: 1, height: 40, borderRadius: 10, border: "none",
              background: isMatch ? (C.danger ?? "#FF453A") : C.surface3,
              color: isMatch ? "#fff" : C.textFaint,
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: isMatch ? "pointer" : "default",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6
            }}
          >
            <Trash2 size={15} color={isMatch ? "#fff" : C.textFaint} /> Delete
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function RemoveSharedSongModal({ song, setlist, onConfirm, onCancel, C }) {
  const [input, setInput] = useState("");
  const keyboardInset = useKeyboardInset();
  const isMatch = input.trim().toLowerCase() === "delete";
  if (!song || !setlist) return null;
  return createPortal(
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 300,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
        paddingBottom: keyboardInset ? `${keyboardInset + 20}px` : 20,
        transition: "padding-bottom 150ms ease-out",
        overflowY: "auto",
        boxSizing: "border-box"
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 360, background: C.surface2,
          border: `1px solid ${C.borderStrong}`, borderRadius: 16,
          padding: "22px 20px 20px", boxSizing: "border-box",
          boxShadow: "0 20px 48px rgba(0,0,0,0.7)", fontFamily: FONT
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <Trash2 size={18} color={C.danger ?? "#FF453A"} /> Remove Song
        </div>
        <div style={{ fontSize: 13.5, color: C.textMuted, lineHeight: 1.45, marginBottom: 12 }}>
          Remove <strong style={{ color: C.text }}>"{song.title}"</strong> from shared setlist <strong style={{ color: C.text }}>"{setlist.name}"</strong>?
        </div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 8 }}>
          Type <span style={{ color: C.danger ?? "#FF453A", fontWeight: 700 }}>delete</span> to confirm:
        </div>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Type "delete"'
          style={{
            width: "100%", height: 42, background: C.surface3,
            border: `1px solid ${isMatch ? (C.danger ?? "#FF453A") : C.border}`,
            borderRadius: 10, padding: "0 12px", color: C.text,
            fontFamily: FONT, fontSize: 15, fontWeight: 600,
            boxSizing: "border-box", outline: "none", marginBottom: 16
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isMatch) onConfirm();
          }}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1, height: 40, borderRadius: 10,
              border: `1px solid ${C.border}`, background: "transparent",
              color: C.text, fontFamily: FONT, fontSize: 14, fontWeight: 600,
              cursor: "pointer"
            }}
          >
            Cancel
          </button>
          <button
            disabled={!isMatch}
            onClick={onConfirm}
            style={{
              flex: 1, height: 40, borderRadius: 10, border: "none",
              background: isMatch ? (C.danger ?? "#FF453A") : C.surface3,
              color: isMatch ? "#fff" : C.textFaint,
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: isMatch ? "pointer" : "default",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6
            }}
          >
            <Trash2 size={15} color={isMatch ? "#fff" : C.textFaint} /> Remove
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function LeaveTeamWarningModal({ onConfirm, onCancel, C }) {
  return createPortal(
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 350,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20, boxSizing: "border-box"
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 360, background: C.surface2,
          border: `1px solid ${C.borderStrong}`, borderRadius: 16,
          padding: "22px 20px 20px", boxSizing: "border-box",
          boxShadow: "0 20px 48px rgba(0,0,0,0.7)", fontFamily: FONT
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertTriangle size={18} color={C.danger ?? "#FF453A"} /> Shared Setlists Will Be Deleted
        </div>
        <div style={{ fontSize: 13.5, color: C.textMuted, lineHeight: 1.45, marginBottom: 18 }}>
          You are the only member on this team. Leaving will permanently delete the shared setlists.
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1, height: 40, borderRadius: 10,
              border: `1px solid ${C.border}`, background: "transparent",
              color: C.text, fontFamily: FONT, fontSize: 14, fontWeight: 600,
              cursor: "pointer"
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1, height: 40, borderRadius: 10, border: "none",
              background: C.danger ?? "#FF453A", color: "#fff",
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: "pointer"
            }}
          >
            Leave & Delete
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function TeamKeyModal({ isOpen, initialKey, onSave, onClose, C }) {
  const [draft, setDraft] = useState(initialKey || "");
  const [error, setError] = useState("");
  const [showOnlyMemberWarning, setShowOnlyMemberWarning] = useState(false);
  const [pendingTargetKey, setPendingTargetKey] = useState(null);
  const keyboardInset = useKeyboardInset();
  useEffect(() => { setDraft(initialKey || ""); setError(""); setShowOnlyMemberWarning(false); setPendingTargetKey(null); }, [initialKey, isOpen]);
  if (!isOpen) return null;
  const isConnected = Boolean(initialKey && initialKey.trim());
  const handleSave = async (val) => {
    const clean = val.trim().toUpperCase();
    const currentClean = (initialKey || "").trim().toUpperCase();
    setError("");
    if (isConnected && clean !== currentClean) {
      const isOnly = await checkIsOnlyTeamMember({ teamKey: currentClean, deviceId: getDeviceId() });
      if (isOnly) {
        setPendingTargetKey(clean);
        setShowOnlyMemberWarning(true);
        return;
      }
    }
    onSave(clean);
  };
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 300,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
        paddingBottom: keyboardInset ? `${keyboardInset + 20}px` : 20,
        transition: "padding-bottom 150ms ease-out",
        overflowY: "auto",
        boxSizing: "border-box"
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 360, background: C.surface2,
          border: `1px solid ${C.borderStrong}`, borderRadius: 16,
          padding: "22px 20px 20px", boxSizing: "border-box",
          boxShadow: "0 20px 48px rgba(0,0,0,0.7)", fontFamily: FONT
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>
          Team Access
        </div>
        <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.45, marginBottom: 14 }}>
          Enter a team code (e.g. your church or band name) to sync shared setlists with your members. Songs & spelling chart are always shared globally.
        </div>
        <input
          autoFocus
          value={draft}
          onChange={(e) => { setDraft(e.target.value.toUpperCase()); setError(""); }}
          placeholder="e.g. FACA or GRACE-CHURCH"
          style={{
            width: "100%", height: 42, background: C.surface3,
            border: `1px solid ${C.border}`,
            borderRadius: 10, padding: "0 12px", color: C.text,
            fontFamily: FONT, fontSize: 15, fontWeight: 600,
            boxSizing: "border-box", outline: "none", marginBottom: error ? 12 : 16
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave(draft);
          }}
        />
        {error && (
          <div style={{ fontSize: 12.5, color: C.danger, fontWeight: 600, marginBottom: 16, paddingLeft: 2 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onClose}
            style={{
              flex: 1, height: 40, borderRadius: 10,
              border: `1px solid ${C.border}`, background: "transparent",
              color: C.text, fontFamily: FONT, fontSize: 14, fontWeight: 600,
              cursor: "pointer"
            }}
          >
            Cancel
          </button>
          {isConnected && (
            <button
              onClick={() => handleSave("")}
              style={{
                flex: 1, height: 40, borderRadius: 10,
                border: `1px solid ${C.border}`, background: "transparent",
                color: C.danger ?? "#FF453A", fontFamily: FONT, fontSize: 13.5, fontWeight: 600,
                cursor: "pointer"
              }}
            >
              Leave Team
            </button>
          )}
          <button
            onClick={() => handleSave(draft)}
            style={{
              flex: 1, height: 40, borderRadius: 10, border: "none",
              background: C.accent, color: "#fff",
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: "pointer"
            }}
          >
            {isConnected && draft.trim().toUpperCase() === initialKey.trim().toUpperCase() ? "Save" : "Connect"}
          </button>
        </div>
      </div>
      {showOnlyMemberWarning && (
        <LeaveTeamWarningModal
          onConfirm={() => {
            setShowOnlyMemberWarning(false);
            onSave(pendingTargetKey ?? "");
          }}
          onCancel={() => {
            setShowOnlyMemberWarning(false);
            setPendingTargetKey(null);
          }}
          C={C}
        />
      )}
    </div>,
    document.body
  );
}

/* =========================================================================
   Root
   ========================================================================= */

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
  const [mode, setMode] = useLocalStorageState("altar:mode", "vocals");
  const [clickSettings, setClickSettings] = useLocalStorageState("altar:click-settings", DEFAULT_CLICK_SETTINGS);
  const [tanglishMode, setTanglishMode] = useLocalStorageState("altar:tanglish", false);
  const [spellingChart, setSpellingChart, spellingReady] = useIndexedDbState("tanglish-spelling-chart", TANGLISH_EXCEPTIONS);
  const [spellingChartOpen, setSpellingChartOpen] = useState(false);
  // Keep the runtime transliteration dictionary in sync with persisted edits.
  useEffect(() => { setActiveTanglishExceptions(spellingChart); }, [spellingChart]);
  const [bandKey, setBandKey] = useState(() => localStorage.getItem("zong:access-key") || "");
  const [syncStatus, setSyncStatus] = useState(() => bandKey ? "Ready" : "Public only");
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
              next = [...next]; next[idx] = { ...rs, subdivision: local.subdivision ?? rs.subdivision }; changed = true;
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
    } catch (error) {
      console.error("[Zong sync]", error);
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
        onSongChange: (_eventType, song, songId) => {
          if (getDirtySongIds().includes(songId)) return; // don't clobber our unpushed edit
          setSongs((prev) => {
            if (!song) return prev.some((s) => s.id === songId) ? prev.filter((s) => s.id !== songId) : prev;
            const idx = prev.findIndex((s) => s.id === songId);
            if (idx === -1) return [...prev, song];
            const existing = prev[idx];
            if (song.updatedAt >= (existing.updatedAt ?? 0)) {
              const next = [...prev]; next[idx] = { ...song, subdivision: existing.subdivision ?? song.subdivision }; return next;
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
    setPianoQuality(q);
    setPianoHighlight(KEY_TO_SEMITONE[song.key] ?? null);
    setTab("practice");
  };

  return (
    <div ref={rootRef} style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0, width: "100%", maxWidth: "none",
      margin: "0 auto", background: C.bg, color: C.text, fontFamily: FONT, overflow: "hidden",
      border: "none", boxSizing: "border-box", touchAction: "pan-x pan-y",
      paddingTop: "var(--safe-top)",
    }}>
      <div style={{ paddingBottom: "calc(55px + max(36px, 8px + var(--safe-bottom)))", height: "100%", overflow: "hidden", boxSizing: "border-box", position: "relative" }}>
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
            <PianoScreen C={C} mode={mode} loadedQuality={pianoQuality} onQualityChange={setPianoQuality} highlightSemitone={tab === "practice" ? pianoHighlight : null} />
          </div>
        </div>
        <div style={{ display: tab === "songs" ? "block" : "none", height: "100%", position: "relative" }}>
          <SongsScreen songs={songs} onOpen={(s) => setViewing({ songId: s.id, fromSetlistId: null })} onAdd={() => { if (mode === "drums") setNewSongSeed({ tempo: Math.round(engine.bpm), timeSignature: formatTimeSig(engine.timeSig), accents: engine.accents, subdivision: engine.subdivision }); setEditingSong(null); }} onEdit={(s) => setEditingSong(s)} onDelete={requestDeleteSong} onLoadToMetronome={mode === "drums" ? (s) => { engine.loadSong(s); setTab("practice"); } : undefined} onLoadToPiano={mode === "vocals" ? handleLoadSongToPiano : undefined} mode={mode} tanglishMode={tanglishMode} C={C} />
        </div>
        <div style={{ display: tab === "setlists" ? "block" : "none", height: "100%", position: "relative" }}>
          <SetlistsScreen setlists={setlists} onOpenStage={handleOpenSetlist} onCreate={handleCreateSetlist} onDelete={handleDeleteSetlist} C={C} />
        </div>
        <div style={{ display: tab === "settings" ? "block" : "none", height: "100%", position: "relative" }}>
          <SettingsScreen
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

      <BottomNav active={tab} onChange={handleTabChange} mode={mode} C={C} />

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