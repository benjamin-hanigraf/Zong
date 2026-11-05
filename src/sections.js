/* =========================================================================
   Shared song sections.

   A song keeps four notes texts (lyrics, chords, chart, drums). Each is split into sections by
   header lines that start with "-" ("-Verse", "-Chorus", …). Stage Mode jumps every device to the
   same section, so all four texts must carry the same sections in the same order — only the lines
   inside a section differ. These helpers keep them in step:

     tidySections(texts)                      fill in any header another text has but this one lacks
     reconcileAfterEdit(base, texts, edited)  carry an add / rename / delete made in one text to the others

   Pure functions over { lyrics, chords, chart, drums } objects of plain editor text; no React here.
   ========================================================================= */

export const SECTION_TEXT_KEYS = ["lyrics", "chords", "chart", "drums"];
export const SECTION_TEXT_NAMES = { lyrics: "Lyrics", chords: "Chords", chart: "Chart", drums: "Drums" };

// Case, spacing and brackets are ignored when matching ("Verse [1]" — written by an older version that bracketed the number — is "Verse 1").
export const normLabel = (label) => String(label || "").toLowerCase().replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
const isHeader = (line) => line.trimStart().startsWith("-");
const labelOf = (line) => line.trimStart().slice(1).trim();

// "a\n-Verse\nx\n-Chorus\ny" -> { pre: ["a"], sections: [{ head, label, norm, body: ["x"] }, …] }
function parse(text) {
  const lines = String(text || "").split("\n");
  const pre = [];
  const sections = [];
  let cur = null;
  lines.forEach((line) => {
    if (isHeader(line)) {
      cur = { head: line, label: labelOf(line), norm: normLabel(labelOf(line)), body: [] };
      sections.push(cur);
    } else if (cur) cur.body.push(line);
    else pre.push(line);
  });
  // A blank text (or only blank lines before the first header) has no preamble worth keeping.
  return { pre: pre.every((l) => l.trim() === "") ? [] : pre, sections };
}
const serialize = ({ pre, sections }) => [...pre, ...sections.flatMap((s) => [s.head, ...s.body])].join("\n");

// Sections that take part in syncing: a header with a label, keyed by label + occurrence ("chorus#2").
function keyed(parsed) {
  const seen = {};
  return parsed.sections.map((s) => {
    if (!s.norm) return null;
    seen[s.norm] = (seen[s.norm] || 0) + 1;
    return { section: s, key: `${s.norm}#${seen[s.norm]}` };
  }).filter(Boolean);
}
const hasContent = (section) => section.body.some((l) => l.trim() !== "");

// Inserts `head` as a new empty section right after the section keyed `afterKey` (or before the
// first section when there is none) — returns the same parsed object.
function insertSection(parsed, head, afterKey) {
  const entry = { head, label: labelOf(head), norm: normLabel(labelOf(head)), body: [] };
  const list = keyed(parsed);
  const prev = afterKey ? list.find((k) => k.key === afterKey) : null;
  if (prev) {
    // Blank lines at the end of the previous section's body stay with it; the new header goes after them.
    parsed.sections.splice(parsed.sections.indexOf(prev.section) + 1, 0, entry);
  } else {
    parsed.sections.unshift(entry);
  }
  return parsed;
}

/** Fills in sections that other texts have and this one is missing, in a shared order. */
export function tidySections(texts) {
  const parsed = {};
  SECTION_TEXT_KEYS.forEach((k) => { parsed[k] = parse(texts[k]); });

  // Shared order: lyrics first; sections only another text has are slotted in after their neighbour.
  const canon = []; // [{ norm, head }] with duplicates allowed (matched by occurrence below)
  const canonKeys = () => { const seen = {}; return canon.map((c) => { seen[c.norm] = (seen[c.norm] || 0) + 1; return `${c.norm}#${seen[c.norm]}`; }); };
  SECTION_TEXT_KEYS.forEach((k) => {
    let prevKey = null;
    keyed(parsed[k]).forEach(({ section, key }) => {
      const keys = canonKeys();
      if (!keys.includes(key)) {
        const at = prevKey ? keys.indexOf(prevKey) + 1 : 0;
        canon.splice(at, 0, { norm: section.norm, head: `-${section.label}` });
        prevKey = canonKeys()[at];
      } else {
        prevKey = key;
      }
    });
  });

  const out = { ...texts };
  let changed = false;
  SECTION_TEXT_KEYS.forEach((k) => {
    const have = new Set(keyed(parsed[k]).map((e) => e.key));
    const keys = canonKeys();
    let touched = false;
    keys.forEach((key, i) => {
      if (have.has(key)) return;
      insertSection(parsed[k], canon[i].head, i > 0 ? keys[i - 1] : null);
      have.add(key);
      touched = true;
    });
    if (touched) { out[k] = serialize(parsed[k]); changed = true; }
  });
  return { texts: out, changed };
}

// Longest-common-subsequence alignment of two label lists -> pairs of matching indexes.
function lcs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return pairs;
}

/**
 * `base` = the texts as they were after the last reconcile, `texts` = now, `edited` = the one text key
 * that was changed. Returns { texts } with the edit carried to the other texts, or { error } when a
 * section was deleted that another text still has notes in.
 */
export function reconcileAfterEdit(base, texts, edited) {
  const oldList = keyed(parse(base[edited]));
  const newParsed = parse(texts[edited]);
  const newList = keyed(newParsed);
  const pairs = lcs(oldList.map((e) => e.section.norm), newList.map((e) => e.section.norm));

  // Walk the gaps between matched sections: equal numbers removed/added in a gap are renames.
  const matched = pairs.map(([oi, ni]) => ({ oi, ni }));   // same label, same place
  const renames = [];   // { oi, ni }
  const removes = [];   // oi
  const adds = [];      // ni
  const anchors = [[-1, -1], ...pairs, [oldList.length, newList.length]];
  for (let a = 0; a < anchors.length - 1; a++) {
    const [oi, ni] = anchors[a];
    const [oj, nj] = anchors[a + 1];
    const gone = []; for (let x = oi + 1; x < oj; x++) gone.push(x);
    const fresh = []; for (let y = ni + 1; y < nj; y++) fresh.push(y);
    const pairUp = Math.min(gone.length, fresh.length);
    for (let p = 0; p < pairUp; p++) renames.push({ oi: gone[p], ni: fresh[p] });
    gone.slice(pairUp).forEach((x) => removes.push(x));
    fresh.slice(pairUp).forEach((y) => adds.push(y));
  }

  const others = SECTION_TEXT_KEYS.filter((k) => k !== edited);
  const parsedOthers = {};
  // Every section of the other texts is looked up ONCE, by its key in the old list, before anything is changed
  // (removing / renaming one duplicate shifts the keys of the rest).
  const lookup = {};
  others.forEach((k) => {
    parsedOthers[k] = parse(texts[k]);
    lookup[k] = new Map(keyed(parsedOthers[k]).map((e) => [e.key, e.section]));
  });

  // Deleting a section is only allowed when the other texts have nothing in it.
  const blockedBy = {};
  removes.forEach((oi) => {
    const label = oldList[oi].section.label;
    others.forEach((k) => {
      const hit = lookup[k].get(oldList[oi].key);
      if (hit && hasContent(hit)) { (blockedBy[label] ||= []).push(SECTION_TEXT_NAMES[k]); }
    });
  });
  const blockedLabels = Object.keys(blockedBy);
  if (blockedLabels.length) {
    const label = blockedLabels[0];
    return { error: { label, modes: blockedBy[label] } };
  }

  const out = { ...texts };
  others.forEach((k) => {
    const p = parsedOthers[k];
    const at = new Array(newList.length).fill(null);          // new-list index -> this text's section object
    matched.forEach(({ oi, ni }) => {
      const sec = lookup[k].get(oldList[oi].key) || null;
      at[ni] = sec;
      // Same section, written differently ("chorus" -> "Chorus"): the other texts take the new spelling too.
      const head = newList[ni].section.head;
      if (sec && oldList[oi].section.label !== newList[ni].section.label) { sec.head = head; sec.label = labelOf(head); }
    });
    renames.forEach(({ oi, ni }) => {
      const sec = lookup[k].get(oldList[oi].key);
      if (!sec) return;
      const head = newList[ni].section.head;
      sec.head = head; sec.label = labelOf(head); sec.norm = normLabel(labelOf(head));
      at[ni] = sec;
    });
    removes.forEach((oi) => {
      const sec = lookup[k].get(oldList[oi].key);
      if (sec) p.sections.splice(p.sections.indexOf(sec), 1);
    });
    adds.sort((x, y) => x - y).forEach((ni) => {
      let prev = null;
      for (let x = ni - 1; x >= 0 && !prev; x--) prev = at[x];
      const entry = { head: newList[ni].section.head, label: newList[ni].section.label, norm: newList[ni].section.norm, body: [] };
      p.sections.splice(prev ? p.sections.indexOf(prev) + 1 : 0, 0, entry);
      at[ni] = entry;
    });
    out[k] = serialize(p);
  });
  const tidy = tidySections(out);
  // What the edit did to the sections (by label), so the song's Structure can follow: renamed ones, and removed ones.
  const changes = {
    renames: [...renames, ...matched.filter(({ oi, ni }) => oldList[oi].section.label !== newList[ni].section.label)].map(({ oi, ni }) => ({ from: oldList[oi].section.label, to: newList[ni].section.label })),
    removes: removes.map((oi) => oldList[oi].section.label),
  };
  return { texts: tidy.texts, changes };
}

/** Section keys + labels of one text, in order (what Stage Mode jumps between). */
export function sectionList(text) {
  return keyed(parse(text)).map((e) => ({ key: e.key, label: e.section.label }));
}

/** Stable key for the n-th block of a rendered song (matches sectionList). */
export function sectionKeysForLabels(labels) {
  const seen = {};
  return labels.map((label) => {
    const n = normLabel(label);
    if (!n) return null;
    seen[n] = (seen[n] || 0) + 1;
    return `${n}#${seen[n]}`;
  });
}
