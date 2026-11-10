// A section's heading in the song view (and the Display preview): letter-spaced capitals in the accent colour inside a rounded box with an
// accent outline (no fill), aligned like the song's text. `size` is the section-heading size setting; the text inside is a little smaller
// (HEAD_TEXT_RATIO) so that the box, outline included, stands about as tall as a line of the song's text rather than taller.
export const HEAD_TEXT_RATIO = 0.8;

export function SectionHead({ label, size, textAlign, C }) {
  const text = size * HEAD_TEXT_RATIO;
  return (
    <div style={{ textAlign, marginBottom: Math.max(6, size * 0.7) }}>
      <span style={{
        display: "inline-block", maxWidth: "100%", boxSizing: "border-box", padding: `${Math.max(1, text * 0.12)}px ${Math.max(7, text * 0.6)}px`, borderRadius: Math.max(5, text * 0.45),
        border: `${Math.max(0.6, Math.round(text * 0.065 * 10) / 10)}px solid ${C.accent}`, color: C.accent, fontSize: text, letterSpacing: 1.5, textTransform: "uppercase", lineHeight: 1.15, textAlign: "left",
      }}>{label}</span>
    </div>
  );
}
