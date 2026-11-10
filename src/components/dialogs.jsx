// Dialogs: delete / remove confirmations, notices, Team key, Stage Mode.
import { AlertTriangle, Trash2 } from "lucide-react";
import { checkIsOnlyTeamMember } from "../supabaseSync";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { getDeviceId } from "../lib/device.js";
import { useModalKeys } from "../lib/keys.js";
import { FONT } from "../lib/constants.js";
import { useKeyboardInset } from "../lib/viewport.js";

export function DeleteSongModal({ song, onConfirm, onCancel, C }) {
  const [input, setInput] = useState("");
  const keyboardInset = useKeyboardInset();
  const isMatch = input.trim().toLowerCase() === "delete";
  const modalRoot = useModalKeys(onCancel, undefined, !!song);
  if (!song) return null;
  return createPortal(
    <div
      ref={modalRoot}
      onClick={onCancel}
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
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <Trash2 size={18} color={C.danger ?? "#FF453A"} /> Delete Song
        </div>
        <div style={{ fontSize: 13.5, color: C.textMuted, lineHeight: 1.45, marginBottom: 12 }}>
          Delete <strong style={{ color: C.text }}>"{song.title}"</strong> permanently for the team?
        </div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 8 }}>
          Type <span style={{ color: C.danger ?? "#FF453A", fontWeight: 700 }}>delete</span> to confirm:
        </div>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Type "delete"'
          style={{
            width: "100%", height: 42, background: C.surface3,
            border: `1px solid ${isMatch ? (C.danger ?? "#FF453A") : C.border}`,
            borderRadius: 10, padding: "0 12px", color: C.text,
            fontFamily: FONT, fontSize: 15, fontWeight: 600,
            boxSizing: "border-box", outline: "none", marginBottom: 16
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isMatch) onConfirm();
          }}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onCancel}
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
            disabled={!isMatch}
            onClick={onConfirm}
            style={{
              flex: 1, height: 40, borderRadius: 10, border: "none",
              background: isMatch ? (C.danger ?? "#FF453A") : C.surface3,
              color: isMatch ? "#fff" : C.textFaint,
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: isMatch ? "pointer" : "default",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6
            }}
          >
            <Trash2 size={15} color={isMatch ? "#fff" : C.textFaint} /> Delete
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function DeleteSetlistModal({ setlist, onConfirm, onCancel, C }) {
  const [input, setInput] = useState("");
  const keyboardInset = useKeyboardInset();
  const isMatch = input.trim().toLowerCase() === "delete";
  const modalRoot = useModalKeys(onCancel, undefined, !!setlist);
  if (!setlist) return null;
  return createPortal(
    <div
      ref={modalRoot}
      onClick={onCancel}
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
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <Trash2 size={18} color={C.danger ?? "#FF453A"} /> Delete Setlist
        </div>
        <div style={{ fontSize: 13.5, color: C.textMuted, lineHeight: 1.45, marginBottom: 12 }}>
          Delete <strong style={{ color: C.text }}>"{setlist.name}"</strong> permanently for the team?
        </div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 8 }}>
          Type <span style={{ color: C.danger ?? "#FF453A", fontWeight: 700 }}>delete</span> to confirm:
        </div>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Type "delete"'
          style={{
            width: "100%", height: 42, background: C.surface3,
            border: `1px solid ${isMatch ? (C.danger ?? "#FF453A") : C.border}`,
            borderRadius: 10, padding: "0 12px", color: C.text,
            fontFamily: FONT, fontSize: 15, fontWeight: 600,
            boxSizing: "border-box", outline: "none", marginBottom: 16
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isMatch) onConfirm();
          }}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onCancel}
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
            disabled={!isMatch}
            onClick={onConfirm}
            style={{
              flex: 1, height: 40, borderRadius: 10, border: "none",
              background: isMatch ? (C.danger ?? "#FF453A") : C.surface3,
              color: isMatch ? "#fff" : C.textFaint,
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: isMatch ? "pointer" : "default",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6
            }}
          >
            <Trash2 size={15} color={isMatch ? "#fff" : C.textFaint} /> Delete
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function RemoveSharedSongModal({ song, setlist, onConfirm, onCancel, C }) {
  const [input, setInput] = useState("");
  const keyboardInset = useKeyboardInset();
  const isMatch = input.trim().toLowerCase() === "delete";
  const modalRoot = useModalKeys(onCancel, undefined, !!(song && setlist));
  if (!song || !setlist) return null;
  return createPortal(
    <div
      ref={modalRoot}
      onClick={onCancel}
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
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <Trash2 size={18} color={C.danger ?? "#FF453A"} /> Remove Song
        </div>
        <div style={{ fontSize: 13.5, color: C.textMuted, lineHeight: 1.45, marginBottom: 12 }}>
          Remove <strong style={{ color: C.text }}>"{song.title}"</strong> from shared setlist <strong style={{ color: C.text }}>"{setlist.name}"</strong>?
        </div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 8 }}>
          Type <span style={{ color: C.danger ?? "#FF453A", fontWeight: 700 }}>delete</span> to confirm:
        </div>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Type "delete"'
          style={{
            width: "100%", height: 42, background: C.surface3,
            border: `1px solid ${isMatch ? (C.danger ?? "#FF453A") : C.border}`,
            borderRadius: 10, padding: "0 12px", color: C.text,
            fontFamily: FONT, fontSize: 15, fontWeight: 600,
            boxSizing: "border-box", outline: "none", marginBottom: 16
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isMatch) onConfirm();
          }}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onCancel}
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
            disabled={!isMatch}
            onClick={onConfirm}
            style={{
              flex: 1, height: 40, borderRadius: 10, border: "none",
              background: isMatch ? (C.danger ?? "#FF453A") : C.surface3,
              color: isMatch ? "#fff" : C.textFaint,
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: isMatch ? "pointer" : "default",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6
            }}
          >
            <Trash2 size={15} color={isMatch ? "#fff" : C.textFaint} /> Remove
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function NoticeDialog({ title, message, buttonLabel = "OK", onClose, C }) {
  const modalRoot = useModalKeys(onClose, () => onClose());
  return createPortal(
    <div ref={modalRoot} onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 350, background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, boxSizing: "border-box" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 360, background: C.surface2, border: `1px solid ${C.borderStrong}`, borderRadius: 16, padding: "22px 20px 20px", boxSizing: "border-box", boxShadow: "0 20px 48px rgba(0,0,0,0.7)", fontFamily: FONT }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertTriangle size={18} color={C.danger ?? "#FF453A"} /> {title}
        </div>
        <div style={{ fontSize: 13.5, color: C.textMuted, lineHeight: 1.45, marginBottom: 18 }}>{message}</div>
        <button onClick={onClose} style={{ width: "100%", height: 40, borderRadius: 10, border: "none", background: C.accent, color: "#fff", fontFamily: FONT, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>{buttonLabel}</button>
      </div>
    </div>,
    document.body
  );
}

// Two-button confirmation. Esc = cancel; Enter = the safe choice (cancel) unless `enterConfirms`.
export function ConfirmDialog({ title, message, confirmLabel, cancelLabel = "Cancel", danger, enterConfirms, onConfirm, onCancel, C }) {
  const modalRoot = useModalKeys(onCancel, enterConfirms ? () => onConfirm() : () => onCancel());
  const red = C.danger ?? "#FF453A";
  return createPortal(
    <div ref={modalRoot} onClick={onCancel} style={{ position: "fixed", inset: 0, zIndex: 350, background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, boxSizing: "border-box" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 360, background: C.surface2, border: `1px solid ${C.borderStrong}`, borderRadius: 16, padding: "22px 20px 20px", boxSizing: "border-box", boxShadow: "0 20px 48px rgba(0,0,0,0.7)", fontFamily: FONT }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 13.5, color: C.textMuted, lineHeight: 1.45, marginBottom: 18 }}>{message}</div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, height: 40, borderRadius: 10, border: `1px solid ${C.border}`, background: "transparent", color: C.text, fontFamily: FONT, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>{cancelLabel}</button>
          <button onClick={onConfirm} style={{ flex: 1, height: 40, borderRadius: 10, border: "none", background: danger ? red : C.accent, color: "#fff", fontFamily: FONT, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function LeaveTeamWarningModal({ onConfirm, onCancel, C }) {
  const modalRoot = useModalKeys(onCancel);
  return createPortal(
    <div
      ref={modalRoot}
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 350,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20, boxSizing: "border-box"
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
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertTriangle size={18} color={C.danger ?? "#FF453A"} /> Shared Setlists Will Be Deleted
        </div>
        <div style={{ fontSize: 13.5, color: C.textMuted, lineHeight: 1.45, marginBottom: 18 }}>
          You are the only member on this team. Leaving will permanently delete the shared setlists.
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onCancel}
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
            onClick={onConfirm}
            style={{
              flex: 1, height: 40, borderRadius: 10, border: "none",
              background: C.danger ?? "#FF453A", color: "#fff",
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: "pointer"
            }}
          >
            Leave & Delete
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function TeamKeyModal({ isOpen, initialKey, onSave, onClose, C }) {
  const [draft, setDraft] = useState(initialKey || "");
  const [error, setError] = useState("");
  const [showOnlyMemberWarning, setShowOnlyMemberWarning] = useState(false);
  const [pendingTargetKey, setPendingTargetKey] = useState(null);
  const keyboardInset = useKeyboardInset();
  useEffect(() => { setDraft(initialKey || ""); setError(""); setShowOnlyMemberWarning(false); setPendingTargetKey(null); }, [initialKey, isOpen]);
  const modalRoot = useModalKeys(onClose, undefined, !!isOpen);
  if (!isOpen) return null;
  const isConnected = Boolean(initialKey && initialKey.trim());
  const handleSave = async (val) => {
    const clean = val.trim().toUpperCase();
    const currentClean = (initialKey || "").trim().toUpperCase();
    setError("");
    if (isConnected && clean !== currentClean) {
      const isOnly = await checkIsOnlyTeamMember({ teamKey: currentClean, deviceId: getDeviceId() });
      if (isOnly) {
        setPendingTargetKey(clean);
        setShowOnlyMemberWarning(true);
        return;
      }
    }
    onSave(clean);
  };
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
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>
          Team Access
        </div>
        <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.45, marginBottom: 14 }}>
          Enter a team code (e.g. your church or band name) to sync shared setlists with your members. Songs & spelling chart are always shared globally.
        </div>
        <input
          autoFocus
          value={draft}
          onChange={(e) => { setDraft(e.target.value.toUpperCase()); setError(""); }}
          // Not a name / email: stop Safari and Chrome offering contacts, saved logins or autofill for it.
          type="text" name="zong-team-code" id="zong-team-code" autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false}
          aria-autocomplete="none" data-form-type="other" data-lpignore="true" data-1p-ignore="true"
          placeholder="e.g. FACA or GRACE-CHURCH"
          style={{
            width: "100%", height: 42, background: C.surface3,
            border: `1px solid ${C.border}`,
            borderRadius: 10, padding: "0 12px", color: C.text,
            fontFamily: FONT, fontSize: 15, fontWeight: 600,
            boxSizing: "border-box", outline: "none", marginBottom: error ? 12 : 16
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave(draft);
          }}
        />
        {error && (
          <div style={{ fontSize: 12.5, color: C.danger, fontWeight: 600, marginBottom: 16, paddingLeft: 2 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
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
          {isConnected && (
            <button
              onClick={() => handleSave("")}
              style={{
                flex: 1, height: 40, borderRadius: 10,
                border: `1px solid ${C.border}`, background: "transparent",
                color: C.danger ?? "#FF453A", fontFamily: FONT, fontSize: 13.5, fontWeight: 600,
                cursor: "pointer"
              }}
            >
              Leave Team
            </button>
          )}
          <button
            onClick={() => handleSave(draft)}
            style={{
              flex: 1, height: 40, borderRadius: 10, border: "none",
              background: C.accent, color: "#fff",
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: "pointer"
            }}
          >
            {isConnected && draft.trim().toUpperCase() === initialKey.trim().toUpperCase() ? "Save" : "Connect"}
          </button>
        </div>
      </div>
      {showOnlyMemberWarning && (
        <LeaveTeamWarningModal
          onConfirm={() => {
            setShowOnlyMemberWarning(false);
            onSave(pendingTargetKey ?? "");
          }}
          onCancel={() => {
            setShowOnlyMemberWarning(false);
            setPendingTargetKey(null);
          }}
          C={C}
        />
      )}
    </div>,
    document.body
  );
}

export function StageModeModal({ live, onClose, C }) {
  const { role, connected, peeked, otherLead } = live;
  const ready = connected && peeked;
  const btn = (primary, danger) => ({ width: "100%", height: 46, borderRadius: 12, border: primary ? "none" : `1px solid ${danger ? (C.danger ?? "#FF453A") : C.border}`, background: primary ? C.accent : "transparent", color: primary ? "#fff" : danger ? (C.danger ?? "#FF453A") : C.text, fontFamily: FONT, fontSize: 15, fontWeight: 700, cursor: "pointer" });
  const body = (text) => <div style={{ fontSize: 13.5, color: C.textMuted, lineHeight: 1.45, marginBottom: 16 }}>{text}</div>;
  let content;
  if (role === "lead") {
    content = (<>
      {body(connected ? "You're leading. Everyone in Stage Mode follows the section you're on." : "Reconnecting… the others will catch up as soon as you're back.")}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button onClick={() => { live.start(false); onClose(); }} style={btn(false)}>Stop leading</button>
        <button onClick={() => { live.close(); onClose(); }} style={btn(false, true)}>Leave Stage Mode</button>
      </div>
    </>);
  } else if (role === "follow") {
    content = (<>
      {body(connected ? (otherLead ? "You're following the lead's section." : "Waiting for someone to lead…") : "Reconnecting…")}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button onClick={() => { live.start(true); onClose(); }} style={btn(false)}>Take over as lead</button>
        <button onClick={() => { live.close(); onClose(); }} style={btn(false, true)}>Leave Stage Mode</button>
      </div>
    </>);
  } else if (!ready) {
    content = body("Looking for your band…");
  } else if (otherLead) {
    content = (<>
      {body("Someone is already leading. Follow along to stay on the same section.")}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button onClick={() => { live.start(false); onClose(); }} style={btn(true)}>Follow along</button>
        <button onClick={() => { live.start(true); onClose(); }} style={btn(false)}>Take over as lead</button>
      </div>
    </>);
  } else {
    content = (<>
      {body("Will you lead? The leader moves through the sections and every other device follows.")}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button onClick={() => { live.start(true); onClose(); }} style={btn(true)}>Yes, I'll lead</button>
        <button onClick={() => { live.start(false); onClose(); }} style={btn(false)}>No, follow along</button>
      </div>
    </>);
  }
  const dismiss = () => { if (role === "off") live.close(); onClose(); };
  // Enter = the highlighted (primary) button of whichever state the dialog is in.
  const primaryAction = role !== "off" || !ready ? null : otherLead ? () => { live.start(false); onClose(); } : () => { live.start(true); onClose(); };
  const modalRoot = useModalKeys(dismiss, primaryAction ? () => primaryAction() : undefined);
  return createPortal(
    <div ref={modalRoot} onClick={dismiss} style={{ position: "fixed", inset: 0, zIndex: 350, background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, boxSizing: "border-box" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 360, background: C.surface2, border: `1px solid ${C.borderStrong}`, borderRadius: 16, padding: "22px 20px 20px", boxSizing: "border-box", boxShadow: "0 20px 48px rgba(0,0,0,0.7)", fontFamily: FONT }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>Stage Mode</div>
        {content}
        {role === "off" && <button onClick={dismiss} style={{ ...btn(false), marginTop: 10, border: "none", color: C.textMuted, height: 36, fontSize: 13.5, fontWeight: 600 }}>Cancel</button>}
      </div>
    </div>,
    document.body
  );
}
