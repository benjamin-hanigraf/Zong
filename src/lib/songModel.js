// Song content model: sections, drums text formats, block parsing, migration of older shapes.
import { tokenizeTaggedLine } from "./chords.js";

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

export const isNewDrumsText = (t) => String(t || "").startsWith(DRUMS_FORMAT_MARK);

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

export const convertOldDrumsText = (text) => DRUMS_FORMAT_MARK + String(text || "").split("\n").map(drumsLineOldToNew).join("\n");

export const drumsToEditor = (stored) => (isNewDrumsText(stored) ? String(stored).slice(DRUMS_FORMAT_MARK.length) : convertOldDrumsText(stored).slice(DRUMS_FORMAT_MARK.length));

export const drumsFromEditor = (text) => (String(text || "").trim() ? DRUMS_FORMAT_MARK + text : "");

export const drumsToTagged = (stored) => String(stored || "").slice(DRUMS_FORMAT_MARK.length).split("\n").map(drumsLineToTagged).join("\n");

export function migrateSongShape(song) {
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

export function parseTextIntoBlocks(text, stripTrailingBlanks = false) {
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

/* =========================================================================
   Song form — the Chords app's Add/Edit Song page is the norm for Altar,
   with a Lyrics/Drums/Chords tab-select added under "Sections" (spec #7/#8).
   ========================================================================= */
export const SECTION_TABS = [
  { id: "lyrics", label: "Lyrics" },
  { id: "chords", label: "Chords" },
  { id: "chart", label: "Chart" },
  { id: "drums", label: "Drums" },
];
