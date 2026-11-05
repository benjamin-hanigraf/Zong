// A section's heading in the song view (and the Display preview): a small solid accent label with dark text, aligned like the song's text.
export function SectionHead({ label, size, textAlign, C }) {
  return (
    <div style={{ textAlign, marginBottom: Math.max(6, size * 0.7) }}>
      <span style={{
        display: "inline-block", maxWidth: "100%", boxSizing: "border-box", padding: `${Math.max(2, size * 0.18)}px ${Math.max(8, size * 0.7)}px`, borderRadius: Math.max(5, size * 0.4),
        background: C.accent, color: "#000", fontSize: size, fontWeight: 600, letterSpacing: 1.5, textTransform: "uppercase", lineHeight: 1.25, textAlign: "left",
      }}>{label}</span>
    </div>
  );
}
