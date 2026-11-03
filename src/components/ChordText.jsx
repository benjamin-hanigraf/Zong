// Renders lyric text with [Chord]/[Note] markers above their characters.
import { useLayoutEffect, useRef, useState } from "react";
import { FONT, MONO } from "../lib/constants.js";
import { flatify, tokenizeTaggedLine } from "../lib/chords.js";
import { TAMIL_COMBINING_RE, TAMIL_RANGE_RE } from "../lib/tanglish.js";
import { uiFrame } from "../lib/viewport.js";
import { Tamil } from "./Tamil.jsx";

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
export function LyricsText({ text, textAlign = "left", fontSize = 22, lineHeightMult = 1.75, bold = false, letterSpacing }) {
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

export function ChordText({ text, onChange, editable, dim, brightTags, dimTags, showLyrics = true, showTags = true, textAlign = "left", fontSize = 22, lineHeightMult = 1.75, tagFontSize, accent, C, emptyHint, bold, lyricsBold, notesBold, flattenTags = false, tagGapMult = 1, hyphenateOverlaps = false, padWordForTag = true, letterSpacing = "normal" }) {
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
