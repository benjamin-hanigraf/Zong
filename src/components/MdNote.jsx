// The MD (musical director) note shown between a section's heading and its content: plain accent-coloured text, aligned like the
// song's text. Not shown in Vocals mode. Used by the song view and by the Display preview in Settings, so the two always match.
import { maybeTanglish } from "../lib/songText.js";

export function MdNote({ note, fontSize, textAlign, tanglishMode, C }) {
  if (!note) return null;
  return (
    <div style={{
      marginBottom: 10, color: C.accent, fontSize: Math.max(13, Math.min(18, Math.round(fontSize * 0.62))), fontWeight: 400, lineHeight: 1.35, whiteSpace: "pre-wrap", textAlign,
    }}>{maybeTanglish(note, tanglishMode)}</div>
  );
}
