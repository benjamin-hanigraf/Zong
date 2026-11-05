// The MD (musical director) note shown between a section's heading and its content: plain accent-coloured letter-spaced capitals, the same
// size as the section heading (`size`), aligned like the song's text. Not shown in Vocals mode. Used by the song view and by the Display
// preview in Settings, so the two always match.
import { maybeTanglish } from "../lib/songText.js";

export function MdNote({ note, size, textAlign, tanglishMode, C }) {
  if (!note) return null;
  return (
    <div style={{ fontSize: size, letterSpacing: 1.5, textTransform: "uppercase", color: C.accent, marginBottom: Math.max(6, size * 0.7), whiteSpace: "pre-wrap", lineHeight: 1.35, textAlign }}>
      {maybeTanglish(note, tanglishMode)}
    </div>
  );
}
