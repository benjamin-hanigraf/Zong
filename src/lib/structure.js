// Song structure: the order a song's sections are played in, with an optional MD (musical director) note on each step.
// Each section is written once in the song's texts; the structure is a list of { s: section label, n: MD note } rows that
// refer to those sections by label, so the same section (a chorus) can be played several times without being written again.
import { normLabel } from "../sections.js";

/** Accepts an array or the JSON string stored on the server; returns clean [{ s, n }] rows (empty when there is none). */
export function cleanStructure(raw) {
  let v = raw;
  if (typeof v === "string") {
    if (!v.trim()) return [];
    try { v = JSON.parse(v); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter((r) => r && typeof r.s === "string" && r.s.trim())
    .slice(0, 200)
    .map((r) => ({ s: r.s.trim().slice(0, 80), n: typeof r.n === "string" ? r.n.slice(0, 400) : "" }));
}

/** The compact text kept on the server ("" when there is no structure; rows without a note carry no "n"). */
export function structureToJson(rows) {
  const clean = cleanStructure(rows);
  return clean.length ? JSON.stringify(clean.map((r) => (r.n ? r : { s: r.s }))) : "";
}

/**
 * The steps to show / play: for each structure row the block of the section it names (matched by label, ignoring case and
 * spacing). `blocks` = parseTextIntoBlocks of the song's text. Returns null when there is no usable structure (the song is
 * then shown as written). Each step has a key that is unique to its place in the order, so a repeated chorus is a separate
 * stop for Stage Mode.
 */
export function playSteps(structure, blocks) {
  const rows = cleanStructure(structure);
  if (!rows.length) return null;
  const at = new Map();
  blocks.forEach((b, i) => {
    const n = normLabel(b.label);
    if (b.label != null && n && !at.has(n)) at.set(n, i);
  });
  const steps = [];
  rows.forEach((r, i) => {
    const n = normLabel(r.s);
    if (at.has(n)) steps.push({ key: `r${i}:${n}`, label: blocks[at.get(n)].label, note: r.n, blockIdx: at.get(n) });
  });
  return steps.length ? steps : null;
}

/** Carries a section rename / removal (from reconcileAfterEdit) over to the rows: renamed sections keep their rows, removed ones lose theirs. */
export function applySectionChanges(rows, changes, presentNorms) {
  if (!changes) return rows;
  const renamed = new Map(changes.renames.map(({ from, to }) => [normLabel(from), to]));
  const gone = new Set(changes.removes.map(normLabel));
  return rows.flatMap((r) => {
    const n = normLabel(r.s);
    if (renamed.has(n)) return [{ ...r, s: renamed.get(n) }];
    if (gone.has(n) && !presentNorms.has(n)) return [];
    return [r];
  });
}
