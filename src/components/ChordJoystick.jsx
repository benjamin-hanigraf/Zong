// Joystick chord piano (Chords mode): right stick = scale degree 1-7, left stick = chord quality, key selector below.
// readOnly (a follower in Stage Mode): shows the leader's key, sticks and chord, plays nothing.
import { useEffect, useRef, useState } from "react";
import { FONT } from "../lib/constants.js";
import { KEY_TO_SEMITONE, chordToPadSpec, flatify, tokenToChord, transposeKey } from "../lib/chords.js";
import { KeyStepper } from "./shared.jsx";

// Right stick: centre = 1, wedges clockwise from the top = 2 3 4 5 6 7.
const DEGREE_WEDGES = [2, 3, 4, 5, 6, 7].map((n) => ({ label: String(n), value: n }));
// Left stick: centre = M (major). Wedges clockwise from the top; the most used (7, m, ♭) sit at the bottom, easiest to reach.
const QUALITY_WEDGES = [
  { label: "sus4", value: "sus4" }, { label: "sus2", value: "sus2" }, { label: "maj7", value: "maj7" }, { label: "7", value: "7" },
  { label: "m", value: "m" }, { label: "♭", value: "b" }, { label: "♯", value: "#" }, { label: "add9", value: "add9" },
];
const CENTRE_RATIO = 0.3;        // centre circle radius as a share of the stick radius
const KNOB_TRAVEL = 0.62;        // how far the knob may move (share of the stick radius)

// Springy stick. onChange(sel | null): sel = { centre: true } or { wedge: n }; null when the finger is lifted.
// `mirror` (read-only): "c" | wedge index | null — the highlighted part, driven from outside.
function Stick({ size, wedges, centreLabel, onChange, mirror, C }) {
  const [knob, setKnob] = useState({ x: 0, y: 0, down: false });
  const [own, setOwn] = useState(null);   // "c" | wedge index | null
  const ownRef = useRef(null);
  const readOnly = mirror !== undefined;
  const active = readOnly ? mirror : own;
  const n = wedges.length;
  const step = 360 / n;
  const R = size / 2;
  const pick = (e) => {
    // offsetX / offsetY are measured in the stick's own (un-rotated) space, so this also works while the page is turned sideways.
    const dx = e.nativeEvent.offsetX - R;
    const dy = e.nativeEvent.offsetY - R;
    const dist = Math.hypot(dx, dy);
    const lim = R * KNOB_TRAVEL;
    const k = dist > lim ? lim / dist : 1;
    setKnob({ x: dx * k, y: dy * k, down: true });
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
    setKnob({ x: 0, y: 0, down: false });
    if (ownRef.current !== null) { ownRef.current = null; setOwn(null); onChange(null); }
  };
  // Knob position when mirroring someone else's stick.
  const mirrorKnob = (() => {
    if (!readOnly || active === null || active === undefined) return { x: 0, y: 0, down: false };
    if (active === "c") return { x: 0, y: 0, down: true };
    const a = ((active * step - 90) * Math.PI) / 180;
    return { x: Math.cos(a) * R * KNOB_TRAVEL, y: Math.sin(a) * R * KNOB_TRAVEL, down: true };
  })();
  const k = readOnly ? mirrorKnob : knob;
  // Annular wedge path (viewBox -100..100).
  const wedgePath = (i) => {
    const a0 = ((i * step - 90 - step / 2) * Math.PI) / 180, a1 = ((i * step - 90 + step / 2) * Math.PI) / 180;
    const r0 = CENTRE_RATIO * 100, r1 = 100;
    const p = (r, a) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
    return `M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 0 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 0 0 ${p(r0, a0)} Z`;
  };
  const fontSize = n > 6 ? 14 : 17;
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
              <text x={(68 * Math.cos(a)).toFixed(1)} y={(68 * Math.sin(a)).toFixed(1)} textAnchor="middle" dominantBaseline="central" fontFamily={FONT} fontWeight="700" fontSize={fontSize} fill={active === i ? C.accent : C.textMuted}>{w.label}</text>
            </g>
          );
        })}
        <circle r={CENTRE_RATIO * 100} fill={active === "c" ? C.accentSoft : C.surface3} stroke={C.border} strokeWidth="1" />
        <text textAnchor="middle" dominantBaseline="central" fontFamily={FONT} fontWeight="800" fontSize="22" fill={active === "c" ? C.accent : C.text}>{centreLabel}</text>
      </svg>
      {/* the knob follows the thumb and springs back to the middle on release */}
      <div aria-hidden="true" style={{
        position: "absolute", left: R - 17, top: R - 17, width: 34, height: 34, borderRadius: "50%", pointerEvents: "none",
        background: k.down ? C.accent : C.surface3, border: `2px solid ${C.accent}`, boxShadow: k.down ? `0 0 14px ${C.accentDim}` : "none",
        transform: `translate(${k.x}px, ${k.y}px)`,
        transition: k.down && !readOnly ? "background 80ms linear" : "transform 380ms cubic-bezier(0.34, 1.7, 0.5, 1), background 160ms ease, box-shadow 160ms ease",
      }} />
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

export function ChordJoystick({ C, playPad, stopPad, onState, readOnly = false, remote = null, loadKey = null }) {
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
  const [box, setBox] = useState({ w: 600, h: 300 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
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

  const stepKey = (d) => setKeyName((k) => transposeKey(k, d));
  // Two sticks plus the key selector (about 250px) must fit side by side, and the sticks must fit the height.
  const stick = Math.max(100, Math.min(box.h - 16, (box.w - 250 - 42) / 2, 300));
  const keyLabel = `${flatify(v.keyName)}${v.keyQuality === "Minor" ? "m" : ""}`;
  return (
    <div ref={boxRef} style={{ flex: 1, position: "relative", overflow: "hidden", touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}>
      {/* the chord being played (nothing when nothing is) */}
      <div style={{ position: "absolute", top: 6, left: 0, right: 0, textAlign: "center", fontFamily: FONT, fontSize: Math.min(64, box.h * 0.2), fontWeight: 800, lineHeight: 1.1, minHeight: Math.min(64, box.h * 0.2) * 1.1, color: C.accent, pointerEvents: "none" }}>
        {chordName ? flatify(chordName) : ""}
      </div>
      {/* left: quality, right: degree */}
      <div style={{ position: "absolute", left: 14, bottom: 12 }}>
        <Stick size={stick} wedges={QUALITY_WEDGES} centreLabel="M" C={C}
          mirror={readOnly ? qualityMirror(v.quality) : undefined}
          onChange={(sel) => setQuality(!sel ? "auto" : sel.centre ? "M" : QUALITY_WEDGES[sel.wedge].value)} />
      </div>
      <div style={{ position: "absolute", right: 14, bottom: 12 }}>
        <Stick size={stick} wedges={DEGREE_WEDGES} centreLabel="1" C={C}
          mirror={readOnly ? degreeMirror(v.degree) : undefined}
          onChange={(sel) => setDegree(!sel ? null : sel.centre ? 1 : DEGREE_WEDGES[sel.wedge].value)} />
      </div>
      {/* key selector (same element as the song view) with the scale toggle below it */}
      <div style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <KeyStepper label={keyLabel} onPrev={() => stepKey(-1)} onNext={() => stepKey(1)} disabled={readOnly} C={C} />
        </div>
        <button onClick={() => setKeyQuality((q) => (q === "Major" ? "Minor" : "Major"))} disabled={readOnly} aria-label="Major or minor key" style={{
          height: 28, padding: "0 14px", borderRadius: 8, fontFamily: FONT, fontSize: 12.5, fontWeight: 700,
          border: `1px solid ${v.keyQuality === "Minor" ? C.accentDim : C.border}`, background: v.keyQuality === "Minor" ? C.accentSoft : C.surface2,
          color: v.keyQuality === "Minor" ? C.accent : C.text, opacity: readOnly ? 0.6 : 1,
        }}>{v.keyQuality}</button>
      </div>
    </div>
  );
}
