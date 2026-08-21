import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  Search, Plus, Pencil, Trash2, ChevronLeft, ChevronRight, ChevronDown, Play, Square,
  ListMusic, Layers, Minus, MoreVertical, AlignLeft, AlignCenter, AlignRight, Check, X,
  Settings as SettingsIcon, Upload, Download, ClipboardPaste, Copy, Save, RefreshCw,
} from "lucide-react";
import { syncLibrary, subscribeToChanges, isSupabaseConfigured } from "./supabaseSync";

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
      if (stored !== undefined) {
        if (key === "songs" && Array.isArray(stored) && !stored.some((s) => s.id === "seed-4")) {
          const tamilSeed = Array.isArray(seed) ? seed.find((s) => s.id === "seed-4") : null;
          if (tamilSeed) {
            const updated = [...stored, tamilSeed];
            setValue(updated);
            idbSet(key, updated).catch(() => { });
            return;
          }
        }
        setValue(stored);
      } else {
        idbSet(key, seed).catch(() => { });
      }
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
  if (typeof navigator !== "undefined" && navigator.share) {
    try {
      if (typeof File !== "undefined" && navigator.canShare) {
        const file = new File([json], filename, { type: "application/json" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: filename });
          return "shared";
        }
      }
    } catch (err) {
      if (err && (err.name === "AbortError" || String(err).includes("Abort") || String(err).includes("cancel"))) {
        return "cancelled";
      }
    }
    try {
      await navigator.share({ title: filename, text: json });
      return "shared";
    } catch (err) {
      if (err && (err.name === "AbortError" || String(err).includes("Abort") || String(err).includes("cancel"))) {
        return "cancelled";
      }
    }
  }
  try {
    downloadJSON(filename, payload);
    return "downloaded";
  } catch {
    return "cancelled";
  }
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
  "\u0B8E": "e", "\u0B8F": "ae", "\u0B90": "ai", "\u0B92": "o", "\u0B93": "o", "\u0B94": "au",
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
// Voiced counterparts for the five consonants that actually alternate.
const TANGLISH_VOICED = {
  "\u0B95": "g", "\u0B9A": "j", "\u0B9F": "d", "\u0BA4": "dh", "\u0BAA": "b",
};
// Nasal consonants — a voicing-capable consonant right after one of these
// (in a nasal+stop cluster, e.g. ன்ப, ம்ப, ந்த, ங்க) voices reliably.
const TANGLISH_NASALS = new Set(["\u0B99", "\u0B9E", "\u0BA3", "\u0BA8", "\u0BAE", "\u0BA9"]);
const TANGLISH_VOWEL_SIGNS = {
  "\u0BBE": "aa", "\u0BBF": "i", "\u0BC0": "ee", "\u0BC1": "u", "\u0BC2": "oo",
  "\u0BC6": "e", "\u0BC7": "ae", "\u0BC8": "ai", "\u0BCA": "o", "\u0BCB": "o", "\u0BCC": "au",
};
const TANGLISH_DIGITS = {
  "\u0BE6": "0", "\u0BE7": "1", "\u0BE8": "2", "\u0BE9": "3", "\u0BEA": "4",
  "\u0BEB": "5", "\u0BEC": "6", "\u0BED": "7", "\u0BEE": "8", "\u0BEF": "9",
};
// Common worship-song words whose everyday spelling doesn't follow the
// positional rule above (mostly word-initial voicing). Extend freely.
const TANGLISH_EXCEPTIONS = {
  "தேவன்": "Devan", "தேவனே": "Devaney", "தேவா": "Deva", "தேவனுடைய": "Devanudaiya",
  "தேவனை": "Devanai", "தேவனிடம்": "Devanidam", "தேவனுக்கு": "Devanukku", "தேவி": "Devi",
  "இயேசு": "Yesu", "இயேசுவே": "Yesuve", "இயேசுவின்": "Yesuvin", "கிறிஸ்து": "Kiristhu",
  "கர்த்தர்": "Karthar", "கர்த்தாவே": "Karthave", "கர்த்தரே": "Karthare",
  "பரிசுத்த": "Parisutha", "ஆவியானவர்": "Aaviyaanavar",
  "பயம்": "Bayam", "பயமே": "Bayame", "பயந்து": "Bayandhu",
  "தயவு": "Dhayavu", "தயவாய்": "Dhayavaai", "தயவுடன்": "Dhayavudan",
  "கிருபை": "Kirubai", "கிருபையால்": "Kirubaiyaal", "கிருபையே": "Kirubaiye",
  "ஸ்தோத்திரம்": "Sthothiram", "ஸ்தோத்திரிப்போம்": "Sthothirippom",
  "மகிமை": "Mahimai", "மகிமையே": "Mahimaiye", "வல்லமை": "Vallamai",
  "துதி": "Thuthi", "துதிப்பாய்": "Thuthippaai", "துதிப்போம்": "Thuthippom",
  "ஆராதனை": "Aaraadhanai", "ஆராதிக்கிறோம்": "Aaraadhikkirom",
  "நன்றி": "Nandri", "மகிழ்ச்சி": "Magizhchi", "சமாதானம்": "Samaadhaanam",
  "நித்தியம்": "Nithiyam", "பாடுவோம்": "Paaduvom", "பாராட்டு": "Paaraattu",
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
const SA = "\u0B9A"; // ச
const TA_RETROFLEX = "\u0B9F"; // ட
const THA = "\u0BA4"; // த
const YA = "\u0BAF"; // ய
// Returns true if the word ends with ச் (ச + pulli, with nothing after).
function wordEndsWithSachPulli(word) {
  const len = word.length;
  return len >= 2 && word[len - 2] === SA && word[len - 1] === TANGLISH_PULLI;
}
function transliterateTamilWordWithOffsets(word, prevWordEndedWithSach = false) {
  let out = "";
  let prevKind = "start"; // "start" | "vowel" | "nasal" | "other"
  let prevCh = ""; // actual previous consonant character (before its pulli)
  const offsets = new Array(word.length + 1);
  let i = 0;
  while (i < word.length) {
    offsets[i] = out.length;
    const ch = word[i];
    if (TANGLISH_CONSONANTS[ch]) {
      const next = word[i + 1];
      const isGeminate = next === TANGLISH_PULLI && word[i + 2] === ch;
      const voiced = TANGLISH_VOICED[ch] && !isGeminate && prevKind === "nasal";
      // ற்ற (geminate ற) carries a "t" sound, not "rr" — e.g. ற்றி -> "tri"
      // (the first ற becomes "t", the second ற plus its vowel becomes "ri").
      const isGeminateRa = isGeminate && ch === "\u0BB1";
      // ங்க never doubles its "g" — the nasal ங் drops its own "ng" spelling
      // down to a bare "n" whenever it's immediately voicing a following க,
      // so the pair reads as "nga" instead of "ngga".
      const isNgaCluster = ch === "\u0B99" && next === TANGLISH_PULLI && word[i + 2] === "\u0B95";
      // த்த geminate: the doubled த produces a single "th" (not "thth").
      // Suppress the leading த் entirely; the following த will carry the "th" + vowel.
      const isGeminateTha = isGeminate && ch === THA;
      // ட்ச cluster: ச after ட் is always "ch" (retroflex stop + sibilant assimilation).
      const isDotaSa = ch === SA && prevCh === TA_RETROFLEX && prevKind === "other";
      // ச at word-start when previous word ended with ச் — treat as "cha"-initial.
      const isSaAfterSach = ch === SA && i === 0 && prevWordEndedWithSach;
      // ச் at word-end (ச followed by pulli as the very last two chars) → "ch".
      const isSaWordFinal = ch === SA && next === TANGLISH_PULLI && i + 2 === word.length;
      // ய followed by pulli: the /y/ offglide becomes an "i" vowel (e.g. -ஆய் → -aai).
      const isYaPulli = ch === YA && next === TANGLISH_PULLI;

      let base;
      if (isGeminateRa) base = "t";
      else if (isNgaCluster) base = "n";
      else if (isGeminateTha) base = ""; // suppressed — second த does the work
      else if (isDotaSa || isSaAfterSach) base = "ch";
      else if (isSaWordFinal) base = "ch";
      else if (isYaPulli) base = "i";
      else if (voiced) base = TANGLISH_VOICED[ch];
      else base = TANGLISH_CONSONANTS[ch];

      const isNasal = TANGLISH_NASALS.has(ch);
      if (isYaPulli) {
        // ய் → "i" (no separate pulli output, consumed here)
        out += base;
        offsets[i + 1] = out.length;
        prevKind = "vowel";
        prevCh = ch;
        i += 2;
      } else if (next === TANGLISH_PULLI) {
        out += base;
        offsets[i + 1] = out.length;
        prevKind = isNasal ? "nasal" : "other";
        prevCh = ch;
        i += 2;
      } else if (next && TANGLISH_VOWEL_SIGNS[next]) {
        // For ட்ச + vowel sign: base is already "ch", add vowel normally.
        out += base;
        offsets[i + 1] = out.length;
        out += TANGLISH_VOWEL_SIGNS[next];
        prevKind = "vowel";
        prevCh = ch;
        i += 2;
      } else {
        out += base + (base === "" ? "" : "a"); // suppressed geminate emits nothing
        prevKind = "vowel";
        prevCh = ch;
        i += 1;
      }
    } else if (TANGLISH_VOWELS[ch]) { out += TANGLISH_VOWELS[ch]; prevKind = "vowel"; prevCh = ""; i += 1; }
    else if (TANGLISH_DIGITS[ch]) { out += TANGLISH_DIGITS[ch]; prevKind = "other"; prevCh = ""; i += 1; }
    else { out += ch; prevKind = "start"; prevCh = ""; i += 1; }
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
// Runs transliteration only when Tanglish mode is on and the text actually
// contains Tamil script; otherwise passes the original text through
// untouched (English/mixed text, or Tanglish mode off).
function maybeTanglish(text, tanglishMode) {
  if (!tanglishMode || !text) return text;
  return TAMIL_RANGE_RE.test(text) ? capitalizeTanglishLines(transliterateTanglish(text)) : text;
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
  const plain = `${song.title || ""} ${song.artist || ""}`.toLowerCase();
  if (plain.includes(q)) return true;
  if (TAMIL_RANGE_RE.test(song.title || "") || TAMIL_RANGE_RE.test(song.artist || "")) {
    const translit = transliterateTanglish(`${song.title || ""} ${song.artist || ""}`).toLowerCase();
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
function migrateSongShape(song) {
  if (!song) return song;
  return {
    ...song,
    lyricsText: song.lyricsText ?? "",
    chordsText: song.chordsText ?? "",
    chartText: song.chartText ?? "",
    drumsText: song.drumsText ?? "",
  };
}
function parseTextIntoBlocks(text) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let current = null;
  lines.forEach((rawLine) => {
    const trimmed = rawLine.trimStart();
    if (trimmed.startsWith("-")) {
      current = { label: trimmed.slice(1).trim(), lines: [] };
      blocks.push(current);
    } else {
      if (!current) { current = { label: null, lines: [] }; blocks.push(current); }
      current.lines.push(trimmed);
    }
  });
  return blocks;
}
// Chords tab only accepts Nashville-number tokens as chord tags — any
// bracketed content that isn't a valid number token is treated as plain
// text. Swapped to fullwidth brackets so the tokenizer (which only looks
// for ASCII "["/"]") renders it as literal characters instead of a tag.
function sanitizeChordsOnlyNashville(text) {
  return String(text || "").replace(/\[([^\]]*)\]/g, (m, inner) => (
    isValidNashvilleToken(inner.trim()) ? m : `\uFF3B${inner}\uFF3D`
  ));
}
// Auto-brackets bare Nashville-number tokens typed in the Chords tab (e.g.
// typing "1 4 5" becomes "[1] [4] [5]") so they behave as real chord tags
// without the user needing to type the brackets themselves. Anything already
// inside [] is left alone, and anything inside () is left completely
// untouched (literal plain-number text, never turned into a tag).
function autoBracketNumbers(text) {
  const s = String(text || "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "[") {
      const end = s.indexOf("]", i);
      if (end === -1) { out += s.slice(i); break; }
      out += s.slice(i, end + 1); i = end + 1; continue;
    }
    if (ch === "(") {
      const end = s.indexOf(")", i);
      if (end === -1) { out += s.slice(i); break; }
      out += s.slice(i, end + 1); i = end + 1; continue;
    }
    if (/\s/.test(ch)) { out += ch; i++; continue; }
    let j = i;
    while (j < s.length && !/[\s[\]()]/.test(s[j])) j++;
    const run = s.slice(i, j);
    out += isValidNashvilleToken(run) ? `[${run}]` : run;
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
function transposeTaggedText(text, semitoneDelta, useFlats) {
  return String(text || "").replace(/\[([^\]]*)\]/g, (_, sym) => `[${transposeChordSymbol(sym, semitoneDelta, useFlats)}]`);
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
function isValidNashvilleToken(trimmed) {
  if (/^[0-9]+$/.test(trimmed) && parseInt(trimmed, 10) > 13) return false;
  return NUMBER_TOKEN_RE.test(trimmed);
}
function tokenToChord(token, key, quality) {
  if (!token) return token;
  const trimmed = token.trim();
  if (!trimmed) return token;
  // A bracket containing only digits (no letters/accidentals) that's above
  // 13 isn't a Nashville degree token at all (degrees only run 1-7) — treat
  // it as literal text (e.g. a bar count, a note number) rather than trying
  // to parse "14" as degree 1 with a "4" suffix.
  if (/^[0-9]+$/.test(trimmed) && parseInt(trimmed, 10) > 13) return token;
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
  return String(taggedText || "").replace(/\[([^\]]*)\]/g, (m, tok) => `[${chordToNumberToken(tok, key, quality)}]`);
}
// Converts every [number] tag in a tagged (lyric-interleaved) text block
// into its derived [ChordLetter] for the given key/quality, leaving the
// lyric characters and non-number tags untouched.
function numbersTaggedToChordsTagged(taggedText, key, quality) {
  return String(taggedText || "").replace(/\[([^\]]*)\]/g, (_, tok) => `[${tokenToChord(tok, key, quality)}]`);
}

/* =========================================================================
   Seed data
   ========================================================================= */
const SEED_SONGS = [
  {
    id: "seed-1", title: "Oceans", artist: "Hillsong United", tempo: 72, timeSignature: "4/4", key: "D", keyQuality: "Major",
    description: "Benny's key: D | Sherly's key: G\nStyle: Rock Shuffle",
    accents: ["normal", "normal", "normal", "normal"], subdivision: 1,
    lyricsText: "-Verse\nYou call me out upon the waters\nThe great unknown where feet may fail\n-Chorus\nAnd I will call upon Your name\nAnd keep my eyes above the waves",
    chordsText: "-Verse\n[1]You call me [4]out upon the [5]waters\nThe [6]great unknown where [4]feet may [5]fail\n-Chorus\n[1]And I will [5]call upon Your [6]name\nAnd [4]keep my eyes a[5]bove the [1]waves",
    chartText: "-Verse\n[1]You call me [4]out upon the [5]waters\nThe [6]great unknown where [4]feet may [5]fail\n-Chorus\n[1]And I will [5]call upon Your [6]name\nAnd [4]keep my eyes a[5]bove the [1]waves",
    drumsText: "-Verse\n[Half-time]You call me out upon the waters\nThe great unknown where feet may fail\n-Chorus\nAnd I will call upon Your name\nAnd keep my eyes a[Double Kick]bove the waves",
  },
  {
    id: "seed-2", title: "Way Maker", artist: "Sinach", tempo: 68, timeSignature: "4/4", key: "E", keyQuality: "Major",
    description: "Benny's key: D | Sherly's key: G\nStyle: Rock Shuffle",
    accents: ["normal", "normal", "normal", "normal"], subdivision: 1,
    lyricsText: "-Chorus\nWay maker, miracle worker, promise keeper",
    chordsText: "-Chorus\n[1]Way maker, [4]miracle worker, [6]promise [5]keeper",
    chartText: "-Chorus\n[1]Way maker, [4]miracle worker, [6]promise [5]keeper",
    drumsText: "-Chorus\n[Shuffle]Way maker, miracle worker, [Double Kick]promise keeper",
  },
  {
    id: "seed-3", title: "Our God", artist: "Chris Tomlin", tempo: 105, timeSignature: "4/4", key: "A", keyQuality: "Major", language: "English",
    description: "Benny's key: D | Sherly's key: G\nStyle: Rock Shuffle",
    accents: ["normal", "normal", "normal", "normal"], subdivision: 1,
    lyricsText: "-Verse\nInto the darkness You shine",
    chordsText: "-Verse\n[1]Into the [5]darkness You [6]shine",
    chartText: "-Verse\n[1]Into the [5]darkness You [6]shine",
    drumsText: "-Verse\nInto the darkness You [Double Kick]shine",
  },
  {
    id: "seed-4", title: "தூயவரே", artist: "Gersson Edinbaro", tempo: 75, timeSignature: "4/4", key: "D", keyQuality: "Major", language: "Tamil",
    description: "Original key: D",
    accents: ["normal", "normal", "normal", "normal"], subdivision: 1,
    lyricsText: "-Chorus\nதூயவரே தூயவரே\nதுதிக்கு பாத்திரரே\n-Verse\nஉம்மைப் போல ஒரு தெய்வம் இல்லை\nஉம்மைப் போல ஒரு ராஜா இல்லை",
    chordsText: "-Chorus\n[1]தூயவரே [4]தூயவரே\n[5]துதிக்கு [1]பாத்திரரே\n-Verse\n[1]உம்மைப் போல ஒரு [4]தெய்வம் இல்லை\n[5]உம்மைப் போல ஒரு [1]ராஜா இல்லை",
    chartText: "-Chorus\n[1]தூயவரே [4]தூயவரே\n[5]துதிக்கு [1]பாத்திரரே\n-Verse\n[1]உம்மைப் போல ஒரு [4]தெய்வம் இல்லை\n[5]உம்மைப் போல ஒரு [1]ராஜா இல்லை",
    drumsText: "-Chorus\n[Half-time]தூயவரே தூயவரே\nதுதிக்கு பாத்திரரே\n-Verse\nஉம்மைப் போல ஒரு தெய்வம் இல்லை\nஉம்மைப் போல ஒரு ராஜா இல்லை",
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

function GenericDropdown({ value, options, onChange, C }) {
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
  const activeOption = options.find((o) => o.id === value);
  return (
    <div style={{ position: "relative" }}>
      <button type="button" ref={btnRef} onClick={handleToggle} style={{
        width: "100%", boxSizing: "border-box", height: 44, padding: "0 14px", borderRadius: 10,
        border: `1px solid ${C.border}`, background: C.surface2, color: C.text,
        fontFamily: FONT, fontSize: 15, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <span>{activeOption ? activeOption.label : ""}</span>
        <ChevronDown size={16} color={C.textMuted} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 140 }} />
          <div style={{
            position: "absolute", ...(openUpward ? { bottom: "110%" } : { top: "110%" }),
            left: 0, right: 0, zIndex: 150,
            background: C.surface3, border: `1px solid ${C.borderStrong}`, borderRadius: 12,
            overflow: "hidden", boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
          }}>
            {options.map((opt) => {
              const active = opt.id === value;
              return (
                <div key={opt.id} onClick={() => { onChange(opt.id); setOpen(false); }} style={{
                  padding: "13px 14px", fontFamily: FONT, fontSize: 14.5, fontWeight: 400,
                  color: active ? C.accent : C.text, background: active ? C.accentSoft : "transparent",
                }}>
                  {opt.label}
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
function MetronomeIcon({ size = 20, color, strokeWidth = 1.3 }) {
  // Callers (e.g. the bottom nav) pass a bolder strokeWidth for the active
  // tab, matching the lucide icons alongside it. Match that weight (instead
  // of capping it far below) so the glyph doesn't read as thin/washed-out
  // next to the lucide icons beside it, and give the case a light fill so
  // it has real visual mass rather than being an outline sliver.
  const sw = Math.min(strokeWidth + 0.2, 1.9);
  return (
    <svg width={size} height={size} style={{ display: "block" }} viewBox="0 0 24 24" fill="none">
      {/* Pyramid case */}
      <path d="M8.4 5h7.2l3.1 14.2a1.1 1.1 0 0 1-1.07 1.3H6.37a1.1 1.1 0 0 1-1.07-1.3L8.4 5z" fill={color} fillOpacity="0.16" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
      {/* Top crossbar the pendulum pivots from */}
      <path d="M9.3 7.4h5.4" stroke={color} strokeWidth={sw} strokeLinecap="round" />
      {/* Pendulum rod */}
      <path d="M12 8.6v9.6" stroke={color} strokeWidth={sw} strokeLinecap="round" />
      {/* Sliding weight */}
      <rect x="10.5" y="12.1" width="3" height="2" rx="0.5" fill={color} stroke="none" />
      {/* Base */}
      <path d="M6.1 19.4h11.8" stroke={color} strokeWidth={sw} strokeLinecap="round" />
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
// ---- Acoustic grand-piano voice -----------------------------------------
// A single fixed-harmonic PeriodicWave — the same exact spectral shape at
// every pitch, decaying uniformly under one lowpass filter — is what reads
// as "electronic"; it's the textbook organ/synth-pad giveaway. A struck
// piano string instead does three things a single wave can't:
//   1. Inharmonicity — a stiff string's overtones aren't exact integer
//      multiples of the fundamental, they stretch sharp (more so in the
//      bass): f_n = n * f0 * sqrt(1 + B * n^2).
//   2. Independent partial decay — upper partials die out far faster than
//      the fundamental, so the *color* visibly darkens as the note rings on
//      instead of just getting quieter at a fixed timbre.
//   3. Two or three lightly-detuned unison strings per note (bass notes on
//      a real grand only have one, mid/treble have two or three), each with
//      its own tiny random detune, producing the natural chorus-like
//      beating a single oscillator per note can never produce.
const PIANO_HARMONICS = [
  { n: 1, relAmp: 1.0, decayMult: 1.0 },
  { n: 2, relAmp: 0.52, decayMult: 0.65 },
  { n: 3, relAmp: 0.26, decayMult: 0.44 },
  { n: 4, relAmp: 0.15, decayMult: 0.30 },
  { n: 5, relAmp: 0.08, decayMult: 0.20 },
  { n: 6, relAmp: 0.04, decayMult: 0.13 },
  { n: 7, relAmp: 0.02, decayMult: 0.09 },
  { n: 8, relAmp: 0.01, decayMult: 0.06 },
];
function pianoInharmonicity(freq) {
  const t = Math.min(1, Math.max(0, (freq - 30) / (1500 - 30)));
  return 0.00035 * Math.pow(1 - t, 2) + 0.00002;
}
function pianoFundamentalDecay(freq) {
  if (freq < 150) return 4.5;
  if (freq < 350) return 3.2;
  if (freq < 700) return 2.2;
  return 1.4;
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

// Tracks how much of the bottom of the layout viewport is currently covered
// by the on-screen keyboard (0 when the keyboard is closed). Scroll-list
// containers add this as extra bottom padding so there's always room to
// scroll focused fields / bottom-of-list items up above the keyboard,
// since the app's fixed-height layout never natively shrinks for it.
function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const kb = window.innerHeight - vv.height - vv.offsetTop;
      setInset(kb > 60 ? Math.round(kb) : 0);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
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

function PianoScreen({ C, mode }) {
  const [octaveStart, setOctaveStartState] = useState(4);
  const octaveStartRef = useRef(4);
  const audioCtxRef = useRef(null);
  const masterCompRef = useRef(null);
  const activeRef = useRef(new Map());
  const containerRef = useRef(null);
  const silentVideoRef = useRef(null);
  const videoUnlockedRef = useRef(false);
  const isLandscapeScreen = useIsLandscapeScreen();
  const isVocals = mode === "vocals";
  const [chordQuality, setChordQuality] = useState("Major");
  const chordQualityRef = useRef("Major");
  useEffect(() => { chordQualityRef.current = chordQuality; }, [chordQuality]);

  useEffect(() => { octaveStartRef.current = octaveStart; }, [octaveStart]);
  const setOctaveStart = (n) => setOctaveStartState(Math.min(5, Math.max(3, n)));

  const WHITE_PRESSED = C.accent;
  const BLACK_PRESSED = C.accent;

  const ensureCtx = () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      // Pin a fixed sample rate rather than letting the browser pick
      // whatever the current audio route happens to be running at (e.g.
      // 48kHz over Bluetooth vs 44.1kHz on the built-in speaker, or a
      // different rate after a call/other app changed the device's audio
      // session). A varying sample rate doesn't change the harmonic
      // content of the PeriodicWave itself, but it does change exactly
      // where the lowpass filter's cutoff and envelope timings land
      // relative to Nyquist and to the audio callback's block size, which
      // is audible as the tone sounding subtly different from session to
      // session even though nothing in the code changed. Some browsers
      // reject an explicit sampleRate on certain devices, so fall back to
      // the default if construction throws.
      const AudioCtxCls = window.AudioContext || window.webkitAudioContext;
      let ctx;
      try {
        ctx = new AudioCtxCls({ latencyHint: "interactive", sampleRate: 44100 });
      } catch {
        ctx = new AudioCtxCls({ latencyHint: "interactive" });
      }
      const comp = ctx.createDynamicsCompressor();
      // Light "safety" limiter rather than a tone-shaping compressor —
      // only steps in on loud chord stacks, doesn't squash single notes.
      comp.threshold.setValueAtTime(-8, ctx.currentTime);
      comp.knee.setValueAtTime(6, ctx.currentTime);
      comp.ratio.setValueAtTime(2.5, ctx.currentTime);
      comp.attack.setValueAtTime(0.006, ctx.currentTime);
      comp.release.setValueAtTime(0.2, ctx.currentTime);
      comp.connect(ctx.destination);
      masterCompRef.current = comp;
      audioCtxRef.current = ctx;
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
  const startVoice = (semitone, volume = 1) => {
    const ctx = ensureCtx();
    const now = ctx.currentTime;
    const freq = freqFor(semitone);
    const dest = masterCompRef.current || ctx.destination;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, now);

    // Grand Piano soundboard acoustic filter with dynamic attack brightness
    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = "lowpass";
    bodyFilter.Q.value = 1.0;
    const initCutoff = Math.min(6800, Math.max(2400, freq * 7));
    const warmCutoff = Math.min(2600, Math.max(750, freq * 2.4));
    bodyFilter.frequency.setValueAtTime(initCutoff, now);
    bodyFilter.frequency.exponentialRampToValueAtTime(warmCutoff, now + 0.28);

    bodyFilter.connect(gain);
    gain.connect(dest);

    const B = pianoInharmonicity(freq);
    const fundamentalTail = pianoFundamentalDecay(freq);
    // Subtle acoustic unison detuning (gentle chorus without sounding out of tune)
    const unisonDetunes = freq < 100 ? [0] : [-0.9, 0.9];
    const oscillators = [];

    unisonDetunes.forEach((detuneCents) => {
      PIANO_HARMONICS.forEach(({ n, relAmp, decayMult }) => {
        const stretch = Math.sqrt(1 + B * n * n);
        const partialFreq = freq * n * stretch;
        if (partialFreq > 16000) return;

        const amp = relAmp * (0.42 / unisonDetunes.length);
        const tau = Math.max(0.08, fundamentalTail * decayMult);
        const stopAt = now + tau + 0.1;
        const startAt = now;

        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = partialFreq;
        osc.detune.value = detuneCents;

        const pg = ctx.createGain();
        const attackTime = n === 1 ? 0.005 : 0.0015;
        pg.gain.setValueAtTime(0, startAt);
        pg.gain.linearRampToValueAtTime(amp, startAt + attackTime);
        pg.gain.exponentialRampToValueAtTime(Math.max(0.00001, amp * 0.001), startAt + tau);

        osc.connect(pg);
        pg.connect(bodyFilter);
        osc.start(startAt);
        osc.stop(stopAt);
        osc.onended = () => { try { osc.disconnect(); pg.disconnect(); } catch { } };
        oscillators.push(osc);
      });
    });

    // Soft felt hammer strike transient
    const noiseDur = 0.018;
    const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * noiseDur));
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = Math.min(3500, Math.max(300, freq * 1.8));
    noiseFilter.Q.value = 1.0;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.04, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + noiseDur);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(gain);

    noise.start(now);
    noise.stop(now + noiseDur);
    noise.onended = () => { try { noise.disconnect(); noiseFilter.disconnect(); noiseGain.disconnect(); } catch { } };
    oscillators.push(noise);

    return { oscillators, bodyFilter, gain };
  };
  const stopVoice = (voice) => {
    if (!voice || !audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const now = ctx.currentTime;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      voice.oscillators.forEach((node) => { try { node.stop(now + 0.20); } catch { } });
    } catch { }
  };

  // --- Warm pad chord voice for Vocals mode -----------------------------------
  // Plays a rich two-octave chord with lower bass root (-12), lower fifth (-5),
  // middle triad, and shimmering upper octave for a full, warm sound.
  const startPadChord = (rootSemitone) => {
    const ctx = ensureCtx();
    const now = ctx.currentTime;
    const dest = masterCompRef.current || ctx.destination;
    const quality = chordQualityRef.current;
    
    // Rich harmonic voicing: [deep bass root, lower 5th, middle root, 3rd, 5th, octave, octave 3rd]
    const majorIntervals = [-12, -5, 0, 4, 7, 12, 16];
    const minorIntervals = [-12, -5, 0, 3, 7, 12, 15];
    const intervals = quality === "Minor" ? minorIntervals : majorIntervals;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0, now);
    masterGain.gain.linearRampToValueAtTime(0.55, now + 0.18);
    masterGain.connect(dest);

    const oscs = [];
    intervals.forEach((interval) => {
      const midi = (octaveStartRef.current + 1) * 12 + rootSemitone + interval;
      const freq = 440 * Math.pow(2, (midi - 69) / 12);

      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      // Warmer cutoff on lower bass notes, open slightly on upper
      filt.frequency.value = interval < 0 ? Math.min(1200, freq * 4.5) : Math.min(3600, freq * 4.0);
      filt.Q.value = 0.5;

      const noteGain = ctx.createGain();
      // Bass & lower notes given solid foundation weight; upper notes sit softly
      noteGain.gain.value = interval < 0 ? 0.65 : interval <= 7 ? 0.45 : 0.32;

      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      // Gentle chorus detune for warm pad fullness
      osc.detune.value = (Math.random() - 0.5) * 8;
      osc.connect(filt);
      filt.connect(noteGain);
      noteGain.connect(masterGain);
      osc.start(now);
      oscs.push(osc);
    });

    return { masterGain, oscillators: oscs };
  };

  const stopPadChord = (padVoice) => {
    if (!padVoice || !audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const now = ctx.currentTime;
    try {
      padVoice.masterGain.gain.cancelScheduledValues(now);
      padVoice.masterGain.gain.setValueAtTime(padVoice.masterGain.gain.value, now);
      padVoice.masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      padVoice.oscillators.forEach(osc => { try { osc.stop(now + 0.38); } catch { } });
    } catch { }
  };
  // ---------------------------------------------------------------------------

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
    if (isVocals) {
      // In vocals mode, single-touch only: stop all existing active chord voices immediately
      activeRef.current.forEach((entry) => {
        stopVoice(entry.voice);
        if (entry.padVoice) stopPadChord(entry.padVoice);
        paintKey(entry.keyEl, false);
      });
      activeRef.current.clear();

      // Full rich chord pad + subtle, gentle root acoustic note
      const padVoice = startPadChord(hit.semitone);
      const pianoVoice = startVoice(hit.semitone, 0.22);
      activeRef.current.set(e.pointerId, { semitone: hit.semitone, voice: pianoVoice, padVoice, keyEl: hit.el });
    } else {
      const voice = startVoice(hit.semitone, 1.0);
      activeRef.current.set(e.pointerId, { semitone: hit.semitone, voice, padVoice: null, keyEl: hit.el });
    }
    paintKey(hit.el, true);
  };

  useEffect(() => {
    const stopEntry = (entry) => {
      if (!entry) return;
      stopVoice(entry.voice);
      if (entry.padVoice) stopPadChord(entry.padVoice);
    };
    const handleMove = (e) => {
      const entry = activeRef.current.get(e.pointerId);
      if (!entry) return;
      e.preventDefault();
      const hit = keyAt(e.clientX, e.clientY);
      const newSemitone = hit ? hit.semitone : null;
      if (newSemitone === entry.semitone) return;
      stopEntry(entry);
      paintKey(entry.keyEl, false);
      if (hit) {
        if (isVocals) {
          const padVoice = startPadChord(hit.semitone);
          const voice = startVoice(hit.semitone, 0.22);
          activeRef.current.set(e.pointerId, { semitone: hit.semitone, voice, padVoice, keyEl: hit.el });
        } else {
          const voice = startVoice(hit.semitone, 1.0);
          activeRef.current.set(e.pointerId, { semitone: hit.semitone, voice, padVoice: null, keyEl: hit.el });
        }
        paintKey(hit.el, true);
      } else {
        activeRef.current.delete(e.pointerId);
      }
    };
    const handleUp = (e) => {
      const entry = activeRef.current.get(e.pointerId);
      if (!entry) return;
      stopEntry(entry);
      paintKey(entry.keyEl, false);
      activeRef.current.delete(e.pointerId);
    };
    const handleVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      activeRef.current.forEach((entry) => { stopVoice(entry.voice); if (entry.padVoice) stopPadChord(entry.padVoice); });
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
      activeRef.current.forEach((entry) => { stopVoice(entry.voice); if (entry.padVoice) stopPadChord(entry.padVoice); });
      activeRef.current.clear();
      if (audioCtxRef.current && audioCtxRef.current.state === "running") audioCtxRef.current.suspend().catch(() => { });
    };
  }, [isVocals]);

  // Close AudioContext fully on unmount so pitch/sample-rate state doesn't accumulate
  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close(); } catch { }
        audioCtxRef.current = null;
        masterCompRef.current = null;
      }
    };
  }, []);

  const renderOctaveKeys = () => (
    <>
      <div style={{ position: "absolute", inset: 0, display: "flex" }}>
        {WHITE_KEYS.map((k) => (
          <div key={k.semitone} data-semitone={k.semitone} data-black="0" style={{
            flex: 1, background: WHITE_KEY_BG, borderRight: "1px solid rgba(0,0,0,0.25)",
            display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 12, boxSizing: "border-box",
          }}>
            <span style={{ fontSize: isVocals ? 14 : 12, fontWeight: 700, color: "rgba(0,0,0,0.42)" }}>{k.name}</span>
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
              <span style={{ fontSize: isVocals ? 11.5 : 10, fontWeight: 700, color: "rgba(255,255,255,0.70)" }}>{k.name}</span>
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
          // Vocals mode: Clean segmented Major / Minor switch matching Add/Edit song style
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
          // Other modes: octave up/down
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
  const wasPlayingBeforeHideRef = useRef(false);
  useEffect(() => {
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
  }, []);

  const setBpm = (v, keepSong = false) => {
    const clamped = Math.min(300, Math.max(30, Math.round(v)));
    setBpmState(clamped);
    if (!keepSong) setLoadedSong(null);
    // Update the ref directly — the scheduler reads it on every 25ms tick so
    // it picks up the new tempo immediately without stopping/restarting (which
    // would cause the accented first-beat "crank" sound on each change).
    bpmRef.current = clamped;
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
      // Loud, sharp click: a very short high-passed noise transient (the
      // "crack") layered with a brief high-pitched tone (the "click"),
      // both with fast decays so it stays punchy rather than ringing.
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
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.frequency.value = isAccent ? 1500 : 1000;
    gain.gain.setValueAtTime(isAccent ? 0.7 : 0.4, scheduledTime);
    gain.gain.exponentialRampToValueAtTime(0.001, scheduledTime + 0.05);
    osc.connect(gain); gain.connect(dest);
    osc.start(scheduledTime); osc.stop(scheduledTime + 0.05);
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
    if (!ctx) return;
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
    unlockAudioPlayback();
    clearInterval(schedulerRef.current);
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      const AudioCtxCls = window.AudioContext || window.webkitAudioContext;
      audioCtxRef.current = new AudioCtxCls();
    }
    // Only auto-resume via onstatechange when the page is actually visible;
    // if the screen is locked iOS suspends the context and we should NOT
    // fight that (doing so caused the every-other-beat bleed-through).
    audioCtxRef.current.onstatechange = () => {
      const ctx = audioCtxRef.current;
      if (!ctx || !schedulerRef.current) return;
      if ((ctx.state === "suspended" || ctx.state === "interrupted") && document.visibilityState === "visible") {
        ctx.resume().catch(() => { });
      }
    };
    if (audioCtxRef.current.state === "suspended" || audioCtxRef.current.state === "interrupted") {
      await audioCtxRef.current.resume();
    }
    // Always create a fresh compressor to reset its internal gain-reduction
    // state — but keep the AudioContext alive so that re-starting is instant
    // (no 150-300ms context creation delay on the first beat).
    if (masterCompRef.current) {
      try { masterCompRef.current.disconnect(); } catch { }
      masterCompRef.current = null;
    }
    ensureMasterChain(audioCtxRef.current);
    beatRef.current = 0;
    nextNoteTimeRef.current = audioCtxRef.current.currentTime + 0.02;
    scheduler();
    clearInterval(schedulerRef.current);
    schedulerRef.current = setInterval(scheduler, 25);
    setPlaying(true);
  };
  const stop = () => {
    clearInterval(schedulerRef.current);
    schedulerRef.current = null;
    setPlaying(false);
    setFlashBeat(-1);
    // Suspend the context (not close) so the next start() is instant — no
    // AudioContext creation latency, no first-beat delay. Disconnect and null
    // the compressor so its internal reduction state is discarded, preventing
    // the accumulating loudness bug across start/stop cycles.
    const ctx = audioCtxRef.current;
    if (masterCompRef.current) {
      try { masterCompRef.current.disconnect(); } catch { }
      masterCompRef.current = null;
    }
    if (ctx && ctx.state !== "closed") {
      try { ctx.suspend().catch(() => { }); } catch { }
    }
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
          <button onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onToggle(); }} style={{
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
const stepBtnStyle = (C) => ({ width: 40, height: 40, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, background: C.surface2, color: C.text, fontSize: 20, fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 });
const bigStepBtnStyle = (C) => ({ width: 56, height: 56, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, background: C.surface2, color: C.text, fontSize: 26, fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 });

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

function ChordText({ text, onChange, editable, dim, brightTags, showLyrics = true, showTags = true, textAlign = "left", fontSize = 22, lineHeightMult = 1.75, tagFontSize, accent, C, emptyHint, bold, lyricsBold, notesBold, flattenTags = false, tagGapMult = 1, hyphenateOverlaps = false, padWordForTag = true, letterSpacing = "normal" }) {
  const [editorFor, setEditorFor] = useState(null); // { line, index } | null
  const [draft, setDraft] = useState("");
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
    <div style={{ fontFamily: MONO, fontSize, lineHeight: `${lineHeightMult}em`, textAlign, whiteSpace: "pre-wrap", wordBreak: "keep-all", overflowWrap: "normal", letterSpacing, hyphens: "none", maxWidth: "100%", boxSizing: "border-box", overflowX: "hidden" }}>
      {lines.map((line, li) => {
        let tokens = tokenizeTaggedLine(line);
        if (tokens.length === 0) tokens.push({ ch: null, tag: null });
        if (hyphenateOverlaps && !editable) tokens = insertOverlapHyphens(tokens, tagSize, fontSize, flattenTags);

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
                position: "relative", display: "inline-block", paddingTop: topPad,
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
                <span style={{
                  position: "absolute", top: 0, left: 0, whiteSpace: "nowrap",
                  fontSize: tagSize, fontWeight: noteWeightBold ? 800 : 600,
                  lineHeight: 1,
                  color: brightTags ? C.text : accent,
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
              <span style={{ color: showLyrics ? (dim ? "#4D4D50" : C.text) : "transparent", visibility: showLyrics ? "visible" : (tok.ch ? "hidden" : "visible"), fontWeight: lyricWeightBold ? 700 : 400 }}>
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
                const minWidthCh = Math.max(1, tagDrivenWidth);
                const minWidthVal = showTags ? `${minWidthCh}ch` : undefined;
                return (
                  <span key={gi} style={{ display: "inline-block", minWidth: minWidthVal }}>
                    {renderChar(repItem)}
                  </span>
                );
              }
              const minWidthCh = padWordForTag ? Math.max(g.items.length, tagDrivenWidth) : g.items.length;
              return (
                <span key={gi} style={{ display: "inline-block", whiteSpace: "nowrap", minWidth: showTags ? `${minWidthCh}ch` : undefined }}>
                  {g.items.map(renderChar)}
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
    if (dragX > 30) { setLeaving(true); setDragX(window.innerWidth); setTimeout(onBack, 200); }
    else setDragX(0);
  };
  const handleTouchStart = (e) => start(e.touches[0].clientX, e.touches[0].clientY);
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
  return { dragX, leaving, dragging: dragX > 0, handlers: { onTouchStart: handleTouchStart, onTouchMove: handleTouchMove, onTouchEnd: handleTouchEnd, onTouchCancel: handleTouchEnd, onMouseDown: handleMouseDown } };
}

function useSetlistSongSwipe(onPrev, onNext) {
  const draggingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0 });
  const dxRef = useRef(0);
  const directionRef = useRef(null);
  const mouseActiveRef = useRef(false);
  const [swipeDragging, setSwipeDragging] = useState(false);
  const start = (x, y) => {
    startRef.current = { x, y };
    directionRef.current = null; dxRef.current = 0; draggingRef.current = true;
  };
  const move = (x, y) => {
    if (!draggingRef.current) return;
    const dx = x - startRef.current.x;
    const dy = y - startRef.current.y;
    if (directionRef.current === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      directionRef.current = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    }
    if (directionRef.current === "y") return;
    dxRef.current = dx;
    setSwipeDragging(true);
  };
  const end = () => {
    const wasHorizontal = directionRef.current === "x";
    const dx = dxRef.current;
    draggingRef.current = false; directionRef.current = null; dxRef.current = 0;
    setSwipeDragging(false);
    if (wasHorizontal) {
      if (dx > 140 && onPrev) onPrev();
      else if (dx < -140 && onNext) onNext();
    }
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
  return { dragX: 0, dragging: swipeDragging, handlers: { onTouchStart: handleTouchStart, onTouchMove: handleTouchMove, onTouchEnd: handleTouchEnd, onTouchCancel: handleTouchEnd, onMouseDown: handleMouseDown } };
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
              <MenuItem icon={X} label="Remove" danger onClick={() => { setOpen(false); onRemoveFromSetlist(); }} C={C} />
            ) : (
              <MenuItem icon={Trash2} label="Delete" danger onClick={() => { setOpen(false); onDelete(); }} C={C} />
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
                      {value}
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
  { id: "chart", label: "Chart" },
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
const escapeHtml = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Auto-growing textarea with a highlighted backdrop: bracketed [tags] are
// tinted in the given accent colour as the user types. When
// restrictToNashville is set, only tokens matching the Nashville-number
// pattern are tinted — anything else in brackets stays plain text colour.
function HighlightedAutoGrowTextarea({ value, onChange, onBlur, onFocus, placeholder, wrapperStyle, textStyle, accent, restrictToNashville, C }) {
  const taRef = useRef(null);
  const backdropRef = useRef(null);
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  const handleScroll = () => {
    if (backdropRef.current && taRef.current) {
      backdropRef.current.scrollTop = taRef.current.scrollTop;
      backdropRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };
  const raw = String(value || "");
  const html = escapeHtml(raw).replace(/\[([^\]]*)\]/g, (m, inner) => {
    const valid = restrictToNashville ? isValidNashvilleToken(inner.trim()) : true;
    return valid ? `<span style="color:${accent}">[${escapeHtml(inner)}]</span>` : m;
  }) + (raw.endsWith("\n") ? "&nbsp;" : "");
  const baseTextStyle = { ...textStyle, margin: 0, border: "none", background: "transparent", boxSizing: "border-box", width: "100%", letterSpacing: "normal", fontKerning: "none", fontVariantLigatures: "none", fontFeatureSettings: '"kern" 0, "liga" 0, "calt" 0' };
  return (
    <div style={{ position: "relative", width: "100%", boxSizing: "border-box", ...wrapperStyle }}>
      <div
        ref={backdropRef}
        aria-hidden="true"
        style={{ ...baseTextStyle, position: "absolute", inset: 0, height: "100%", color: C.text, overflow: "hidden", pointerEvents: "none" }}
        dangerouslySetInnerHTML={{ __html: html || "" }}
      />
      {!raw && placeholder ? (
        <div style={{ ...baseTextStyle, position: "absolute", inset: 0, height: "100%", color: C.textFaint, overflow: "hidden", pointerEvents: "none" }}>{placeholder}</div>
      ) : null}
      <textarea
        ref={taRef}
        className="no-ring"
        value={raw}
        onChange={onChange}
        onBlur={onBlur}
        onFocus={onFocus}
        onScroll={handleScroll}
        style={{ ...baseTextStyle, position: "relative", display: "block", color: "transparent", caretColor: C.text, resize: "none", overflow: "hidden", outline: "none", boxShadow: "none" }}
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
  const initialDecomposed = decomposeKey(initial?.key ?? "C");
  const [keyNatural, setKeyNatural] = useState(initialDecomposed.natural);
  const [keyAccidental, setKeyAccidental] = useState(initialDecomposed.accidental);
  const [keyQuality, setKeyQuality] = useState(initial?.keyQuality ?? "Major");
  const [language, setLanguage] = useState(initial?.language ?? "English");
  const [description, setDescription] = useState(initial?.description ?? "");
  const migratedInitial = initial ? migrateSongShape(initial) : null;
  const [lyricsText, setLyricsText] = useState(migratedInitial?.lyricsText ?? "");
  const [chordsText, setChordsText] = useState(migratedInitial?.chordsText ?? "");
  const [chartText, setChartText] = useState(migratedInitial?.chartText ?? "");
  const [drumsText, setDrumsText] = useState(migratedInitial?.drumsText ?? "");
  const [accents, setAccents] = useState(initial?.accents ?? seed?.accents ?? defaultAccents(4));
  const [subdivision, setSubdivision] = useState(initial?.subdivision ?? seed?.subdivision ?? 1);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const [sectionTab, setSectionTab] = useState("lyrics");

  const { dragX, leaving, dragging, handlers } = useEdgeSwipeBack(onCancel);
  const keyboardInset = useKeyboardInset();

  const handlePasteFromClipboard = async () => {
    try {
      const raw = await navigator.clipboard.readText();
      if (!raw || !raw.trim()) { setError("Clipboard is empty"); return; }
      const lines = raw.replace(/\r\n/g, "\n").split("\n");
      const fieldMap = { title: "title", artist: "artist", tempo: "tempo", "time signature": "timeSignature", key: "key", description: "description" };
      const fields = {};
      const parsedLines = [];
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
        if (trimmed.startsWith("#")) parsedLines.push("-" + trimmed.slice(1).trim());
        else if (trimmed) parsedLines.push(trimmed);
      }
      if (fields.title !== undefined) setTitle(fields.title);
      if (fields.artist !== undefined) setArtist(fields.artist);
      if (fields.tempo !== undefined) { const digits = fields.tempo.replace(/[^\d]/g, ""); if (digits) setTempo(digits); }
      if (fields.timeSignature !== undefined) { const m = fields.timeSignature.match(/^(\d+)\s*\/\s*(\d+)$/); if (m) setTimeSig({ beats: parseInt(m[1], 10), unit: parseInt(m[2], 10) }); }
      if (fields.key !== undefined) { const pk = parseKeyPaste(fields.key); if (pk) { setKeyNatural(pk.natural); setKeyAccidental(pk.accidental); setKeyQuality(pk.quality); } }
      if (fields.description !== undefined) setDescription(fields.description);
      if (parsedLines.length) setLyricsText(parsedLines.join("\n"));
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

  const handleSave = () => {
    const cleanTitle = toTitleCase(title.trim());
    const cleanArtist = toTitleCase(artist.trim());
    const isDuplicate = songs.some((s) => {
      if (initial && s.id === initial.id) return false;
      return s.title.toLowerCase() === cleanTitle.toLowerCase() && (s.artist || "").toLowerCase() === cleanArtist.toLowerCase();
    });
    if (!cleanTitle) return;
    if (isDuplicate) { setError("A song with this title and artist already exists."); return; }
    const savedKey = composeKey(keyNatural, keyAccidental);
    const normalizedChordsText = chordsTaggedToNumbersTagged(autoBracketNumbers(chordsText), savedKey, keyQuality);
    onSave({
      title: cleanTitle, artist: cleanArtist, tempo: tempo === "" ? "" : Number(tempo), timeSignature: formatTimeSig(timeSig),
      key: savedKey, keyQuality, language, description, accents, subdivision,
      lyricsText, chordsText: normalizedChordsText, chartText, drumsText,
    });
  };
  const canSave = title.trim().length > 0;
  const SECTION_TAB_VALUES = { lyrics: [lyricsText, setLyricsText], chords: [chordsText, setChordsText], chart: [chartText, setChartText], drums: [drumsText, setDrumsText] };
  const [activeSectionValue, setActiveSectionValue] = SECTION_TAB_VALUES[sectionTab];
  const SECTION_TAB_PLACEHOLDERS = {
    lyrics: "-Verse\nFirst line\nSecond line\n-Chorus\n…",
    chords: "-Verse\n1 4 5\n-Chorus\n…",
    chart: "-Verse\n[C]First line [G]of lyrics\n-Chorus\n…",
    drums: "-Verse\n[Kick]First line of lyrics\n-Chorus\n…",
  };

  return (
    <div className="scroll-list" style={{ position: "fixed", inset: 0, zIndex: 150, background: C.bg, color: C.text, fontFamily: FONT, overflowY: dragging ? "hidden" : "auto", touchAction: dragging ? "none" : "pan-y", boxSizing: "border-box", paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: keyboardInset ? Math.max(60, keyboardInset + 60) : 60, transform: `translateX(${dragX}px)`, transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none" }} {...handlers}>
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 5, background: C.bg }}>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}><ChevronLeft size={22} /></button>
        <div style={{ fontSize: 17, fontWeight: 600 }}>{initial ? "Edit Song" : "Add Song"}</div>
        <div style={{ flex: 1 }} />
        <button disabled={!canSave} onClick={handleSave} style={{ height: 34, padding: "0 16px", borderRadius: 9, border: "none", background: canSave ? C.accent : C.surface2, color: canSave ? "#fff" : C.textFaint, fontFamily: FONT, fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
          Save
        </button>
      </div>

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18, paddingBottom: 60, width: "100%", boxSizing: "border-box" }}>
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
            onFocus={scrollFieldIntoView}
            onBlur={() => { if (sectionTab === "chords") setChordsText((t) => autoBracketNumbers(t)); }}
            placeholder={SECTION_TAB_PLACEHOLDERS[sectionTab]}
            accent={C.accent}
            restrictToNashville={sectionTab === "chords"}
            C={C}
            wrapperStyle={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, minHeight: 140 }}
            textStyle={{ fontFamily: FONT, fontSize: 16, fontWeight: lyricsBold ? 700 : 400, lineHeight: 1.4, textAlign: "left", padding: "12px 14px", whiteSpace: "pre-wrap", wordBreak: "keep-all", overflowWrap: "normal", hyphens: "none" }} />
        </Field>

        {error && <div style={{ color: C.danger, fontSize: 13, textAlign: "center", fontWeight: 500 }}>{error}</div>}

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
   Songs list (no time signature shown per spec #6)
   ========================================================================= */
function PositionedActionMenu({ x, y, onEdit, onShare, onDelete, onClose, deleteConfirmMessage = "Delete this song?", C }) {
  const MENU_WIDTH = 170;
  const mountTimeRef = useRef(Date.now());
  const handleClose = (e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (Date.now() - mountTimeRef.current < 350) {
      return;
    }
    onClose();
  };
  // Anchor to the actual long-press point, clamped so the menu stays fully
  // on screen — it was previously pinned to a fixed right-edge x regardless
  // of where the press happened, so it always showed up near the bottom
  // right corner.
  const clampedX = Math.min(Math.max(x, MENU_WIDTH / 2 + 12), window.innerWidth - MENU_WIDTH / 2 - 12);
  const openUpward = y > window.innerHeight - 160;
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  // Portaled to document.body: a `position: fixed` descendant is positioned
  // relative to the nearest ancestor that has a CSS transform (any
  // transform, including translateX(0)), not the viewport — and list rows
  // set an inline transform for swipe-to-load. Without the portal, the menu
  // was anchoring to that row's transformed box instead of the screen,
  // landing in a different spot depending on which row/scroll position it
  // opened from.
  // Track whether the backdrop received a touchstart — if it didn't, the
  // touchend that follows is the release of the long-press that *opened*
  // this menu, and we must not close on it.
  const backdropTouchStartRef = useRef(false);
  return createPortal(
    <>
      <div
        onTouchStart={(e) => { e.stopPropagation(); backdropTouchStartRef.current = true; }}
        onTouchEnd={(e) => {
          e.stopPropagation();
          if (!backdropTouchStartRef.current) return;
          backdropTouchStartRef.current = false;
          onClose();
        }}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ position: "fixed", inset: 0, zIndex: 210 }}
      />
      <div
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "fixed", left: clampedX, top: openUpward ? y - 10 : y + 10,
          transform: openUpward ? "translate(-50%, -100%)" : "translate(-50%, 0)",
          zIndex: 220, width: "max-content", minWidth: MENU_WIDTH,
          background: C.surface3, border: `1px solid ${C.borderStrong}`, borderRadius: 12, overflow: "hidden",
          boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
        }}>
        <MenuItem icon={Pencil} label="Edit" onClick={() => { onClose(); onEdit(); }} C={C} />
        <MenuItem icon={IosShareIcon} label="Share" onClick={() => { onClose(); onShare(); }} C={C} />
        <MenuItem icon={Trash2} label="Delete" danger onClick={() => { onClose(); onDelete(); }} C={C} />
      </div>
    </>,
    document.body
  );
}
function SongRow({ song, onOpen, onEdit, onShare, onDelete, onLoadToMetronome, mode, tanglishMode, C, dimmed, onMenuOpenChange }) {
  const longPressTimerRef = useRef(null);
  const firedLongPressRef = useRef(false);
  const [menuPos, setMenuPos] = useState(null); // { x, y } | null
  const swipeStartRef = useRef(null);
  const [swipeDx, setSwipeDx] = useState(0);
  const swipeFiredRef = useRef(false);
  const startPress = (e) => {
    firedLongPressRef.current = false;
    const point = e.touches ? e.touches[0] : e;
    const x = point.clientX, y = point.clientY;
    swipeStartRef.current = { x, y };
    swipeFiredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      firedLongPressRef.current = true; setMenuPos({ x, y });
      if (onMenuOpenChange) onMenuOpenChange(song.id);
      if (navigator.vibrate) navigator.vibrate(15);
    }, 500);
  };
  const movePress = (e) => {
    if (!swipeStartRef.current || firedLongPressRef.current) return;
    // Swipe-to-load-into-metronome only does anything in Drums mode; in
    // Lyrics/Chords mode there's no onLoadToMetronome handler, so don't
    // let the row drag around for a gesture that has no effect.
    if (!onLoadToMetronome) return;
    const point = e.touches ? e.touches[0] : e;
    const dx = point.clientX - swipeStartRef.current.x;
    const dy = point.clientY - swipeStartRef.current.y;
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
      if (dx > 0) setSwipeDx(Math.min(dx, 120));
    }
  };
  const cancelPress = () => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    if (swipeDx > 60 && onLoadToMetronome) { swipeFiredRef.current = true; onLoadToMetronome(song); }
    setSwipeDx(0);
    swipeStartRef.current = null;
  };
  const handleClick = () => {
    if (firedLongPressRef.current) { firedLongPressRef.current = false; return; }
    if (swipeFiredRef.current) { swipeFiredRef.current = false; return; }
    onOpen(song);
  };
  // Right-click opens the same action menu as a long-press, since holding
  // down a mouse button for 500ms isn't a discoverable gesture on
  // laptop/PC — right-click is the standard desktop convention for a
  // context/action menu.
  const handleContextMenu = (e) => {
    e.preventDefault();
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    firedLongPressRef.current = true;
    setMenuPos({ x: e.clientX, y: e.clientY });
    if (onMenuOpenChange) onMenuOpenChange(song.id);
  };
  const badgeText = mode === "drums" ? (song.tempo !== "" && song.tempo != null ? `${song.tempo}` : "—") : keyLabel(song);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", position: "relative", opacity: dimmed ? 0.3 : 1, transition: dimmed ? "opacity 150ms ease" : "transform 120ms ease", transform: `translateX(${swipeDx}px)`, background: C.bg, zIndex: menuPos ? 130 : 1, userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
      onClick={handleClick} onTouchStart={startPress} onTouchMove={movePress} onTouchEnd={cancelPress} onTouchCancel={cancelPress}
      onMouseDown={startPress} onMouseMove={movePress} onMouseUp={cancelPress} onMouseLeave={cancelPress} onContextMenu={handleContextMenu}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{maybeTanglish(song.title, tanglishMode)}</div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{maybeTanglish(song.artist, tanglishMode) || "Unknown"}</div>
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color: C.accent, border: `1px solid ${C.accentDim}`, borderRadius: 6, padding: "3px 7px", flexShrink: 0 }}>{badgeText}</span>
      {menuPos && (
        <PositionedActionMenu
          x={menuPos.x} y={menuPos.y}
          onEdit={() => onEdit(song)}
          onShare={() => onShare(song)}
          onDelete={() => onDelete(song.id)}
          onClose={() => { setMenuPos(null); if (onMenuOpenChange) onMenuOpenChange(null); }}
          C={C}
        />
      )}
    </div>
  );
}
function SongsScreen({ songs, onOpen, onAdd, onEdit, onShare, onDelete, onLoadToMetronome, mode, tanglishMode, C }) {
  const [query, setQuery] = useState("");
  const [langFilter, setLangFilter] = useState("All");
  const [activeMenuId, setActiveMenuId] = useState(null);
  const keyboardInset = useKeyboardInset();
  const filtered = songs
    .filter((s) => songMatchesQuery(s, query))
    .filter((s) => langFilter === "All" || s.language === langFilter)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 auto", padding: "22px 20px 14px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div><div style={{ fontSize: 26, fontWeight: 700 }}>Songs</div><div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{songs.length} songs</div></div>
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
      <div className="scroll-list" style={{ flex: 1, overflowY: activeMenuId != null ? "hidden" : "auto", padding: `0 20px ${14 + keyboardInset}px`, boxSizing: "border-box" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>{songs.length === 0 ? "No songs yet." : "No matches."}</div>
        ) : filtered.map((s) => (
          <SongRow key={s.id} song={s} onOpen={onOpen} onEdit={onEdit} onShare={onShare} onDelete={onDelete} onLoadToMetronome={onLoadToMetronome} mode={mode} tanglishMode={tanglishMode} C={C}
            dimmed={activeMenuId != null && activeMenuId !== s.id} onMenuOpenChange={setActiveMenuId} />
        ))}
      </div>
    </div>
  );
}

function SongPickerScreen({ songs, selectedIds, onToggle, onClose, setlistName, onRenameSetlist, isShared, onToggleShared, mode, tanglishMode, C }) {
  const [query, setQuery] = useState("");
  const [nameDraft, setNameDraft] = useState(setlistName ?? "");
  const filtered = songs.filter((s) => songMatchesQuery(s, query));
  const commitName = () => { const trimmed = nameDraft.trim(); if (trimmed && onRenameSetlist) onRenameSetlist(trimmed); else setNameDraft(setlistName ?? ""); };
  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 150, display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top, 0px)", boxSizing: "border-box" }}>
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
            <div key={s.id} onClick={() => onToggle(s.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
              <div style={{ width: 21, height: 21, borderRadius: "50%", border: `1.5px solid ${checked ? C.accent : C.borderStrong}`, background: checked ? C.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {checked && <Check size={14} color="#fff" />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 15.5, fontWeight: 600 }}>{maybeTanglish(s.title, tanglishMode)}</div><div style={{ fontSize: 12.5, color: C.textMuted }}>{maybeTanglish(s.artist, tanglishMode) || "Unknown"}</div></div>
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

function SongExportPicker({ songs, onClose, onExport, tanglishMode, C }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const filtered = songs.filter((s) => songMatchesQuery(s, query));
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
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 15.5, fontWeight: 600 }}>{maybeTanglish(s.title, tanglishMode)}</div><div style={{ fontSize: 12.5, color: C.textMuted }}>{maybeTanglish(s.artist, tanglishMode) || "Unknown"}</div></div>
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
function SongDetailScreen({
  song, contextKey, onKeyChange, contextTempo, onTempoChange, onBack, onEdit, onDelete, onShare,
  fontSize, textAlign, lyricsBold, notesBold, lineSpacing, noteSpacing = 1, chordFontSize, sectionFontSize,
  isInSetlist, isSharedSetlist, syncedKeyOverride, syncedTempoOverride, onSaveOverrideToTeam,
  onRemoveFromSetlist, onPrevSong, onNextSong, mode, engine, tanglishMode, C
}) {
  const [viewKey, setViewKey] = useState(contextKey ?? song.key);
  const [descOpen, setDescOpen] = useState(false);
  const [chordsView, setChordsView] = useState("chords");
  const [nashvilleMode, setNashvilleMode] = useState(true);
  const [metroBarVisible, setMetroBarVisible] = useLocalStorageState("altar:song-view-metro-bar", false);
  const ms = migrateSongShape(song);

  const showBottomBar = mode === "drums" && !!engine && metroBarVisible;

  useEffect(() => { setViewKey(contextKey ?? song.key); }, [song.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (mode === "drums" && engine) engine.loadSong({ ...song, tempo: contextTempo ?? song.tempo }); }, [song.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const cycleSubdivision = () => engine && engine.setSubdivision((engine.subdivision % 3) + 1);
  const wasPlayingBeforeAdjustRef = useRef(false);
  const pauseForAdjust = () => { if (engine) { wasPlayingBeforeAdjustRef.current = engine.playing; if (engine.playing) engine.stop(); } };
  const resumeAfterAdjust = () => { if (engine && wasPlayingBeforeAdjustRef.current) engine.start(); };
  // Tempo changes made here (within a setlist) are saved back onto that
  // setlist's entry as a tempoOverride, mirroring how key changes are
  // scoped to the setlist rather than overwriting the song's own tempo.
  const stepBpm = (delta) => {
    if (!engine) return;
    const next = Math.min(300, Math.max(30, Math.round(engine.bpm + delta)));
    engine.setBpm(next, true);
    if (onTempoChange) onTempoChange(next);
  };
  const decBpmHold = useHoldRepeat(() => stepBpm(-1), { onStart: pauseForAdjust, onEnd: resumeAfterAdjust });
  const incBpmHold = useHoldRepeat(() => stepBpm(1), { onStart: pauseForAdjust, onEnd: resumeAfterAdjust });

  const edgeBack = useEdgeSwipeBack(onBack, isInSetlist ? 0 : 80);
  const setlistSwipe = useSetlistSongSwipe(onPrevSong, onNextSong);
  const { dragX, leaving, dragging, handlers } = isInSetlist ? { dragX: setlistSwipe.dragX, leaving: false, dragging: setlistSwipe.dragging, handlers: setlistSwipe.handlers } : edgeBack;

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
  const activeRawText = isVocals ? ms.lyricsText : mode === "drums" ? ms.drumsText : (chordsView === "chords" ? ms.chordsText : ms.chartText);

  const hasKeyChanged = Boolean(isSharedSetlist && onSaveOverrideToTeam && viewKey !== (syncedKeyOverride ?? song.key));
  const currentBpm = engine ? Math.round(engine.bpm) : (contextTempo ?? song.tempo);
  const baseTempo = syncedTempoOverride ?? (song.tempo === "" || song.tempo == null ? 120 : song.tempo);
  const hasTempoChanged = Boolean(isSharedSetlist && onSaveOverrideToTeam && currentBpm !== Number(baseTempo));

  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 100, display: "flex", flexDirection: "column", overflow: "hidden", paddingTop: "env(safe-area-inset-top, 0px)", boxSizing: "border-box", transform: `translateX(${dragX}px)`, transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none", touchAction: "pan-y" }} {...handlers}>
      <div style={{ flex: "0 0 auto", padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}`, position: "relative", zIndex: 2, background: C.bg }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6, position: "relative", zIndex: 1 }}><ChevronLeft size={22} /></button>
        <div style={{ flex: 1, minWidth: 0 }} />
        <div
          onTouchStart={startTitlePress} onTouchMove={cancelTitlePress} onTouchEnd={cancelTitlePress} onTouchCancel={cancelTitlePress}
          onMouseDown={startTitlePress} onMouseUp={cancelTitlePress} onMouseLeave={cancelTitlePress}
          style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", maxWidth: "calc(100% - 140px)", textAlign: "center", cursor: "pointer" }}
        >
          <div style={{ fontSize: 15, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{maybeTanglish(song.title, tanglishMode)}</div>
          {song.artist && <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{maybeTanglish(song.artist, tanglishMode)}</div>}
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
          <button onClick={() => setChordsView((v) => (v === "chords" ? "chart" : "chords"))} style={lyricsToggleStyle(true)}>{chordsView === "chords" ? "Chords" : "Chart"}</button>
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
            <BeatAccentControl count={(engine.timeSig.beats === 6 && engine.timeSig.unit === 8) ? 4 : engine.timeSig.beats} flashBeat={engine.flashBeat} accents={engine.accents} onChange={engine.setAccents} size={7} C={C} />
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

      <div className="scroll-list" style={{ flex: 1, overflowY: dragging ? "hidden" : "auto", overflowX: "hidden", padding: "16px 20px 40px", touchAction: dragging ? "none" : "pan-y" }}>
        {descOpen && song.description && (
          <div style={{ marginBottom: 18, padding: "11px 13px", background: C.surface2, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.accent}`, borderRadius: 8, fontSize: 13.5, color: C.textMuted, whiteSpace: "pre-wrap" }}>
            {maybeTanglish(song.description, tanglishMode)}
          </div>
        )}
        {(() => {
          let displayText = activeRawText;
          if (mode === "chords" && chordsView === "chords") displayText = sanitizeChordsOnlyNashville(displayText);
          if (mode === "chords" && !nashvilleMode) displayText = numbersTaggedToChordsTagged(displayText, viewKey, song.keyQuality);
          const letterSpacing = tanglishLetterSpacing(displayText, tanglishMode);
          displayText = maybeTanglish(displayText, tanglishMode);
          return parseTextIntoBlocks(displayText).map((block, idx) => (
            <div key={idx} style={{ marginBottom: 20, paddingTop: idx > 0 ? 16 : 0, borderTop: idx > 0 ? `1px solid ${C.border}` : "none" }}>
              {block.label && <div style={{ fontSize: labelFontSize, letterSpacing: 1.5, textTransform: "uppercase", color: C.accent, marginBottom: 8, textAlign }}>{block.label}</div>}
              {isVocals ? (
                <ChordText text={block.lines.join("\n")} editable={false} showLyrics showTags={false} textAlign={textAlign} fontSize={fontSize} lineHeightMult={lineSpacing} accent={C.accent} lyricsBold={lyricsBold} C={C} letterSpacing={letterSpacing} />
              ) : (
                <ChordText text={block.lines.join("\n")} editable={false} dim showLyrics brightTags textAlign={textAlign} fontSize={fontSize} tagFontSize={chordFontSize} lineHeightMult={lineSpacing} accent={C.accent} lyricsBold={lyricsBold} notesBold={notesBold} flattenTags={mode === "chords" && !nashvilleMode} C={C} tagGapMult={noteSpacing} hyphenateOverlaps={mode === "chords"} padWordForTag={mode !== "drums"} letterSpacing={letterSpacing} />
              )}
            </div>
          ));
        })()}
      </div>

      {showBottomBar && (
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "14px 16px max(20px, calc(10px + env(safe-area-inset-bottom, 0px)))", background: "#0B0B0C" }}>
          <button {...decBpmHold} style={{ width: 48, height: 48, borderRadius: "50%", border: "none", background: C.surface2, color: C.text, fontSize: 22, fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>−</button>
          <button onPointerDown={(e) => { e.preventDefault(); engine.toggle(); }} style={{ flex: "0 1 60%", height: 64, borderRadius: 18, border: "none", background: "#1F1F1F", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {engine.playing ? <Square size={26} color={C.accent} fill={C.accent} /> : <Play size={26} color={C.accent} fill={C.accent} style={{ marginLeft: 3 }} />}
          </button>
          <button {...incBpmHold} style={{ width: 48, height: 48, borderRadius: "50%", border: "none", background: C.surface2, color: C.text, fontSize: 22, fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>+</button>
        </div>
      )}
    </div>
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
        <div style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{maybeTanglish(song.title, tanglishMode)}</div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{maybeTanglish(song.artist, tanglishMode) || "Unknown"}</div>
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
function SetlistStageScreen({ setlist, songs, onBack, onUpdateSetlist, onOpenSong, onShare, onDeleteSetlist, initialPickerOpen, mode, tanglishMode, C }) {
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

  const commitName = () => { const trimmed = nameDraft.trim(); if (trimmed) onUpdateSetlist({ ...setlist, name: trimmed }); setEditingName(false); };
  const startNameLongPress = () => { if (nameLongPressTimerRef.current) clearTimeout(nameLongPressTimerRef.current); nameLongPressTimerRef.current = setTimeout(() => { setPickerOpen(true); }, 500); };
  const cancelNameLongPress = () => { if (nameLongPressTimerRef.current) { clearTimeout(nameLongPressTimerRef.current); nameLongPressTimerRef.current = null; } };

  const setlistSongs = setlist.entries.map((e) => {
    const song = songs.find((s) => s.id === e.songId);
    return song ? { song, keyOverride: e.keyOverride, tempoOverride: e.tempoOverride } : null;
  }).filter(Boolean);

  const removeFromStage = (songId) => onUpdateSetlist({ ...setlist, entries: setlist.entries.filter((e) => e.songId !== songId) });
  const toggleSong = (songId) => {
    const has = setlist.entries.some((e) => e.songId === songId);
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
  const endSongDrag = () => { if (dragTimerRef.current) clearTimeout(dragTimerRef.current); if (activeDragIndex !== null) justDraggedRef.current = true; setActiveDragIndex(null); setDragY(0); mouseDragIdxRef.current = null; };
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

      <div className="scroll-list" style={{ flex: 1, overflowY: (activeDragIndex !== null || dragging) ? "hidden" : "auto", padding: "0 20px 14px", boxSizing: "border-box", touchAction: (activeDragIndex !== null || dragging) ? "none" : "pan-y" }}>
        {setlistSongs.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>No songs added yet.</div>
        ) : setlistSongs.map(({ song: s, keyOverride, tempoOverride }, idx) => {
          const isDraggingThis = activeDragIndex === idx;
          return (
            <SwipeToDelete key={s.id} id={s.id} openId={openSwipeId} onOpenIdChange={setOpenSwipeId} onDelete={() => removeFromStage(s.id)} icon={X} C={C} elevated={isDraggingThis}>
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
          onClose={() => setPickerOpen(false)}
          setlistName={setlist.name}
          onRenameSetlist={(name) => onUpdateSetlist({ ...setlist, name })}
          isShared={Boolean(setlist.shared)}
          onToggleShared={(shared) => onUpdateSetlist({ ...setlist, shared })}
          mode={mode}
          tanglishMode={tanglishMode}
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
function SpellingChartRow({ tamilKey, value, isFirst, isEditing, draftTamil, setDraftTamil, draftLatin, setDraftLatin, onStartEdit, onDelete, onCommit, C, activeRef, scrollContainerRef }) {
  const inputStyle = {
    flex: 1, height: 38, borderRadius: 8, border: `1px solid ${C.border}`,
    background: C.surface3, color: C.text, fontFamily: FONT, fontSize: 14,
    fontWeight: 500, padding: "0 8px", outline: "none", boxSizing: "border-box", minWidth: 0,
  };

  const rowBorder = isFirst ? "none" : `1px solid ${C.border}`;

  // On focus, scroll the row above the keyboard using direct scrollTop math.
  // scrollIntoView() inside position:fixed containers is unreliable on Android.
  const scrollRowIntoView = (e) => {
    const input = e.currentTarget;
    setTimeout(() => {
      const container = scrollContainerRef?.current;
      if (!container || !input) return;
      const containerRect = container.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      // Estimate keyboard height from visualViewport if available
      const kbHeight = window.visualViewport
        ? Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop)
        : 0;
      const visibleBottom = containerRect.bottom - kbHeight;
      if (inputRect.bottom > visibleBottom) {
        container.scrollTop += inputRect.bottom - visibleBottom + 16;
      }
    }, 380);
  };

  if (isEditing) {
    return (
      <div
        ref={activeRef}
        onClick={(e) => e.stopPropagation()}
        style={{ borderTop: rowBorder, padding: "10px 12px", display: "flex", alignItems: "center", gap: 8, background: C.surface3 }}
      >
        <input
          autoFocus
          value={draftTamil}
          onChange={(e) => setDraftTamil(e.target.value)}
          onFocus={scrollRowIntoView}
          onKeyDown={(e) => { if (e.key === "Enter") onCommit(null); }}
          style={inputStyle}
          placeholder="தமிழ்"
        />
        <input
          value={draftLatin}
          onChange={(e) => setDraftLatin(e.target.value)}
          onFocus={scrollRowIntoView}
          onKeyDown={(e) => { if (e.key === "Enter") onCommit(null); }}
          style={inputStyle}
          placeholder="Tanglish"
        />
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(tamilKey); }}
          style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${C.border}`, background: "none", color: C.danger ?? "#FF453A", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          aria-label="Delete"
        >
          <Trash2 size={15} />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={(e) => onStartEdit(tamilKey, value, e)}
      style={{ width: "100%", display: "grid", gridTemplateColumns: "1fr 1fr", alignItems: "center", gap: 0, padding: "13px 12px", borderTop: rowBorder, background: "none", border: "none", textAlign: "left", cursor: "pointer", boxSizing: "border-box" }}
    >
      <div style={{ fontSize: 16, fontWeight: 500, color: C.text, paddingRight: 8 }}>{tamilKey}</div>
      <div style={{ fontSize: 14, fontWeight: 500, color: C.textMuted, paddingRight: 8 }}>{value}</div>
    </button>
  );
}

function SpellingChartScreen({ chart, onSave, onBack, C }) {
  const [activeEditKey, setActiveEditKey] = useState(null); // null | "__NEW__" | string
  const [draftTamil, setDraftTamil] = useState("");
  const [draftLatin, setDraftLatin] = useState("");
  const activeRowRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const keyboardInset = useKeyboardInset();

  const handleBack = () => {
    commitActiveEdit(null);
    onBack();
  };
  const { dragX, leaving, dragging, handlers } = useEdgeSwipeBack(handleBack);

  // User-added entries on top (newest-first), then seed entries below.
  const seedKeys = Object.keys(TANGLISH_EXCEPTIONS);
  const userKeys = Object.keys(chart).filter((k) => !seedKeys.includes(k)).reverse();
  const presentSeedKeys = seedKeys.filter((k) => k in chart);
  const rows = [...userKeys, ...presentSeedKeys];

  const commitActiveEdit = (newKeyToEdit = null, newDraftT = "", newDraftL = "") => {
    if (activeEditKey === "__NEW__") {
      const t = draftTamil.trim();
      const l = draftLatin.trim();
      if (t && l && !chart[t]) {
        // Prepend new custom word to the top
        onSave({ [t]: l, ...chart });
      }
    } else if (activeEditKey && chart[activeEditKey] !== undefined) {
      const origTamil = activeEditKey;
      const origLatin = chart[activeEditKey];
      const t = draftTamil.trim();
      const l = draftLatin.trim();
      if (t && l && (t !== origTamil || l !== origLatin)) {
        const next = { ...chart };
        if (origTamil !== t) delete next[origTamil];
        next[t] = l;
        onSave(next);
      }
    }
    setActiveEditKey(newKeyToEdit);
    setDraftTamil(newDraftT);
    setDraftLatin(newDraftL);
  };

  const handleStartAdd = (e) => {
    e.stopPropagation();
    commitActiveEdit("__NEW__", "", "");
  };

  const handleStartEditRow = (key, val, e) => {
    e.stopPropagation();
    if (activeEditKey === key) return;
    commitActiveEdit(key, key, val);
  };

  const handleDelete = (key) => {
    if (activeEditKey === key) {
      setActiveEditKey(null);
    }
    const next = { ...chart };
    delete next[key];
    onSave(next);
  };

  // Scroll the active editing row into view above the keyboard.
  // scrollIntoView() is unreliable inside position:fixed overflow containers on
  // Android Chrome, so we calculate scrollTop directly on the container instead.
  useEffect(() => {
    if (!activeEditKey || !activeRowRef.current || !scrollContainerRef.current) return;
    // Wait for the keyboard to finish animating open (~380 ms on Android)
    const timer = setTimeout(() => {
      const container = scrollContainerRef.current;
      const row = activeRowRef.current;
      if (!container || !row) return;
      const containerRect = container.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      // The visible height is the total container height minus the keyboard inset
      const visibleBottom = containerRect.bottom - keyboardInset;
      if (rowRect.bottom > visibleBottom) {
        // Row is hidden behind the keyboard — scroll it into view with 16px clearance
        container.scrollTop += rowRect.bottom - visibleBottom + 16;
      }
    }, 380);
    return () => clearTimeout(timer);
  }, [activeEditKey, keyboardInset]);

  const inputStyle = {
    flex: 1, height: 40, borderRadius: 8, border: `1px solid ${C.border}`,
    background: C.surface3, color: C.text, fontFamily: FONT, fontSize: 15,
    fontWeight: 500, padding: "0 10px", outline: "none", boxSizing: "border-box", minWidth: 0,
  };

  return (
    <div
      ref={scrollContainerRef}
      className="scroll-list"
      onClick={() => { if (activeEditKey) commitActiveEdit(null); }}
      style={{
        position: "fixed", inset: 0, zIndex: 150,
        background: C.bg, color: C.text, fontFamily: FONT,
        overflowY: dragging ? "hidden" : "auto",
        touchAction: dragging ? "none" : "pan-y",
        boxSizing: "border-box",
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: keyboardInset ? Math.max(80, keyboardInset + 80) : 60,
        transform: `translateX(${dragX}px)`,
        transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none"
      }}
      {...handlers}
    >
      {/* Sticky Header matching SongForm */}
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 5, background: C.bg }}>
        <button
          onClick={(e) => { e.stopPropagation(); handleBack(); }}
          style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6, marginLeft: -6 }}
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
          {/* Add Word inline top row */}
          {activeEditKey === "__NEW__" ? (
            <div
              ref={activeRowRef}
              onClick={(e) => e.stopPropagation()}
              style={{ padding: "10px 12px", display: "grid", gridTemplateColumns: "1fr 1fr", alignItems: "center", gap: 8, background: C.surface3, boxSizing: "border-box" }}
            >
              <input
                autoFocus
                placeholder="தமிழ்"
                value={draftTamil}
                onChange={(e) => setDraftTamil(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commitActiveEdit(null); }}
                style={inputStyle}
              />
              <input
                placeholder="Tanglish"
                value={draftLatin}
                onChange={(e) => setDraftLatin(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commitActiveEdit(null); }}
                style={inputStyle}
              />
            </div>
          ) : (
            <button
              onClick={handleStartAdd}
              style={{ width: "100%", display: "grid", gridTemplateColumns: "1fr 1fr", alignItems: "center", gap: 0, padding: "13px 12px", background: "none", border: "none", textAlign: "left", cursor: "pointer", boxSizing: "border-box" }}
            >
              <div style={{ fontSize: 15, fontWeight: 600, color: C.accent, display: "flex", alignItems: "center", gap: 6 }}>
                <Plus size={15} /> Add word...
              </div>
              <div style={{ fontSize: 13, color: C.textFaint }}>Custom transliteration</div>
            </button>
          )}

          {rows.map((key) => (
            <SpellingChartRow
              key={key}
              tamilKey={key}
              value={chart[key]}
              isFirst={false}
              isEditing={activeEditKey === key}
              draftTamil={draftTamil}
              setDraftTamil={setDraftTamil}
              draftLatin={draftLatin}
              setDraftLatin={setDraftLatin}
              onStartEdit={handleStartEditRow}
              onDelete={handleDelete}
              onCommit={commitActiveEdit}
              activeRef={activeEditKey === key ? activeRowRef : null}
              scrollContainerRef={scrollContainerRef}
              C={C}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SettingsScreen({ mode, setMode, fontSize, setFontSize, chordFontSize, setChordFontSize, sectionFontSize, setSectionFontSize, textAlign, setTextAlign, lyricsBold, setLyricsBold, notesBold, setNotesBold, lineSpacing, setLineSpacing, noteSpacing = 1, setNoteSpacing, clickSettings, setClickSettings, tanglishMode, setTanglishMode, onOpenSpellingChart, onConfigureSync, onForceSync, bandKey, syncStatus, C }) {
  const [toneIndex, setToneIndex] = useState(() => Math.max(0, CLICK_TONES.findIndex((t) => t.id === clickSettings.clickTone)));
  const alignOptions = [{ id: "left", Icon: AlignLeft }, { id: "center", Icon: AlignCenter }, { id: "right", Icon: AlignRight }];
  const labelFontSize = sectionFontSize;
  const rowBtnStyle = { display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "14px 16px", borderRadius: 12, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontFamily: FONT, fontSize: 15, fontWeight: 600 };

  // Which display target the Font Size / Bold / Spacing controls below the
  // dropdown currently affect.
  const [displayTarget, setDisplayTarget] = useState("lyrics");
  const ALL_DISPLAY_TARGETS = [
    { id: "lyrics", label: "Song Lyrics" },
    { id: "chords", label: "Chords / Notes" },
    { id: "headers", label: "Section Headers" },
  ];
  const DISPLAY_TARGETS = mode === "vocals"
    ? ALL_DISPLAY_TARGETS.filter((t) => t.id !== "chords")
    : ALL_DISPLAY_TARGETS;
  // If the selected target isn't available in this mode, reset to lyrics
  const effectiveDisplayTarget = DISPLAY_TARGETS.some((t) => t.id === displayTarget) ? displayTarget : "lyrics";
  const setEffectiveDisplayTarget = (v) => setDisplayTarget(v);

  const cycleTone = (dir) => {
    const next = (toneIndex + dir + CLICK_TONES.length) % CLICK_TONES.length;
    setToneIndex(next);
    setClickSettings({ ...clickSettings, clickTone: CLICK_TONES[next].id });
  };
  const decLyricsSizeHold = useHoldRepeat(() => setFontSize((f) => Math.max(14, f - 1)));
  const incLyricsSizeHold = useHoldRepeat(() => setFontSize((f) => Math.min(100, f + 1)));
  const decNotesSizeHold = useHoldRepeat(() => setChordFontSize((f) => Math.max(8, f - 1)));
  const incNotesSizeHold = useHoldRepeat(() => setChordFontSize((f) => Math.min(100, f + 1)));
  const decSectionSizeHold = useHoldRepeat(() => setSectionFontSize((f) => Math.max(9, f - 1)));
  const incSectionSizeHold = useHoldRepeat(() => setSectionFontSize((f) => Math.min(30, f + 1)));
  const decLineSpacingHold = useHoldRepeat(() => setLineSpacing((f) => Math.max(1.1, Math.round((f - 0.15) * 100) / 100)));
  const incLineSpacingHold = useHoldRepeat(() => setLineSpacing((f) => Math.min(3, Math.round((f + 0.15) * 100) / 100)));
  const decNoteSpacingHold = useHoldRepeat(() => setNoteSpacing((f) => Math.max(0.1, Math.round((f - 0.05) * 100) / 100)));
  const incNoteSpacingHold = useHoldRepeat(() => setNoteSpacing((f) => Math.min(2.5, Math.round((f + 0.05) * 100) / 100)));

  // Font Size / Bold / Spacing all delegate to whichever target is picked
  // in the dropdown above them.
  const targetSize = effectiveDisplayTarget === "lyrics" ? fontSize : effectiveDisplayTarget === "chords" ? chordFontSize : sectionFontSize;
  const targetSizeHold = effectiveDisplayTarget === "lyrics" ? { dec: decLyricsSizeHold, inc: incLyricsSizeHold }
    : effectiveDisplayTarget === "chords" ? { dec: decNotesSizeHold, inc: incNotesSizeHold }
      : { dec: decSectionSizeHold, inc: incSectionSizeHold };
  const targetBold = effectiveDisplayTarget === "lyrics" ? lyricsBold : effectiveDisplayTarget === "chords" ? notesBold : null;
  const targetSetBold = effectiveDisplayTarget === "lyrics" ? setLyricsBold : effectiveDisplayTarget === "chords" ? setNotesBold : null;
  const targetSpacing = effectiveDisplayTarget === "lyrics" ? lineSpacing : effectiveDisplayTarget === "chords" ? noteSpacing : null;
  const targetSpacingHold = effectiveDisplayTarget === "lyrics" ? { dec: decLineSpacingHold, inc: incLineSpacingHold }
    : effectiveDisplayTarget === "chords" ? { dec: decNoteSpacingHold, inc: incNoteSpacingHold }
      : null;

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
            <Field label="APPLY TO">
              <GenericDropdown value={effectiveDisplayTarget} options={DISPLAY_TARGETS} onChange={setEffectiveDisplayTarget} C={C} />
            </Field>
            <Field label="FONT SIZE">
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1, height: 44, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 10, padding: "0 4px" }}>
                  <button {...targetSizeHold.dec} style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Minus size={16} color={C.text} /></button>
                  <div style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{targetSize}px</div>
                  <button {...targetSizeHold.inc} style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Plus size={16} color={C.text} /></button>
                </div>
                {targetSetBold && (
                  <button onClick={() => targetSetBold((b) => !b)} style={{ width: 44, height: 44, borderRadius: 10, flexShrink: 0, border: `1px solid ${targetBold ? C.accent : C.border}`, background: targetBold ? C.accentSoft : C.surface3, color: targetBold ? C.accent : C.text, fontFamily: FONT, fontSize: 16, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>B</button>
                )}
              </div>
            </Field>
            {targetSpacingHold && (
              <Field label="SPACING">
                <div style={{ height: 44, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 10, padding: "0 4px" }}>
                  <button {...targetSpacingHold.dec} style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Minus size={16} color={C.text} /></button>
                  <div style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{targetSpacing.toFixed(2)}</div>
                  <button {...targetSpacingHold.inc} style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Plus size={16} color={C.text} /></button>
                </div>
              </Field>
            )}
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
    <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", bottom: 100, background: C.surface3, border: `1px solid ${C.borderStrong}`, padding: "10px 18px", borderRadius: 999, fontSize: 13.5, fontWeight: 600, zIndex: 300, whiteSpace: "nowrap", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
      {message}
    </div>
  );
}

function BottomNav({ active, onChange, mode, C }) {
  const firstTab = mode === "drums" ? { id: "practice", label: "Metronome", icon: MetronomeIcon } : { id: "practice", label: "Piano", icon: PianoIcon };
  const items = [firstTab, { id: "songs", label: "Songs", icon: ListMusic }, { id: "setlists", label: "Setlists", icon: Layers }, { id: "settings", label: "Settings", icon: SettingsIcon }];
  return (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 30 }}>
      <div style={{ display: "flex", background: C.bg, paddingTop: 18, paddingBottom: "max(36px, calc(8px + env(safe-area-inset-bottom, 0px)))" }}>
        {items.map(({ id, label, icon: Icon }) => {
          const isActive = active === id;
          const isPiano = Icon === PianoIcon;
          return (
            <button key={id} onClick={() => onChange(id)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", gap: 3, padding: "0 0 6px", background: "none", border: "none", fontFamily: FONT, cursor: "pointer" }}>
              {/* Allow the piano icon to be naturally wider than 18px; constrain only height */}
              <div style={{ height: 18, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon size={18} height={isPiano ? 18 : undefined} color={isActive ? C.accent : C.textMuted} strokeWidth={isActive ? 2.3 : 1.8} />
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

function TeamKeyModal({ isOpen, initialKey, onSave, onClose, C }) {
  const [draft, setDraft] = useState(initialKey || "");
  const [error, setError] = useState("");
  const keyboardInset = useKeyboardInset();
  useEffect(() => { setDraft(initialKey || ""); setError(""); }, [initialKey, isOpen]);
  if (!isOpen) return null;
  const isConnected = Boolean(initialKey && initialKey.trim());
  const handleSave = (val) => {
    const clean = val.trim().toUpperCase();
    setError("");
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
          onChange={(e) => { setDraft(e.target.value); setError(""); }}
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

  const [songs, setSongs] = useIndexedDbState("songs", []);
  const [setlists, setSetlists] = useIndexedDbState("setlists", []);
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
  const [spellingChart, setSpellingChart] = useIndexedDbState("tanglish-spelling-chart", TANGLISH_EXCEPTIONS);
  const [spellingChartOpen, setSpellingChartOpen] = useState(false);
  // Keep the runtime transliteration dictionary in sync with persisted edits.
  useEffect(() => { setActiveTanglishExceptions(spellingChart); }, [spellingChart]);
  const [bandKey, setBandKey] = useState(() => localStorage.getItem("zong:access-key") || "");
  const [syncStatus, setSyncStatus] = useState(() => bandKey ? "Ready" : "Public only");
  const syncRevision = useRef(() => {
    try {
      const stored = localStorage.getItem("zong:revision");
      if (!stored) return { global: 0, team: 0 };
      const parsed = JSON.parse(stored);
      if (typeof parsed === "object" && parsed !== null) return parsed;
      // Legacy plain-number value — migrate
      return { global: Number(parsed) || 0, team: 0 };
    } catch { return { global: 0, team: 0 }; }
  });
  // Unwrap the lazy-init function so the ref holds the value, not the fn
  if (typeof syncRevision.current === "function") syncRevision.current = syncRevision.current();
  const syncDirty = useRef(false);
  const syncing = useRef(false);

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
    if (mode !== "drums" && engine.playing) engine.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const [tab, setTab] = useState(() => (mode === "vocals" ? "songs" : "practice"));
  const [editingSong, setEditingSong] = useState(undefined);
  const [newSongSeed, setNewSongSeed] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [songToDelete, setSongToDelete] = useState(null);
  const [teamKeyModalOpen, setTeamKeyModalOpen] = useState(false);
  const [stageIndex, setStageIndex] = useState(null);
  const [stageAutoOpenPicker, setStageAutoOpenPicker] = useState(false);
  const [exportPickerOpen, setExportPickerOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState("");

  // A stable ref that always holds the latest performSync so that save functions
  // defined before performSync's useCallback can still trigger an immediate push.
  const performSyncRef = useRef(null);

  const saveSongs = (next) => {
    // Resolve the next value immediately (handles both plain value and updater fn)
    // and eagerly push it into the ref so performSync (which fires on the very
    // next microtask, before React re-renders) always sees the brand-new songs.
    const resolved = typeof next === "function" ? next(songsRef.current) : next;
    songsRef.current = resolved;
    syncDirty.current = true;
    setSongs(resolved);
    setTimeout(() => performSyncRef.current?.(true), 0);
  };
  const saveSetlists = (next) => {
    const resolved = typeof next === "function" ? next(setlistsRef.current) : next;
    setlistsRef.current = resolved;
    syncDirty.current = true;
    setSetlists(resolved);
    setTimeout(() => performSyncRef.current?.(true), 0);
  };
  const saveSpellingChart = (next) => {
    const resolved = typeof next === "function" ? next(spellingChartRef.current) : next;
    spellingChartRef.current = resolved;
    syncDirty.current = true;
    setSpellingChart(resolved);
    setTimeout(() => performSyncRef.current?.(true), 0);
  };

  const performSync = useCallback(async (force = false) => {
    // Keep the ref in sync so save functions can call the latest closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    performSyncRef.current = performSync;
    if (!navigator.onLine || syncing.current) return;
    syncing.current = true;
    if (bandKey) setSyncStatus("Syncing…");
    try {
      // Always read from stable refs so we never push stale state from a
      // captured closure (fixes the "song added on iPhone not appearing
      // elsewhere" stale-closure bug).
      const latestSongs = songsRef.current;
      const latestSpelling = spellingChartRef.current;
      const latestSetlists = setlistsRef.current;
      const sharedSetlists = latestSetlists.filter((sl) => sl.shared);
      const isChanged = force || syncDirty.current;
      if (isChanged) {
        console.log("[Zong Sync] Pushing updates to Supabase...", { songsCount: latestSongs.length, sharedSetlistsCount: sharedSetlists.length });
      }
      const result = await syncLibrary({
        key: bandKey,
        state: { songs: latestSongs, spellingChart: latestSpelling, sharedSetlists },
        revision: syncRevision.current,
        changed: isChanged
      });
      syncRevision.current = result.revision;  // { global: N, team: M }
      localStorage.setItem("zong:revision", JSON.stringify(result.revision));
      console.log("[Zong Sync] Sync successful. Current revision:", result.revision);

      if (result.conflict || result.pulled) {
        const remoteSongs = result.state?.songs || [];
        const remoteSpelling = result.state?.spellingChart || {};
        const remoteSharedSetlists = result.state?.sharedSetlists || [];

        // 1. Merge Songs (prevent duplicates by id, then title+artist)
        const mergedSongs = [...latestSongs];
        remoteSongs.forEach((rs) => {
          const idx = mergedSongs.findIndex((ls) =>
            ls.id === rs.id ||
            (ls.title.trim().toLowerCase() === rs.title.trim().toLowerCase() &&
              (ls.artist || "").trim().toLowerCase() === (rs.artist || "").trim().toLowerCase())
          );
          if (idx !== -1) {
            mergedSongs[idx] = { ...mergedSongs[idx], ...rs };
          } else {
            mergedSongs.push(rs);
          }
        });

        // 2. Merge Spelling Chart
        const mergedSpelling = { ...latestSpelling, ...remoteSpelling };

        // 3. Merge Setlists (keep personal setlists, merge shared setlists for team subscribers)
        let mergedSetlists = latestSetlists;
        if (bandKey) {
          const personalSetlists = latestSetlists.filter((sl) => !sl.shared);
          const sharedMap = new Map();
          remoteSharedSetlists.forEach((rsl) => {
            const normalizedEntries = (rsl.entries || []).map((e) => ({
              ...e,
              syncedKeyOverride: e.syncedKeyOverride ?? e.keyOverride,
              syncedTempoOverride: e.syncedTempoOverride ?? e.tempoOverride
            }));
            sharedMap.set(rsl.id, { ...rsl, shared: true, entries: normalizedEntries });
          });
          latestSetlists.filter((sl) => sl.shared).forEach((lsl) => {
            if (sharedMap.has(lsl.id)) {
              const remoteSl = sharedMap.get(lsl.id);
              const mergedEntries = remoteSl.entries.map((re) => {
                const le = lsl.entries.find((e) => e.songId === re.songId);
                if (le) {
                  return {
                    ...re,
                    keyOverride: le.keyOverride ?? re.keyOverride,
                    tempoOverride: le.tempoOverride ?? re.tempoOverride,
                    syncedKeyOverride: re.syncedKeyOverride ?? re.keyOverride,
                    syncedTempoOverride: re.syncedTempoOverride ?? re.tempoOverride
                  };
                }
                return re;
              });
              sharedMap.set(lsl.id, { ...remoteSl, entries: mergedEntries });
            } else if (result.conflict) {
              sharedMap.set(lsl.id, lsl);
            }
          });
          mergedSetlists = [...personalSetlists, ...Array.from(sharedMap.values())];
        }

        setSongs(mergedSongs);
        setSpellingChart(mergedSpelling);
        setSetlists(mergedSetlists);
        if (result.conflict) {
          // The merge produced a superset of both sides — push it back so the
          // server is up to date and other devices can receive it.
          syncDirty.current = true;
        } else {
          syncDirty.current = false;
        }
        if (bandKey) setSyncStatus("Up to date");
      } else {
        syncDirty.current = false;
        if (bandKey) setSyncStatus("Up to date");
      }
    } catch (error) {
      if (bandKey) setSyncStatus(navigator.onLine ? error.message : "Offline");
    } finally {
      syncing.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandKey]);

  useEffect(() => {
    // Sync immediately on mount (and whenever bandKey changes) so that:
    // (a) performSyncRef.current is set before the user can save their first song, and
    // (b) any data the remote gained while this device was offline is pulled in.
    performSync();

    const online = () => performSync();
    window.addEventListener("online", online);

    // Prefer Realtime push (Supabase) over polling — falls back to 30s poll if
    // Supabase is not configured (e.g. still using the Apps Script endpoint).
    let unsubscribeRealtime = null;
    let timer = null;

    if (isSupabaseConfigured()) {
      unsubscribeRealtime = subscribeToChanges({
        teamKey: bandKey || null,
        onGlobal: () => {
          console.log("[Zong App] Realtime global update event received -> pulling updates");
          performSync(false);
        },
        onTeam: () => {
          console.log("[Zong App] Realtime team update event received -> pulling updates");
          performSync(false);
        }
      });
      // Fallback fast background polling (5 seconds) to ensure guaranteed sync even without WebSockets
      timer = window.setInterval(() => performSync(false), 5000);
    } else {
      // No Supabase — keep the original 10-second Google Sheets poll
      timer = window.setInterval(() => performSync(false), 10000);
    }

    return () => {
      window.removeEventListener("online", online);
      if (timer) window.clearInterval(timer);
      if (unsubscribeRealtime) unsubscribeRealtime();
    };
  }, [performSync, bandKey]);

  // When IndexedDB finishes loading local songs/spelling on boot, ensure initial sync runs
  const initialSyncTriggered = useRef(false);
  useEffect(() => {
    if (!initialSyncTriggered.current && (songs.length > 0 || (spellingChart && Object.keys(spellingChart).length > 0))) {
      initialSyncTriggered.current = true;
      performSync(false);
    }
  }, [songs, spellingChart, performSync]);

  const handleSaveTeamKey = (newKey) => {
    const clean = newKey.trim().toUpperCase();
    setTeamKeyModalOpen(false);
    localStorage.setItem("zong:access-key", clean);
    localStorage.removeItem("zong:revision");
    syncRevision.current = { global: 0, team: 0 };
    setBandKey(clean);
    if (!clean) {
      setSyncStatus("Public only");
      flash("Disconnected from Team");
      return;
    }
    flash("Connected to Team");
    syncDirty.current = true;
    performSync(true);
  };

  const handleLeaveTeam = () => {
    localStorage.setItem("zong:access-key", "");
    localStorage.removeItem("zong:revision");
    syncRevision.current = { global: 0, team: 0 };
    setBandKey("");
    setSyncStatus("Public only");
    flash("Left Team");
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

  // iOS Safari quirk: focusing a text input (e.g. the search bar) makes the
  // browser scroll the whole layout viewport to keep the input above the
  // on-screen keyboard — even though html/body are position:fixed, this
  // still drags every fixed-position element (including the bottom nav)
  // upward with it. The app never actually uses window/document scrolling
  // itself (all real scrolling happens inside internal .scroll-list divs,
  // whose scroll events don't bubble to window), so pinning any window-level
  // scroll straight back to the top neutralises this without touching any
  // legitimate scrolling in the app.
  useEffect(() => {
    const pinScroll = () => { if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0); };
    window.addEventListener("scroll", pinScroll, { passive: true });
    window.visualViewport?.addEventListener("scroll", pinScroll);
    window.visualViewport?.addEventListener("resize", pinScroll);
    return () => {
      window.removeEventListener("scroll", pinScroll);
      window.visualViewport?.removeEventListener("scroll", pinScroll);
      window.visualViewport?.removeEventListener("resize", pinScroll);
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
    setNewSongSeed(null);
  };
  const requestDeleteSong = (songOrId) => {
    const s = typeof songOrId === "object" && songOrId !== null ? songOrId : songs.find((item) => item.id === songOrId);
    if (s) setSongToDelete(s);
  };
  const executeDeleteSong = (id) => {
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
  const handleCreateSetlist = () => {
    let n = 1;
    while (setlists.some((sl) => sl.name.toLowerCase() === `setlist ${n}`.toLowerCase())) n += 1;
    const now = Date.now();
    const newSl = { id: uid(), name: `Setlist ${n}`, entries: [], shared: false, createdAt: now, updatedAt: now, lastOpenedAt: now };
    const next = [newSl, ...setlists];
    saveSetlists(next);
    setStageAutoOpenPicker(true);
    setStageIndex(0);
  };
  const handleOpenSetlist = (id) => {
    const now = Date.now();
    saveSetlists(setlists.map((sl) => (sl.id === id ? { ...sl, lastOpenedAt: now } : sl)));
    setStageAutoOpenPicker(false);
    setStageIndex(setlists.findIndex((sl) => sl.id === id));
  };
  const handleDeleteSetlist = (id) => saveSetlists(setlists.filter((sl) => sl.id !== id));
  const handleUpdateSetlist = (updated) => saveSetlists(setlists.map((sl) => (sl.id === updated.id ? { ...updated, updatedAt: Date.now() } : sl)));
  const handleRemoveSongFromSetlist = (setlistId, songId) => {
    saveSetlists(setlists.map((sl) => (sl.id !== setlistId ? sl : { ...sl, entries: sl.entries.filter((e) => e.songId !== songId) })));
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
    performSync(true);
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
    const entries = setlist.entries.map((e) => ({ song: songs.find((s) => s.id === e.songId), keyOverride: e.keyOverride, tempoOverride: e.tempoOverride })).filter((e) => e.song);
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
      newEntries.push({ songId, keyOverride: e.keyOverride ?? null, tempoOverride: e.tempoOverride ?? null });
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
        input, textarea, select { font-size: 16px; }
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
            ? <MetronomeScreen engine={engine} onUpdateSongAccents={handleUpdateSongAccents} onUpdateSongSubdivision={handleUpdateSongSubdivision} onLongPressTitle={() => { setNewSongSeed({ tempo: Math.round(engine.bpm), timeSignature: formatTimeSig(engine.timeSig), accents: engine.accents, subdivision: engine.subdivision }); setEditingSong(null); }} C={C} />
            : <PianoScreen C={C} mode={mode} />
        )}
        {tab === "songs" && (
          <SongsScreen songs={songs} onOpen={(s) => setViewing({ songId: s.id, fromSetlistId: null })} onAdd={() => { if (mode === "drums") setNewSongSeed({ tempo: Math.round(engine.bpm), timeSignature: formatTimeSig(engine.timeSig), accents: engine.accents, subdivision: engine.subdivision }); setEditingSong(null); }} onEdit={(s) => setEditingSong(s)} onShare={exportSingleSong} onDelete={requestDeleteSong} onLoadToMetronome={mode === "drums" ? (s) => { engine.loadSong(s); setTab("practice"); } : undefined} mode={mode} tanglishMode={tanglishMode} C={C} />
        )}
        {tab === "setlists" && (
          <SetlistsScreen setlists={setlists} onOpenStage={handleOpenSetlist} onCreate={handleCreateSetlist} onDelete={handleDeleteSetlist} C={C} />
        )}
        {tab === "settings" && (
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
              flash("Syncing with Supabase…");
              await performSync(true);
              flash("Synced with Supabase!");
            }}
            bandKey={bandKey}
            syncStatus={syncStatus}
            C={C}
          />
        )}
      </div>

      <BottomNav active={tab} onChange={handleTabChange} mode={mode} C={C} />

      {editingSong !== undefined && (
        <SongForm initial={editingSong} seed={newSongSeed} onSave={handleSaveSong} onCancel={() => { setEditingSong(undefined); setNewSongSeed(null); }} onDelete={requestDeleteSong} onDuplicate={handleDuplicateSong} songs={songs} mode={mode} fontSize={fontSize} chordFontSize={chordFontSize} lyricsBold={lyricsBold} notesBold={notesBold} lineSpacing={lineSpacing} textAlign={textAlign} C={C} />
      )}

      {viewingSong && (
        <SongDetailScreen
          key={viewingSong.id}
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
          onShare={exportSingleSong}
          onRemoveFromSetlist={viewing?.fromSetlistId ? () => handleRemoveSongFromSetlist(viewing.fromSetlistId, viewingSong.id) : null}
          onPrevSong={viewing?.fromSetlistId && prevSetlistSongId ? () => setViewing({ songId: prevSetlistSongId, fromSetlistId: viewing.fromSetlistId }) : null}
          onNextSong={viewing?.fromSetlistId && nextSetlistSongId ? () => setViewing({ songId: nextSetlistSongId, fromSetlistId: viewing.fromSetlistId }) : null}
          fontSize={fontSize} textAlign={textAlign} lyricsBold={lyricsBold} notesBold={notesBold} lineSpacing={lineSpacing} noteSpacing={noteSpacing} chordFontSize={chordFontSize} sectionFontSize={sectionFontSize}
          mode={mode} engine={engine} tanglishMode={tanglishMode}
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
          mode={mode} tanglishMode={tanglishMode} C={C}
        />
      )}

      {exportPickerOpen && (
        <SongExportPicker songs={songs} onClose={() => setExportPickerOpen(false)} onExport={(ids) => { exportSongsByIds(ids); setExportPickerOpen(false); }} tanglishMode={tanglishMode} C={C} />
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