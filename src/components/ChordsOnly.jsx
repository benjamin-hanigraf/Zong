// Renders pure chord progressions (Chords view).
import { FONT, MONO } from "../lib/constants.js";
import { chordToNumberToken, flatify, isChordSymbol, isStandaloneX, isValidNashvilleToken, splitNotePunct, tokenToChord } from "../lib/chords.js";
import { maybeTanglish } from "../lib/songText.js";

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

export function ChordsOnlyBlock({ lines, viewKey, keyQuality, nashvilleMode, textAlign = "left", fontSize = 22, chordFontSize, lineSpacing = 1.75, lyricsBold, notesBold, tanglishMode, C }) {
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
