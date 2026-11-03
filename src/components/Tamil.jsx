// Renders Tamil text scaled to match Latin x-height.
import { FONT } from "../lib/constants.js";

// Runs transliteration only when Tanglish mode is on and the text actually
// contains Tamil script; otherwise passes the original text through
// untouched (English/mixed text, or Tanglish mode off).
// Tamil glyphs are drawn smaller than Latin ones at the same font-size. Measure, on this very
// device and font, the Latin x-height against the Tamil base-letter height (baseline to mean
// line) and publish the ratio as --ta-scale; <Tamil> uses it to size Tamil runs so both
// scripts look equally big. Works with whatever Tamil font the platform provides.
function measureTamilScale() {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `400 200px ${FONT}`;
    const latin = ctx.measureText("x").actualBoundingBoxAscent;
    const heights = ["ம", "ர", "ன", "ல", "வ", "ப", "க", "ட", "த", "ச"]
      .map((ch) => ctx.measureText(ch).actualBoundingBoxAscent)
      .filter((h) => h > 0)
      .sort((a, b) => a - b);
    if (!latin || !heights.length) return 1;
    const tamil = heights[Math.floor(heights.length / 2)];
    return Math.max(0.9, Math.min(1.5, latin / tamil));
  } catch { return 1; }
}

export function applyTamilScale() {
  const scale = measureTamilScale();
  document.documentElement.style.setProperty("--ta-scale", scale.toFixed(3));
}

const TAMIL_RUN_RE = /([\u0B80-\u0BFF]+(?:[\s\u200c\u200d]+[\u0B80-\u0BFF]+)*)/;

export function Tamil({ children }) {
  if (typeof children !== "string" || !/[\u0B80-\u0BFF]/.test(children)) return <>{children}</>;
  return (
    <>
      {children.split(TAMIL_RUN_RE).map((part, i) => (
        /[\u0B80-\u0BFF]/.test(part)
          ? <span key={i} style={{ fontSize: "calc(1em * var(--ta-scale, 1))" }}>{part}</span>
          : part
      ))}
    </>
  );
}
