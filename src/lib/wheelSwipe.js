// Two-finger trackpad swipes (Mac / PC) as an alternative to dragging across the page.
//
// A trackpad swipe arrives as a stream of `wheel` events (with deltaX), including the momentum after the fingers lift. A swipe is one
// gesture from its first event until the stream has been quiet for a moment. Only a clearly horizontal gesture is taken; a vertical one
// (ordinary scrolling) is left alone and so is the rest of the page. Each user of this decides which gestures it wants (`accept`),
// so it is only ever applied to the swipes that exist for touch (back, next / previous song, row actions) — never to everything.
import { useEffect, useRef } from "react";

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent || "");
const QUIET_MS = 90;

/** Distance the fingers moved to the right for this event (positive = right), whatever the "natural scrolling" setting is. */
export const swipeDelta = (e) => {
  // With natural scrolling (the Mac default) the page follows the fingers, so a swipe to the right arrives as a negative deltaX.
  const natural = e.webkitDirectionInvertedFromDevice ?? IS_MAC;
  return natural ? -e.deltaX : e.deltaX;
};

/**
 * Handlers: accept(sign, event) -> bool  (sign: 1 = to the right, -1 = left; decide whether this swipe is yours),
 *           onStart(), onMove(dx, vx), onEnd(dx, vx)  — dx = total distance so far (px, + = right), vx = recent speed (px / ms).
 * `enabled: false` switches it off. The handlers are read fresh on every event, so they may close over current state.
 */
export function useWheelSwipe(handlers) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    let g = null;
    let timer = null;
    const finish = () => {
      timer = null;
      const done = g;
      g = null;
      if (done && done.state === "active") latest.current.onEnd?.(done.dx, done.vx);
    };
    const arm = () => { clearTimeout(timer); timer = setTimeout(finish, QUIET_MS); };
    const onWheel = (e) => {
      const h = latest.current;
      if (h.enabled === false || e.ctrlKey) return;   // ctrl + wheel is pinch-zoom
      const now = performance.now();
      const dx = swipeDelta(e);
      if (!g) g = { state: "pending", ax: 0, ay: 0, dx: 0, vx: 0, last: now };
      if (g.state === "ignored") { arm(); return; }
      if (g.state === "pending") {
        g.ax += dx; g.ay += e.deltaY;
        if (Math.abs(g.ax) + Math.abs(g.ay) < 6) { arm(); return; }
        if (Math.abs(g.ay) >= Math.abs(g.ax) * 0.8 || (h.accept && !h.accept(Math.sign(g.ax), e))) { g.state = "ignored"; arm(); return; }
        g.state = "active"; g.dx = g.ax; g.last = now;
        h.onStart?.();
        e.preventDefault();
        h.onMove?.(g.dx, 0);
        arm();
        return;
      }
      e.preventDefault();
      const dt = Math.max(1, now - g.last);
      g.vx = 0.6 * g.vx + 0.4 * (dx / dt);
      g.last = now;
      g.dx += dx;
      h.onMove?.(g.dx, g.vx);
      arm();
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => { window.removeEventListener("wheel", onWheel); clearTimeout(timer); };
  }, []);
}
