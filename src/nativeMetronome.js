/**
 * nativeMetronome.js
 *
 * Thin adapter layer between the React metronome engine and the native
 * NativeMetronome Capacitor plugin (iOS only).
 *
 * Usage:
 *   import { isNative, nativeMetronome } from './nativeMetronome';
 *
 *   if (isNative) {
 *     // use nativeMetronome.*
 *   } else {
 *     // use the existing Web Audio useMetronomeEngine hook as before
 *   }
 *
 * The nativeMetronome object intentionally mirrors the method surface of
 * useMetronomeEngine so callers can be switched with minimal changes.
 */

// ── Capacitor detection ────────────────────────────────────────────────────
// We import lazily so the web bundle never breaks if @capacitor/core is absent
// (Vite tree-shakes it away in PWA mode).
let _Capacitor = null;
let _NativeMetronome = null;

async function ensurePlugins() {
  if (_Capacitor) return;
  try {
    const cap = await import('@capacitor/core');
    _Capacitor = cap.Capacitor;
    if (_Capacitor.isNativePlatform()) {
      const { registerPlugin } = cap;
      _NativeMetronome = registerPlugin('NativeMetronome');
    }
  } catch {
    // Running in a browser without Capacitor — no-op.
  }
}

// Synchronous after the first call to ensurePlugins().
export function isNativePlatform() {
  return Boolean(_Capacitor?.isNativePlatform?.());
}

// Call once early in app bootstrap.
export async function initNativeMetronome() {
  await ensurePlugins();
  return isNativePlatform();
}

// ── Wrapper ────────────────────────────────────────────────────────────────
export const nativeMetronome = {
  /**
   * Start the metronome.
   * @param {object} opts - { bpm, beatsPerBar, accents }
   *   accents: string[] of "normal"|"accent"|"mute", length == beatsPerBar
   */
  start({ bpm, beatsPerBar, accents }) {
    return _NativeMetronome?.start({ bpm, beatsPerBar, accents: accents ?? [] });
  },

  stop() {
    return _NativeMetronome?.stop();
  },

  setTempo({ bpm }) {
    return _NativeMetronome?.setTempo({ bpm });
  },

  setBeatsPerBar({ beatsPerBar, accents }) {
    return _NativeMetronome?.setBeatsPerBar({ beatsPerBar, accents: accents ?? [] });
  },

  setAccents({ accents }) {
    return _NativeMetronome?.setAccents({ accents });
  },

  setVolume({ volume }) {
    return _NativeMetronome?.setVolume({ volume });
  },

  /**
   * Listen for beat events fired by native audio clock.
   * @param {function} handler - called with { beatIndex: number }
   * @returns {function} removeListener
   */
  addBeatListener(handler) {
    if (!_NativeMetronome) return () => {};
    let handle = null;
    _NativeMetronome.addListener('beat', handler).then(h => { handle = h; });
    return () => { handle?.remove(); };
  },

  /**
   * Listen for remote-command events (lock-screen play/pause).
   * @param {function} handler - called with { command: "play"|"pause" }
   * @returns {function} removeListener
   */
  addRemoteCommandListener(handler) {
    if (!_NativeMetronome) return () => {};
    let handle = null;
    _NativeMetronome.addListener('remoteCommand', handler).then(h => { handle = h; });
    return () => { handle?.remove(); };
  },
};
