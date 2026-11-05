// The MD (musical director) note shown between a section's heading and its content: accent text in a rounded box with an accent outline and a
// very faint accent fill, aligned like the song's text. Not shown in Vocals mode. Used by the song view and by the Display preview in
// Settings, so the two always match.
import { maybeTanglish } from "../lib/songText.js";

export function MdNote({ note, fontSize, textAlign, tanglishMode, C }) {
  if (!note) return null;
  return (
    <div style={{
      width: "fit-content", maxWidth: "100%", boxSizing: "border-box", marginBottom: 10, padding: "6px 11px", borderRadius: 8,
      border: `1.5px solid ${C.accent}`, background: `${C.accent}0D`, color: C.accent,
      fontSize: Math.max(13, Math.min(18, Math.round(fontSize * 0.62))), fontWeight: 400, lineHeight: 1.35, whiteSpace: "pre-wrap", textAlign,
      marginLeft: textAlign === "center" || textAlign === "right" ? "auto" : 0, marginRight: textAlign === "center" ? "auto" : 0,
    }}>{maybeTanglish(note, tanglishMode)}</div>
  );
}
