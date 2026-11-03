// Swipe gestures: edge swipe back and swiping between songs of a setlist.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { uiWidth } from "./viewport.js";

/* =========================================================================
   Swipe hooks
   ========================================================================= */
export function useEdgeSwipeBack(onBack, edgeZone = 24) {
  const touchStartRef = useRef(null);
  const [dragX, setDragX] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const mouseActiveRef = useRef(false);
  const start = (x, y) => {
    if (leaving) return;
    if (x > edgeZone) { touchStartRef.current = null; return; }
    touchStartRef.current = { x, y };
  };
  const move = (x, y) => {
    if (!touchStartRef.current || leaving) return;
    const dx = x - touchStartRef.current.x;
    const dy = y - touchStartRef.current.y;
    if (dx > 0 && dx > Math.abs(dy)) setDragX(dx);
  };
  const end = () => {
    if (!touchStartRef.current) return;
    touchStartRef.current = null;
    if (dragX > 30) { setLeaving(true); setDragX(uiWidth()); setTimeout(onBack, 200); }
    else setDragX(0);
  };
  // Touches that begin inside a text field belong to the field (caret, selection, magnifier) — never a back-swipe.
  const inTextField = (e) => !!e.target?.closest?.("textarea, input, [contenteditable]");
  const handleTouchStart = (e) => { if (inTextField(e)) { touchStartRef.current = null; return; } start(e.touches[0].clientX, e.touches[0].clientY); };
  const handleTouchMove = (e) => move(e.touches[0].clientX, e.touches[0].clientY);
  const handleTouchEnd = () => end();
  const handleMouseDown = (e) => { if (inTextField(e)) return; mouseActiveRef.current = true; start(e.clientX, e.clientY); };
  useEffect(() => {
    const onMouseMove = (e) => { if (mouseActiveRef.current) move(e.clientX, e.clientY); };
    const onMouseUp = () => { if (mouseActiveRef.current) { mouseActiveRef.current = false; end(); } };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  });
  return { dragX, leaving, dragging: dragX > 0, handlers: { onTouchStart: handleTouchStart, onTouchMove: handleTouchMove, onTouchEnd: handleTouchEnd, onTouchCancel: handleTouchEnd, onMouseDown: handleMouseDown } };
}

// Swipe between the songs of a setlist.
//
// The page follows the finger (transform written straight to the element — no React
// re-render while dragging, so it tracks at full frame rate). On release the old page is
// copied into a "ghost" that slides out while the new song slides in from the other side,
// both with the same easing and distance so their edges stay flush: a clean push transition.
// Uses the Web Animations API (all current browsers, iOS Safari, desktop and the app).
const SWIPE_MS = 300;

const SWIPE_EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";

export function useSetlistSongSwipe(onPrev, onNext, cardRef, songId) {
  // cardRef = the song's scrolling content area (lyrics / chords / notes). Only that part slides;
  // the header, badges and bottom bars stay where they are and just update their text.
  const startRef = useRef({ x: 0, y: 0 });
  const dirRef = useRef(null);
  const shownRef = useRef(0);       // current horizontal offset of the card
  const velRef = useRef({ x: 0, t: 0, v: 0 });
  const activeRef = useRef(false);
  const busyRef = useRef(false);
  const pendingRef = useRef(null);  // enter animation to run once the new song has rendered
  const ghostRef = useRef(null);
  const mouseActiveRef = useRef(false);

  const setX = (x) => {
    shownRef.current = x;
    const el = cardRef.current;
    if (el) el.style.transform = x === 0 ? "" : `translate3d(${x}px,0,0)`;
  };

  const start = (x, y) => {
    if (busyRef.current) return;
    startRef.current = { x, y };
    velRef.current = { x, t: performance.now(), v: 0 };
    dirRef.current = null;
    activeRef.current = true;
  };
  const move = (x, y) => {
    if (!activeRef.current || busyRef.current) return;
    const dx = x - startRef.current.x;
    const dy = y - startRef.current.y;
    if (dirRef.current === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      dirRef.current = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    }
    if (dirRef.current !== "x") return;
    const now = performance.now();
    const dt = now - velRef.current.t;
    if (dt > 0) velRef.current = { x, t: now, v: (x - velRef.current.x) / dt };
    // Resistance when there is no song in that direction.
    const canGo = dx > 0 ? !!onPrev : !!onNext;
    setX(canGo ? dx : dx * 0.25);
  };

  const animateBack = () => {
    const el = cardRef.current;
    const from = shownRef.current;
    setX(0);
    if (el && el.animate && from !== 0) {
      el.animate([{ transform: `translate3d(${from}px,0,0)` }, { transform: "translate3d(0,0,0)" }], { duration: 240, easing: SWIPE_EASE });
    }
  };

  const commit = (dir) => {   // dir: -1 = next song (page moves left), 1 = previous
    const el = cardRef.current;
    const go = () => (dir < 0 ? onNext() : onPrev());
    if (!el || !el.animate) { setX(0); go(); return; }
    busyRef.current = true;
    const W = uiWidth();
    const from = shownRef.current;

    // Ghost copy of the outgoing content slides away, pinned exactly over the content area.
    const rect = el.getBoundingClientRect();   // includes the current drag offset
    const ghost = el.cloneNode(true);
    ghost.setAttribute("aria-hidden", "true");
    Object.assign(ghost.style, {
      position: "fixed", left: `${rect.left - from}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`, margin: "0", flex: "none",
      background: getComputedStyle(el.parentElement || document.body).backgroundColor,
      pointerEvents: "none", transform: "", zIndex: "101", willChange: "transform",
    });
    document.body.appendChild(ghost);
    ghost.scrollTop = el.scrollTop;
    ghostRef.current = ghost;
    const out = ghost.animate(
      [{ transform: `translate3d(${from}px,0,0)` }, { transform: `translate3d(${dir * W}px,0,0)` }],
      { duration: SWIPE_MS, easing: SWIPE_EASE, fill: "forwards" }
    );
    const removeGhost = () => { ghost.remove(); if (ghostRef.current === ghost) ghostRef.current = null; };
    out.onfinish = removeGhost; out.oncancel = removeGhost;

    // The real card waits off-screen on the opposite side until the new song is rendered.
    const enterFrom = from - dir * W;
    el.style.transform = `translate3d(${enterFrom}px,0,0)`;
    shownRef.current = 0;
    pendingRef.current = { enterFrom };
    go();
    // Safety net: if the song never changed, put the card back.
    setTimeout(() => {
      if (pendingRef.current) {
        pendingRef.current = null;
        if (cardRef.current) cardRef.current.style.transform = "";
        busyRef.current = false;
      }
    }, 800);
  };

  // New song has rendered (before the browser paints): slide it in.
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    const el = cardRef.current;
    if (!pending || !el) return;
    pendingRef.current = null;
    el.style.transform = "";
    if (!el.animate) { busyRef.current = false; return; }
    const enter = el.animate(
      [{ transform: `translate3d(${pending.enterFrom}px,0,0)` }, { transform: "translate3d(0,0,0)" }],
      { duration: SWIPE_MS, easing: SWIPE_EASE }
    );
    const done = () => { busyRef.current = false; };
    enter.onfinish = done; enter.oncancel = done;
  }, [songId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (ghostRef.current) ghostRef.current.remove(); }, []);

  const end = () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    const wasHorizontal = dirRef.current === "x";
    dirRef.current = null;
    if (!wasHorizontal) return;
    const dx = shownRef.current;
    const v = velRef.current.v;
    const threshold = Math.min(120, uiWidth() * 0.25);
    const flick = Math.abs(v) > 0.5 && Math.abs(dx) > 24;
    const far = Math.abs(dx) > threshold;
    if (dx > 0 && onPrev && (far || (flick && v > 0))) commit(1);
    else if (dx < 0 && onNext && (far || (flick && v < 0))) commit(-1);
    else animateBack();
  };

  const handleTouchStart = (e) => { if (e.touches.length !== 1) return; start(e.touches[0].clientX, e.touches[0].clientY); };
  const handleTouchMove = (e) => move(e.touches[0].clientX, e.touches[0].clientY);
  const handleTouchEnd = () => end();
  const handleMouseDown = (e) => { mouseActiveRef.current = true; start(e.clientX, e.clientY); };
  useEffect(() => {
    const onMouseMove = (e) => { if (mouseActiveRef.current) move(e.clientX, e.clientY); };
    const onMouseUp = () => { if (mouseActiveRef.current) { mouseActiveRef.current = false; end(); } };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  });

  return {
    handlers: { onTouchStart: handleTouchStart, onTouchMove: handleTouchMove, onTouchEnd: handleTouchEnd, onTouchCancel: handleTouchEnd, onMouseDown: handleMouseDown },
  };
}

export const SWIPE_REVEAL = 76;
