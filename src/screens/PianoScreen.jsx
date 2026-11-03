// Piano / Chord Piano tab.
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { isNativePlatform, nativePiano } from "../nativeMetronome";
import { useEffect, useRef, useState } from "react";
import { FONT } from "../lib/constants.js";
import { SILENT_VIDEO_SRC, _pianoBuffers, nextNativeNoteId, findNearestPianoSample, getSharedAudioContext, loadAudioSamples, unlockAudioPlayback } from "../lib/audio.js";
import { LandscapeLock } from "../components/LandscapeLock.jsx";
import { ChordJoystick } from "../components/ChordJoystick.jsx";
import { padVoicing } from "../lib/chords.js";
import { PieIcon } from "../components/shared.jsx";

const WHITE_KEY_BG = "#F2F1EC";

// filled in per-mode below (needs accent colour)
const BLACK_KEY_BG = "#0A0A0A";

const WHITE_KEYS = [
  { name: "C", semitone: 0 }, { name: "D", semitone: 2 }, { name: "E", semitone: 4 },
  { name: "F", semitone: 5 }, { name: "G", semitone: 7 }, { name: "A", semitone: 9 }, { name: "B", semitone: 11 },
];

const BLACK_KEYS = [
  { name: "C#", semitone: 1, afterWhiteIndex: 0 },
  { name: "D#", semitone: 3, afterWhiteIndex: 1 },
  { name: "F#", semitone: 6, afterWhiteIndex: 3 },
  { name: "G#", semitone: 8, afterWhiteIndex: 4 },
  { name: "A#", semitone: 10, afterWhiteIndex: 5 },
];

export function PianoScreen({ C, mode, loadedQuality, onQualityChange, highlightSemitone = null, joystickOn = false, onJoystickToggle, joystickRemote = null, joystickKey = null, onJoystickState, onLeaveStage }) {
  const [octaveStart, setOctaveStartState] = useState(4);
  const octaveStartRef = useRef(4);
  const masterCompRef = useRef(null);
  // pointerId -> { semitone, voice, padVoice, keyEl }
  const activeRef = useRef(new Map());
  const containerRef = useRef(null);
  const silentVideoRef = useRef(null);
  const videoUnlockedRef = useRef(false);
  const isVocals = mode === "vocals";
  // Chords mode: the joystick chord piano instead of the keyboard — switched on here, or (following a Stage Mode leader) from outside.
  const followingJoystick = mode === "chords" && !!joystickRemote?.on;
  const joystick = mode === "chords" && (joystickOn || followingJoystick);
  const [chordQuality, setChordQuality] = useState(loadedQuality || "Major");
  const chordQualityRef = useRef(loadedQuality || "Major");


  useEffect(() => {
    if (loadedQuality && loadedQuality !== chordQuality) {
      setChordQuality(loadedQuality);
    }
  }, [loadedQuality]);

  useEffect(() => {
    chordQualityRef.current = chordQuality;
    if (onQualityChange) onQualityChange(chordQuality);
  }, [chordQuality]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { octaveStartRef.current = octaveStart; }, [octaveStart]);
  const setOctaveStart = (n) => setOctaveStartState(Math.min(5, Math.max(3, n)));

  const WHITE_PRESSED = C.accent;
  const BLACK_PRESSED = C.accent;

  const ensureCtx = () => {
    const ctx = getSharedAudioContext();
    if (!masterCompRef.current || masterCompRef.current.context !== ctx) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-12, ctx.currentTime);
      comp.knee.setValueAtTime(8, ctx.currentTime);
      comp.ratio.setValueAtTime(3.0, ctx.currentTime);
      comp.attack.setValueAtTime(0.006, ctx.currentTime);
      comp.release.setValueAtTime(0.22, ctx.currentTime);
      comp.connect(ctx.destination);
      masterCompRef.current = comp;
    }
    // iOS can leave the context "interrupted" (not just "suspended") after another audio
    // session — e.g. the native metronome, a call, a notification — took the output.
    // Resume from either state, otherwise the piano stays silent until iOS recovers by itself.
    if (ctx.state !== "running") ctx.resume().catch(() => { });
    if (!videoUnlockedRef.current && silentVideoRef.current) {
      videoUnlockedRef.current = true;
      silentVideoRef.current.play().catch(() => { videoUnlockedRef.current = false; });
    }
    return ctx;
  };

  useEffect(() => {
    // In the iOS app the native engine plays the piano: no Web Audio context is created at all.
    if (isNativePlatform()) return;
    const ctx = ensureCtx();
    if (!_pianoBuffers || Object.keys(_pianoBuffers).length === 0) loadAudioSamples(ctx).catch(() => { });
  }, []);

  const midiFor = (semitone) => (octaveStartRef.current + 1) * 12 + semitone;

  const releaseVoice = (voice) => {
    if (voice && voice.nativeId) { nativePiano.noteOff(voice.nativeId); return; }
    if (!voice || !voice.ctx) return;
    const { gainNode, source, ctx } = voice;
    const now = ctx.currentTime;
    try {
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(gainNode.gain.value, now);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
      try { source.stop(now + 0.32); } catch { }
    } catch { }
  };

  const startNote = (semitone) => {
    if (isNativePlatform()) {
      const nativeId = nextNativeNoteId();
      nativePiano.noteOn(nativeId, midiFor(semitone));
      return { nativeId, semitone };
    }
    const ctx = ensureCtx();
    const now = ctx.currentTime;
    const dest = masterCompRef.current || ctx.destination;
    const midi = midiFor(semitone);
    const nearest = findNearestPianoSample(midi);

    const gainNode = ctx.createGain();
    const baseGain = isVocals ? 1.5 : 1.0;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(baseGain, now + 0.008);
    gainNode.connect(dest);

    if (nearest && nearest.buffer) {
      const semitoneDiff = midi - nearest.midi;
      const source = ctx.createBufferSource();
      source.buffer = nearest.buffer;
      source.playbackRate.value = Math.pow(2, semitoneDiff / 12);
      source.connect(gainNode);
      source.start(now);
      source.onended = () => {
        try { source.disconnect(); gainNode.disconnect(); } catch { }
      };
      return { source, gainNode, ctx, semitone, midi };
    } else {
      const osc = ctx.createOscillator();
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      osc.frequency.value = freq;
      osc.connect(gainNode);
      osc.start(now);
      osc.onended = () => {
        try { osc.disconnect(); gainNode.disconnect(); } catch { }
      };
      return { source: osc, gainNode, ctx, semitone, midi };
    }
  };

  // --- Warm pad chord voice for Vocals mode (High volume, clean harmonics) ---
  // spec (optional) = { third, fifth, seventh, bass } for the joystick's chords (7th, aug, dim, slash …); without it
  // this is the plain major / minor pad of the Vocals chord piano, unchanged.
  const startPadChord = (rootSemitone, spec) => {
    if (isNativePlatform()) {
      const nativeId = nextNativeNoteId();
      if (spec) { const v = padVoicing(spec); nativePiano.padChordOn(nativeId, v.root, v.third, v.fifth, v.octave, v.extra, v.bass); }
      else nativePiano.padOn(nativeId, rootSemitone, chordQualityRef.current === "Minor");
      return { nativeId };
    }
    const ctx = ensureCtx();
    const now = ctx.currentTime;
    const dest = masterCompRef.current || ctx.destination;
    const quality = chordQualityRef.current;

    const baseMidi = 48 + rootSemitone; // C3 to B3
    const thirdInterval = quality === "Minor" ? 3 : 4;

    // Vocals chord piano: the original open voicing, unchanged. The joystick's chords (spec) use padVoicing:
    // close voicing in a fixed register, same voices / filters / pans, just placed closer together.
    let notes;
    if (spec) {
      const v = padVoicing(spec);
      notes = [
        { midi: v.root, gain: 0.28, cutoff: 800, detune: 0, pan: -0.30 },
        { midi: v.fifth, gain: 0.18, cutoff: 1600, detune: 5, pan: 0.25 },
        v.octave >= 0 && { midi: v.octave, gain: 0.32, cutoff: 1800, detune: 6, pan: 0.00 },
        { midi: v.third, gain: 0.20, cutoff: 2000, detune: 5, pan: 0.20 },
        v.extra >= 0 && { midi: v.extra, gain: 0.16, cutoff: 2000, detune: 5, pan: -0.15 },
        v.bass >= 0 && { midi: v.bass, gain: 0.28, cutoff: 700, detune: 0, pan: -0.10 },
      ].filter(Boolean);
    } else {
      notes = [
        { midi: baseMidi, gain: 0.28, cutoff: 800, detune: 0 },
        { midi: baseMidi + 7, gain: 0.18, cutoff: 1600, detune: 5 },
        { midi: baseMidi + 12, gain: 0.32, cutoff: 1800, detune: 6 },
        { midi: baseMidi + 12 + thirdInterval, gain: 0.20, cutoff: 2000, detune: 5 },
      ];
    }

    const masterFilter = ctx.createBiquadFilter();
    masterFilter.type = "lowpass";
    masterFilter.frequency.value = 2400;
    masterFilter.Q.value = 0.5;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0, now);
    // Vocals volume boost: 0.48 (clear, loud, doesn't clip)
    masterGain.gain.linearRampToValueAtTime(0.48, now + 0.08);
    masterFilter.connect(masterGain);
    masterGain.connect(dest);

    const panValues = [-0.30, 0.25, 0.00, 0.20, -0.15, -0.10];
    const oscs = [];

    notes.forEach(({ midi, gain: noteGainVal, cutoff, detune, pan }, idx) => {
      const freq = 440 * Math.pow(2, (midi - 69) / 12);

      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = cutoff;
      filt.Q.value = 0.4;

      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (panner) panner.pan.value = pan ?? panValues[idx] ?? 0;

      const noteGain = ctx.createGain();
      noteGain.gain.value = noteGainVal;

      if (panner) {
        filt.connect(panner);
        panner.connect(noteGain);
      } else {
        filt.connect(noteGain);
      }
      noteGain.connect(masterFilter);

      const detunes = detune > 0 ? [-detune / 2, detune / 2] : [0];
      detunes.forEach((dt) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        osc.detune.value = dt;
        osc.connect(filt);
        osc.start(now);
        oscs.push(osc);
      });

      if (idx > 0) {
        const airGain = ctx.createGain();
        airGain.gain.value = noteGainVal * 0.08;
        const airFilt = ctx.createBiquadFilter();
        airFilt.type = "lowpass";
        airFilt.frequency.value = Math.min(cutoff * 1.4, 3000);
        airFilt.Q.value = 0.4;
        const airOsc = ctx.createOscillator();
        airOsc.type = "sine";
        airOsc.frequency.value = freq * 2;
        airOsc.connect(airFilt);
        airFilt.connect(airGain);
        airGain.connect(masterFilter);
        airOsc.start(now);
        oscs.push(airOsc);
      }
    });

    return { masterGain, oscillators: oscs };
  };

  const stopPadChord = (padVoice) => {
    if (!padVoice) return;
    if (padVoice.nativeId) { nativePiano.noteOff(padVoice.nativeId); return; }
    const ctx = getSharedAudioContext();
    const now = ctx.currentTime;
    try {
      padVoice.masterGain.gain.cancelScheduledValues(now);
      padVoice.masterGain.gain.setValueAtTime(padVoice.masterGain.gain.value, now);
      padVoice.masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
      padVoice.oscillators.forEach((osc) => { try { osc.stop(now + 0.30); } catch { } });
    } catch { }
  };

  const keyAt = (x, y) => {
    const hitEl = document.elementFromPoint(x, y);
    if (!hitEl) return null;
    const keyEl = hitEl.closest && hitEl.closest("[data-semitone]");
    if (!keyEl || !containerRef.current || !containerRef.current.contains(keyEl)) return null;
    return { semitone: parseInt(keyEl.dataset.semitone, 10), el: keyEl };
  };

  const paintKeyRef = useRef(null);
  const paintKey = (keyEl, pressed) => {
    if (!keyEl) return;
    const isBlack = keyEl.dataset.black === "1";
    keyEl.style.background = pressed ? (isBlack ? BLACK_PRESSED : WHITE_PRESSED) : (isBlack ? BLACK_KEY_BG : WHITE_KEY_BG);
  };
  // Keep a stable ref to paintKey so that the pointermove useEffect (which
  // only re-runs when isVocals changes) always calls the latest version and
  // never applies a stale accent colour from a previous mode render.
  paintKeyRef.current = paintKey;

  const handlePointerDown = (e) => {
    e.preventDefault();
    const hit = keyAt(e.clientX, e.clientY);
    if (!hit) return;
    unlockAudioPlayback();
    if (isVocals) {
      activeRef.current.forEach((entry) => {
        if (entry.padVoice) stopPadChord(entry.padVoice);
        else if (entry.voice) releaseVoice(entry.voice);
        paintKey(entry.keyEl, false);
      });
      activeRef.current.clear();

      const padVoice = startPadChord(hit.semitone);
      activeRef.current.set(e.pointerId, { semitone: hit.semitone, padVoice, voice: null, keyEl: hit.el });
    } else {
      const voice = startNote(hit.semitone);
      activeRef.current.set(e.pointerId, { semitone: hit.semitone, voice, padVoice: null, keyEl: hit.el });
    }
    paintKey(hit.el, true);
  };

  useEffect(() => {
    const activeVoices = activeRef.current;   // the Map is created once and never replaced
    const stopEntry = (entry) => {
      if (!entry) return;
      if (entry.padVoice) stopPadChord(entry.padVoice);
      else if (entry.voice) releaseVoice(entry.voice);
    };

    const handleMove = (e) => {
      const entry = activeRef.current.get(e.pointerId);
      if (!entry) return;
      e.preventDefault();
      const hit = keyAt(e.clientX, e.clientY);
      const newSemitone = hit ? hit.semitone : null;
      if (newSemitone === entry.semitone) return;
      stopEntry(entry);
      paintKeyRef.current(entry.keyEl, false);
      if (hit) {
        if (isVocals) {
          const padVoice = startPadChord(hit.semitone);
          activeRef.current.set(e.pointerId, { semitone: hit.semitone, padVoice, voice: null, keyEl: hit.el });
        } else {
          const voice = startNote(hit.semitone);
          activeRef.current.set(e.pointerId, { semitone: hit.semitone, voice, padVoice: null, keyEl: hit.el });
        }
        paintKeyRef.current(hit.el, true);
      } else {
        activeRef.current.delete(e.pointerId);
      }
    };

    const handleUp = (e) => {
      const entry = activeRef.current.get(e.pointerId);
      if (!entry) return;
      paintKeyRef.current(entry.keyEl, false);
      stopEntry(entry);
      activeRef.current.delete(e.pointerId);
    };

    const handleVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      activeRef.current.forEach((entry) => {
        if (entry.padVoice) stopPadChord(entry.padVoice);
        else if (entry.voice) releaseVoice(entry.voice);
      });
      activeRef.current.clear();
      if (isNativePlatform()) { nativePiano.allOff(); return; }
      const ctx = getSharedAudioContext();
      if (ctx && ctx.state === "running") ctx.suspend().catch(() => { });
    };

    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      document.removeEventListener("visibilitychange", handleVisibility);
      activeVoices.forEach((entry) => {
        if (entry.padVoice) stopPadChord(entry.padVoice);
        else if (entry.voice) releaseVoice(entry.voice);
      });
      activeVoices.clear();
    };
  }, [isVocals]);

  // The song's key (set by swiping a song into the piano): a soft accent glow rising from the bottom edge, fading out a third of the way up.
  const keyGlow = (semitone) => (semitone === highlightSemitone
    ? <div aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "33%", borderRadius: "inherit", pointerEvents: "none", background: `linear-gradient(to top, ${C.accent}59, ${C.accent}00)` }} />
    : null);

  const renderOctaveKeys = () => (
    <>
      <div style={{ position: "absolute", inset: 0, display: "flex" }}>
        {WHITE_KEYS.map((k) => (
          <div key={k.semitone} data-semitone={k.semitone} data-black="0" style={{
            position: "relative", flex: 1, background: WHITE_KEY_BG, borderRight: "1px solid rgba(0,0,0,0.25)",
            display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 12, boxSizing: "border-box",
          }}>
            <span style={{ fontSize: isVocals ? 14 : 12, fontWeight: 700, color: "rgba(0,0,0,0.42)" }}>{k.name}</span>{keyGlow(k.semitone)}
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {BLACK_KEYS.map((k) => {
          const boundaryPct = ((k.afterWhiteIndex + 1) / 7) * 100;
          const widthPct = (0.62 / 7) * 100;
          const leftPct = boundaryPct - widthPct / 2;
          return (
            <div key={k.semitone} data-semitone={k.semitone} data-black="1" style={{
              position: "absolute", top: 0, height: "58%", left: `${leftPct}%`, width: `${widthPct}%`,
              background: BLACK_KEY_BG, borderRadius: "0 0 4px 4px", pointerEvents: "auto", boxShadow: "0 3px 6px rgba(0,0,0,0.5)",
              display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 10, boxSizing: "border-box",
            }}>
              <span style={{ fontSize: isVocals ? 11.5 : 10, fontWeight: 700, color: "rgba(255,255,255,0.70)" }}>{k.name}</span>{keyGlow(k.semitone)}
            </div>
          );
        })}
      </div>
    </>
  );

  const pianoBody = (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", fontFamily: FONT, color: C.text }}>
      <div style={{ height: 56, flexShrink: 0, display: "flex", alignItems: "center", padding: "0 16px", gap: 10, boxSizing: "border-box", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            {isVocals ? "Chord Piano" : "Piano"}
          </div>
          {mode === "chords" && !followingJoystick && (
            <button onClick={() => onJoystickToggle?.()} aria-label={joystick ? "Back to the piano keys" : "Joystick chord piano"} title={joystick ? "Piano keys" : "Joystick chord piano"} style={{
              width: 32, height: 32, borderRadius: "50%", border: `1px solid ${joystick ? C.accent : C.borderStrong}`, background: joystick ? C.accentSoft : C.surface2,
              color: joystick ? C.accent : C.text, display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <PieIcon size={17} />
            </button>
          )}
        </div>
        {isVocals ? (
          <div style={{ display: "flex", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 3, gap: 4 }}>
            {["Major", "Minor"].map((q) => {
              const active = chordQuality === q;
              return (
                <button
                  key={q}
                  onClick={() => setChordQuality(q)}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 7,
                    border: "none",
                    fontFamily: FONT,
                    fontSize: 13,
                    fontWeight: 700,
                    background: active ? C.accentSoft : "transparent",
                    color: active ? C.accent : C.textMuted,
                    cursor: "pointer",
                    transition: "all 150ms ease"
                  }}
                >
                  {q}
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {followingJoystick && (
              <button onClick={() => onLeaveStage?.()} aria-label="Leave Stage Mode" title="Leave Stage Mode" style={{
                width: 32, height: 32, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, background: C.surface2, color: C.textMuted, display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <X size={16} />
              </button>
            )}
            {!joystick && <>
            <button onClick={() => setOctaveStart(octaveStart - 1)} disabled={octaveStart <= 3} style={{
              width: 32, height: 32, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, background: C.surface2,
              color: C.text, display: "flex", alignItems: "center", justifyContent: "center", opacity: octaveStart <= 3 ? 0.35 : 1,
            }}>
              <ChevronLeft size={15} />
            </button>
            <div style={{ fontSize: 13.5, fontWeight: 700, minWidth: 26, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{octaveStart - 4 === 0 ? "0" : octaveStart - 4 > 0 ? `+${octaveStart - 4}` : `${octaveStart - 4}`}</div>
            <button onClick={() => setOctaveStart(octaveStart + 1)} disabled={octaveStart >= 5} style={{
              width: 32, height: 32, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, background: C.surface2,
              color: C.text, display: "flex", alignItems: "center", justifyContent: "center", opacity: octaveStart >= 5 ? 0.35 : 1,
            }}>
              <ChevronRight size={15} />
            </button>
            </>}
          </div>
        )}
      </div>

      {joystick ? (
        <ChordJoystick C={C} playPad={(spec) => startPadChord(spec.root, spec)} stopPad={stopPadChord} loadKey={joystickKey} onState={onJoystickState} readOnly={followingJoystick} remote={joystickRemote} />
      ) : (
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        style={{ flex: 1, position: "relative", touchAction: "none", overflow: "hidden" }}
      >
        {renderOctaveKeys()}
      </div>
      )}
    </div>
  );

  return (
    <div style={{ height: "100%" }}>
      {!isNativePlatform() && <video
        ref={silentVideoRef}
        src={SILENT_VIDEO_SRC}
        loop
        playsInline
        muted={false}
        volume={0.01}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
      />}
      <LandscapeLock>{pianoBody}</LandscapeLock>
    </div>
  );
}
