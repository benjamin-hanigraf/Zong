// App chrome: toast and bottom navigation.
import { Layers, ListMusic, Settings as SettingsIcon } from "lucide-react";
import { FONT } from "../lib/constants.js";
import { MetronomeIcon, PianoIcon } from "./shared.jsx";

export function Toast({ message, C }) {
  if (!message) return null;
  return (
    <div style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: "calc(55px + max(36px, 8px + var(--safe-bottom)) + 16px)", background: C.surface3, border: `1px solid ${C.borderStrong}`, padding: "10px 18px", borderRadius: 999, fontSize: 13.5, fontWeight: 600, zIndex: 300, whiteSpace: "nowrap", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
      {message}
    </div>
  );
}

export function BottomNav({ active, onChange, mode, C }) {
  const firstTab = mode === "drums" ? { id: "practice", label: "Metronome", icon: MetronomeIcon } : { id: "practice", label: "Piano", icon: PianoIcon };
  const items = [firstTab, { id: "songs", label: "Songs", icon: ListMusic }, { id: "setlists", label: "Setlists", icon: Layers }, { id: "settings", label: "Settings", icon: SettingsIcon }];
  return (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 30 }}>
      <div style={{ display: "flex", background: C.bg, paddingTop: 18, paddingBottom: "max(36px, calc(8px + var(--safe-bottom)))" }}>
        {items.map(({ id, label, icon: Icon }, index) => {
          const isActive = active === id;
          const isPiano = Icon === PianoIcon;
          return (
            <button key={id} onClick={() => onChange(id)} title={`${label} (${index + 1})`} aria-current={isActive ? "page" : undefined} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", gap: 3, padding: "0 0 6px", background: "none", border: "none", fontFamily: FONT, cursor: "pointer" }}>
              {/* Allow the piano icon to be naturally balanced; constrain height */}
              <div style={{ height: 18, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon size={isPiano ? 16 : 18} height={isPiano ? 16 : undefined} color={isActive ? C.accent : C.textMuted} strokeWidth={isActive ? 2.3 : 1.8} />
              </div>
              <span style={{ fontSize: 8, color: isActive ? C.accent : C.textMuted, fontWeight: isActive ? 600 : 400 }}>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
