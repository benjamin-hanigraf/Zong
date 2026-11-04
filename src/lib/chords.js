// Chord maths: keys, transposition, Nashville numbers <-> chord letters, chord-text helpers.


/* =========================================================================
   Chord-name transposition (letters, not the old Nashville-number system —
   Altar's chords are typed directly as [G], [Em], [C#m7] etc. in the lyric
   text, so transposing just shifts the spelled root by semitones).
   ========================================================================= */
const CHROMATIC_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const CHROMATIC_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

const FLAT_KEYS = new Set(["F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"]);

export const KEY_TO_SEMITONE = {
  C: 0, "B#": 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4,
  F: 5, "E#": 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10,
  Bb: 10, B: 11, Cb: 11,
};

export const ALL_KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function spellNote(semitone, useFlats) {
  const s = ((semitone % 12) + 12) % 12;
  return useFlats ? CHROMATIC_FLAT[s] : CHROMATIC_SHARP[s];
}

export function transposeKey(key, semitoneDelta) {
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
}

export function flatify(str) {
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

// Splits a whitespace-delimited word into surrounding punctuation and the note
// itself, so "(Bb", "1)", "'4/1'" or "-5" are still read as notes. Interior
// characters (the slash in 4/1 or G/B) and accidentals/chord marks (# b + °)
// stay part of the note.
export function splitNotePunct(word) {
  const w = String(word || "");
  const lead = w.match(/^[^A-Za-z0-9#]*/)[0].replace(/^$/, "");
  const rest = w.slice(lead.length);
  const trail = rest.match(/[^A-Za-z0-9#\u00B0+]*$/)[0];
  return { lead, core: rest.slice(0, rest.length - trail.length), trail };
}

// A lone "x" (as in "x2" repeat markers written "x 2") turns the note right after
// it into plain text. Only "x" does this; all other punctuation is ignored.
export const isStandaloneX = (core) => core === "x" || core === "X";

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
// Section headers ("-Verse 1") are never chords: converters below leave those lines alone.
const mapNonHeaderLines = (text, fn) => String(text || "").split("\n").map((l) => (l.trimStart().startsWith("-") ? l : fn(l))).join("\n");

export function autoBracketNumbers(text) { return mapNonHeaderLines(text, autoBracketNumbersLine); }

function autoBracketNumbersLine(text) {
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
export function tokenizeTaggedLine(rawLine) {
  const line = String(rawLine || "").trimStart();
  const tokens = [];
  let i = 0;
  let pendingTag = null;
  while (i < line.length) {
    if (line[i] === "[") {
      const end = line.indexOf("]", i);
      if (end === -1) { tokens.push({ ch: line[i], tag: pendingTag }); pendingTag = null; i++; continue; }
      // Tags with no character between them ([1][4][5]) all belong to the same place: keep every one, not just the last.
      const inner = line.slice(i + 1, end);
      pendingTag = pendingTag !== null ? `${pendingTag} ${inner}` : inner;
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

const MINOR_SCALE_OFFSETS = [0, 2, 3, 5, 7, 8, 10];

// natural minor
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

export const isValidNashvilleToken = (t) => isSingleNashvilleToken(t) || !!splitChordSequence(t, isSingleNashvilleToken);

export const isChordSymbol = (t) => isSingleChordSymbol(t) || !!splitChordSequence(t, isSingleChordSymbol);

export function tokenToChord(token, key, quality) {
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
export function chordToNumberToken(symbol, key, quality) {
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
export function chordsTaggedToNumbersTagged(taggedText, key, quality) {
  return mapNonHeaderLines(taggedText, (line) => line.replace(/\[([^\]]*)\]/g, (m, tok, off, whole) => (
    precededByStandaloneX(whole, off) ? tok : `[${chordToNumberToken(tok, key, quality)}]`
  )));
}

// Converts every [number] tag in a tagged (lyric-interleaved) text block
// into its derived [ChordLetter] for the given key/quality, leaving the
// lyric characters and non-number tags untouched.
export function numbersTaggedToChordsTagged(taggedText, key, quality) {
  return mapNonHeaderLines(taggedText, (line) => line.replace(/\[([^\]]*)\]/g, (_, tok, off, whole) => (
    precededByStandaloneX(whole, off) ? tok : `[${tokenToChord(tok, key, quality)}]`
  )));
}

/**
 * Turns a chord name ("Dm7", "G/B", "C#aug", "Bdim", "Ab") into what the pad synth needs:
 * the root's semitone and the intervals above it. bass = semitone of a slash-chord's bass note, or -1.
 */
export function chordToPadSpec(chord) {
  const m = String(chord || "").trim().match(/^([A-G])([#b]?)(.*?)(?:\/([A-G][#b]?))?$/);
  if (!m) return null;
  const root = KEY_TO_SEMITONE[m[1] + m[2]];
  if (root == null) return null;
  const suffix = m[3];
  const dim = suffix.startsWith("dim");
  const aug = suffix.startsWith("aug") || suffix.startsWith("+");
  const minor = !dim && /^m(?!aj)/.test(suffix);
  const sus = suffix.startsWith("sus2") ? 2 : suffix.startsWith("sus") ? 5 : 0;   // sus2 / sus4 replace the third
  // `seventh` = an extra tone above the octave root: 7th (9 / 10 / 11) or the added 9th (2 = add9).
  const seventh = /dim7/.test(suffix) ? 9 : /maj7/i.test(suffix) ? 11 : /add9/.test(suffix) ? 2 : /7/.test(suffix) ? 10 : 0;
  return {
    root,
    third: sus || (dim || minor ? 3 : 4),
    fifth: dim ? 6 : aug ? 8 : 7,
    seventh,
    bass: m[4] ? (KEY_TO_SEMITONE[m[4]] ?? -1) : -1,
  };
}

/**
 * Where each note of a pad chord sits (MIDI numbers, -1 = not used). Close voicing: the third, fifth and 7th / 9th all
 * stay within about an octave of the root, so nothing sounds far away; the root always lies in C3–B3 whatever
 * the key — never too high, and never down where it is hard to hear — and a slash chord's bass
 * is always the lowest note (the chord moves up an octave if it has to), which keeps the inversion right.
 *   root     the chord's root (lowest note unless there is a slash bass)
 *   third    third / sus2 / sus4      fifth   fifth (or ♭5 / ♯5)
 *   octave   the root doubled an octave up (left out for maj7: it would clash with the 7th)
 *   extra    7th or added 9th        bass    slash-chord bass
 */
export function padVoicing(spec) {
  // Every root sits in the same octave (C3–B3), so chords 1–7 all live in one register and none is left down in the
  // quiet bass (low notes are much harder to hear). A slash bass goes below it (C2–B2), so it is always the lowest note.
  const base = 48 + spec.root;
  const bassMidi = spec.bass >= 0 ? 36 + spec.bass : -1;
  return {
    root: base,
    third: base + spec.third,
    fifth: base + spec.fifth,
    octave: spec.seventh === 11 ? -1 : base + 12,
    extra: spec.seventh ? base + (spec.seventh === 2 ? 14 : spec.seventh) : -1,
    bass: bassMidi,
  };
}

/** The chord a plain Major / Minor pad key stands for (Vocals chord piano), in the same shape as chordToPadSpec. */
export const plainPadSpec = (root, minor) => ({ root, third: minor ? 3 : 4, fifth: 7, seventh: 0, bass: -1 });

/**
 * The notes of a pad chord as the warm-pad samples play them: [{ midi, gain, pan }]. The web player and the iOS engine
 * both play exactly this list, so the Vocals chord piano and the joystick sound the same everywhere.
 */
export function padSampleNotes(spec) {
  const v = padVoicing(spec);
  return padLevels([
    { midi: v.root, gain: 0.26, pan: -0.30 },
    { midi: v.fifth, gain: 0.20, pan: 0.25 },
    v.octave >= 0 && { midi: v.octave, gain: 0.22, pan: 0 },
    { midi: v.third, gain: 0.20, pan: 0.20 },
    v.extra >= 0 && { midi: v.extra, gain: 0.16, pan: -0.15 },
    v.bass >= 0 && { midi: v.bass, gain: 0.26, pan: -0.10 },
  ].filter(Boolean));
}

/**
 * Audibility: the ear hears high notes much more easily than low ones, so a chord of low notes sounds weak next to one of
 * higher notes. Each note's gain is lifted in proportion to how low it is (up to +6 dB below middle C, a touch less above
 * it; phone speakers can't reproduce the deepest notes, so pushing those harder only distorts), then the whole chord is scaled to one fixed loudness — so every chord, in every key and with any modifier, comes
 * out equally audible, and the low notes of a chord are no longer buried under its high ones.
 */
const PAD_LOUDNESS = 0.72;
export function padLevels(notes) {
  const lifted = notes.map((n) => {
    const db = n.midi < 60 ? Math.min(6, 0.4 * (60 - n.midi)) : -Math.min(3, 0.2 * (n.midi - 60));
    return { ...n, gain: n.gain * Math.pow(10, db / 20) };
  });
  const total = Math.sqrt(lifted.reduce((s, n) => s + n.gain * n.gain, 0)) || 1;
  const peak = Math.max(...lifted.map((n) => n.gain));
  const k = Math.min(PAD_LOUDNESS / total, 0.95 / peak);
  return lifted.map((n) => ({ ...n, gain: n.gain * k }));
}
