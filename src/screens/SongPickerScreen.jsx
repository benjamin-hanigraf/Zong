// Song picker used when building a setlist.
import { Check, ChevronLeft, Search } from "lucide-react";
import { useRef, useState } from "react";
import { useKeys } from "../lib/keys.js";
import { FONT } from "../lib/constants.js";
import { keyLabel } from "../lib/helpers.js";
import { compareEnglishThenTamil, maybeTanglish, songMatchesQuery, stripAltTitle } from "../lib/songText.js";
import { ClearableInput, navRowKeys } from "../components/shared.jsx";
import { Tamil } from "../components/Tamil.jsx";

export function SongPickerScreen({ songs, selectedIds, onToggle, onClose, setlistName, onRenameSetlist, isShared, onToggleShared, mode, tanglishMode, C }) {
  const [query, setQuery] = useState("");
  const [nameDraft, setNameDraft] = useState(setlistName ?? "");
  // English titles first (A–Z), then Tamil titles (in Tamil alphabetical order).
  const filtered = songs.filter((s) => songMatchesQuery(s, query)).sort(compareEnglishThenTamil);
  const commitName = () => { const trimmed = nameDraft.trim(); if (trimmed && onRenameSetlist) onRenameSetlist(trimmed); else setNameDraft(setlistName ?? ""); };
  const pickerRoot = useRef(null);
  useKeys({ rootRef: pickerRoot, escape: () => onClose(), primary: () => onClose() });   // Esc / Enter = Done
  return (
    <div ref={pickerRoot} style={{ position: "fixed", inset: 0, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 150, display: "flex", flexDirection: "column", paddingTop: "var(--safe-top)", boxSizing: "border-box" }}>
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onClose} aria-label="Back" title="Back (Esc)" style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6 }}><ChevronLeft size={22} /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <input className="no-ring" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onBlur={commitName} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            style={{ width: "100%", boxSizing: "border-box", fontFamily: FONT, fontSize: 17, fontWeight: 600, background: "transparent", border: "none", color: C.text, padding: 0, outline: "none" }} />
        </div>
        {onToggleShared && (
          <button
            onClick={() => onToggleShared(!isShared)}
            style={{
              height: 30,
              padding: "0 10px",
              borderRadius: 8,
              fontFamily: FONT,
              fontWeight: 700,
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              border: `1px solid ${isShared ? C.accentDim : C.border}`,
              background: isShared ? C.accentSoft : C.surface2,
              color: isShared ? C.accent : C.text,
              cursor: "pointer"
            }}
          >
            {isShared ? "Shared" : "Share"}
          </button>
        )}
        <button onClick={onClose} style={{ background: "none", border: "none", fontFamily: FONT, fontSize: 15.5, fontWeight: 700, color: C.accent, padding: "6px 4px" }}>Done</button>
      </div>
      <div style={{ padding: "14px 20px 6px" }}>
        <ClearableInput search autoFocus value={query} onChangeText={setQuery} placeholder="Search title or artist"
          leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
          style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box", paddingLeft: 36, paddingRight: query ? 36 : 14 }} />
      </div>
      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", padding: "6px 20px 40px" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>{songs.length === 0 ? "No songs in your library yet." : "No matches."}</div>
        ) : filtered.map((s) => {
          const checked = selectedIds.includes(s.id);
          return (
            <div key={s.id} data-nav-row tabIndex={0} role="checkbox" aria-checked={checked} onKeyDown={navRowKeys(() => { setQuery(""); onToggle(s.id); })} onClick={() => { setQuery(""); onToggle(s.id); }} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
              <div style={{ width: 21, height: 21, borderRadius: "50%", border: `1.5px solid ${checked ? C.accent : C.borderStrong}`, background: checked ? C.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {checked && <Check size={14} color="#fff" />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 15.5, fontWeight: 600 }}><Tamil>{maybeTanglish(stripAltTitle(s.title), tanglishMode)}</Tamil></div><div style={{ fontSize: 12.5, color: C.textMuted }}><Tamil>{maybeTanglish(s.artist, tanglishMode) || "Unknown"}</Tamil></div></div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.accent }}>
                {mode === "drums" ? (s.tempo !== "" && s.tempo != null ? `${s.tempo}` : "—") : keyLabel(s)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
