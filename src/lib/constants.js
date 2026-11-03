// Modes, accent colours, fonts, time signatures, click tones, languages.


/* =========================================================================
   MODES — Altar merges Click (metronome/drums) and Chords (chart/vocals)
   into three practice modes: Vocals, Drums, Chords. Each has its own accent
   colour; everything else (surfaces, text, layout) stays shared.
   ========================================================================= */
export const MODES = ["vocals", "chords", "drums"];

// display order for the Settings tab-select
export const MODE_META = {
  vocals: { label: "Vocals", accent: "#30D158", accentDim: "rgba(48,209,88,0.35)", accentSoft: "rgba(48,209,88,0.12)" },
  drums: { label: "Drums", accent: "#FFB020", accentDim: "rgba(255,176,32,0.35)", accentSoft: "rgba(255,176,32,0.12)" },
  chords: { label: "Chords", accent: "#0A84FF", accentDim: "rgba(10,132,255,0.35)", accentSoft: "rgba(10,132,255,0.12)" },
};

export function colorsFor(mode) {
  const m = MODE_META[mode] || MODE_META.vocals;
  return {
    bg: "#000000",
    surface: "#121212",
    surface2: "#1C1C1E",
    surface3: "#2C2C2E",
    border: "rgba(255,255,255,0.08)",
    borderStrong: "rgba(255,255,255,0.18)",
    text: "#FFFFFF",
    textMuted: "#98989D",
    textFaint: "#4D4D50",
    accent: m.accent,
    accentDim: m.accentDim,
    accentSoft: m.accentSoft,
    danger: "#FF453A",
  };
}

export const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif";

export const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

export const TIME_SIGS = [
  { beats: 2, unit: 4 }, { beats: 3, unit: 4 }, { beats: 4, unit: 4 },
  { beats: 6, unit: 4 }, { beats: 6, unit: 8 },
];

export const CLICK_TONES = [
  { id: "classic", name: "Classic" },
  { id: "digital", name: "Digital" },
  { id: "sharp", name: "Sharp" },
  { id: "cowbell", name: "Cowbell" },
];

export const PAN_OPTIONS = [
  { id: "left", label: "Left" },
  { id: "center", label: "Centre" },
  { id: "right", label: "Right" },
];

export const DEFAULT_CLICK_SETTINGS = { clickTone: "classic", pan: "center" };

export const LANGUAGES = [
  { id: "English", label: "English" },
  { id: "Tamil", label: "தமிழ்" },
];
