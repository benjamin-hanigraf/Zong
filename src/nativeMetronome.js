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
  // Keep WebKit's own audio (piano) on the "playback" category so it never
  // switches the shared session to one the silent switch can mute.
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* unsupported */ }
}

// Synchronous: Capacitor knows the platform at load time.
export function isNativePlatform() { return native; }
export async function initNativeMetronome() { return native; }

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
  /** { bpm, beatsPerBar, accents, subdivision } */
  start(settings) { return Plugin?.start(settings); },   // resolves { playing }
  /** Applies new settings while playing (restarts the bar only if something changed). */
  update(settings) { return Plugin?.update(settings); },
  stop() { return Plugin?.stop(); },                       // resolves { playing }
  setVolume({ volume }) { return Plugin?.setVolume({ volume }); },
  async getState() { return (await Plugin?.getState())?.playing ?? false; },
  /** handler({ beatIndex }) */
  addBeatListener(handler) { return listen("beat", handler); },
  /** handler({ playing }) */
  addStateListener(handler) { return listen("state", handler); },
};
