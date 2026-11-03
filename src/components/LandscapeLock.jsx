// Rotates a child (the piano) to face the wider screen edge.
import { useEffect, useRef, useState } from "react";
import { useIsLandscapeScreen } from "../lib/viewport.js";

export function LandscapeLock({ children }) {
  const outerRef = useRef(null);
  const [size, setSize] = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 0,
    h: typeof window !== "undefined" ? window.innerHeight : 0,
  }));
  const isLandscapeScreen = useIsLandscapeScreen();
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        setSize({ w, h });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (isLandscapeScreen) {
    return (
      <div ref={outerRef} style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", background: "#000" }}>
        {children}
      </div>
    );
  }
  const w = size.w || (typeof window !== "undefined" ? window.innerWidth : 0);
  const h = size.h || (typeof window !== "undefined" ? window.innerHeight : 0);
  return (
    <div ref={outerRef} style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", background: "#000" }}>
      {w > 0 && h > 0 && (
        <div style={{ position: "absolute", top: "50%", left: "50%", width: h, height: w, transform: "translate(-50%, -50%) rotate(90deg)", transformOrigin: "center center" }}>
          {children}
        </div>
      )}
    </div>
  );
}
