const KEY_TO_SEMITONE = {
  C: 0, "B#": 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4,
  F: 5, "E#": 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10,
  Bb: 10, B: 11, Cb: 11,
};
const NASHVILLE = ["1", "1#", "2", "2#", "3", "4", "4#", "5", "5#", "6", "6#", "7"];
function toNashville(symbol, currentKey) {
  if (!symbol) return symbol;
  const CHORD_ROOT_RE = /^([A-G])([#b]?)/;
  const baseSemi = KEY_TO_SEMITONE[currentKey] || 0;
  const convertOne = (part) => {
    const m = part.match(CHORD_ROOT_RE);
    if (!m) return part;
    const root = m[1] + m[2];
    const rest = part.slice(m[0].length);
    const semitone = KEY_TO_SEMITONE[root];
    if (semitone === undefined) return part;
    const diff = (semitone - baseSemi + 12) % 12;
    return NASHVILLE[diff] + rest;
  };
  return symbol.split("/").map(convertOne).join("/");
}

console.log(toNashville("C#m7/G#", "A")); // A is 9. C# is 1. diff = (1 - 9 + 12)%12 = 4 -> 3
// A=1, B=2, C#=3, D=4, E=5, F#=6, G#=7.
// In A: C# is 3, G# is 7. Output should be 3m7/7.
