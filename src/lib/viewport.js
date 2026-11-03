// Device class, phone orientation lock, on-screen keyboard inset.
import { useEffect, useState } from "react";

// "phone" | "ipad" | "desktop". Phones are locked to portrait, iPads rotate
// freely, and desktops (Mac/PC) keep a fixed landscape-oriented UI.
function detectDevice() {
  if (typeof navigator === "undefined" || typeof window === "undefined") return "desktop";
  const ua = navigator.userAgent;
  const smallestDim = Math.min(window.screen?.width || 0, window.screen?.height || 0);
  const isIPad =
    /iPad/i.test(ua) ||
    ((navigator.platform === "MacIntel" || /Macintosh/i.test(ua)) && navigator.maxTouchPoints > 1);
  if (isIPad) return "ipad";
  if (/iPhone|iPod/i.test(ua) || (/Mobi|Android/i.test(ua) && smallestDim < 600)) return "phone";
  if (/Android/i.test(ua)) return "ipad"; // Android tablets rotate freely like iPad
  return "desktop";
}

export const DEVICE_CLASS = detectDevice();

/* =========================================================================
   Phone orientation lock.
   iOS Safari / home-screen PWAs cannot lock the screen to portrait. When the phone is turned
   sideways the OS makes the viewport landscape, so on phones we turn the whole page back by 90°
   (the <body> is rotated and given the swapped width/height), which keeps the UI upright relative
   to the phone body — a rotation lock. Everything that depends on the page frame follows it:
     • sizes come from the body (never `100dvh` / `window.innerHeight`, which still describe the
       sideways viewport) — use uiWidth() / uiHeight();
     • the notch / home-indicator insets rotate with the page, exposed as --safe-top/-bottom/-left/-right.
   The native iOS app is locked to portrait by the OS, so none of this ever triggers there.
   ========================================================================= */
export const uiFrame = { rotated: false, width: 0, height: 0 };

export const uiWidth = () => (uiFrame.rotated ? uiFrame.width : window.innerWidth);

export function startPhoneOrientationLock() {
  if (typeof document === "undefined") return () => { };
  window.screen?.orientation?.lock?.("portrait")?.catch?.(() => { });   // works on Android / installed PWAs
  const root = document.documentElement;
  const body = document.body;
  const SAFE_VARS = ["--safe-top", "--safe-bottom", "--safe-left", "--safe-right"];
  // Hidden probe whose padding is the real (screen-frame) safe-area inset, so the values can be read in px.
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  body.appendChild(probe);

  const reset = () => {
    ["top", "left", "right", "bottom", "width", "height", "transform", "transformOrigin"].forEach((prop) => { body.style[prop] = ""; });
    SAFE_VARS.forEach((v) => root.style.removeProperty(v));
    uiFrame.rotated = false;
  };
  const apply = () => {
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    if (iw <= ih) { reset(); return; }
    const angle = window.screen?.orientation?.angle ?? (typeof window.orientation === "number" ? window.orientation : 90);
    const clockwise = angle === 270 || angle === -90;     // device turned clockwise: counter-rotate the other way
    const rot = clockwise ? 90 : -90;
    Object.assign(body.style, {
      top: "50%", left: "50%", right: "auto", bottom: "auto",
      width: `${ih}px`, height: `${iw}px`,
      transformOrigin: "center center",
      transform: `translate(-50%, -50%) rotate(${rot}deg)`,
    });
    const cs = getComputedStyle(probe);
    const inset = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
    // Which screen edge each edge of the (rotated) portrait page now sits on.
    const m = clockwise
      ? { top: inset.right, bottom: inset.left, left: inset.top, right: inset.bottom }
      : { top: inset.left, bottom: inset.right, left: inset.bottom, right: inset.top };
    Object.entries(m).forEach(([edge, px]) => root.style.setProperty(`--safe-${edge}`, `${px}px`));
    uiFrame.rotated = true;
    uiFrame.width = ih;      // the page's own width  = the viewport's short side
    uiFrame.height = iw;     // the page's own height = the viewport's long side
  };
  // The OS updates innerWidth/innerHeight a moment after the rotation events, so re-check shortly after too.
  let timers = [];
  const schedule = () => {
    apply();
    timers.forEach(clearTimeout);
    timers = [setTimeout(apply, 120), setTimeout(apply, 400)];
  };
  apply();
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  window.screen?.orientation?.addEventListener?.("change", schedule);
  window.visualViewport?.addEventListener("resize", apply);
  return () => {
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    window.screen?.orientation?.removeEventListener?.("change", schedule);
    window.visualViewport?.removeEventListener("resize", apply);
    timers.forEach(clearTimeout);
    probe.remove();
    reset();
  };
}

export function useIsLandscapeScreen() {
  // The piano rotates to face the wider edge. On phones the UI is always held
  // portrait (even if the OS reports a landscape viewport, we counter-rotate
  // the page), so the piano must always rotate itself on phones.
  const getIsLandscape = () => typeof window !== "undefined" && DEVICE_CLASS !== "phone" && window.innerWidth > window.innerHeight;
  const [isLandscape, setIsLandscape] = useState(getIsLandscape);
  useEffect(() => {
    const update = () => setIsLandscape(getIsLandscape());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return isLandscape;
}

// Tracks how much of the bottom of the layout viewport is currently covered
// by the on-screen keyboard (0 when the keyboard is closed). Scroll-list
// containers add this as extra bottom padding so there's always room to
// scroll focused fields / bottom-of-list items up above the keyboard,
// since the app's fixed-height layout never natively shrinks for it.
export function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      // A sideways (counter-rotated) phone page cannot map the keyboard onto its own bottom edge.
      const kb = uiFrame.rotated ? 0 : window.innerHeight - vv.height - vv.offsetTop;
      const next = kb > 60 ? Math.round(kb) : 0;
      setInset((prev) => (Math.abs(prev - next) < 2 ? prev : next));   // ignore sub-pixel jitter while typing/scrolling
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
    };
  }, []);
  return inset;
}

// On focus, nudges a field into view above the keyboard once it has finished
// animating open. Needed because the app's own scroll-pinning effect
// neutralises the browser's native "scroll focused input into view" step.
export const scrollFieldIntoView = (e) => {
  const el = e.currentTarget;
  setTimeout(() => { el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, 320);
};
