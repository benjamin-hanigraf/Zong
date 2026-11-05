// The MD (musical director) note shown between a section's heading and its content: plain accent-coloured text in sentence case (first letter capitalised), the same
// size as the section heading (`size`), aligned like the song's text. Not shown in Vocals mode. Used by the song view and by the Display
// preview in Settings, so the two always match.
import { maybeTanglish } from "../lib/songText.js";

// First letter of the note capitalised, the rest as typed (sentence case).
const sentenceCase = (t) => { const s = String(t || ""); const i = s.search(/\S/); return i < 0 ? s : s.slice(0, i) + s.charAt(i).toUpperCase() + s.slice(i + 1); };

export function MdNote({ note, size, textAlign, tanglishMode, C }) {
  if (!note) return null;
  return (
    <div style={{ fontSize: size, letterSpacing: 1.5, color: C.accent, marginBottom: Math.max(6, size * 0.7), whiteSpace: "pre-wrap", lineHeight: 1.35, textAlign }}>
      {sentenceCase(maybeTanglish(note, tanglishMode))}
    </div>
  );
}
