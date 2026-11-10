// Add / Edit song form, including the section text boxes and shared-section syncing.
import { ChevronDown, ChevronLeft, Copy, GripVertical, Plus, Trash2, X } from "lucide-react";
import { normLabel, reconcileAfterEdit, sectionList } from "../sections.js";
import { applySectionChanges, cleanStructure } from "../lib/structure.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useKeys } from "../lib/keys.js";
import { FONT, LANGUAGES } from "../lib/constants.js";
import { defaultAccents, getSongAccents, getSongSubdivision, setSongAccentsLocal, setSongSubdivision } from "../lib/songDevice.js";
import { composeKey, decomposeKey, formatTimeSig, parseTimeSig, toTitleCase } from "../lib/helpers.js";
import { escapeHtml, stripAltTitle } from "../lib/songText.js";
import { SECTION_TABS, drumsFromEditor, drumsToEditor, migrateSongShape } from "../lib/songModel.js";
import { autoBracketNumbers, chordsTaggedToNumbersTagged } from "../lib/chords.js";
import { scrollFieldIntoView, uiFrame, useKeyboardInset } from "../lib/viewport.js";
import { useEdgeSwipeBack } from "../lib/swipe.js";
import { AccidentalButton, ClearableInput, Field, NaturalDropdown, OptionDropdown, TabSelect, TimeSigPicker } from "../components/shared.jsx";
import { ConfirmDialog, NoticeDialog } from "../components/dialogs.jsx";

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
        aria-label="Section text"
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

export function SongForm({ initial, seed, onSave, onCancel, onDelete, onDuplicate, songs, mode, fontSize = 22, chordFontSize = 16, lyricsBold = false, notesBold = false, lineSpacing = 1.75, textAlign = "left", C }) {
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
  // All four notes texts share the same sections. Whenever the user leaves a text (switches tab or saves),
  // a section added / renamed / deleted in it is carried to the other three. `sectionBase` = the texts as
  // of the last such sync, which is what the edit is measured against.
  const sectionBase = useRef({ lyrics: lyricsText, chords: chordsText, chart: chartText, drums: drumsText });
  const [sectionNotice, setSectionNotice] = useState(null);
  // Structure: the order the sections are played in, each step with an MD note (collapsed until opened).
  const [structure, setStructure] = useState(() => cleanStructure(initial?.structure).map((r, i) => ({ ...r, id: `r${i}` })));
  const [structureOpen, setStructureOpen] = useState(false);
  const nextRowId = useRef(1000);
  const syncSections = (editedKey) => {
    const now = { lyrics: lyricsText, chords: chordsText, chart: chartText, drums: drumsText };
    const res = reconcileAfterEdit(sectionBase.current, now, editedKey);
    if (res.error) { setSectionNotice(res.error); return null; }
    // A renamed section keeps its Structure rows; a removed one loses them.
    const present = new Set(sectionList(res.texts.lyrics).map((e) => normLabel(e.label)));
    setStructure((rows) => applySectionChanges(rows, res.changes, present));
    if (res.texts.lyrics !== lyricsText) setLyricsText(res.texts.lyrics);
    if (res.texts.chords !== chordsText) setChordsText(res.texts.chords);
    if (res.texts.chart !== chartText) setChartText(res.texts.chart);
    if (res.texts.drums !== drumsText) setDrumsText(res.texts.drums);
    sectionBase.current = res.texts;
    return res.texts;
  };

  const { dragX, leaving, dragging, handlers } = useEdgeSwipeBack(onCancel);
  const keyboardInset = useKeyboardInset();
  const formRoot = useRef(null);
  const [discardOpen, setDiscardOpen] = useState(false);

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
    const synced = syncSections(sectionTab);
    if (!synced) return;
    const cleanTitle = toTitleCase(title.trim());
    const cleanArtist = toTitleCase(artist.trim());
    const isDuplicate = songs.some((s) => {
      if (initial && s.id === initial.id) return false;
      return stripAltTitle(s.title).toLowerCase() === stripAltTitle(cleanTitle).toLowerCase() && (s.artist || "").toLowerCase() === cleanArtist.toLowerCase();
    });
    if (!cleanTitle) return;
    if (isDuplicate) { setError("A song with this title and artist already exists."); return; }
    const savedKey = composeKey(keyNatural, keyAccidental);
    const normalizedChordsText = chordsTaggedToNumbersTagged(autoBracketNumbers(synced.chords), savedKey, keyQuality);
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
      lyricsText: synced.lyrics, chordsText: normalizedChordsText, chartText: synced.chart, drumsText: drumsFromEditor(synced.drums),
      structure: cleanStructure(structure),
    });
  };
  // Save only lights up once something differs from the values the form opened with.
  const formSnapshot = JSON.stringify([title, artist, tempo, timeSig, keyNatural, keyAccidental, keyQuality, language, description, lyricsText, chordsText, chartText, drumsText, accents, subdivision, structure.map((r) => [r.s, r.n])]);
  const openedSnapshot = useRef(formSnapshot);
  const canSave = title.trim().length > 0 && formSnapshot !== openedSnapshot.current;
  // Esc leaves (asking first when there are unsaved changes); Enter / Ctrl+S saves; Tab stays in the form.
  useKeys({
    rootRef: formRoot,
    escape: () => { if (formSnapshot !== openedSnapshot.current) setDiscardOpen(true); else onCancel(); },
    primary: () => { if (!canSave) return false; handleSave(); },
  });
  const SECTION_TAB_VALUES = { lyrics: [lyricsText, setLyricsText], chords: [chordsText, setChordsText], chart: [chartText, setChartText], drums: [drumsText, setDrumsText] };
  const [activeSectionValue, setActiveSectionValue] = SECTION_TAB_VALUES[sectionTab];
  const SECTION_TAB_PLACEHOLDERS = {
    lyrics: "-Verse\nFirst line\nSecond line\n-Chorus\n…",
    chords: "-Verse\n1 4 5\n-Chorus\n…",
    chart: "-Verse\n[C]First line [G]of lyrics\n-Chorus\n…",
    drums: "-Verse\nKick [First line of lyrics]\nSnare [Second line]\n-Chorus\n…",
  };

  // The sections a Structure row can pick: every section named in any of the texts (the one being typed in included).
  const sectionOptions = (() => {
    const seen = new Set();
    const out = [];
    [activeSectionValue, lyricsText, chordsText, chartText, drumsText].forEach((t) => sectionList(t).forEach(({ label }) => {
      const n = normLabel(label);
      if (n && !seen.has(n)) { seen.add(n); out.push({ id: label, label }); }
    }));
    return out;
  })();
  // Editing a section's heading (a letter, or only its case) renames the Structure rows that use it, as you type.
  const followHeadingEdit = (before, after) => {
    const was = sectionList(before);
    const now = sectionList(after);
    if (was.length !== now.length) return;   // a heading was added or removed: handled when the text is synced
    const renames = was.map((w, i) => ({ from: w.label, to: now[i].label })).filter((r) => r.from !== r.to);
    if (!renames.length) return;
    setStructure((rows) => rows.map((r) => {
      const hit = renames.find((x) => normLabel(x.from) === normLabel(r.s));
      return hit ? { ...r, s: hit.to } : r;
    }));
  };
  const setRow = (id, patch) => setStructure((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = () => setStructure((rows) => [...rows, { id: `n${nextRowId.current++}`, s: "", n: "" }]);
  const removeRow = (id) => setStructure((rows) => rows.filter((r) => r.id !== id));
  // Rows are moved by holding the dots at their left edge. The row follows the finger (or cursor); the rows it passes slide aside,
  // and nothing is reordered until it is let go — so nothing re-renders or flickers while it moves.
  const rowRefs = useRef({});
  const handleRefs = useRef({});
  const refocusRow = useRef(null);
  // Keyboard: with the dots in focus, ↑ ↓ move the row one place (the focus follows it).
  const moveRowByKey = (e, id) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const from = structure.findIndex((r) => r.id === id);
    const to = from + (e.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= structure.length) return;
    refocusRow.current = id;
    setStructure((rows) => { const next = [...rows]; const [m] = next.splice(from, 1); next.splice(to, 0, m); return next; });
  };
  useEffect(() => { if (refocusRow.current) { handleRefs.current[refocusRow.current]?.focus(); refocusRow.current = null; } }, [structure]);
  const [drag, setDrag] = useState(null);   // { id, from, to, dy } while a row is held
  const dragRef = useRef(null);
  const ROW_GAP = 8;
  const startDrag = (e, id) => {
    e.preventDefault();
    const scroller = formRoot.current;
    const ids = structure.map((r) => r.id);
    const rects = ids.map((rid) => rowRefs.current[rid]?.getBoundingClientRect());
    if (!scroller || rects.some((r) => !r)) return;
    const from = ids.indexOf(id);
    dragRef.current = { id, from, startY: e.clientY, startScroll: scroller.scrollTop, tops: rects.map((r) => r.top + scroller.scrollTop), hs: rects.map((r) => r.height), lastY: e.clientY };
    setDrag({ id, from, to: from, dy: 0 });
  };
  const updateDrag = (clientY) => {
    const d = dragRef.current;
    const scroller = formRoot.current;
    if (!d || !scroller) return;
    d.lastY = clientY;
    const dy = clientY - d.startY + (scroller.scrollTop - d.startScroll);
    const center = d.tops[d.from] + d.hs[d.from] / 2 + dy;
    const last = d.tops.length - 1;
    let to = d.from;
    if (center < d.tops[0]) to = 0;
    else if (center > d.tops[last] + d.hs[last]) to = last;
    else for (let i = 0; i <= last; i++) if (center >= d.tops[i] - ROW_GAP / 2 && center < d.tops[i] + d.hs[i] + ROW_GAP / 2) { to = i; break; }
    d.to = to;
    setDrag((cur) => (cur && cur.dy === dy && cur.to === to ? cur : cur && { ...cur, dy, to }));
  };
  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && d.to !== undefined && d.to !== d.from) setStructure((rows) => { const next = [...rows]; const [m] = next.splice(d.from, 1); next.splice(d.to, 0, m); return next; });
    setDrag(null);
  };
  // While a row is held the whole window follows the pointer, and the page scrolls when the row nears its top or bottom edge.
  useEffect(() => {
    if (!drag) return undefined;
    const move = (e) => updateDrag(e.clientY);
    const up = () => endDrag();
    let raf = 0;
    const autoScroll = () => {
      const d = dragRef.current;
      const scroller = formRoot.current;
      if (d && scroller) {
        const edge = 90;
        const y = d.lastY;
        if (y < edge + 60) scroller.scrollTop -= Math.ceil((edge + 60 - y) / 10);
        else if (y > window.innerHeight - edge) scroller.scrollTop += Math.ceil((y - (window.innerHeight - edge)) / 10);
        updateDrag(d.lastY);
      }
      raf = requestAnimationFrame(autoScroll);
    };
    raf = requestAnimationFrame(autoScroll);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
  }, [!!drag]); // eslint-disable-line react-hooks/exhaustive-deps
  // Where a row sits while a drag is going on: the held row follows the pointer; the ones it has passed move one slot over.
  const rowShift = (index, id) => {
    if (!drag) return 0;
    const h = (dragRef.current?.hs[drag.from] || 44) + ROW_GAP;
    if (id === drag.id) return drag.dy;
    if (drag.from < index && index <= drag.to) return -h;
    if (drag.to <= index && index < drag.from) return h;
    return 0;
  };

  return (
    <div ref={formRoot} className="scroll-list" style={{ position: "fixed", inset: 0, zIndex: 150, background: C.bg, color: C.text, fontFamily: FONT, overflowY: dragging ? "hidden" : "auto", touchAction: dragging ? "none" : "pan-y", boxSizing: "border-box", paddingBottom: keyboardInset ? Math.max(60, keyboardInset + 60) : 60, transform: dragX ? `translateX(${dragX}px)` : "none", transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none" }} {...handlers}>
      <div data-sticky-header style={{ padding: "calc(16px + var(--safe-top)) 20px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 5, background: C.bg }}>
        <button onClick={onCancel} aria-label="Back" style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}><ChevronLeft size={22} /></button>
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
                <button key={t.id} onClick={() => { if (t.id === sectionTab) return; if (syncSections(sectionTab)) setSectionTab(t.id); }} style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: "none", fontFamily: FONT, fontSize: 13.5, fontWeight: 700, background: active ? C.accentSoft : "transparent", color: active ? C.accent : C.textMuted }}>
                  {t.label}
                </button>
              );
            })}
          </div>

          <HighlightedAutoGrowTextarea
            value={activeSectionValue}
            onChange={(e) => { followHeadingEdit(activeSectionValue, e.target.value); setActiveSectionValue(e.target.value); }}
            onBlur={() => { if (sectionTab === "chords") setChordsText((t) => autoBracketNumbers(t)); }}
            placeholder={SECTION_TAB_PLACEHOLDERS[sectionTab]}
            accent={C.accent}
            drumMode={sectionTab === "drums"}
            chartMode={sectionTab === "chart"}
            C={C}
            wrapperStyle={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, minHeight: 140 }}
            textStyle={{ fontFamily: FONT, fontSize: 16, fontWeight: lyricsBold ? 700 : 400, lineHeight: 1.4, textAlign: "left", padding: "12px 14px", whiteSpace: "pre-wrap", wordBreak: "keep-all", overflowWrap: "normal", hyphens: "none" }} />
        </Field>

        {/* Structure: the order the sections are played in (a section is written once above, then used as often as needed here). */}
        <div>
          <button type="button" onClick={() => setStructureOpen((o) => !o)} aria-expanded={structureOpen} style={{
            width: "100%", boxSizing: "border-box", height: 44, padding: "0 14px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.text,
            fontFamily: FONT, fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <span style={{ color: C.accent }}>Structure</span>
            <ChevronDown size={18} style={{ transform: structureOpen ? "rotate(180deg)" : "none", transition: "transform 150ms ease", opacity: 0.7 }} />
          </button>
          {structureOpen && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              {structure.map((row, index) => {
                const held = drag?.id === row.id;
                return (
                <div key={row.id} ref={(el) => { if (el) rowRefs.current[row.id] = el; else delete rowRefs.current[row.id]; }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, position: "relative", zIndex: held ? 10 : 1, borderRadius: 10,
                    transform: drag ? `translateY(${rowShift(index, row.id)}px)` : "none",
                    transition: held || !drag ? "none" : "transform 150ms ease",
                  }}>
                  <button type="button" ref={(el) => { if (el) handleRefs.current[row.id] = el; else delete handleRefs.current[row.id]; }}
                    onPointerDown={(e) => startDrag(e, row.id)} onKeyDown={(e) => moveRowByKey(e, row.id)}
                    aria-label={`Move ${row.s || "this section"}`}
                    style={{ width: 22, height: 44, padding: 0, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center", color: C.textMuted, touchAction: "none", cursor: "grab", flexShrink: 0 }}>
                    <GripVertical size={18} />
                  </button>
                  <div style={{ width: "36%", minWidth: 110, flexShrink: 0 }}>
                    <OptionDropdown options={sectionOptions} value={row.s} onChange={(v) => setRow(row.id, { s: v })} placeholder="Section" C={C} />
                  </div>
                  <input value={row.n} onChange={(e) => setRow(row.id, { n: e.target.value })} onFocus={scrollFieldIntoView} placeholder="MD notes" maxLength={400}
                    style={{ flex: 1, minWidth: 0, height: 44, boxSizing: "border-box", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontFamily: FONT, fontSize: 16, padding: "0 12px" }} />
                  <button type="button" onClick={() => removeRow(row.id)} aria-label="Remove this section" title="Remove" style={{ background: "none", border: "none", color: C.textMuted, display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 44, padding: 0, flexShrink: 0 }}>
                    <X size={18} />
                  </button>
                </div>
                );
              })}
              <button type="button" onClick={addRow} style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", padding: "8px 0", color: C.accent, fontFamily: FONT, fontSize: 15, fontWeight: 700 }}>
                <span style={{ width: 22, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Plus size={18} /></span>
                Add section
              </button>
            </div>
          )}
        </div>

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
      {discardOpen && (
        <ConfirmDialog title="Discard changes?" message="You have unsaved changes to this song." confirmLabel="Discard" cancelLabel="Keep editing" danger
          onConfirm={() => { setDiscardOpen(false); onCancel(); }} onCancel={() => setDiscardOpen(false)} C={C} />
      )}
      {sectionNotice && (
        <NoticeDialog
          title="Section still has notes"
          message={`"${sectionNotice.label}" can't be removed yet — ${sectionNotice.modes.join(" and ")} still ${sectionNotice.modes.length > 1 ? "have" : "has"} notes under it. Delete those notes there first, or add the "-${sectionNotice.label}" line back here.`}
          onClose={() => setSectionNotice(null)} C={C}
        />
      )}
    </div>
  );
}
