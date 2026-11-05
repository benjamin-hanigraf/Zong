// A section's heading in the song view (and the Display preview): small letter-spaced capitals in the accent colour, aligned like the song's text.
export function SectionHead({ label, size, textAlign, C }) {
  return (
    <div style={{ fontSize: size, letterSpacing: 1.5, textTransform: "uppercase", color: C.accent, marginBottom: Math.max(6, size * 0.7), textAlign }}>{label}</div>
  );
}
