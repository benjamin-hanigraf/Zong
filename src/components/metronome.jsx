// Metronome controls: knob, beat-dot control, subdivision icon, hold-to-repeat.
import { ChevronLeft, ChevronRight, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useKeys } from "../lib/keys.js";
import { FONT } from "../lib/constants.js";
import { useFlashBeat, usePlaying } from "../lib/metronomeEngine.js";
import { defaultAccents } from "../lib/songDevice.js";

export function PlayStopGlyph({ size, color, stopColor = color, playNudge = 0 }) {
  const playing = usePlaying();
  return playing
    ? <Square size={size * 0.93} color={stopColor} fill={stopColor} />
    : <Play size={size} color={color} fill={color} style={{ marginLeft: playNudge }} />;
}

const DEG_PER_BPM = 6;

const KNOB_TOUCH_PAD = 28;

export function Knob({ value, min = 30, max = 300, onChange, size = 220, onToggle, C }) {
  const knobRef = useRef(null);
  const rectRef = useRef(null);
  const lastAngleRef = useRef(0);
  const downPosRef = useRef({ x: 0, y: 0 });
  const runningValueRef = useRef(value);
  const [spin, setSpin] = useState(0);
  const [dragging, setDragging] = useState(false);

  const angleFromPointer = (clientX, clientY) => {
    const rect = rectRef.current;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx; const dy = clientY - cy;
    return Math.atan2(dx, -dy) * (180 / Math.PI);
  };
  const handlePointerDown = (e) => {
    rectRef.current = knobRef.current.getBoundingClientRect();
    lastAngleRef.current = angleFromPointer(e.clientX, e.clientY);
    downPosRef.current = { x: e.clientX, y: e.clientY };
    runningValueRef.current = value;
    knobRef.current.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const handlePointerMove = (e) => {
    if (!dragging) return;
    const current = angleFromPointer(e.clientX, e.clientY);
    let delta = current - lastAngleRef.current;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    lastAngleRef.current = current;
    setSpin((s) => (s + delta) % 360);
    runningValueRef.current = Math.min(max, Math.max(min, runningValueRef.current + delta / DEG_PER_BPM));
    onChange(runningValueRef.current);
  };
  const handlePointerUp = (e) => {
    setDragging(false);
    try { knobRef.current.releasePointerCapture(e.pointerId); } catch { }
    const moved = Math.hypot(e.clientX - downPosRef.current.x, e.clientY - downPosRef.current.y);
    if (moved < 6 && rectRef.current) {
      const centerX = rectRef.current.left + rectRef.current.width / 2;
      const step = e.clientX < centerX ? -1 : 1;
      onChange(Math.min(max, Math.max(min, value + step)));
    }
  };
  const ticks = Array.from({ length: 40 });
  return (
    <div ref={knobRef} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
      style={{ width: size + KNOB_TOUCH_PAD * 2, height: size + KNOB_TOUCH_PAD * 2, margin: -KNOB_TOUCH_PAD, position: "relative", touchAction: "none", userSelect: "none", cursor: "grab" }}>
      <div style={{
        position: "absolute", inset: KNOB_TOUCH_PAD, borderRadius: "50%",
        background: `radial-gradient(circle at 50% 38%, ${C.surface3}, ${C.surface2} 70%)`,
        boxShadow: `inset 0 2px 6px rgba(0,0,0,0.6), inset 0 -1px 0 rgba(255,255,255,0.04), 0 8px 24px rgba(0,0,0,0.5)`,
        border: `1px solid ${C.border}`, pointerEvents: "none",
      }}>
        <div style={{ position: "absolute", inset: 0, transform: `rotate(${spin}deg)` }}>
          <svg width={size} height={size} style={{ position: "absolute", inset: 0 }}>
            {ticks.map((_, i) => {
              const t = (i / ticks.length) * 360;
              const rad = (t * Math.PI) / 180;
              const r1 = size / 2 - 13; const r2 = size / 2 - 7;
              const cx = size / 2, cy = size / 2;
              const x1 = cx + r1 * Math.sin(rad), y1 = cy - r1 * Math.cos(rad);
              const x2 = cx + r2 * Math.sin(rad), y2 = cy - r2 * Math.cos(rad);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.border} strokeWidth={1.5} strokeLinecap="round" />;
            })}
          </svg>
          <div style={{ position: "absolute", top: "50%", left: "50%", width: 4, height: size * 0.32, background: C.accent, borderRadius: 2, transformOrigin: "top center", transform: "translate(-50%, 0)", boxShadow: `0 0 6px ${C.accent}99` }} />
        </div>
        <div style={{ position: "absolute", inset: size * 0.14, borderRadius: "50%", background: `linear-gradient(180deg, ${C.surface2}, #0A0A0A)`, border: `1px solid ${C.border}`, pointerEvents: "none" }}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "38%", display: "flex", alignItems: "center", justifyContent: "flex-start", paddingLeft: size * 0.09 }}>
            <ChevronLeft size={size * 0.1} color={C.textFaint} />
          </div>
          <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "38%", display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: size * 0.09 }}>
            <ChevronRight size={size * 0.1} color={C.textFaint} />
          </div>
          <button onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onToggle(); }} style={{
            position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            width: size * 0.34, height: size * 0.34, borderRadius: "50%", border: "none", background: "transparent", pointerEvents: "auto",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <PlayStopGlyph size={size * 0.14} color="#fff" playNudge={size * 0.015} />
          </button>
        </div>
      </div>
    </div>
  );
}

function dotColor(state, lit, C) {
  if (state === "mute") return "transparent";
  if (state === "accent") return lit ? C.accent : C.accentDim;
  return lit ? "#fff" : C.surface3;
}

export function BeatAccentControl({ count, accents, onChange, size = 9, openUpwardOnly, muted = false, onToggleMuted, C }) {
  const flashBeat = useFlashBeat();
  const [open, setOpen] = useState(false);
  useKeys({ escape: () => setOpen(false) }, open);
  const [openUpward, setOpenUpward] = useState(false);
  const [hAlign, setHAlign] = useState("center"); // "center" | "left" | "right" — keeps the popup on-screen horizontally
  const btnRef = useRef(null);
  const POPUP_HEIGHT = 76;
  const POPUP_WIDTH = 220;
  const pattern = accents && accents.length === count ? accents : defaultAccents(count);
  const cycleBeat = (i) => {
    const order = ["normal", "accent", "mute"];
    const next = order[(order.indexOf(pattern[i] || "normal") + 1) % order.length];
    const nextPattern = pattern.slice();
    nextPattern[i] = next;
    onChange(nextPattern);
  };
  // Long-press toggles mute mode; a normal tap opens the pattern editor (also while muted).
  const pressTimer = useRef(null);
  const longPressed = useRef(false);
  const pressOrigin = useRef({ x: 0, y: 0 });
  const clearPress = () => { clearTimeout(pressTimer.current); pressTimer.current = null; };
  useEffect(() => clearPress, []);
  const handleOpen = () => {
    if (longPressed.current) { longPressed.current = false; return; }
    if (openUpwardOnly) {
      setOpenUpward(true);
    } else if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setOpenUpward(spaceBelow < POPUP_HEIGHT + 12 && spaceAbove > spaceBelow);
      const centerX = rect.left + rect.width / 2;
      if (centerX - POPUP_WIDTH / 2 < 8) setHAlign("left");
      else if (centerX + POPUP_WIDTH / 2 > window.innerWidth - 8) setHAlign("right");
      else setHAlign("center");
    }
    setOpen(true);
  };
  const hAlignStyle = hAlign === "left" ? { left: 0 } : hAlign === "right" ? { right: 0 } : { left: "50%", transform: "translateX(-50%)" };
  return (
    <div style={{ position: "relative", zIndex: 2 }} ref={btnRef}>
      <button
        onClick={handleOpen}
        onPointerDown={(e) => {
          if (!onToggleMuted) return;
          longPressed.current = false;
          pressOrigin.current = { x: e.clientX, y: e.clientY };
          clearPress();
          pressTimer.current = setTimeout(() => {
            pressTimer.current = null;
            longPressed.current = true;
            onToggleMuted();
            try { navigator.vibrate?.(15); } catch { }
          }, 500);
        }}
        onPointerMove={(e) => { if (pressTimer.current && Math.hypot(e.clientX - pressOrigin.current.x, e.clientY - pressOrigin.current.y) > 10) clearPress(); }}
        onPointerUp={clearPress}
        onPointerLeave={clearPress}
        onPointerCancel={clearPress}
        onContextMenu={(e) => e.preventDefault()}
        style={{ display: "flex", gap: 8, justifyContent: "center", background: "none", border: "none", padding: 6, cursor: "pointer", WebkitTouchCallout: "none", userSelect: "none" }}>
        {pattern.map((state, i) => (
          <div key={i} style={{ width: size, height: size, borderRadius: "50%", background: muted ? (flashBeat === i ? "#fff" : "transparent") : dotColor(state, flashBeat === i, C), border: muted || state === "mute" ? `1.5px solid ${muted && flashBeat === i ? "#fff" : C.textFaint}` : "none", boxSizing: "border-box", transition: "background 60ms linear" }} />
        ))}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 140 }} />
          <div style={{
            position: "absolute", ...(openUpward ? { bottom: "100%", marginBottom: 10 } : { top: "100%", marginTop: 10 }),
            ...hAlignStyle, zIndex: 150, background: C.surface3, border: `1px solid ${C.borderStrong}`, borderRadius: 16, padding: "16px 18px",
            boxShadow: "0 12px 32px rgba(0,0,0,0.6)", display: "flex", alignItems: "center", gap: 14, minWidth: POPUP_WIDTH, justifyContent: "center",
            maxWidth: "calc(100vw - 16px)", boxSizing: "border-box",
          }}>
            {pattern.map((state, i) => (
              <button key={i} onClick={() => cycleBeat(i)} style={{ background: "none", border: "none", padding: 4, cursor: "pointer" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: state === "mute" ? "transparent" : state === "accent" ? C.accent : "#fff", border: state === "mute" ? `2px solid ${C.textFaint}` : "none", boxSizing: "border-box" }} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function SubdivisionIcon({ value, size = 18, color }) {
  if (value === 1) {
    // Shift the notehead right so it reads as centered within the bounding box
    return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none"><ellipse cx="13" cy="18" rx="4" ry="3" fill={color} /><line x1="16.8" y1="18" x2="16.8" y2="4" stroke={color} strokeWidth="2" strokeLinecap="round" /></svg>);
  }
  if (value === 2) {
    return (<svg width={size * 1.15} height={size} viewBox="0 0 28 24" fill="none"><ellipse cx="6.5" cy="19" rx="3.4" ry="2.6" fill={color} /><ellipse cx="21.5" cy="19" rx="3.4" ry="2.6" fill={color} /><line x1="9.7" y1="19" x2="9.7" y2="6" stroke={color} strokeWidth="2" strokeLinecap="round" /><line x1="24.7" y1="19" x2="24.7" y2="6" stroke={color} strokeWidth="2" strokeLinecap="round" /><line x1="9.7" y1="6" x2="24.7" y2="6" stroke={color} strokeWidth="2.2" strokeLinecap="round" /></svg>);
  }
  return (
    <svg width={size * 1.5} height={size} viewBox="0 0 40 24" fill="none">
      <text x="20" y="6" fontSize="9" fontWeight="700" fill={color} textAnchor="middle" fontFamily={FONT}>3</text>
      <ellipse cx="6" cy="19" rx="3" ry="2.3" fill={color} /><ellipse cx="20" cy="19" rx="3" ry="2.3" fill={color} /><ellipse cx="34" cy="19" rx="3" ry="2.3" fill={color} />
      <line x1="9" y1="19" x2="9" y2="8" stroke={color} strokeWidth="1.8" strokeLinecap="round" /><line x1="23" y1="19" x2="23" y2="8" stroke={color} strokeWidth="1.8" strokeLinecap="round" /><line x1="37" y1="19" x2="37" y2="8" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <line x1="9" y1="8" x2="37" y2="8" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function useHoldRepeat(step, { onStart, onEnd } = {}) {
  const timeoutRef = useRef(null);
  const startTimeRef = useRef(0);
  const activeRef = useRef(false);
  const stepRef = useRef(step);
  stepRef.current = step;
  const clear = () => {
    const wasActive = activeRef.current;
    activeRef.current = false;
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (wasActive && onEnd) onEnd();
  };
  const scheduleNext = () => {
    if (!activeRef.current) return;
    const heldSeconds = (performance.now() - startTimeRef.current) / 1000;
    const minInterval = 35, startInterval = 300, tau = 0.55;
    const interval = minInterval + (startInterval - minInterval) * Math.exp(-heldSeconds / tau);
    timeoutRef.current = setTimeout(() => { stepRef.current(); scheduleNext(); }, interval);
  };
  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    clear();
    if (onStart) onStart();
    activeRef.current = true; startTimeRef.current = performance.now();
    stepRef.current();
    timeoutRef.current = setTimeout(scheduleNext, 380);
  };
  useEffect(() => () => clear(), []);
  return { onPointerDown, onPointerUp: clear, onPointerLeave: clear, onPointerCancel: clear };
}
