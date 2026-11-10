// Metronome tab (Drums mode).
import { useEffect, useRef, useState } from "react";
import { hasOpenLayer, isShown, isTypingTarget } from "../lib/keys.js";
import { FONT } from "../lib/constants.js";
import { stripAltTitle } from "../lib/songText.js";
import { Tamil } from "../components/Tamil.jsx";
import { BeatAccentControl, Knob, SubdivisionIcon } from "../components/metronome.jsx";
import { TimeSigPicker } from "../components/shared.jsx";

/* =========================================================================
   Metronome tab (Drums mode's first page). Settings/Piano buttons removed
   per Altar spec — Settings now lives only in the bottom-nav Settings tab.
   ========================================================================= */
export function MetronomeScreen({ engine, onUpdateSongAccents, onUpdateSongSubdivision, onLongPressTitle, C }) {
  const { bpm, setBpm, timeSig, setTimeSig, accents, setAccents, subdivision, setSubdivision, toggle, tapTempo, loadedSong } = engine;
  const [editingBpm, setEditingBpm] = useState(false);
  const [bpmDraft, setBpmDraft] = useState("");
  const longPressTimerRef = useRef(null);

  const startTitleTouch = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => { if (onLongPressTitle) onLongPressTitle(); }, 500);
  };
  const clearTitleTouch = () => { if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; } };

  // Keyboard (Mac / PC): Space start / stop, ↑ ↓ tempo (Shift = 10), T tap tempo, M silence / restore every beat.
  // Ignored while a dialog is open, while typing, and for keys that a focused button or the tempo slider already handles.
  const pageRef = useRef(null);
  const latest = useRef({});
  latest.current = { bpm, setBpm, toggle, tapTempo, toggleMuted: engine.toggleMuted };
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || hasOpenLayer()) return;
      if (!pageRef.current || !isShown(pageRef.current)) return;
      const t = e.target;
      if (isTypingTarget(t)) return;
      const onControl = /^(BUTTON|A|SELECT)$/.test(t?.tagName || "") || t?.getAttribute?.("role") === "slider";
      const L = latest.current;
      if (e.key === " " && !onControl) { e.preventDefault(); L.toggle(); }
      else if ((e.key === "t" || e.key === "T") && !e.repeat) { e.preventDefault(); L.tapTempo(e); }
      else if ((e.key === "m" || e.key === "M") && !e.repeat) { e.preventDefault(); L.toggleMuted(); }
      else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !onControl) { e.preventDefault(); L.setBpm(Math.round(L.bpm) + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1), true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const changeAccents = (next) => { const merged = engine.editAccents(next); if (loadedSong) onUpdateSongAccents(loadedSong.id, merged); };
  const cycleSubdivision = () => {
    const next = (subdivision % 3) + 1;
    setSubdivision(next);
  };

  return (
    <div ref={pageRef} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-between", padding: "50px 20px 24px", boxSizing: "border-box", overflowY: "auto" }}>
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
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const next = Math.min(300, Math.max(30, Math.round(bpm) + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1)));
              setBpm(next, true); setBpmDraft(String(next));
            }
          }}
          className="bpm-number-input"
          style={{ fontSize: 60, fontWeight: 600, fontFamily: FONT, color: C.accent, fontVariantNumeric: "tabular-nums", lineHeight: "42px", background: "transparent", border: "none", textAlign: "center", width: 150, padding: 0, caretColor: "transparent" }}
        />
        <div style={{ fontSize: 11, letterSpacing: 2, color: C.textMuted, marginTop: 6 }}>BPM</div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", maxWidth: 320 }}>
        <BeatAccentControl count={(timeSig.beats === 6 && timeSig.unit === 8) ? 4 : timeSig.beats} accents={engine.shownAccents} onChange={changeAccents} onToggleMuted={engine.toggleMuted} C={C} />
      </div>

      <Knob value={bpm} onChange={(v) => setBpm(v, true)} size={268} onToggle={toggle} C={C} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, width: "100%", maxWidth: 320 }}>
        <TimeSigPicker value={timeSig} onChange={setTimeSig} fullWidth height={58} style={{ width: "100%" }} C={C} />
        <button onClick={cycleSubdivision} aria-label="Subdivision" style={{ width: "100%", height: 58, boxSizing: "border-box", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <SubdivisionIcon value={subdivision} size={19} color={C.text} />
        </button>
        <button onPointerDown={tapTempo} onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); tapTempo(e); } }} style={{ width: "100%", height: 58, boxSizing: "border-box", fontFamily: FONT, fontSize: 14, letterSpacing: 1, fontWeight: 600, borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, display: "flex", alignItems: "center", justifyContent: "center" }}>
          TAP
        </button>
      </div>
    </div>
  );
}
