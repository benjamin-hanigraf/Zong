// Songs list.
import { Plus, Search } from "lucide-react";
import { useRef, useState } from "react";
import { FONT, LANGUAGES } from "../lib/constants.js";
import { keyLabel } from "../lib/helpers.js";
import { maybeTanglishTitle, songMatchesQuery, stripAltTitle } from "../lib/songText.js";
import { ClearableInput, navRowKeys } from "../components/shared.jsx";
import { useWheelSwipe } from "../lib/wheelSwipe.js";
import { useKeyboardInset } from "../lib/viewport.js";
import { Tamil } from "../components/Tamil.jsx";
import { SwipeToDelete } from "../components/SwipeToDelete.jsx";

/* =========================================================================
   Songs list
   ========================================================================= */
function SongRow({ song, onOpen, onEdit, onDelete, onLoadToMetronome, onLoadToPiano, mode, tanglishMode, isSwipeOpen, lastScrollTimeRef, C }) {
  const longPressTimerRef = useRef(null);
  const firedLongPressRef = useRef(false);
  const swipeStartRef = useRef(null);
  const [swipeDx, setSwipeDx] = useState(0);
  const swipeFiredRef = useRef(false);
  // Track whether the delete swipe was already open when the gesture started.
  // If the row was open, we let the gesture close it but suppress the load-to-piano/metronome
  // action — the user must start a fresh swipe from the closed state to trigger load.
  const wasOpenRef = useRef(false);

  const isVocals = mode === "vocals";
  const isDrums = mode === "drums";
  const isChords = mode === "chords";
  const canSwipeRight = (isDrums && !!onLoadToMetronome) || ((isVocals || isChords) && !!onLoadToPiano);

  const startPress = (e) => {
    firedLongPressRef.current = false;
    // If the scroll list was scrolling within the last 400ms, don't start long-press.
    if (lastScrollTimeRef && Date.now() - (lastScrollTimeRef.current || 0) < 400) return;
    // Capture whether the delete panel was already exposed when this touch began.
    wasOpenRef.current = Boolean(isSwipeOpen);
    const point = e.touches ? e.touches[0] : e;
    const x = point.clientX, y = point.clientY;
    swipeStartRef.current = { x, y };
    swipeFiredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      firedLongPressRef.current = true;
      if (navigator.vibrate) navigator.vibrate(15);
      if (onEdit) onEdit(song);
    }, 500);
  };

  const movePress = (e) => {
    if (!swipeStartRef.current || firedLongPressRef.current) return;
    const point = e.touches ? e.touches[0] : e;
    const dx = point.clientX - swipeStartRef.current.x;
    const dy = point.clientY - swipeStartRef.current.y;
    // Cancel long-press if finger moved more than 8px in any direction.
    if (Math.hypot(dx, dy) > 8) {
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    }
    if (!canSwipeRight) return;
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) setSwipeDx(Math.min(dx, 120));
    }
  };

  const cancelPress = () => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    // Only fire the load action if the row was NOT already open (i.e. this is a fresh right-swipe,
    // not the gesture that closes the delete panel).
    if (swipeDx > 60 && !wasOpenRef.current) {
      swipeFiredRef.current = true;
      if (isDrums && onLoadToMetronome) onLoadToMetronome(song);
      else if ((isVocals || isChords) && onLoadToPiano) onLoadToPiano(song);
    }
    setSwipeDx(0);
    swipeStartRef.current = null;
    wasOpenRef.current = false;
  };

  const handleClick = () => {
    if (firedLongPressRef.current) { firedLongPressRef.current = false; return; }
    if (swipeFiredRef.current) { swipeFiredRef.current = false; return; }
    onOpen(song);
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    firedLongPressRef.current = true;
    if (onEdit) onEdit(song);
  };

  // Trackpad: a two-finger swipe right over the row does what swiping the row right does (load it into the piano / metronome).
  const rowRef = useRef(null);
  useWheelSwipe({
    accept: (sign, e) => sign > 0 && canSwipeRight && !isSwipeOpen && !!rowRef.current?.contains(e.target),
    onMove: (dx) => setSwipeDx(Math.min(120, Math.max(0, dx))),
    onEnd: (dx) => {
      setSwipeDx(0);
      if (dx > 60) { if (isDrums && onLoadToMetronome) onLoadToMetronome(song); else if ((isVocals || isChords) && onLoadToPiano) onLoadToPiano(song); }
    },
  });
  const badgeText = mode === "drums" ? (song.tempo !== "" && song.tempo != null ? `${song.tempo}` : "—") : keyLabel(song);
  return (
    <div ref={rowRef} data-nav-row tabIndex={0} role="button"
      onKeyDown={navRowKeys(() => onOpen(song), {
        onEdit: onEdit ? () => onEdit(song) : undefined,
        onDelete: onDelete ? () => onDelete(song.id) : undefined,
        onLoad: canSwipeRight ? () => (isDrums ? onLoadToMetronome(song) : onLoadToPiano(song)) : undefined,
      })} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", position: "relative", transform: `translateX(${swipeDx}px)`, transition: swipeDx === 0 ? "transform 120ms ease" : "none", background: C.bg, zIndex: 1, userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
      onClick={handleClick} onTouchStart={startPress} onTouchMove={movePress} onTouchEnd={cancelPress} onTouchCancel={cancelPress}
      onMouseDown={startPress} onMouseMove={movePress} onMouseUp={cancelPress} onMouseLeave={cancelPress} onContextMenu={handleContextMenu}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Tamil>{maybeTanglishTitle(stripAltTitle(song.title), tanglishMode)}</Tamil></div>
        <div style={{ fontSize: 12.5, color: "#6A6A6E", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Tamil>{maybeTanglishTitle(song.artist, tanglishMode) || "Unknown"}</Tamil></div>
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color: C.accent, border: `1px solid ${C.accentDim}`, borderRadius: 6, padding: "3px 7px", flexShrink: 0 }}>{badgeText}</span>
    </div>
  );
}

export function SongsScreen({ songs, onOpen, onAdd, onEdit, onDelete, onLoadToMetronome, onLoadToPiano, mode, tanglishMode, C }) {
  const [query, setQuery] = useState("");
  const [langFilter, setLangFilter] = useState("All");
  const [openSwipeId, setOpenSwipeId] = useState(null);
  const keyboardInset = useKeyboardInset();
  // Track last scroll time so SongRow can suppress long-press if user just scrolled
  const lastScrollTimeRef = useRef(0);
  // Total under the title follows the language filter (All / English / Tamil), not the search box.
  const languageSongCount = langFilter === "All" ? songs.length : songs.filter((s) => s.language === langFilter).length;
  const filtered = songs
    .filter((s) => songMatchesQuery(s, query))
    .filter((s) => langFilter === "All" || s.language === langFilter)
    .sort((a, b) => stripAltTitle(a.title).localeCompare(stripAltTitle(b.title), undefined, { sensitivity: "base" }));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 auto", padding: "22px 20px 14px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div><div style={{ fontSize: 26, fontWeight: 700 }}>Songs</div><div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{languageSongCount} songs</div></div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setLangFilter(f => f === "All" ? "English" : f === "English" ? "Tamil" : "All")} style={{ height: 34, padding: "0 14px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontFamily: FONT, fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
              {langFilter === "All" ? "All" : (langFilter === "Tamil" ? (tanglishMode ? "Tamil" : "தமிழ்") : (LANGUAGES.find(l => l.id === langFilter)?.label || langFilter))}
            </button>
            <button onClick={onAdd} aria-label="Add song" style={{ width: 34, height: 34, borderRadius: "50%", border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Plus size={17} color={C.accent} /></button>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <ClearableInput search onEnter={() => { if (filtered[0]) { setQuery(""); onOpen(filtered[0]); } }} value={query} onChangeText={setQuery} placeholder="Search title or artist"
            leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
            style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box", paddingLeft: 36, paddingRight: query ? 36 : 14 }} />
        </div>
      </div>
      <div className="scroll-list" onScroll={() => { lastScrollTimeRef.current = Date.now(); }} style={{ flex: 1, overflowY: "auto", padding: `0 20px ${14 + keyboardInset}px`, boxSizing: "border-box" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>{songs.length === 0 ? "No songs yet." : "No matches."}</div>
        ) : filtered.map((s) => (
          <SwipeToDelete key={s.id} id={s.id} openId={openSwipeId} onOpenIdChange={setOpenSwipeId} onDelete={() => onDelete(s.id)} C={C}>
            <SongRow song={s} onOpen={(song) => { setQuery(""); onOpen(song); }} onEdit={onEdit} onDelete={onDelete} onLoadToMetronome={onLoadToMetronome} onLoadToPiano={onLoadToPiano} mode={mode} tanglishMode={tanglishMode} isSwipeOpen={openSwipeId === s.id} lastScrollTimeRef={lastScrollTimeRef} C={C} />
          </SwipeToDelete>
        ))}
      </div>
    </div>
  );
}
