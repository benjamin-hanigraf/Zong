// Song viewer, including Stage Mode controls.
import { ChevronDown, ChevronLeft, ChevronRight, Maximize, Minimize, Save, X } from "lucide-react";
import { sectionList } from "../sections.js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isTopLayer, isTypingTarget, useKeys } from "../lib/keys.js";
import { useLocalStorageState } from "../lib/storage.js";
import { FONT } from "../lib/constants.js";
import { flatify, numbersTaggedToChordsTagged, transposeKey } from "../lib/chords.js";
import { maybeTanglish, maybeTanglishTitle, stripAltTitle, tanglishLetterSpacing } from "../lib/songText.js";
import { drumsToTagged, migrateSongShape, parseTextIntoBlocks } from "../lib/songModel.js";
import { BeatAccentControl, PlayStopGlyph, SubdivisionIcon, useHoldRepeat } from "../components/metronome.jsx";
import { useEdgeSwipeBack, useSetlistSongSwipe } from "../lib/swipe.js";
import { DEVICE_CLASS } from "../lib/viewport.js";
import { Tamil } from "../components/Tamil.jsx";
import { MetronomeIcon, TimeSigPicker } from "../components/shared.jsx";
import { ChordsOnlyBlock } from "../components/ChordsOnly.jsx";
import { ChordText, LyricsText } from "../components/ChordText.jsx";
import { ConfirmDialog } from "../components/dialogs.jsx";

/* =========================================================================
   Song detail / chart viewer.
   ========================================================================= */
export function SongDetailScreen({
  song, contextKey, onKeyChange, contextTempo, onTempoChange, onBack, onEdit, onDelete,
  fontSize, textAlign, lyricsBold, notesBold, lineSpacing, noteSpacing = 1, chordFontSize, sectionFontSize,
  isInSetlist, isSharedSetlist, syncedKeyOverride, syncedTempoOverride, onSaveOverrideToTeam,
  onRemoveFromSetlist, onPrevSong, onNextSong, mode, engine, tanglishMode, liveSync, C
}) {
  const [viewKey, setViewKey] = useState(contextKey ?? song.key);
  const [descOpen, setDescOpen] = useState(false);
  const [chordsView, setChordsView] = useLocalStorageState("altar:song-view-chords-mode", "chords");
  const [nashvilleMode, setNashvilleMode] = useState(true);
  const [metroBarVisible, setMetroBarVisible] = useLocalStorageState("altar:song-view-metro-bar", false);
  const ms = migrateSongShape(song);

  const showBottomBar = mode === "drums" && !!engine && metroBarVisible;

  const scrollRef = useRef(null);
  const detailRoot = useRef(null);
  const [leaveStageAsk, setLeaveStageAsk] = useState(false);
  // Full-screen view (Windows / Mac only): the button or the ` (tilde) key toggles it; Esc leaves it.
  const canFullscreen = DEVICE_CLASS === "desktop" && typeof document !== "undefined" && !!document.fullscreenEnabled;
  const [isFull, setIsFull] = useState(() => !!document.fullscreenElement);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => { });
  };
  useEffect(() => {
    const sync = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", sync);
    return () => { document.removeEventListener("fullscreenchange", sync); if (document.fullscreenElement) document.exitFullscreen?.(); };   // closing the song leaves full screen
  }, []);
  useEffect(() => {
    if (!canFullscreen) return undefined;
    const onKey = (e) => {
      if (e.code !== "Backquote" || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || !isTopLayer(detailRoot.current)) return;
      e.preventDefault(); toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canFullscreen]);
  useKeys({ rootRef: detailRoot, escape: () => { if (document.fullscreenElement) document.exitFullscreen?.(); else if (descOpen) setDescOpen(false); else onBack(); } });
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

  // ── Stage Mode ──────────────────────────────────────────────────────────────
  // Every song's texts share the same sections, so a section KEY (label + occurrence) means the same place
  // in every mode. liveSync = { role: "lead" | "follow", status, target, onSection } or null when off.
  const syncRole = liveSync?.role || null;
  const sectionEntries = useMemo(() => sectionList(activeRawText), [activeRawText]);
  const keyedBlocks = (blocks) => { let c = 0; return blocks.map((block) => ({ block, key: block.label ? sectionEntries[c++]?.key : null })); };
  const [activeSection, setActiveSection] = useState(0);
  const activeKey = syncRole ? sectionEntries[activeSection]?.key : null;
  const syncMarker = (key) => (syncRole && key && key === activeKey
    ? <div aria-hidden="true" style={{ position: "absolute", left: -13, top: 0, bottom: 0, width: 3, borderRadius: 2, background: C.accent }} />
    : null);
  // Lead: tapping anywhere in a section jumps everyone to it (to play the sections in any order).
  const sectionTap = (key) => (syncRole === "lead" && key ? () => { const at = sectionEntries.findIndex((e) => e.key === key); if (at >= 0 && at !== activeSection) goToSection(at, true); } : undefined);
  const scrollToSection = (idx) => {
    const el = scrollRef.current?.querySelector(`[data-section-key="${CSS.escape(sectionEntries[idx]?.key || "")}"]`);
    const box = scrollRef.current;
    if (!el || !box) return;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 6;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
  };
  const goToSection = (idx, report) => {
    if (!sectionEntries.length) return;
    const next = Math.min(sectionEntries.length - 1, Math.max(0, idx));
    setActiveSection(next);
    scrollToSection(next);
    if (report) liveSync?.onSection?.({ sectionKey: sectionEntries[next].key, sectionIdx: next });
  };
  // New song: back to the first section (the lead tells the others; followers wait for the lead's position).
  useEffect(() => {
    setActiveSection(0);
    if (syncRole === "lead") liveSync.onSection?.({ sectionKey: sectionEntries[0]?.key ?? null, sectionIdx: 0 });
  }, [song.id, syncRole]); // eslint-disable-line react-hooks/exhaustive-deps
  // Followers: jump to whatever section the lead says.
  useEffect(() => {
    const t = liveSync?.target;
    if (syncRole !== "follow" || !t || t.songId !== song.id) return;
    const at = t.sectionKey ? sectionEntries.findIndex((e) => e.key === t.sectionKey) : -1;
    goToSection(at >= 0 ? at : Math.min(t.sectionIdx ?? 0, sectionEntries.length - 1), false);
  }, [liveSync?.target]); // eslint-disable-line react-hooks/exhaustive-deps
  // Lead: next / previous section from the screen buttons or a keyboard / clicker / pedal.
  const stepSection = (delta) => {
    if (delta > 0 && activeSection >= sectionEntries.length - 1) { if (onNextSong) onNextSong(); return; }
    goToSection(activeSection + delta, true);
  };
  const stepRef = useRef(stepSection);
  stepRef.current = stepSection;
  const goRef = useRef(null);
  goRef.current = (idx) => goToSection(idx, true);
  useEffect(() => {
    if (syncRole !== "lead") return undefined;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")) return;
      if (e.key === " " && /^(BUTTON|A)$/.test(e.target?.tagName || "")) return;   // Space on a focused button presses that button
      if (e.shiftKey && e.key === "ArrowRight") { if (onNextSong) { e.preventDefault(); onNextSong(); } }
      else if (e.shiftKey && e.key === "ArrowLeft") { if (onPrevSong) { e.preventDefault(); onPrevSong(); } }
      else if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)) { e.preventDefault(); stepRef.current(1); }
      else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) { e.preventDefault(); stepRef.current(-1); }
      else if (e.key === "Home") { e.preventDefault(); goRef.current(0); }
      else if (e.key === "End") { e.preventDefault(); goRef.current(Infinity); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [syncRole, onNextSong, onPrevSong]);
  // E = edit this song (the keyboard way to open the editor; touch uses a long-press on the title).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.key !== "e" && e.key !== "E") || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTypingTarget(e.target)) return;
      if (!isTopLayer(detailRoot.current) || !onEdit) return;
      e.preventDefault(); onEdit(song);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEdit, song]);
  // Not in Stage Mode: ← / → switch songs inside a setlist.
  useEffect(() => {
    if (syncRole) return undefined;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTypingTarget(e.target)) return;
      if (e.key === "ArrowRight" && onNextSong) { e.preventDefault(); onNextSong(); }
      else if (e.key === "ArrowLeft" && onPrevSong) { e.preventDefault(); onPrevSong(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [syncRole, onNextSong, onPrevSong]);

  const hasKeyChanged = Boolean(isSharedSetlist && onSaveOverrideToTeam && viewKey !== (syncedKeyOverride ?? song.key));
  const currentBpm = engine ? Math.round(engine.bpm) : (contextTempo ?? song.tempo);
  const baseTempo = syncedTempoOverride ?? (song.tempo === "" || song.tempo == null ? 120 : song.tempo);
  const hasTempoChanged = Boolean(isSharedSetlist && onSaveOverrideToTeam && currentBpm !== Number(baseTempo));

  return (
    <>
    {/* Solid backdrop so the setlist page never shows through while the song card slides. */}
    {isInSetlist && <div style={{ position: "fixed", inset: 0, background: C.bg, zIndex: 99 }} />}
    <div ref={detailRoot} style={{ position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 100, display: "flex", flexDirection: "column", overflow: "hidden", paddingTop: "var(--safe-top)", boxSizing: "border-box", transform: isInSetlist ? undefined : `translateX(${dragX}px)`, transition: isInSetlist ? "none" : ((leaving || transitioning) ? "transform 180ms ease-out" : dragging ? "none" : dragX === 0 ? "transform 180ms ease" : "none"), touchAction: "pan-y" }} {...handlers}>
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
        {canFullscreen && (
          <button onClick={toggleFullscreen} aria-label={isFull ? "Exit full screen" : "Full screen"} title={isFull ? "Exit full screen (Esc)" : "Full screen (`)"} style={{ ...chevronBtn, width: 30, height: 30, position: "relative", zIndex: 1 }}>
            {isFull ? <Minimize size={15} /> : <Maximize size={15} />}
          </button>
        )}
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
            return keyedBlocks(parseTextIntoBlocks(rawText, true)).map(({ block, key }, idx) => (
              <div key={idx} data-section-key={key || undefined} onClick={sectionTap(key)} style={{ position: "relative", cursor: syncRole === "lead" && key ? "pointer" : undefined, marginBottom: 20, paddingTop: idx > 0 ? 16 : 0, borderTop: idx > 0 ? `1px solid ${C.border}` : "none" }}>
                {syncMarker(key)}
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
          return keyedBlocks(parseTextIntoBlocks(displayText, true)).map(({ block, key }, idx) => (
            <div key={idx} data-section-key={key || undefined} onClick={sectionTap(key)} style={{ position: "relative", cursor: syncRole === "lead" && key ? "pointer" : undefined, marginBottom: 20, paddingTop: idx > 0 ? 16 : 0, borderTop: idx > 0 ? `1px solid ${C.border}` : "none" }}>
              {syncMarker(key)}
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

      {syncRole && (
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, padding: `10px 16px ${showBottomBar ? 10 : "max(14px, calc(6px + var(--safe-bottom)))"}`, borderTop: `1px solid ${C.border}`, background: C.bg }}>
          <button
            onClick={() => (syncRole === "lead" ? setLeaveStageAsk(true) : liveSync.onLeave?.())}
            aria-label="Leave Stage Mode" title="Leave Stage Mode"
            style={{ width: 30, height: 30, borderRadius: 8, border: "none", background: "transparent", color: C.textFaint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginRight: 4 }}
          ><X size={16} /></button>
          <span title={liveSync.status === "live" ? "Connected" : "Reconnecting…"} style={{ width: 9, height: 9, borderRadius: "50%", flexShrink: 0, background: liveSync.status === "live" ? C.accent : "#FFB020" }} />
          {syncRole === "lead" ? (
            <>
              <button onClick={() => stepSection(-1)} aria-label="Previous section" style={{ width: 52, height: 44, borderRadius: 12, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, display: "flex", alignItems: "center", justifyContent: "center" }}><ChevronLeft size={22} /></button>
              <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {sectionEntries[activeSection]?.label || "—"} <span style={{ color: C.textMuted, fontWeight: 600 }}>{sectionEntries.length ? `${activeSection + 1}/${sectionEntries.length}` : ""}</span>
              </div>
              <button onClick={() => stepSection(1)} aria-label="Next section" style={{ width: 52, height: 44, borderRadius: 12, border: `1px solid ${C.accentDim}`, background: C.accentSoft, color: C.accent, display: "flex", alignItems: "center", justifyContent: "center" }}><ChevronRight size={22} /></button>
            </>
          ) : (
            <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.textMuted, fontWeight: 600 }}>
              {liveSync.leaderPresent === false ? "Waiting for a leader…" : `Following · ${sectionEntries[activeSection]?.label || "—"}`}{liveSync.status === "live" ? "" : " · reconnecting…"}
            </div>
          )}
        </div>
      )}

      {leaveStageAsk && (
        <ConfirmDialog title="Leave Stage Mode?" message="You're leading. Everyone else will be left without a leader until someone takes over." confirmLabel="Leave" cancelLabel="Stay" danger
          onConfirm={() => { setLeaveStageAsk(false); liveSync.onLeave?.(); }} onCancel={() => setLeaveStageAsk(false)} C={C} />
      )}

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
