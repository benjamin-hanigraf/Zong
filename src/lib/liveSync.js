// Stage Mode hook: one device leads, the rest follow, over the Team realtime channel.
import { isSupabaseConfigured, joinLiveSync } from "../supabaseSync";
import { useEffect, useRef, useState } from "react";
import { getDeviceId } from "./device.js";

/* =========================================================================
   Root
   ========================================================================= */

/* =========================================================================
   Stage Mode (live section sync over the Team's realtime channel)
   One device leads, the rest follow. The lead's position (song + section) is broadcast; followers
   jump to it. See joinLiveSync in supabaseSync.js for the transport.
   ========================================================================= */
export function useLiveSync({ teamKey, onApply }) {
  const [role, setRole] = useState("off");          // "off" | "lead" | "follow"
  const [connected, setConnected] = useState(false);
  const [peeked, setPeeked] = useState(false);       // presence has been read at least once
  const [otherLead, setOtherLead] = useState(false); // another device is leading
  const ctl = useRef(null);
  const roleRef = useRef("off");
  const posRef = useRef(null);
  const peersRef = useRef(0);   // other devices on the channel
  const lastSig = useRef("");
  const applyRef = useRef(onApply);
  applyRef.current = onApply;
  const deviceId = getDeviceId();
  const available = Boolean(teamKey) && isSupabaseConfigured();

  const changeRole = (next) => { roleRef.current = next; setRole(next); };
  const close = () => {
    if (ctl.current) { try { ctl.current.leave(); } catch { /* ignore */ } ctl.current = null; }
    changeRole("off"); setConnected(false); setPeeked(false); setOtherLead(false);
    lastSig.current = "";
  };
  // Opens the channel without taking a role, so the Stage Mode dialog can see whether someone already leads.
  const open = () => {
    if (ctl.current || !available) return;
    setPeeked(false);
    ctl.current = joinLiveSync({
      teamKey, deviceId,
      onStatus: (st) => {
        setConnected(st === "SUBSCRIBED");
        if (st === "SUBSCRIBED") {
          if (roleRef.current === "follow") ctl.current?.ask();
          if (roleRef.current === "lead" && posRef.current) ctl.current?.sendPosition(posRef.current);
        }
      },
      onPeers: (n) => { peersRef.current = n; },
      onLeads: (leads) => {
        setPeeked(true);
        setOtherLead(leads.some((l) => l.deviceId !== deviceId));
        const top = [...leads].sort((a, b) => b.since - a.since || (a.deviceId < b.deviceId ? 1 : -1))[0];
        if (roleRef.current === "lead" && top && top.deviceId !== deviceId) {   // someone took over
          ctl.current?.setLead(false); changeRole("follow"); ctl.current?.ask();
        }
      },
      onPosition: (pos) => {
        if (roleRef.current !== "follow" || !pos) return;
        const sig = JSON.stringify([pos.songId, pos.setlistId, pos.sectionKey, pos.sectionIdx]);
        if (sig === lastSig.current) return;      // the lead's regular re-send: nothing new, don't pull anyone back
        if (applyRef.current(pos)) lastSig.current = sig;
      },
      onAsk: () => { if (roleRef.current === "lead" && posRef.current) ctl.current?.sendPosition(posRef.current); },
      onPeerJoined: () => { setTimeout(() => { if (roleRef.current === "lead" && posRef.current) ctl.current?.sendPosition(posRef.current); }, 800); },
    });
  };
  const start = (asLead) => {
    open();
    if (!ctl.current) return;
    lastSig.current = "";
    if (asLead) { ctl.current.setLead(true); changeRole("lead"); }
    else { ctl.current.setLead(false); changeRole("follow"); ctl.current.ask(); }
  };
  const publish = (pos) => {
    posRef.current = pos;
    if (roleRef.current === "lead") ctl.current?.sendPosition(pos);
  };
  // Every move is sent instantly (publish). On top of that the lead repeats its position now and then so a device
  // that dropped out lands in the right place — only while someone else is listening, and sparingly to save data.
  useEffect(() => {
    if (role !== "lead") return undefined;
    const t = setInterval(() => { if (posRef.current && peersRef.current > 0) ctl.current?.sendPosition(posRef.current); }, 12000);
    return () => clearInterval(t);
  }, [role]);
  useEffect(() => close, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { close(); }, [teamKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return { available, role, connected, peeked, otherLead, open, close, start, publish };
}
