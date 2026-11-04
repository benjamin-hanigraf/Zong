// Joystick chord piano (Chords mode): right stick = scale degree 1-7, left stick = chord quality, key selector below.
// readOnly (a follower in Stage Mode): shows the leader's key, sticks and chord, plays nothing.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FONT } from "../lib/constants.js";
import { KEY_TO_SEMITONE, chordToPadSpec, flatify, tokenToChord, transposeKey } from "../lib/chords.js";
import { KeyStepper, TabSelect } from "./shared.jsx";
import { hasOpenLayer, isTypingTarget } from "../lib/keys.js";

// Right stick: centre = 1, wedges clockwise from the top = 2 3 4 5 6 7.
const DEGREE_WEDGES = [2, 3, 4, 5, 6, 7].map((n) => ({ label: String(n), value: n }));
// Left stick: centre = M (major). Wedges clockwise from the top; the most used (7, m, ♭) sit at the bottom, easiest to reach.
const QUALITY_WEDGES = [
  { label: "sus4", value: "sus4" }, { label: "sus2", value: "sus2" }, { label: "maj7", value: "maj7" }, { label: "7", value: "7" },
  { label: "m", value: "m" }, { label: "♭", value: "b" }, { label: "♯", value: "#" }, { label: "add9", value: "add9" },
];
// Computer keyboard: 1-7 = the degree; S = the left stick's centre (M) and the keys around it are its wedges, in the same
// places: W sus4, E sus2, D maj7, C 7, X m, Z ♭, A ♯, Q add9. Keyed by physical key (e.code), so any layout works.
const QUALITY_KEYS = { KeyS: "M", KeyW: "sus4", KeyE: "sus2", KeyD: "maj7", KeyC: "7", KeyX: "m", KeyZ: "b", KeyA: "#", KeyQ: "add9" };
const CENTRE_RATIO = 0.4;        // centre circle radius as a share of the stick radius
const LABEL_SIZE = 15;           // every label on both sticks, centre included

// Stick. onChange(sel | null): sel = { centre: true } or { wedge: n }; null when the finger is lifted.
// `mirror` (read-only): "c" | wedge index | null — the highlighted part, driven from outside.
function Stick({ size, wedges, centreLabel, onChange, mirror, hl = null, C }) {
  const [own, setOwn] = useState(null);   // "c" | wedge index | null
  const ownRef = useRef(null);
  const readOnly = mirror !== undefined;
  const active = readOnly ? mirror : (own ?? hl);   // hl = what the computer keyboard is holding
  const n = wedges.length;
  const step = 360 / n;
  const R = size / 2;
  const pick = (e) => {
    // offsetX / offsetY are measured in the stick's own (un-rotated) space, so this also works while the page is turned sideways.
    const dx = e.nativeEvent.offsetX - R;
    const dy = e.nativeEvent.offsetY - R;
    const dist = Math.hypot(dx, dy);
    let sel;
    if (dist < R * CENTRE_RATIO) sel = { centre: true };
    else {
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI;            // clockwise from the right
      sel = { wedge: Math.round(((((deg + 90) % 360) + 360) % 360) / step) % n };   // 0 = top
    }
    const key = sel.centre ? "c" : sel.wedge;
    if (ownRef.current !== key) { ownRef.current = key; setOwn(key); onChange(sel); }
  };
  const release = () => {
    if (ownRef.current !== null) { ownRef.current = null; setOwn(null); onChange(null); }
  };
  // Annular wedge path (viewBox -100..100).
  const wedgePath = (i) => {
    const a0 = ((i * step - 90 - step / 2) * Math.PI) / 180, a1 = ((i * step - 90 + step / 2) * Math.PI) / 180;
    const r0 = CENTRE_RATIO * 100, r1 = 100;
    const p = (r, a) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
    return `M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 0 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 0 0 ${p(r0, a0)} Z`;
  };
  return (
    <div
      onPointerDown={readOnly ? undefined : (e) => { e.currentTarget.setPointerCapture(e.pointerId); pick(e); }}
      onPointerMove={readOnly ? undefined : (e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e); }}
      onPointerUp={readOnly ? undefined : release}
      onPointerCancel={readOnly ? undefined : release}
      onLostPointerCapture={readOnly ? undefined : release}
      onContextMenu={(e) => e.preventDefault()}
      style={{ width: size, height: size, position: "relative", touchAction: "none", userSelect: "none", WebkitUserSelect: "none", flexShrink: 0, pointerEvents: readOnly ? "none" : "auto" }}
    >
      <svg viewBox="-100 -100 200 200" width={size} height={size} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <circle r="100" fill={C.surface2} stroke={C.borderStrong} strokeWidth="1.5" />
        {wedges.map((w, i) => {
          const a = ((i * step - 90) * Math.PI) / 180;
          return (
            <g key={w.label}>
              <path d={wedgePath(i)} fill={active === i ? C.accentSoft : "transparent"} stroke={C.border} strokeWidth="1" />
              <text x={(71 * Math.cos(a)).toFixed(1)} y={(71 * Math.sin(a)).toFixed(1)} textAnchor="middle" dominantBaseline="central" fontFamily={FONT} fontWeight="700" fontSize={LABEL_SIZE} fill={active === i ? C.accent : C.textMuted}>{w.label}</text>
            </g>
          );
        })}
        <circle r={CENTRE_RATIO * 100} fill={active === "c" ? C.accentSoft : C.surface3} stroke={C.border} strokeWidth="1" />
        <text textAnchor="middle" dominantBaseline="central" fontFamily={FONT} fontWeight="700" fontSize={LABEL_SIZE} fill={active === "c" ? C.accent : C.text}>{centreLabel}</text>
      </svg>
    </div>
  );
}

// Which wedge / centre a state value corresponds to (for mirroring a leader's sticks).
const degreeMirror = (degree) => (degree == null ? null : degree === 1 ? "c" : degree - 2);
const qualityMirror = (quality) => (quality === "auto" || quality == null ? null : quality === "M" ? "c" : QUALITY_WEDGES.findIndex((w) => w.value === quality));

// The chord for a key / degree / quality, using the same Nashville rules as the Chords view: with the left stick untouched
// it is the key's natural chord (2 = Dm in C); the "M" centre forces a major chord; ♯ / ♭ move the root a semitone.
export function joystickChord(keyName, keyQuality, degree, quality) {
  if (degree == null) return null;
  const acc = quality === "#" ? "#" : quality === "b" ? "b" : "";
  const suffix = ["M", "m", "7", "maj7", "sus2", "sus4", "add9"].includes(quality) ? quality : "";
  return tokenToChord(`${acc}${degree}${suffix}`, keyName, keyQuality);
}

export function ChordJoystick({ C: theme, playPad, stopPad, onState, readOnly = false, remote = null, loadKey = null }) {
  // This page's fills are one step darker than the app's usual surfaces (wheels, key selector, scale switch).
  const C = { ...theme, surface2: theme.surface, surface3: theme.surface2 };
  const [keyName, setKeyName] = useState("C");   // spelled as the song has it (Bb stays Bb); stepping uses the same names as the song view
  const [keyQuality, setKeyQuality] = useState("Major");
  const [degree, setDegree] = useState(null);     // 1-7 while the right stick is held, else null
  const [quality, setQuality] = useState("auto"); // left stick: auto (nothing held) | M m 7 maj7 sus2 sus4 add9 # b
  // A song swiped into the piano sets the key and scale.
  const loadNonce = useRef(null);
  useEffect(() => {
    if (!loadKey || loadNonce.current === loadKey.nonce) return;
    loadNonce.current = loadKey.nonce;
    if (KEY_TO_SEMITONE[loadKey.key] != null) setKeyName(loadKey.key);
    setKeyQuality(loadKey.quality === "Minor" ? "Minor" : "Major");
  }, [loadKey]);
  const voiceRef = useRef(null);
  const boxRef = useRef(null);
  const [box, setBox] = useState(null);   // measured before the first paint, so the sticks never flash at a guessed size
  const measureBox = () => {
    const el = boxRef.current;
    if (!el) return;
    const w = el.clientWidth, h = el.clientHeight;
    setBox((b) => (b && b.w === w && b.h === h ? b : { w, h }));
  };
  useLayoutEffect(measureBox);   // after every render too: the page around us may have just changed size
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(measureBox);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // What is shown: the leader's state when read-only, otherwise our own.
  const v = readOnly && remote ? remote : { keyName, keyQuality, degree, quality, chord: joystickChord(keyName, keyQuality, degree, quality) };
  const chordName = v.chord || null;

  // Own chord: play it while the right stick is held; a change of chord / key restarts it.
  useEffect(() => {
    if (readOnly) return undefined;
    if (voiceRef.current) { stopPad(voiceRef.current); voiceRef.current = null; }
    if (!chordName) return undefined;
    const spec = chordToPadSpec(chordName);
    if (spec) voiceRef.current = playPad(spec);
    return undefined;
  }, [chordName, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (voiceRef.current) { stopPad(voiceRef.current); voiceRef.current = null; } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Tell Stage Mode followers what is happening (key, sticks, chord).
  // Kept tiny (a few bytes: key, scale, degree, quality — the chord is worked out again on the other side) and at most
  // ~8 messages a second, however fast the thumb sweeps across the wedges.
  const stateRef = useRef(onState);
  stateRef.current = onState;
  const sentAt = useRef(0);
  const pending = useRef(null);
  useEffect(() => {
    if (readOnly) return undefined;
    const msg = { o: 1, k: keyName, m: keyQuality === "Minor" ? 1 : 0, d: degree, q: quality };
    const send = () => { pending.current = null; sentAt.current = Date.now(); stateRef.current?.(msg); };
    const wait = 125 - (Date.now() - sentAt.current);
    if (pending.current) clearTimeout(pending.current);
    if (wait <= 0) send(); else pending.current = setTimeout(send, wait);
    return undefined;
  }, [keyName, keyQuality, degree, quality, readOnly]);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); if (!readOnly) stateRef.current?.({ o: 0 }); }, [readOnly]);

  // Computer keyboard (see QUALITY_KEYS). Held keys are tracked in press order; the most recent one still held wins.
  useEffect(() => {
    if (readOnly) return undefined;
    let degrees = [];
    let qualities = [];
    const apply = () => {
      setDegree(degrees.length ? degrees[degrees.length - 1] : null);
      setQuality(qualities.length ? QUALITY_KEYS[qualities[qualities.length - 1]] : "auto");
    };
    const degreeOf = (e) => { const m = /^(?:Digit|Numpad)([1-7])$/.exec(e.code); return m ? Number(m[1]) : null; };
    const onDown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || isTypingTarget(e.target) || hasOpenLayer()) return;
      const d = degreeOf(e);
      const isQ = e.code in QUALITY_KEYS;
      if (d == null && !isQ) return;
      e.preventDefault();
      if (e.repeat) return;
      if (d != null) degrees = [...degrees.filter((x) => x !== d), d];
      else qualities = [...qualities.filter((x) => x !== e.code), e.code];
      apply();
    };
    const onUp = (e) => {
      const d = degreeOf(e);
      if (d != null) degrees = degrees.filter((x) => x !== d);
      else if (e.code in QUALITY_KEYS) qualities = qualities.filter((x) => x !== e.code);
      else return;
      apply();
    };
    const releaseAll = () => { if (degrees.length || qualities.length) { degrees = []; qualities = []; apply(); } };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", releaseAll);
    return () => { window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); window.removeEventListener("blur", releaseAll); };
  }, [readOnly]);

  const stepKey = (d) => setKeyName((k) => transposeKey(k, d));
  // Laid out for a phone held sideways. On a bigger screen (Mac / PC) everything is scaled up by the same factor (sticks, key
  // selector, chord name), so it keeps the same proportions as on the iPhone instead of looking small in a large window.
  if (!box) return <div ref={boxRef} style={{ flex: 1, position: "relative", overflow: "hidden" }} />;
  const scale = Math.max(1, Math.min(box.w / 760, box.h / 380, 2.4));
  const bw = box.w / scale, bh = box.h / scale;
  // Two sticks plus the key selector (about 250px) must fit side by side, and the sticks must fit the height.
  const stick = Math.max(100, Math.min(bh - 16, (bw - 190 - 42) / 2, 300)) * scale;
  const keyLabel = `${flatify(v.keyName)}${v.keyQuality === "Minor" ? "m" : ""}`;
  return (
    <div ref={boxRef} style={{ flex: 1, position: "relative", overflow: "hidden", touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}>
      {/* the chord being played (nothing when nothing is) */}
      <div style={{ position: "absolute", top: 6 * scale, left: 0, right: 0, textAlign: "center", fontFamily: FONT, fontSize: Math.min(64, bh * 0.2) * scale, fontWeight: 800, lineHeight: 1.1, minHeight: Math.min(64, bh * 0.2) * scale * 1.1, color: C.accent, pointerEvents: "none" }}>
        {chordName ? flatify(chordName) : ""}
      </div>
      {/* left: quality, right: degree */}
      <div style={{ position: "absolute", left: 14 * scale, bottom: 12 * scale }}>
        <Stick size={stick} wedges={QUALITY_WEDGES} centreLabel="M" C={C}
          mirror={readOnly ? qualityMirror(v.quality) : undefined} hl={qualityMirror(quality)}
          onChange={(sel) => setQuality(!sel ? "auto" : sel.centre ? "M" : QUALITY_WEDGES[sel.wedge].value)} />
      </div>
      <div style={{ position: "absolute", right: 14 * scale, bottom: 12 * scale }}>
        <Stick size={stick} wedges={DEGREE_WEDGES} centreLabel="1" C={C}
          mirror={readOnly ? degreeMirror(v.degree) : undefined} hl={degreeMirror(degree)}
          onChange={(sel) => setDegree(!sel ? null : sel.centre ? 1 : DEGREE_WEDGES[sel.wedge].value)} />
      </div>
      {/* key selector (same element as the song view, a little bigger) with the scale switch below it, same width */}
      <div style={{ position: "absolute", bottom: 12 * scale, left: "50%", transform: `translateX(-50%) scale(${scale})`, transformOrigin: "50% 100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <KeyStepper label={keyLabel} onPrev={() => stepKey(-1)} onNext={() => stepKey(1)} disabled={readOnly} large C={C} />
        </div>
        <div style={{ width: 144, opacity: readOnly ? 0.6 : 1, pointerEvents: readOnly ? "none" : "auto" }}>
          <TabSelect options={[{ id: "Major", label: "Major" }, { id: "Minor", label: "Minor" }]} value={v.keyQuality} onChange={setKeyQuality} buttonPadding="8px 0" C={C} />
        </div>
      </div>
    </div>
  );
}
