// Run with: npm test   — checks that real chords are recognised and ordinary words / numbers are never turned into chords.
import assert from "node:assert/strict";
import { autoBracketNumbers, chordToNumberToken, chordsTaggedToNumbersTagged, isChordSymbol, isValidNashvilleToken, numbersTaggedToChordsTagged, tokenToChord } from "../src/lib/chords.js";

const words = ["Drop", "Drum", "Drums", "End", "Fade", "Fill", "Bass", "Big", "Cue", "Gap", "Crash", "Dad", "Add", "Aug", "Dim", "Edge", "Fast", "Good", "Guitar", "Choir", "Break", "Build", "Ending", "All", "And", "Cut", "Bridge", "Chorus", "Verse", "Keys", "Dom", "Bar", "Beat", "Bell", "Ride", "Acoustic", "1st", "2nd", "3rd", "4th", "2x", "3x", "4ever", "7up"];
for (const w of words) assert.ok(!isChordSymbol(w) && !isValidNashvilleToken(w), `"${w}" must stay a word`);

const chords = ["C", "A", "Am", "Em", "F#m7", "Bb", "Eb", "G/B", "D/F#", "Dsus4", "Cadd9", "Em7b5", "Abmaj7", "E7#9", "Cmaj7", "C6", "Cdim7", "Caug", "C+", "Gm/Bb", "Bm7(b5)", "bA", "Cmajor"];
for (const c of chords) assert.ok(isChordSymbol(c), `"${c}" must be a chord`);

const numbers = ["1", "6m", "b7", "#4", "5/7", "1/3", "37", "49", "7dim", "6M", "6maj", "1add9", "4sus2", "2m7", "1sus4", "6m7", "1M7", "4maj7", "13"];
for (const n of numbers) assert.ok(isValidNashvilleToken(n), `"${n}" must be a number chord`);

// conversions never touch a word
assert.equal(chordToNumberToken("Drop", "C", "Major"), "Drop");
assert.equal(chordToNumberToken("Guitar solo", "C", "Major"), "Guitar solo");
assert.equal(chordToNumberToken("D", "C", "Major"), "2");
assert.equal(chordsTaggedToNumbersTagged("[Drop] [D] [Fill]", "C", "Major"), "[Drop] [2] [Fill]");
assert.equal(autoBracketNumbers("1 4 1st 2x Drop"), "[1] [4] 1st 2x Drop");
assert.equal(numbersTaggedToChordsTagged("[1st] [2x] [4]", "C", "Major"), "[1st] [2x] [F]");
assert.equal(tokenToChord("1st", "C", "Major"), "1st");
console.log("chords: all checks passed");
