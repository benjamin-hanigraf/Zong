// Small string / time-signature / key helpers.
import { flatify } from "./chords.js";

/* =========================================================================
   Small helpers
   ========================================================================= */
export const uid = () => "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

export function toTitleCase(str) {
  return String(str || "").replace(/(^|[\s.\-_/])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

export function parseTimeSig(str) {
  const m = String(str || "").match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return { beats: 4, unit: 4 };
  return { beats: parseInt(m[1], 10), unit: parseInt(m[2], 10) };
}

export const formatTimeSig = (ts) => `${ts.beats}/${ts.unit}`;

export const keyLabel = (song) => {
  if (!song.key || song.key === "") return "–";
  return flatify(`${song.key}${song.keyQuality === "Minor" ? "m" : ""}`);
};

export function decomposeKey(keyStr) {
  if (!keyStr) return { natural: "", accidental: "natural" };
  const natural = keyStr[0];
  const suffix = keyStr.slice(1);
  const accidental = suffix === "b" ? "flat" : suffix === "#" ? "sharp" : "natural";
  return { natural, accidental };
}

export const composeKey = (natural, accidental) => natural ? natural + (accidental === "flat" ? "b" : accidental === "sharp" ? "#" : "") : "";
