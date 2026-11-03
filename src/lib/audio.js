// Shared Web Audio context, piano / metronome sample loading, silent-switch unlock.
import { isNativePlatform } from "../nativeMetronome";

export const SILENT_VIDEO_SRC = "data:video/mp4;base64,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";

// Shared iOS audio-unlock hack: playing a muted silent video from within a
// user-gesture call stack unlocks WebAudio playback for the whole page
// (including when the ring/silent switch is on, or the app is opened
// standalone from the home screen). Previously only PianoScreen did this
// locally, so the metronome stayed silent until the user visited Piano and
// pressed a key. Calling this once, from any first gesture, unlocks audio
// for every audio-producing feature in the app.
let __sharedSilentVideoEl = null;

let __audioUnlocked = false;

export function unlockAudioPlayback() {
  // The native app owns the audio session (AVAudioSession .playback); this
  // PWA-only workaround would only fight it.
  if (isNativePlatform()) return;
  if (__audioUnlocked) return;
  __audioUnlocked = true;
  try {
    if (!__sharedSilentVideoEl) {
      const v = document.createElement("video");
      v.src = SILENT_VIDEO_SRC;
      // Deliberately NOT muted: iOS only promotes the page's audio session
      // to the "playback" category (which ignores the hardware silent
      // switch) for an actually-playing, unmuted video element. A muted
      // video doesn't trigger that promotion, so the metronome/piano would
      // stay silent whenever the phone's silent switch was on — this was
      // the root cause of audio sometimes not playing.
      v.muted = false;
      v.volume = 0.01;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute("loop", "");
      v.setAttribute("playsinline", "");
      v.setAttribute("webkit-playsinline", "");
      v.style.position = "fixed";
      v.style.width = "1px";
      v.style.height = "1px";
      v.style.opacity = "0";
      v.style.pointerEvents = "none";
      // Belt-and-braces: if the loop attribute ever fails to hold (some
      // WebViews drop it after backgrounding/foregrounding), explicitly
      // restart on "ended" so the audio session never silently drops back
      // to a category the hardware mute switch can interrupt mid-session.
      v.addEventListener("ended", () => {
        v.currentTime = 0;
        v.play().catch(() => { });
      });
      document.body.appendChild(v);
      __sharedSilentVideoEl = v;
    }
    __sharedSilentVideoEl.loop = true;
    __sharedSilentVideoEl.play().catch(() => { __audioUnlocked = false; });
  } catch {
    __audioUnlocked = false;
  }
}

/* =========================================================================
   Shared Audio Assets & Loader (Piano samples & Metronome WAVs)
   ========================================================================= */
let _sharedAudioCtx = null;

export function getSharedAudioContext() {
  if (!_sharedAudioCtx || _sharedAudioCtx.state === "closed") {
    const AudioCtxCls = window.AudioContext || window.webkitAudioContext;
    try {
      _sharedAudioCtx = new AudioCtxCls({ latencyHint: "interactive", sampleRate: 44100 });
    } catch {
      _sharedAudioCtx = new AudioCtxCls({ latencyHint: "interactive" });
    }
    // Safety net: whenever iOS interrupts the context and the app is on screen, bring it back.
    const ctx = _sharedAudioCtx;
    ctx.addEventListener("statechange", () => {
      if (ctx.state === "interrupted" && document.visibilityState === "visible") ctx.resume().catch(() => { });
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && ctx.state === "interrupted") ctx.resume().catch(() => { });
    });
  }
  return _sharedAudioCtx;
}

const PIANO_SAMPLE_DEFS = [
  { name: "C2", midi: 36 }, { name: "Ds2", midi: 39 }, { name: "Fs2", midi: 42 }, { name: "A2", midi: 45 },
  { name: "C3", midi: 48 }, { name: "Ds3", midi: 51 }, { name: "Fs3", midi: 54 }, { name: "A3", midi: 57 },
  { name: "C4", midi: 60 }, { name: "Ds4", midi: 63 }, { name: "Fs4", midi: 66 }, { name: "A4", midi: 69 },
];

let _nativeNoteId = 0;
export const nextNativeNoteId = () => ++_nativeNoteId;

// unique id per native piano voice
export let _pianoBuffers = null;

// { [name]: { buffer: AudioBuffer, midi: number } }
export let _metronomeBuffers = null;

// { hi: AudioBuffer, low: AudioBuffer }
let _audioLoadingPromise = null;

export function loadAudioSamples(ctx) {
  if (_audioLoadingPromise) return _audioLoadingPromise;
  _audioLoadingPromise = (async () => {
    const pianoPromises = PIANO_SAMPLE_DEFS.map(async ({ name, midi }) => {
      try {
        const res = await fetch(`/tones/${name}.mp3`);
        const ab = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab);
        return { name, midi, buf };
      } catch (err) {
        return { name, midi, buf: null };
      }
    });

    const mHiPromise = fetch("/tones/m_hi.wav")
      .then(r => r.arrayBuffer())
      .then(ab => ctx.decodeAudioData(ab))
      .catch(() => null);

    const mLowPromise = fetch("/tones/m_low.wav")
      .then(r => r.arrayBuffer())
      .then(ab => ctx.decodeAudioData(ab))
      .catch(() => null);

    const [pianoResults, mHi, mLow] = await Promise.all([
      Promise.all(pianoPromises),
      mHiPromise,
      mLowPromise,
    ]);

    const pMap = {};
    pianoResults.forEach(({ name, midi, buf }) => {
      if (buf) pMap[name] = { buffer: buf, midi };
    });
    _pianoBuffers = pMap;
    _metronomeBuffers = { hi: mHi, low: mLow };
    return { piano: _pianoBuffers, metronome: _metronomeBuffers };
  })();
  return _audioLoadingPromise;
}

export function findNearestPianoSample(midi) {
  if (!_pianoBuffers) return null;
  let best = null;
  let minDist = Infinity;
  for (const def of PIANO_SAMPLE_DEFS) {
    const entry = _pianoBuffers[def.name];
    if (!entry) continue;
    const dist = Math.abs(midi - def.midi);
    if (dist < minDist) {
      minDist = dist;
      best = entry;
    }
  }
  return best;
}
