// A section's heading in the song view (and the Display preview): letter-spaced capitals in the accent colour inside a rounded box with an
// accent outline (no fill), aligned like the song's text.
export function SectionHead({ label, size, textAlign, C }) {
  return (
    <div style={{ textAlign, marginBottom: Math.max(6, size * 0.7) }}>
      <span style={{
        display: "inline-block", maxWidth: "100%", boxSizing: "border-box", padding: `${Math.max(2, size * 0.2)}px ${Math.max(8, size * 0.7)}px`, borderRadius: Math.max(6, size * 0.45),
        border: `1px solid ${C.accent}`, color: C.accent, fontSize: size, letterSpacing: 1.5, textTransform: "uppercase", lineHeight: 1.25, textAlign: "left",
      }}>{label}</span>
    </div>
  );
}
