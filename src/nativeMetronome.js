/**
 * nativeMetronome.js
 *
 * Thin adapter between the React metronome and the native NativeMetronome
 * Capacitor plugin (iOS app only). On the web/PWA `isNativePlatform()` is false
 * and the Web Audio engine in App.jsx is used instead.
 *
 * The native side is the source of truth for whether the metronome is playing:
 * it publishes "state" events (start, stop, audio interruption, lock-screen
 * buttons) and "beat" events driven by the audio clock.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

const native = Capacitor.isNativePlatform();
const Plugin = native ? registerPlugin("NativeMetronome") : null;

if (native) {
  // The iOS app must never show a "Now Playing" media card for the web view (it would be
  // titled "localhost"): the native engine and the Live Activity own the lock-screen UI.
  try {
    if (navigator.mediaSession) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    }
  } catch { /* unsupported */ }
}

// Synchronous: Capacitor knows the platform at load time.
export function isNativePlatform() { return native; }

// Registers a listener and returns a remover that is safe to call even before
// the (async) registration has finished — otherwise listeners would leak and
// fire several times.
function listen(event, handler) {
  if (!Plugin) return () => {};
  let removed = false;
  let handle = null;
  Plugin.addListener(event, handler).then((h) => {
    if (removed) h.remove(); else handle = h;
  });
  return () => { removed = true; if (handle) { handle.remove(); handle = null; } };
}

export const nativeMetronome = {
  /** { bpm, beatsPerBar, accents, subdivision, title } */
  start(settings) { return Plugin?.start(settings); },   // resolves { playing }
  /** Applies new settings while playing (restarts the bar only if something changed). */
  update(settings) { return Plugin?.update(settings); },
  stop() { return Plugin?.stop(); },                       // resolves { playing }
  /** Resolves { playing, bpm } */
  async getState() { return (await Plugin?.getState()) ?? { playing: false }; },
  /** handler({ beatIndex }) */
  addBeatListener(handler) { return listen("beat", handler); },
  /** handler({ playing }) */
  addStateListener(handler) { return listen("state", handler); },
  /** handler({ bpm }) — tempo changed by the lock-screen +/- buttons */
  addTempoListener(handler) { return listen("tempo", handler); },
};

// Piano / pad chord voices are rendered by the native engine in the iOS app (Web Audio there
// was muted by the phone's silent switch). Fire-and-forget: a key press must never wait.
const quiet = () => {};
export const nativePiano = {
  noteOn(id, midi) { Plugin?.pianoNoteOn({ id, midi })?.catch(quiet); },
  padOn(id, root, minor) { Plugin?.padOn({ id, root, minor })?.catch(quiet); },
  // The joystick's chords: the MIDI note of each voice (root, third, fifth, root an octave up, 7th / 9th, slash bass; -1 = not used).
  padChordOn(id, root, third, fifth, octave, extra, bass) { Plugin?.padChordOn({ id, root, third, fifth, octave, extra, bass })?.catch(quiet); },
  // Warm-pad samples (public/tones/pad_*.mp3): ask once whether the iOS engine has them, then play each note of a chord.
  padSamplesReady() { return Plugin?.padSamplesReady ? Plugin.padSamplesReady().then((r) => !!r?.ready).catch(() => false) : Promise.resolve(false); },
  padSampleOn(id, midi, gain, pan) { Plugin?.padSampleOn({ id, midi, gain, pan })?.catch(quiet); },
  noteOff(id) { Plugin?.pianoNoteOff({ id })?.catch(quiet); },
  allOff() { Plugin?.pianoAllOff()?.catch(quiet); },
};
