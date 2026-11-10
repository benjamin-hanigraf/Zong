// Spelling chart screen and its edit dialog.
import { ChevronLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { createPortal } from "react-dom";
import { recordDeletedSpellingKey } from "../supabaseSync";
import { useRef, useState } from "react";
import { useKeys, useModalKeys } from "../lib/keys.js";
import { FONT } from "../lib/constants.js";
import { TANGLISH_EXCEPTIONS } from "../lib/tanglish.js";
import { useKeyboardInset } from "../lib/viewport.js";
import { useEdgeSwipeBack } from "../lib/swipe.js";

/* =========================================================================
   SpellingChartScreen — full-screen overlay listing every TANGLISH_EXCEPTIONS
   entry as a Tamil → Tanglish table, with inline add / edit / delete support.
   ========================================================================= */
function SpellingChartModal({ initialTamil = "", initialLatin = "", isNew = false, onSave, onDelete, onClose, C }) {
  const [tamil, setTamil] = useState(initialTamil);
  const [latin, setLatin] = useState(initialLatin);
  const [error, setError] = useState("");
  const keyboardInset = useKeyboardInset();
  const latinInputRef = useRef(null);

  const handleSave = () => {
    const t = tamil.trim();
    const l = latin.trim();
    if (!t) {
      setError("Please enter a Tamil word");
      return;
    }
    if (!l) {
      setError("Please enter its Tanglish transliteration");
      return;
    }
    onSave(t, l);
  };

  const modalRoot = useModalKeys(onClose, () => handleSave());
  return createPortal(
    <div
      ref={modalRoot}
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 300,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
        paddingBottom: keyboardInset ? `${keyboardInset + 20}px` : 20,
        transition: "padding-bottom 150ms ease-out",
        overflowY: "auto",
        boxSizing: "border-box"
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 360, background: C.surface2,
          border: `1px solid ${C.borderStrong}`, borderRadius: 16,
          padding: "22px 20px 20px", boxSizing: "border-box",
          boxShadow: "0 20px 48px rgba(0,0,0,0.7)", fontFamily: FONT
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
          {isNew ? <Plus size={18} color={C.accent} /> : <Pencil size={17} color={C.accent} />}
          {isNew ? "Add Spelling Override" : "Edit Spelling Override"}
        </div>

        {error && (
          <div style={{ color: C.danger, fontSize: 13, fontWeight: 600, padding: "8px 12px", background: "rgba(255, 69, 58, 0.12)", border: `1px solid ${C.danger}40`, borderRadius: 8, marginBottom: 14 }}>
            {error}
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6 }}>
            Tamil Word
          </label>
          <input
            autoFocus
            value={tamil}
            onChange={(e) => { setTamil(e.target.value); setError(""); }}
            placeholder="e.g. இயேசு"
            style={{
              width: "100%", height: 42, background: C.surface3,
              border: `1px solid ${C.border}`, borderRadius: 10,
              padding: "0 12px", color: C.text, fontFamily: FONT,
              fontSize: 15, fontWeight: 500, boxSizing: "border-box", outline: "none"
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); latinInputRef.current?.focus(); }
            }}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6 }}>
            Transliteration (Tanglish)
          </label>
          <input
            ref={latinInputRef}
            value={latin}
            onChange={(e) => { setLatin(e.target.value); setError(""); }}
            placeholder="e.g. Yesu"
            style={{
              width: "100%", height: 42, background: C.surface3,
              border: `1px solid ${C.border}`, borderRadius: 10,
              padding: "0 12px", color: C.text, fontFamily: FONT,
              fontSize: 15, fontWeight: 500, boxSizing: "border-box", outline: "none"
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
            }}
          />
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {!isNew && onDelete && (
            <button
              onClick={() => onDelete(initialTamil)}
              style={{
                width: 40, height: 40, borderRadius: 10,
                border: `1px solid ${C.danger ?? "#FF453A"}40`,
                background: "rgba(255, 69, 58, 0.12)",
                color: C.danger ?? "#FF453A",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", flexShrink: 0
              }}
              aria-label="Delete override"
            >
              <Trash2 size={16} />
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              flex: 1, height: 40, borderRadius: 10,
              border: `1px solid ${C.border}`, background: "transparent",
              color: C.text, fontFamily: FONT, fontSize: 14, fontWeight: 600,
              cursor: "pointer"
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={{
              flex: 1, height: 40, borderRadius: 10, border: "none",
              background: C.accent, color: "#fff",
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center"
            }}
          >
            {isNew ? "Add" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function SpellingChartRow({ tamilKey, value, isFirst, onClick, C }) {
  const rowBorder = isFirst ? "none" : `1px solid ${C.border}`;
  return (
    <button
      onClick={() => onClick(tamilKey, value)}
      style={{
        width: "100%", display: "grid", gridTemplateColumns: "1fr 1fr",
        alignItems: "center", gap: 0, padding: "13px 14px",
        borderTop: rowBorder, background: "none", border: "none",
        textAlign: "left", cursor: "pointer", boxSizing: "border-box"
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 500, color: C.text, paddingRight: 8 }}>{tamilKey}</div>
      <div style={{ fontSize: 14, fontWeight: 500, color: C.textMuted, paddingRight: 8 }}>{value}</div>
    </button>
  );
}

export function SpellingChartScreen({ chart, onSave, onBack, C }) {
  const [modalData, setModalData] = useState(null); // null | { isNew: boolean, origTamil?: string, tamil: string, latin: string }
  const { dragX, leaving, dragging, handlers } = useEdgeSwipeBack(onBack);

  // User-added entries on top (newest-first), then seed entries below.
  const seedKeys = Object.keys(TANGLISH_EXCEPTIONS);
  const userKeys = Object.keys(chart).filter((k) => !seedKeys.includes(k)).reverse();
  const presentSeedKeys = seedKeys.filter((k) => k in chart);
  const rows = [...userKeys, ...presentSeedKeys];

  const handleSaveModal = (newTamil, newLatin) => {
    if (!modalData) return;
    if (modalData.isNew) {
      onSave({ [newTamil]: newLatin, ...chart });
    } else {
      const origTamil = modalData.origTamil;
      const next = { ...chart };
      if (origTamil && origTamil !== newTamil) {
        recordDeletedSpellingKey(origTamil);
        delete next[origTamil];
      }
      next[newTamil] = newLatin;
      onSave(next);
    }
    setModalData(null);
  };

  const handleDeleteModal = (tamilKey) => {
    recordDeletedSpellingKey(tamilKey);
    const next = { ...chart };
    delete next[tamilKey];
    onSave(next);
    setModalData(null);
  };

  const chartRoot = useRef(null);
  useKeys({ rootRef: chartRoot, escape: () => onBack() }, !modalData);
  return (
    <div
      ref={chartRoot}
      className="scroll-list"
      style={{
        position: "fixed", inset: 0, zIndex: 150,
        background: C.bg, color: C.text, fontFamily: FONT,
        overflowY: dragging ? "hidden" : "auto",
        touchAction: dragging ? "none" : "pan-y",
        boxSizing: "border-box",
        paddingBottom: "max(40px, var(--safe-bottom))",
        transform: `translateX(${dragX}px)`,
        transition: leaving ? "transform 200ms ease-out" : dragX === 0 ? "transform 200ms ease" : "none"
      }}
      {...handlers}
    >
      {/* Sticky Header matching SongForm */}
      <div style={{ padding: "calc(16px + var(--safe-top)) 20px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 5, background: C.bg }}>
        <button
          onClick={onBack} aria-label="Back" title="Back (Esc)"
          style={{ background: "none", border: "none", color: C.textMuted, display: "flex", padding: 6, marginLeft: -6, cursor: "pointer" }}
        >
          <ChevronLeft size={22} />
        </button>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Spelling Chart</div>
      </div>

      <div style={{ padding: 20, width: "100%", boxSizing: "border-box" }}>
        {/* Subtitle */}
        <div style={{ padding: "0 0 12px", fontSize: 12.5, color: C.textMuted, lineHeight: 1.5 }}>
          Custom transliteration overrides. Tap any row to edit.
        </div>

        {/* Rows with Add Word at the TOP */}
        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 24 }}>
          {/* Add Word top button */}
          <button
            onClick={() => setModalData({ isNew: true, tamil: "", latin: "" })}
            style={{ width: "100%", display: "grid", gridTemplateColumns: "1fr 1fr", alignItems: "center", gap: 0, padding: "13px 14px", background: "none", border: "none", textAlign: "left", cursor: "pointer", boxSizing: "border-box" }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, color: C.accent, display: "flex", alignItems: "center", gap: 6 }}>
              <Plus size={15} /> Add word...
            </div>
            <div style={{ fontSize: 13, color: C.textFaint }}>Custom transliteration</div>
          </button>

          {rows.map((key, idx) => (
            <SpellingChartRow
              key={key}
              tamilKey={key}
              value={chart[key]}
              isFirst={false}
              onClick={(tKey, val) => setModalData({ isNew: false, origTamil: tKey, tamil: tKey, latin: val })}
              C={C}
            />
          ))}
        </div>
      </div>

      {modalData && (
        <SpellingChartModal
          initialTamil={modalData.tamil}
          initialLatin={modalData.latin}
          isNew={modalData.isNew}
          onSave={handleSaveModal}
          onDelete={handleDeleteModal}
          onClose={() => setModalData(null)}
          C={C}
        />
      )}
    </div>
  );
}
