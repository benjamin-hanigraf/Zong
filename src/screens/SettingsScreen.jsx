// Settings tab.
import { AlignCenter, AlignLeft, AlignRight, ChevronLeft, ChevronRight, Download, Minus, Plus, RefreshCw, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { CLICK_TONES, FONT, MODES, MODE_META, PAN_OPTIONS } from "../lib/constants.js";
import { numbersTaggedToChordsTagged } from "../lib/chords.js";
import { useHoldRepeat } from "../components/metronome.jsx";
import { Field, IosSwitch, SectionLabel } from "../components/shared.jsx";
import { ChordText, LyricsText } from "../components/ChordText.jsx";
import { MdNote } from "../components/MdNote.jsx";
import { SectionHead } from "../components/SectionHead.jsx";

// Display settings. One − / + control (10–100 px) sets the lyrics size; notes and section headers
// follow in fixed ratios. The three spacing presets set line spacing and note gap together.
const MIN_TEXT_SIZE = 10;

const MAX_TEXT_SIZE = 100;

const NOTES_SIZE_RATIO = 0.9;

const HEADER_SIZE_RATIO = 0.75;

const SPACING_PRESETS = [
  { id: "tight", label: "Tight", line: 1.15, note: 0.15, iconGap: 3.5 },
  { id: "normal", label: "Normal", line: 1.4, note: 0.30, iconGap: 6.5 },
  { id: "airy", label: "Airy", line: 1.9, note: 0.60, iconGap: 10 },
];

// Three text lines with the preset's line gap, drawn in the button's colour.
function SpacingIcon({ gap, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <line x1="5" y1={12 - gap} x2="19" y2={12 - gap} />
      <line x1="5" y1="12" x2="19" y2="12" />
      <line x1="5" y1={12 + gap} x2="19" y2={12 + gap} />
    </svg>
  );
}

export function SettingsScreen({ mode, setMode, fontSize, setFontSize, chordFontSize, setChordFontSize, sectionFontSize, setSectionFontSize, textAlign, setTextAlign, lyricsBold, setLyricsBold, notesBold, setNotesBold, lineSpacing, setLineSpacing, noteSpacing = 1, setNoteSpacing, clickSettings, setClickSettings, tanglishMode, setTanglishMode, onOpenSpellingChart, onConfigureSync, onForceSync, bandKey, syncStatus, live, onOpenStageMode, onExportLibrary, onImportLibrary, C }) {
  const importInputRef = useRef(null);
  const [toneIndex, setToneIndex] = useState(() => Math.max(0, CLICK_TONES.findIndex((t) => t.id === clickSettings.clickTone)));
  const alignOptions = [{ id: "left", Icon: AlignLeft }, { id: "center", Icon: AlignCenter }, { id: "right", Icon: AlignRight }];
  const labelFontSize = sectionFontSize;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const applyTextSize = (size) => {
    const v = Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, size));
    fontSizeRef.current = v;
    setFontSize(v);
    setChordFontSize(Math.min(100, Math.max(8, Math.round(v * NOTES_SIZE_RATIO))));
    setSectionFontSize(Math.min(30, Math.max(9, Math.round(v * HEADER_SIZE_RATIO))));
  };
  const decSizeHold = useHoldRepeat(() => applyTextSize(fontSizeRef.current - 1));
  const incSizeHold = useHoldRepeat(() => applyTextSize(fontSizeRef.current + 1));
  const activeSpacing = SPACING_PRESETS.find((p) => Math.abs(p.line - lineSpacing) <= 0.1)?.id ?? null;
  const applySpacing = (preset) => { setLineSpacing(preset.line); setNoteSpacing(preset.note); };

  const cycleTone = (dir) => {
    const next = (toneIndex + dir + CLICK_TONES.length) % CLICK_TONES.length;
    setToneIndex(next);
    setClickSettings({ ...clickSettings, clickTone: CLICK_TONES[next].id });
  };
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
              <IosSwitch checked={tanglishMode} onChange={setTanglishMode} label="Transliteration" C={C} />
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
            <Field label="TEXT SIZE">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0, height: 44, boxSizing: "border-box", display: "flex", alignItems: "stretch", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                  <button {...decSizeHold} aria-label="Smaller text" style={{ flex: "1 1 0", minWidth: 0, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Minus size={16} color={C.text} /></button>
                  <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums", borderLeft: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}` }}>{fontSize}px</div>
                  <button {...incSizeHold} aria-label="Larger text" style={{ flex: "1 1 0", minWidth: 0, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center" }}><Plus size={16} color={C.text} /></button>
                </div>
                {(() => {
                  const boldOn = lyricsBold && notesBold;
                  return (
                    <button onClick={() => { setLyricsBold(!boldOn); setNotesBold(!boldOn); }} aria-label="Bold" aria-pressed={boldOn}
                      style={{ width: 44, height: 44, borderRadius: 10, flexShrink: 0, border: `1px solid ${boldOn ? C.accent : C.border}`, background: boldOn ? C.accentSoft : C.surface3, color: boldOn ? C.accent : C.text, fontFamily: FONT, fontSize: 16, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>B</button>
                  );
                })()}
              </div>
            </Field>
            <Field label="LINE SPACING">
              <div style={{ display: "flex", gap: 8 }}>
                {SPACING_PRESETS.map((preset) => {
                  const active = activeSpacing === preset.id;
                  return (
                    <button key={preset.id} onClick={() => applySpacing(preset)} aria-label={`${preset.label} line spacing`} style={{ flex: 1, height: 44, borderRadius: 10, border: `1px solid ${active ? C.accent : C.border}`, background: active ? C.accentSoft : C.surface3, color: active ? C.accent : C.text, fontFamily: FONT, fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                      <SpacingIcon gap={preset.iconGap} size={22} />
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="TEXT ALIGNMENT">
              <div style={{ display: "flex", gap: 8 }}>
                {alignOptions.map(({ id, Icon }) => {
                  const active = textAlign === id;
                  return (
                    <button key={id} onClick={() => setTextAlign(id)} aria-label={`Align ${id}`} aria-pressed={textAlign === id} style={{ flex: 1, height: 44, borderRadius: 10, border: `1px solid ${active ? C.accent : C.border}`, background: active ? C.accentSoft : C.surface3, color: active ? C.accent : C.text, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Icon size={16} />
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="PREVIEW">
              <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, overflowX: "hidden" }}>
                {/* Drawn with the same pieces and settings as the song view, so what is shown here is what the song looks like. */}
                <SectionHead label="Chorus" size={labelFontSize} textAlign={textAlign} C={C} />
                {mode !== "vocals" && <MdNote note="Soft, then build to big" size={labelFontSize} textAlign={textAlign} tanglishMode={tanglishMode} C={C} />}
                {mode === "vocals" ? (
                  <LyricsText
                    text={"Way maker, miracle worker,\npromise keeper, light in the darkness"}
                    textAlign={textAlign} fontSize={fontSize} lineHeightMult={lineSpacing} bold={lyricsBold}
                  />
                ) : mode === "drums" ? (
                  <ChordText
                    text={"[Half-time]Way maker, miracle worker,\npromise keeper, [Double Kick]light in the darkness"}
                    editable={false} dim showLyrics brightTags
                    textAlign={textAlign} fontSize={fontSize} tagFontSize={chordFontSize} lineHeightMult={lineSpacing}
                    accent={C.accent} lyricsBold={lyricsBold} notesBold={notesBold} C={C} tagGapMult={noteSpacing}
                    hyphenateOverlaps={false} padWordForTag
                  />
                ) : (
                  <ChordText
                    text={numbersTaggedToChordsTagged("[1]Way maker, [4]miracle worker,\n[6]promise keeper, [5]light in the [1]darkness", "E", "Major")}
                    editable={false} dim showLyrics brightTags flattenTags
                    textAlign={textAlign} fontSize={fontSize} tagFontSize={chordFontSize} lineHeightMult={lineSpacing}
                    accent={C.accent} lyricsBold={lyricsBold} notesBold={notesBold} C={C} tagGapMult={noteSpacing}
                    hyphenateOverlaps padWordForTag
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
                    <button onClick={() => cycleTone(-1)} aria-label="Previous click sound" style={{ background: "none", border: "none", padding: 10, display: "flex" }}><ChevronLeft size={20} color={C.text} /></button>
                    <div style={{ fontSize: 16, fontWeight: 600, textAlign: "center", flex: 1 }}>{CLICK_TONES[toneIndex]?.name}</div>
                    <button onClick={() => cycleTone(1)} aria-label="Next click sound" style={{ background: "none", border: "none", padding: 10, display: "flex" }}><ChevronRight size={20} color={C.text} /></button>
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
            <div style={{ display: "flex", gap: 8, padding: "0 8px 8px 8px" }}>
              {[
                { label: "Export", Icon: Upload, onClick: onExportLibrary },
                { label: "Import", Icon: Download, onClick: () => importInputRef.current?.click() },
              ].map(({ label, Icon, onClick }) => (
                <button key={label} onClick={onClick} style={{ flex: 1, height: 44, borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface3, color: C.text, fontFamily: FONT, fontSize: 14.5, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer" }}>
                  <Icon size={16} color={C.accent} />{label}
                </button>
              ))}
              <input ref={importInputRef} type="file" accept=".json,application/json" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onImportLibrary(f); }} />
            </div>
          </div>

          <SectionLabel>STAGE</SectionLabel>
          <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 26 }}>
            <button
              onClick={onOpenStageMode}
              style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", color: C.text, fontFamily: FONT, fontSize: 15, fontWeight: 600, padding: "16px 16px", cursor: "pointer", textAlign: "left" }}
            >
              <span>Stage Mode</span>
              <span style={{ display: "flex", alignItems: "center", gap: 7, color: live.role === "off" ? C.textMuted : C.accent, fontSize: 13, fontWeight: 700 }}>
                {live.role !== "off" && <span style={{ width: 8, height: 8, borderRadius: "50%", background: live.connected ? C.accent : "#FFB020" }} />}
                {live.role === "lead" ? "Leading" : live.role === "follow" ? "Following" : "Off"}
              </span>
            </button>
          </div>

          <div style={{ textAlign: "center", fontSize: 11.5, color: C.textFaint, paddingTop: 12 }}>Created by Benjamin Hanigraf</div>
        </div>
      </div>
    </div>
  );
}
