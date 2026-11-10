// Setlists list and the setlist editor.
import { ChevronLeft, Pencil, Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useKeys } from "../lib/keys.js";
import { FONT } from "../lib/constants.js";
import { flatify } from "../lib/chords.js";
import { maybeTanglishTitle, stripAltTitle } from "../lib/songText.js";
import { ClearableInput, navRowKeys } from "../components/shared.jsx";
import { useKeyboardInset } from "../lib/viewport.js";
import { useEdgeSwipeBack } from "../lib/swipe.js";
import { Tamil } from "../components/Tamil.jsx";
import { SwipeToDelete } from "../components/SwipeToDelete.jsx";
import { SongPickerScreen } from "./SongPickerScreen.jsx";
import { RemoveSharedSongModal } from "../components/dialogs.jsx";

/* =========================================================================
   Setlist song row
   ========================================================================= */
function SetlistSongRow({ song, keyOverride, tempoOverride, style, handlers, onClick, onKeyDown, mode, tanglishMode, C }) {
  const effectiveTempo = tempoOverride ?? song.tempo;
  const badgeText = mode === "drums"
    ? (effectiveTempo !== "" && effectiveTempo != null ? `${effectiveTempo}` : "—")
    : flatify(`${keyOverride || song.key}${song.keyQuality === "Minor" ? "m" : ""}`);
  return (
    <div data-nav-row data-song-id={song.id} tabIndex={0} role="button" onKeyDown={onKeyDown} onClick={onClick} {...handlers} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", position: "relative", touchAction: "pan-y", ...style }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Tamil>{maybeTanglishTitle(stripAltTitle(song.title), tanglishMode)}</Tamil></div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Tamil>{maybeTanglishTitle(song.artist, tanglishMode) || "Unknown"}</Tamil></div>
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color: C.accent, border: `1px solid ${C.accentDim}`, borderRadius: 6, padding: "3px 7px", flexShrink: 0 }}>{badgeText}</span>
    </div>
  );
}

/* =========================================================================
   Setlist stage — merges Click's Stage (bottom metronome bar, only shown
   in Drums mode per spec #11) with Chords' setlist stage (reorder, swipe
   to delete, song picker).
   ========================================================================= */
export function SetlistStageScreen({ setlist, songs, onBack, onCommit, onUpdateSetlist, onOpenSong, onDeleteSetlist, initialPickerOpen, mode, tanglishMode, C }) {
  const [pickerOpen, setPickerOpen] = useState(!!initialPickerOpen);
  const [openSwipeId, setOpenSwipeId] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const nameLongPressTimerRef = useRef(null);
  const stageRoot = useRef(null);
  const { dragX, leaving, dragging, handlers } = useEdgeSwipeBack(onBack, 24, stageRoot);

  const [activeDragIndex, setActiveDragIndex] = useState(null);
  const [dragY, setDragY] = useState(0);
  const dragTimerRef = useRef(null);
  const startYRef = useRef(0);
  const justDraggedRef = useRef(false);

  const commitName = () => { const trimmed = nameDraft.trim(); if (trimmed) { onUpdateSetlist({ ...setlist, name: trimmed }); onCommit?.(setlist.id); } setEditingName(false); };
  const startNameLongPress = () => { if (nameLongPressTimerRef.current) clearTimeout(nameLongPressTimerRef.current); nameLongPressTimerRef.current = setTimeout(() => { setPickerOpen(true); }, 500); };
  const cancelNameLongPress = () => { if (nameLongPressTimerRef.current) { clearTimeout(nameLongPressTimerRef.current); nameLongPressTimerRef.current = null; } };

  const [songToRemove, setSongToRemove] = useState(null);

  const setlistSongs = setlist.entries.map((e) => {
    const song = songs.find((s) => s.id === e.songId);
    return song ? { song, keyOverride: e.keyOverride, tempoOverride: e.tempoOverride } : null;
  }).filter(Boolean);

  const removeFromStage = (songId, commit = false) => {
    onUpdateSetlist({ ...setlist, entries: setlist.entries.filter((e) => e.songId !== songId) });
    if (commit) onCommit?.(setlist.id);
  };
  const requestRemoveFromStage = (songId) => {
    if (setlist.shared) {
      const s = songs.find((item) => item.id === songId);
      if (s) { setSongToRemove(s); return; }
    }
    removeFromStage(songId, true);
  };
  const toggleSong = (songId) => {
    const has = setlist.entries.some((e) => e.songId === songId);
    if (has && setlist.shared) {
      const s = songs.find((item) => item.id === songId);
      if (s) { setSongToRemove(s); return; }
    }
    onUpdateSetlist({ ...setlist, entries: has ? setlist.entries.filter((e) => e.songId !== songId) : [...setlist.entries, { songId, keyOverride: null, tempoOverride: null }] });
  };

  // Keyboard reorder: Alt + ↑ / ↓ on a song moves it one place (the focus follows it).
  const moveSongBy = (idx, dir) => {
    const to = idx + dir;
    if (to < 0 || to >= setlist.entries.length) return;
    const id = setlist.entries[idx].songId;
    const next = [...setlist.entries];
    [next[idx], next[to]] = [next[to], next[idx]];
    onUpdateSetlist({ ...setlist, entries: next });
    // saved a moment later, once the new order has been applied (committing in the same breath would save the old one)
    setTimeout(() => { onCommit?.(setlist.id); document.querySelector(`[data-song-id="${CSS.escape(id)}"]`)?.focus(); }, 80);
  };
  const mouseDragIdxRef = useRef(null);
  const startSongDrag = (idx, clientY) => {
    startYRef.current = clientY;
    if (dragTimerRef.current) clearTimeout(dragTimerRef.current);
    dragTimerRef.current = setTimeout(() => { setActiveDragIndex(idx); setDragY(0); if (navigator.vibrate) navigator.vibrate(15); }, 400);
  };
  const moveSongDrag = (idx, clientY, preventDefault) => {
    if (activeDragIndex === null) { if (Math.abs(clientY - startYRef.current) > 10) clearTimeout(dragTimerRef.current); }
    else {
      if (preventDefault) preventDefault();
      const deltaY = clientY - startYRef.current;
      setDragY(deltaY);
      const rowHeight = 60; const total = setlistSongs.length;
      if (deltaY > rowHeight / 2 && idx < total - 1) {
        const next = [...setlist.entries];[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
        onUpdateSetlist({ ...setlist, entries: next });
        startYRef.current += rowHeight; setActiveDragIndex(idx + 1); setDragY(clientY - startYRef.current);
        mouseDragIdxRef.current = idx + 1;
      } else if (deltaY < -rowHeight / 2 && idx > 0) {
        const next = [...setlist.entries];[next[idx], next[idx - 1]] = [next[idx - 1], next[idx]];
        onUpdateSetlist({ ...setlist, entries: next });
        startYRef.current -= rowHeight; setActiveDragIndex(idx - 1); setDragY(clientY - startYRef.current);
        mouseDragIdxRef.current = idx - 1;
      }
    }
  };
  const endSongDrag = () => { if (dragTimerRef.current) clearTimeout(dragTimerRef.current); if (activeDragIndex !== null) { justDraggedRef.current = true; onCommit?.(setlist.id); } setActiveDragIndex(null); setDragY(0); mouseDragIdxRef.current = null; };
  const handleSongTouchStart = (idx, e) => { if (e.touches.length !== 1) return; startSongDrag(idx, e.touches[0].clientY); };
  const handleSongTouchMove = (idx, e) => { if (e.touches.length !== 1) return; moveSongDrag(idx, e.touches[0].clientY, () => { e.preventDefault(); e.stopPropagation(); }); };
  const handleSongTouchEnd = () => endSongDrag();
  const handleSongMouseDown = (idx, e) => { mouseDragIdxRef.current = idx; startSongDrag(idx, e.clientY); };
  useEffect(() => {
    const onMouseMove = (e) => { if (mouseDragIdxRef.current !== null) moveSongDrag(mouseDragIdxRef.current, e.clientY); };
    const onMouseUp = () => { if (mouseDragIdxRef.current !== null) endSongDrag(); };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  });

  const bottomInset = "calc(55px + max(36px, 8px + var(--safe-bottom)))";
  useKeys({ rootRef: stageRoot, escape: () => onBack() });

  return (
    <div ref={stageRoot} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: bottomInset, background: C.bg, color: C.text, fontFamily: FONT, zIndex: 80, display: "flex", flexDirection: "column", paddingTop: "var(--safe-top)", boxSizing: "border-box", transform: `translateX(${dragX}px)`, transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none" }} {...handlers}>
      <div style={{ padding: "16px 16px 12px", display: "flex", alignItems: "center", gap: 6 }}>
        <button onClick={onBack} aria-label="Back" style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", color: C.textMuted, flexShrink: 0 }}><ChevronLeft size={22} /></button>
        {editingName ? (
          <input className="no-ring" autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onBlur={commitName} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            style={{ flex: 1, fontFamily: FONT, fontSize: 16, fontWeight: 700, background: "transparent", border: "none", color: C.text, textAlign: "center", padding: "6px 10px", textTransform: "uppercase", letterSpacing: 0.5, outline: "none" }} />
        ) : (
          <button onTouchStart={startNameLongPress} onTouchMove={cancelNameLongPress} onTouchEnd={cancelNameLongPress} onTouchCancel={cancelNameLongPress}
            onMouseDown={startNameLongPress} onMouseUp={cancelNameLongPress} onMouseLeave={cancelNameLongPress}
            style={{ flex: 1, textAlign: "center", fontSize: 16, fontWeight: 700, padding: "0 4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: 0.5, background: "none", border: "none", color: C.text }}>
            {setlist.name}
          </button>
        )}
        <button onClick={() => setPickerOpen(true)} style={{ width: 34, height: 34, borderRadius: "50%", border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer" }}>
          <Pencil size={16} color={C.accent} />
        </button>
      </div>

      <div className="scroll-list" style={{ flex: 1, overflowY: (activeDragIndex !== null || dragging) ? "hidden" : "auto", padding: "0 20px 14px", boxSizing: "border-box", touchAction: (activeDragIndex !== null || dragging) ? "none" : "pan-y" }}>
        {setlistSongs.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>No songs added yet.</div>
        ) : setlistSongs.map(({ song: s, keyOverride, tempoOverride }, idx) => {
          const isDraggingThis = activeDragIndex === idx;
          return (
            <SwipeToDelete key={s.id} id={s.id} openId={openSwipeId} onOpenIdChange={setOpenSwipeId} onDelete={() => requestRemoveFromStage(s.id)} icon={X} C={C} elevated={isDraggingThis} disabled={activeDragIndex !== null}>
              <SetlistSongRow
                song={s} keyOverride={keyOverride} tempoOverride={tempoOverride} mode={mode} tanglishMode={tanglishMode} C={C}
                onClick={() => {
                  if (justDraggedRef.current) { justDraggedRef.current = false; return; }
                  if (activeDragIndex === null) onOpenSong(s);
                }}
                onKeyDown={navRowKeys(() => onOpenSong(s), { onDelete: () => requestRemoveFromStage(s.id), onMove: (dir) => moveSongBy(idx, dir) })}
                handlers={{
                  onTouchStart: (e) => handleSongTouchStart(idx, e),
                  onTouchMove: (e) => handleSongTouchMove(idx, e),
                  onTouchEnd: handleSongTouchEnd,
                  onTouchCancel: handleSongTouchEnd,
                  onMouseDown: (e) => handleSongMouseDown(idx, e),
                }}
                style={{
                  transform: isDraggingThis ? `translateY(${dragY}px)` : "none", zIndex: isDraggingThis ? 100 : 1,
                  background: isDraggingThis ? C.surface3 : C.bg, boxShadow: isDraggingThis ? "0 8px 24px rgba(0,0,0,0.6)" : "none",
                  transition: isDraggingThis ? "none" : "transform 0.15s ease, background 0.15s ease",
                }}
              />
            </SwipeToDelete>
          );
        })}
      </div>

      {pickerOpen && (
        <SongPickerScreen
          songs={songs}
          selectedIds={setlist.entries.map((e) => e.songId)}
          onToggle={toggleSong}
          onClose={() => { setPickerOpen(false); onCommit?.(setlist.id); }}
          setlistName={setlist.name}
          onRenameSetlist={(name) => onUpdateSetlist({ ...setlist, name })}
          isShared={Boolean(setlist.shared)}
          onToggleShared={(shared) => onUpdateSetlist({ ...setlist, shared })}
          mode={mode}
          tanglishMode={tanglishMode}
          C={C}
        />
      )}

      {songToRemove && (
        <RemoveSharedSongModal
          song={songToRemove}
          setlist={setlist}
          onConfirm={() => {
            removeFromStage(songToRemove.id, !pickerOpen);
            setSongToRemove(null);
          }}
          onCancel={() => setSongToRemove(null)}
          C={C}
        />
      )}
    </div>
  );
}

export function SetlistsScreen({ setlists, onOpenStage, onCreate, onDelete, C }) {
  const [query, setQuery] = useState("");
  const [openSwipeId, setOpenSwipeId] = useState(null);
  const keyboardInset = useKeyboardInset();
  const filtered = setlists.filter((sl) => sl.name.toLowerCase().includes(query.toLowerCase()));

  // Sort setlists by last added or last opened first
  const sorted = [...filtered].sort((a, b) => {
    const timeA = a.lastOpenedAt || a.updatedAt || a.createdAt || 0;
    const timeB = b.lastOpenedAt || b.updatedAt || b.createdAt || 0;
    if (timeA !== timeB) return timeB - timeA;
    return setlists.indexOf(b) - setlists.indexOf(a);
  });

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 auto", padding: "22px 20px 14px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div><div style={{ fontSize: 26, fontWeight: 700 }}>Setlists</div><div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{setlists.length} setlist{setlists.length === 1 ? "" : "s"}</div></div>
          <button onClick={onCreate} aria-label="New setlist" style={{ width: 34, height: 34, borderRadius: "50%", border: `1px solid ${C.border}`, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Plus size={17} color={C.accent} /></button>
        </div>
        <div style={{ marginTop: 16 }}>
          <ClearableInput search onEnter={() => { if (sorted[0]) onOpenStage(sorted[0].id); }} value={query} onChangeText={setQuery} placeholder="Search setlists"
            leftIcon={<Search size={15} color={C.textFaint} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />}
            style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontFamily: FONT, fontSize: 16, boxSizing: "border-box", paddingLeft: 36, paddingRight: query ? 36 : 14 }} />
        </div>
      </div>
      <div className="scroll-list" style={{ flex: 1, overflowY: "auto", padding: `0 20px ${14 + keyboardInset}px`, boxSizing: "border-box" }}>
        {sorted.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 20px", color: C.textFaint, fontSize: 14 }}>{setlists.length === 0 ? "No setlists yet." : "No matches."}</div>
        )}
        {sorted.map((sl) => (
          <SwipeToDelete key={sl.id} id={sl.id} openId={openSwipeId} onOpenIdChange={setOpenSwipeId} onDelete={() => onDelete(sl.id)} C={C}>
            <div data-nav-row tabIndex={0} role="button" onKeyDown={navRowKeys(() => onOpenStage(sl.id), { onDelete: () => onDelete(sl.id) })} onClick={() => onOpenStage(sl.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{sl.name}</div>
                <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>{sl.entries.length} song{sl.entries.length === 1 ? "" : "s"}</div>
              </div>
              {sl.shared && (
                <span style={{ fontSize: 11, fontWeight: 700, color: C.accent, border: `1px solid ${C.accentDim}`, borderRadius: 6, padding: "2px 7px", flexShrink: 0 }}>
                  Shared
                </span>
              )}
            </div>
          </SwipeToDelete>
        ))}
      </div>
    </div>
  );
}
