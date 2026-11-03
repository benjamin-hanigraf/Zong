// Offline Tamil -> Tanglish transliteration engine and its spelling dictionary.
import { tokenizeTaggedLine } from "./chords.js";

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
export const TAMIL_RANGE_RE = /[\u0B80-\u0BFF]/;

export const TAMIL_COMBINING_RE = /[\u0BBE-\u0BCD]/;

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
export const REMOVED_SEED_WORDS = {
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

export const TANGLISH_EXCEPTIONS = {
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

export function setActiveTanglishExceptions(map) { activeTanglishExceptions = map; }

// Transliterates one clean (tag-free) Tamil word into Tanglish, while also
// recording — for every input character index — the output-string offset
// at that exact point. That lets a tag anchored to a specific input
// character later be spliced into the precise corresponding spot in the
// transliterated output, even mid-syllable (between a consonant and its
// own vowel sign).
const KA = "\u0B95";

// க
const NGA = "\u0B99";

// ங
const SA = "\u0B9A";

// ச
const NYA = "\u0B9E";

// ஞ
const TA_RETROFLEX = "\u0B9F";

// ட
const THA = "\u0BA4";

// த
const NNNA = "\u0BA9";

// ன
const PA = "\u0BAA";

// ப
const YA = "\u0BAF";

// ய
const RA_HARD = "\u0BB1";

// ற

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

export function transliterateTanglish(input) {
  return String(input || "").split("\n").map(transliterateTanglishLine).join("\n");
}

// Capitalises the first Latin letter of every line — conventional for
// Tanglish song-sheet display.
export function capitalizeTanglishLines(text) {
  return String(text || "").split("\n").map((line) => line.replace(/[a-z]/, (c) => c.toUpperCase())).join("\n");
}

// Capitalises the first letter of every Latin word — used for titles and
// artist names so they read as proper-cased (e.g. "Oru Naal Kaanom").
export function capitalizeTanglishWords(text) {
  return String(text || "").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
