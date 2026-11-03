// Shared form controls (Field, ClearableInput, pickers, switches) and small icons.
import { X } from "lucide-react";
import { useRef, useState } from "react";
import { isShown, useKeys } from "../lib/keys.js";
import { FONT, TIME_SIGS } from "../lib/constants.js";

/* =========================================================================
   Shared bits
   ========================================================================= */
export function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, letterSpacing: 1.5, color: "#4D4D50", marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

export function SectionLabel({ children }) {
  return <div style={{ fontSize: 11, letterSpacing: 1.5, color: "#4D4D50", marginBottom: 10, marginTop: 4, fontWeight: 700 }}>{children}</div>;
}

// `search` marks it as a list's search box: the / key focuses it, Esc clears it, ↓ jumps to the first result, Enter runs onEnter.
// Keyboard handling for a focusable list row: Enter / Space activates it, ↑ / ↓ move between rows, Home / End jump to the ends.
export const navRowKeys = (activate) => (e) => {
  if (e.target !== e.currentTarget) return;
  const rows = [...document.querySelectorAll("[data-nav-row]")].filter(isShown);
  const at = rows.indexOf(e.currentTarget);
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
  else if (e.key === "ArrowDown") { e.preventDefault(); rows[Math.min(rows.length - 1, at + 1)]?.focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); if (at <= 0) [...document.querySelectorAll("input[data-search]")].find(isShown)?.focus(); else rows[at - 1].focus(); }
  else if (e.key === "Home") { e.preventDefault(); rows[0]?.focus(); }
  else if (e.key === "End") { e.preventDefault(); rows[rows.length - 1]?.focus(); }
};

export function ClearableInput({ value, onChangeText, placeholder, leftIcon, style, type, inputMode, autoFocus, search, onEnter }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      {leftIcon}
      <input
        autoFocus={autoFocus} type={type} inputMode={inputMode} value={value}
        onChange={(e) => onChangeText(e.target.value)}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        data-search={search ? "1" : undefined}
        onKeyDown={search ? (e) => {
          if (e.key === "Escape") { e.preventDefault(); if (value) onChangeText(""); else e.currentTarget.blur(); }
          else if (e.key === "ArrowDown") { const row = [...document.querySelectorAll("[data-nav-row]")].find(isShown); if (row) { e.preventDefault(); row.focus(); } }
          else if (e.key === "Enter" && onEnter) { e.preventDefault(); onEnter(); }
        } : undefined}
        placeholder={placeholder} style={style}
      />
      {focused && value ? (
        <button
          tabIndex={-1} onPointerDown={(e) => { e.preventDefault(); onChangeText(""); }}
          style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", padding: 4, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <X size={14} color="#98989D" />
        </button>
      ) : null}
    </div>
  );
}

export function TimeSigPicker({ value, onChange, fullWidth, height = 44, fontSize, style, subtle, C }) {
  const [open, setOpen] = useState(false);
  useKeys({ escape: () => setOpen(false) }, open);
  const [openUpward, setOpenUpward] = useState(false);
  const [openLeft, setOpenLeft] = useState(false);
  const btnRef = useRef(null);
  const DROPDOWN_HEIGHT = 220;
  const DROPDOWN_WIDTH = 70; // sized to the text it contains ("6/8" etc. plus padding), not a fixed min-width
  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUpward(spaceBelow < DROPDOWN_HEIGHT && rect.top > spaceBelow);
      // If centering the dropdown under the button would push its left edge
      // past the screen edge, anchor it to the button's left edge instead.
      const centerLeft = rect.left + rect.width / 2 - DROPDOWN_WIDTH / 2;
      setOpenLeft(centerLeft < 4);
    }
    setOpen((o) => !o);
  };
  return (
    <div style={{ position: "relative", width: fullWidth ? "100%" : undefined, boxSizing: "border-box", zIndex: open ? 500 : "auto", ...style }}>
      <button
        ref={btnRef} type="button" onClick={handleToggle}
        style={subtle ? {
          fontFamily: FONT, fontSize: fontSize ?? 11, fontWeight: 600, borderRadius: 6, boxSizing: "border-box",
          border: `1px solid ${C.border}`, background: "transparent", color: value ? C.textMuted : C.textFaint,
          width: fullWidth ? "100%" : undefined, textAlign: "center", height, padding: "0 7px",
          display: "flex", alignItems: "center", justifyContent: "center",
        } : {
          fontFamily: FONT, fontSize: fontSize ?? 16, fontWeight: 600, borderRadius: 10, boxSizing: "border-box",
          border: `1px solid ${C.border}`, background: C.surface2, color: value ? C.text : C.textFaint,
          width: fullWidth ? "100%" : undefined, textAlign: "center", height, padding: "0 10px",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        {value ? `${value.beats}/${value.unit}` : "—"}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 140 }} />
          <div style={{
            position: "absolute", ...(openUpward ? { bottom: "110%" } : { top: "110%" }),
            ...(openLeft ? { left: 0 } : { left: "50%", transform: "translateX(-50%)" }), zIndex: 500, width: DROPDOWN_WIDTH,
            background: C.surface3, border: `1px solid ${C.borderStrong}`, borderRadius: 12,
            overflow: "hidden", boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
          }}>
            {TIME_SIGS.map((ts) => {
              const active = value && ts.beats === value.beats && ts.unit === value.unit;
              return (
                <div key={`${ts.beats}/${ts.unit}`} onClick={() => { onChange(ts); setOpen(false); }} style={{
                  padding: "10px 16px", fontFamily: FONT, fontSize: 15, fontWeight: 500, textAlign: "center",
                  color: active ? C.accent : C.text, background: active ? C.accentSoft : "transparent",
                }}>
                  {ts.beats}/{ts.unit}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const NATURALS = ["C", "D", "E", "F", "G", "A", "B"];

const NATURAL_OPTIONS = [
  { id: "", label: "–" },
  ...NATURALS.map((n) => ({ id: n, label: n }))
];

export function NaturalDropdown({ value, onChange, C }) {
  const [open, setOpen] = useState(false);
  useKeys({ escape: () => setOpen(false) }, open);
  const [openUpward, setOpenUpward] = useState(false);
  const btnRef = useRef(null);
  const DROPDOWN_HEIGHT = 320;
  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUpward(spaceBelow < DROPDOWN_HEIGHT && rect.top > spaceBelow);
    }
    setOpen((o) => !o);
  };
  return (
    <div style={{ position: "relative" }}>
      <button ref={btnRef} type="button" onClick={handleToggle} style={{
        width: "100%", boxSizing: "border-box", height: 44, padding: "0 10px", borderRadius: 10,
        border: `1px solid ${C.border}`, background: C.surface2, color: C.text,
        fontFamily: FONT, fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <span>{value || "–"}</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 140 }} />
          <div style={{
            position: "absolute", ...(openUpward ? { bottom: "110%" } : { top: "110%" }),
            left: 0, right: 0, zIndex: 150,
            background: C.surface3, border: `1px solid ${C.borderStrong}`, borderRadius: 12,
            boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
          }}>
            {NATURAL_OPTIONS.map(({ id, label }) => {
              const active = id === (value || "");
              return (
                <div key={label} onClick={() => { onChange(id); setOpen(false); }} style={{
                  padding: "12px 14px", fontFamily: FONT, fontSize: 15, fontWeight: 700, textAlign: "center",
                  color: active ? C.accent : C.text, background: active ? C.accentSoft : "transparent", cursor: "pointer",
                }}>
                  {label}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function AccidentalButton({ variant, natural, value, onChange, C }) {
  const disabled = !natural || (variant === "flat" ? (natural === "C" || natural === "F") : (natural === "E" || natural === "B"));
  const active = value === variant;
  const icon = variant === "flat" ? "\u266d" : "\u266f";
  return (
    <button
      type="button" disabled={disabled} onClick={() => onChange(active ? "natural" : variant)}
      style={{
        width: "100%", height: 44, borderRadius: 10, fontFamily: FONT, fontSize: 17, fontWeight: 700,
        border: `1px solid ${active ? C.accent : C.border}`,
        background: active ? C.accentSoft : C.surface2,
        color: disabled ? C.textFaint : active ? C.accent : C.textMuted,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {icon}
    </button>
  );
}

// Plain iOS-style switch — a single toggle knob with no embedded text
// labels, for rows where the label already lives outside the control
// (e.g. "Tamil Transliteration" ...... [ o--]).
export function IosSwitch({ checked, onChange, C }) {
  return (
    <div
      role="switch" aria-checked={checked} tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(!checked); } }}
      style={{
        position: "relative", width: 51, height: 31, borderRadius: 16, flexShrink: 0, cursor: "pointer",
        boxSizing: "border-box", background: checked ? C.accent : C.surface3,
        border: `1px solid ${checked ? C.accent : C.borderStrong}`, transition: "background 150ms ease, border-color 150ms ease",
      }}
    >
      <span style={{ position: "absolute", top: 2, left: checked ? 22 : 2, width: 25, height: 25, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.4)", transition: "left 150ms ease" }} />
    </div>
  );
}

export function TabSelect({ options, value, onChange, C }) {
  return (
    <div style={{ display: "flex", gap: 6, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 4 }}>
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button key={opt.id} onClick={() => onChange(opt.id)} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", fontFamily: FONT, fontSize: 13.5, fontWeight: 700, background: active ? C.accentSoft : "transparent", color: active ? C.accent : C.textMuted }}>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* =========================================================================
   Piano tab (shown for Vocals + Chords modes)
   ========================================================================= */
export function PianoIcon({ size = 18, height, color, strokeWidth }) {
  // Simplified, refined piano icon with black keys only and matching line weight
  const h = height ?? size;
  const w = Math.round(h * 1.32);
  const sw = strokeWidth ? Math.min(strokeWidth * 0.72, 1.4) : 1.2;
  return (
    <svg width={w} height={h} style={{ display: "block" }} viewBox="0 0 24 18" fill="none">
      <rect x="1" y="1" width="22" height="16" rx="2.5" stroke={color} strokeWidth={sw} />
      {/* Clean black keys */}
      <rect x="5.5" y="1" width="2" height="8" fill={color} rx="0.5" />
      <rect x="11" y="1" width="2" height="8" fill={color} rx="0.5" />
      <rect x="16.5" y="1" width="2" height="8" fill={color} rx="0.5" />
    </svg>
  );
}

export function MetronomeIcon({ size = 20, color, strokeWidth = 2 }) {
  // Outline from the supplied Metronome.svg, scaled into a 24-unit box like the
  // lucide icons beside it so size and stroke weight match (stroke is in 24-unit space).
  const k = 20 / 387.35;
  return (
    <svg width={size} height={size} style={{ display: "block" }} viewBox="0 0 24 24" fill="none">
      <g transform={`translate(12 12) scale(${k}) translate(-159.92 -193.675)`} stroke={color} strokeWidth={strokeWidth / k} strokeLinecap="round" strokeMiterlimit="10" fill="none">
        <path d="M220.23,93.03l-11.87-36.49c-15.85-48.73-84.79-48.73-100.64,0L21.77,320.79c-7.48,22.98,9.65,46.57,33.82,46.57h204.91c24.17,0,41.3-23.59,33.82-46.57l-32.81-100.86" />
        <line x1="157.59" y1="283.78" x2="299.84" y2="62.03" />
      </g>
    </svg>
  );
}
