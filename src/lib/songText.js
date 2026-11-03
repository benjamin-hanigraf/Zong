// Song title / search helpers (alt titles, Tanglish display, query matching).
import { TAMIL_RANGE_RE, capitalizeTanglishLines, capitalizeTanglishWords, transliterateTanglish } from "./tanglish.js";

export function maybeTanglish(text, tanglishMode) {
  if (!tanglishMode || !text) return text;
  return TAMIL_RANGE_RE.test(text) ? capitalizeTanglishLines(transliterateTanglish(text)) : text;
}

// Title/artist variant: capitalises every word instead of just every line-start.
export function maybeTanglishTitle(text, tanglishMode) {
  if (!tanglishMode || !text) return text;
  return TAMIL_RANGE_RE.test(text) ? capitalizeTanglishWords(transliterateTanglish(text)) : text;
}

// Strip bracketed [Alt Title] groups from a title for display.
// The raw title field (e.g. "Way Maker [Camino Hacedor]") keeps the alt title
// for editing and search, but every display surface calls this so the alt is hidden.
// Alt titles are written in square or round brackets; a bare number like "(2)" is
// the duplicate-song counter, not an alt title, so it stays visible.
const ALT_TITLE_RE = /\s*(?:\[[^\]]*\]|\((?!\s*\d+\s*\))[^)]*\))/g;

export function stripAltTitle(title) {
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
export function tanglishLetterSpacing(sourceText, tanglishMode) {
  return tanglishMode && sourceText && TAMIL_RANGE_RE.test(sourceText) ? "-0.02em" : "normal";
}

// Lets a Latin/Tanglish search query match Tamil-script song titles/artists
// by comparing the query against a transliterated version of the text too.
export function songMatchesQuery(song, query) {
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

export const escapeHtml = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function compareEnglishThenTamil(a, b) {
  const ta = (t) => /[\u0B80-\u0BFF]/.test(t);
  const titleA = stripAltTitle(a.title), titleB = stripAltTitle(b.title);
  const tamilA = ta(titleA), tamilB = ta(titleB);
  if (tamilA !== tamilB) return tamilA ? 1 : -1;
  return titleA.localeCompare(titleB, tamilA ? "ta" : undefined, { sensitivity: "base", numeric: true });
}
