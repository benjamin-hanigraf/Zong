// Desktop keyboard control: the layer stack behind Esc / Enter / Tab (useKeys, useModalKeys).
import { useEffect, useRef } from "react";

/* =========================================================================
   Keyboard control (desktop). Screens, dialogs and pop-ups register themselves with useKeys while
   they are open; the topmost one owns the keyboard:
     Esc    → closes / goes back          Enter → the primary action (Save, Done, OK …)
     Tab    → stays inside the open layer (so it never wanders to the page behind)
   Enter is left alone when a button/link/checkbox is focused (it activates that control as usual)
   and inside multi-line text boxes (Ctrl/Cmd+Enter or Ctrl/Cmd+S runs the primary action there).
   ========================================================================= */
const keyStack = [];

export const hasOpenLayer = () => keyStack.length > 0;
// True when `el` is the root of the topmost layer (nothing — dialog, pop-up — is open above it).
export const isTopLayer = (el) => !!el && keyStack.length > 0 && keyStack[keyStack.length - 1].root() === el;

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export const isShown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

export const isTypingTarget = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);

function onGlobalKeyDown(e) {
  if (!keyStack.length || e.defaultPrevented || e.isComposing) return;
  const top = keyStack[keyStack.length - 1];
  const t = e.target;
  const tag = t?.tagName;
  if (e.key === "Tab") {
    const layer = [...keyStack].reverse().find((k) => k.root());
    const root = layer?.root();
    if (!root) return;
    const items = [...root.querySelectorAll(FOCUSABLE)].filter(isShown);
    if (!items.length) return;
    const active = document.activeElement;
    if (!root.contains(active)) { e.preventDefault(); items[e.shiftKey ? items.length - 1 : 0].focus(); }
    else if (e.shiftKey && active === items[0]) { e.preventDefault(); items[items.length - 1].focus(); }
    else if (!e.shiftKey && active === items[items.length - 1]) { e.preventDefault(); items[0].focus(); }
    return;
  }
  if (e.key === "Escape") { if (top.escape(e)) e.preventDefault(); return; }
  if ((e.key === "s" || e.key === "S") && (e.metaKey || e.ctrlKey)) { if (top.hasPrimary()) { e.preventDefault(); top.primary(e); } return; }
  if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
    const modified = e.metaKey || e.ctrlKey;
    if (tag === "TEXTAREA" && !modified) return;
    if (!modified) {
      if (/^(BUTTON|A|SELECT|SUMMARY)$/.test(tag)) return;
      if (/^(button|checkbox|radio|link|tab|option|menuitem|switch)$/.test(t?.getAttribute?.("role") || "")) return;
      if (tag === "INPUT" && /^(button|submit|checkbox|radio|file)$/.test(t.type)) return;
    }
    if (top.primary(e)) e.preventDefault();
  }
}

if (typeof window !== "undefined") window.addEventListener("keydown", onGlobalKeyDown);

// handlers: { escape, primary, rootRef }. A handler returns false when it chose not to act, so the key falls through.
export function useKeys({ escape, primary, rootRef } = {}, active = true) {
  const latest = useRef({});
  latest.current = { escape, primary, rootRef };
  useEffect(() => {
    if (!active) return undefined;
    const run = (name) => (e) => { const f = latest.current[name]; return f ? f(e) !== false : false; };
    const entry = { escape: run("escape"), primary: run("primary"), hasPrimary: () => !!latest.current.primary, root: () => latest.current.rootRef?.current || null };
    keyStack.push(entry);
    // Opening a layer moves the keyboard into it (so Esc / Enter / Tab act on it, not on a field behind); closing puts focus back.
    const before = document.activeElement;
    const frame = requestAnimationFrame(() => {
      const root = entry.root();
      if (!root || root.contains(document.activeElement)) return;
      if (!root.hasAttribute("tabindex")) root.tabIndex = -1;
      root.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      const i = keyStack.indexOf(entry);
      if (i >= 0) keyStack.splice(i, 1);
      setTimeout(() => {
        const a = document.activeElement;
        if ((!a || a === document.body) && before && before !== document.body && document.contains(before) && isShown(before)) before.focus({ preventScroll: true });
      }, 0);
    };
  }, [active]);
}

// Dialog helper: Esc closes, Enter runs `primary`, Tab stays inside. Attach the returned ref to the dialog's outer element.
export function useModalKeys(onClose, primary, active = true) {
  const rootRef = useRef(null);
  useKeys({ escape: onClose, primary, rootRef }, active);
  return rootRef;
}
