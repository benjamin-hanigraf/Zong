// Joystick chord piano (Chords mode): right stick = scale degree 1-7, left stick = chord quality, key selector below.
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FONT } from "../lib/constants.js";
import { ALL_KEYS, chordToPadSpec, flatify, tokenToChord } from "../lib/chords.js";

// Right stick: centre = 1, wedges clockwise from the top = 2 3 4 5 6 7.
const DEGREE_WEDGES = ["2", "3", "4", "5", "6", "7"];
// Left stick: centre = M (major), wedges clockwise from the top.
const QUALITY_WEDGES = ["m", "7", "aug", "dim", "#", "b"];
const CENTRE_RATIO = 0.3;        // centre circle radius as a share of the stick radius
const KNOB_TRAVEL = 0.62;        // how far the knob may move (share of the stick radius)

// Springy stick. onChange(sel | null): sel = { centre: true } or { wedge: 0-5 }; null when the finger is lifted.
function Stick({ size, wedges, centreLabel, onChange, C }) {
  const ref = useRef(null);
  const [knob, setKnob] = useState({ x: 0, y: 0, down: false });
  const [active, setActive] = useState(null);   // "c" | wedge index | null
  const activeRef = useRef(null);
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
      sel = { wedge: Math.round((((deg + 90) % 360) + 360) % 360 / 60) % 6 };   // 0 = top
    }
    const key = sel.centre ? "c" : sel.wedge;
    if (activeRef.current !== key) { activeRef.current = key; setActive(key); onChange(sel); }
  };
  const release = () => {
    setKnob({ x: 0, y: 0, down: false });
    if (activeRef.current !== null) { activeRef.current = null; setActive(null); onChange(null); }
  };
  // Annular wedge path (viewBox -100..100).
  const wedgePath = (i) => {
    const a0 = ((i * 60 - 90 - 30) * Math.PI) / 180, a1 = ((i * 60 - 90 + 30) * Math.PI) / 180;
    const r0 = CENTRE_RATIO * 100, r1 = 100;
    const p = (r, a) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
    return `M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 0 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 0 0 ${p(r0, a0)} Z`;
  };
  return (
    <div
      ref={ref}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pick(e); }}
      onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e); }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(e) => e.preventDefault()}
      style={{ width: size, height: size, position: "relative", touchAction: "none", userSelect: "none", WebkitUserSelect: "none", flexShrink: 0 }}
    >
      <svg viewBox="-100 -100 200 200" width={size} height={size} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <circle r="100" fill={C.surface2} stroke={C.borderStrong} strokeWidth="1.5" />
        {wedges.map((label, i) => {
          const a = ((i * 60 - 90) * Math.PI) / 180;
          return (
            <g key={label}>
              <path d={wedgePath(i)} fill={active === i ? C.accentSoft : "transparent"} stroke={C.border} strokeWidth="1" />
              <text x={(66 * Math.cos(a)).toFixed(1)} y={(66 * Math.sin(a)).toFixed(1)} textAnchor="middle" dominantBaseline="central" fontFamily={FONT} fontWeight="700" fontSize="17" fill={active === i ? C.accent : C.textMuted}>{label}</text>
            </g>
          );
        })}
        <circle r={CENTRE_RATIO * 100} fill={active === "c" ? C.accentSoft : C.surface3} stroke={C.border} strokeWidth="1" />
        <text textAnchor="middle" dominantBaseline="central" fontFamily={FONT} fontWeight="800" fontSize="22" fill={active === "c" ? C.accent : C.text}>{centreLabel}</text>
      </svg>
      {/* the knob follows the thumb and springs back to the middle on release */}
      <div aria-hidden="true" style={{
        position: "absolute", left: R - 17, top: R - 17, width: 34, height: 34, borderRadius: "50%", pointerEvents: "none",
        background: knob.down ? C.accent : C.surface3, border: `2px solid ${C.accent}`, boxShadow: knob.down ? `0 0 14px ${C.accentDim}` : "none",
        transform: `translate(${knob.x}px, ${knob.y}px)`,
        transition: knob.down ? "background 80ms linear" : "transform 380ms cubic-bezier(0.34, 1.7, 0.5, 1), background 160ms ease, box-shadow 160ms ease",
      }} />
    </div>
  );
}

export function ChordJoystick({ C, playPad, stopPad }) {
  const [keyIdx, setKeyIdx] = useState(0);
  const [keyQuality, setKeyQuality] = useState("Major");
  const [degree, setDegree] = useState(null);     // 1-7 while the right stick is held, else null
  const [quality, setQuality] = useState("auto"); // left stick: auto (nothing held) | M m 7 aug dim # b
  const [lastChord, setLastChord] = useState("");
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

  // The chord for the current key / degree / quality, using the same Nashville rules as the Chords view:
  // with the left stick untouched it is the key's natural chord (2 = Dm in C), the "M" centre forces a major chord.
  const chordName = degree === null ? null : (() => {
    const acc = quality === "#" ? "#" : quality === "b" ? "b" : "";
    const suffix = ["M", "m", "7", "aug", "dim"].includes(quality) ? quality : "";
    return tokenToChord(`${acc}${degree}${suffix}`, ALL_KEYS[keyIdx], keyQuality);
  })();

  useEffect(() => {
    if (voiceRef.current) { stopPad(voiceRef.current); voiceRef.current = null; }
    if (!chordName) return undefined;
    const spec = chordToPadSpec(chordName);
    if (spec) { voiceRef.current = playPad(spec); setLastChord(chordName); }
    return undefined;
  }, [chordName]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (voiceRef.current) { stopPad(voiceRef.current); voiceRef.current = null; } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stepKey = (d) => setKeyIdx((i) => (i + d + 12) % 12);
  // Two sticks plus the key selector (about 250px) must fit side by side, and the sticks must fit the height.
  const stick = Math.max(100, Math.min(box.h - 16, (box.w - 250 - 42) / 2, 300));
  const small = { width: 40, height: 40, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, background: C.surface2, color: C.text, display: "flex", alignItems: "center", justifyContent: "center" };
  return (
    <div ref={boxRef} style={{ flex: 1, position: "relative", overflow: "hidden", touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}>
      {/* chord being played */}
      <div style={{ position: "absolute", top: 6, left: 0, right: 0, textAlign: "center", fontFamily: FONT, fontSize: Math.min(64, box.h * 0.2), fontWeight: 800, lineHeight: 1.1, color: degree !== null ? C.accent : C.textFaint, pointerEvents: "none", transition: "color 120ms ease" }}>
        {lastChord ? flatify(lastChord) : "—"}
      </div>
      {/* left: quality, right: degree */}
      <div style={{ position: "absolute", left: 14, bottom: 12 }}>
        <Stick size={stick} wedges={QUALITY_WEDGES} centreLabel="M" C={C} onChange={(sel) => setQuality(!sel ? "auto" : sel.centre ? "M" : QUALITY_WEDGES[sel.wedge])} />
      </div>
      <div style={{ position: "absolute", right: 14, bottom: 12 }}>
        <Stick size={stick} wedges={DEGREE_WEDGES} centreLabel="1" C={C} onChange={(sel) => setDegree(!sel ? null : sel.centre ? 1 : Number(DEGREE_WEDGES[sel.wedge]))} />
      </div>
      {/* key selector */}
      <div style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={() => stepKey(-1)} aria-label="Previous key" style={small}><ChevronLeft size={18} /></button>
        <div style={{ minWidth: 56, textAlign: "center", fontFamily: FONT, fontSize: 24, fontWeight: 800 }}>{flatify(ALL_KEYS[keyIdx])}{keyQuality === "Minor" ? "m" : ""}</div>
        <button onClick={() => stepKey(1)} aria-label="Next key" style={small}><ChevronRight size={18} /></button>
        <button onClick={() => setKeyQuality((q) => (q === "Major" ? "Minor" : "Major"))} aria-label="Major or minor key" style={{ ...small, width: "auto", padding: "0 12px", borderRadius: 20, fontFamily: FONT, fontSize: 13, fontWeight: 700, color: keyQuality === "Minor" ? C.accent : C.text, background: keyQuality === "Minor" ? C.accentSoft : C.surface2 }}>{keyQuality === "Minor" ? "Minor" : "Major"}</button>
      </div>
    </div>
  );
}
