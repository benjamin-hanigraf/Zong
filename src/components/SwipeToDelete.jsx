// Swipe-to-delete row wrapper.
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SWIPE_REVEAL } from "../lib/swipe.js";

export function SwipeToDelete({ id, openId, onOpenIdChange, onDelete, children, icon: RevealIcon = Trash2, elevated = false, C }) {
  const [translateX, setTranslateX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0); const startYRef = useRef(0); const startTranslateRef = useRef(0);
  const movedRef = useRef(false); const directionRef = useRef(null);
  const isOpen = openId === id;
  useEffect(() => { if (!isOpen) setTranslateX(0); }, [isOpen]);
  const mouseActiveRef = useRef(false);
  const startDrag = (x, y) => {
    if (openId !== null && openId !== id) onOpenIdChange(null);
    startXRef.current = x; startYRef.current = y;
    startTranslateRef.current = translateX; movedRef.current = false; directionRef.current = null;
    setDragging(true);
  };
  const moveDrag = (x, y, stopFn) => {
    const dx = x - startXRef.current;
    const dy = y - startYRef.current;
    if (directionRef.current === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      directionRef.current = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    }
    if (directionRef.current === "y") return;
    if (stopFn) stopFn();
    if (Math.abs(dx) > 6) movedRef.current = true;
    setTranslateX(Math.min(0, Math.max(-SWIPE_REVEAL, startTranslateRef.current + dx)));
  };
  const endDrag = (stopFn) => {
    setDragging(false);
    if (directionRef.current === "y") { directionRef.current = null; return; }
    if (stopFn) stopFn();
    const shouldOpen = translateX < -SWIPE_REVEAL / 2;
    setTranslateX(shouldOpen ? -SWIPE_REVEAL : 0);
    onOpenIdChange(shouldOpen ? id : null);
    directionRef.current = null;
  };
  const handleTouchStart = (e) => startDrag(e.touches[0].clientX, e.touches[0].clientY);
  const handleTouchMove = (e) => moveDrag(e.touches[0].clientX, e.touches[0].clientY, () => e.stopPropagation());
  const handleTouchEnd = (e) => endDrag(() => e.stopPropagation());
  const handleMouseDown = (e) => { mouseActiveRef.current = true; startDrag(e.clientX, e.clientY); };
  useEffect(() => {
    const onMouseMove = (e) => { if (mouseActiveRef.current) moveDrag(e.clientX, e.clientY); };
    const onMouseUp = () => { if (mouseActiveRef.current) { mouseActiveRef.current = false; endDrag(); } };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  });
  const handleContentClickCapture = (e) => {
    if (movedRef.current) { e.stopPropagation(); return; }
    if (isOpen) { e.stopPropagation(); setTranslateX(0); onOpenIdChange(null); }
  };
  return (
    <div style={{ position: "relative", overflow: elevated ? "visible" : "hidden", zIndex: elevated ? 100 : "auto" }}>
      <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: SWIPE_REVEAL, display: "flex", alignItems: "stretch", justifyContent: "center", background: "#161618" }}>
        <button onClick={() => { onDelete(); setTranslateX(0); onOpenIdChange(null); }} style={{ width: "100%", background: "none", border: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <RevealIcon size={18} color={C.danger} />
        </button>
      </div>
      <div onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} onMouseDown={handleMouseDown} onClickCapture={handleContentClickCapture}
        style={{ transform: `translateX(${translateX}px)`, transition: dragging ? "none" : "transform 200ms ease", background: C.bg, touchAction: "pan-y", cursor: "grab" }}>
        {children}
      </div>
    </div>
  );
}
