// Per-song settings kept on this device only (beat accents, subdivision).


// Per-song beat subdivision stored on-device (Requirement 9: saved on-device per song across all modes and events, single beat online)
const SONG_SUBDIVISIONS_KEY = "zong:song-subdivisions";

// Per-song beat accents stored on-device (device-local, not synced to Supabase).
export const SONG_ACCENTS_KEY = "zong:song-accents";

export function getSongSubdivision(songId) {
  if (!songId) return 1;
  try {
    const map = JSON.parse(localStorage.getItem(SONG_SUBDIVISIONS_KEY) || "{}");
    return Number(map[songId]) || 1;
  } catch {
    return 1;
  }
}

export function setSongSubdivision(songId, sub) {
  if (!songId) return;
  try {
    const map = JSON.parse(localStorage.getItem(SONG_SUBDIVISIONS_KEY) || "{}");
    map[songId] = Number(sub) || 1;
    localStorage.setItem(SONG_SUBDIVISIONS_KEY, JSON.stringify(map));
  } catch { }
}

export function getSongAccents(songId, beats) {
  if (!songId) return defaultAccents(beats ?? 4);
  try {
    const map = JSON.parse(localStorage.getItem(SONG_ACCENTS_KEY) || "{}");
    const stored = map[songId];
    if (Array.isArray(stored) && (!beats || stored.length === beats)) return stored;
  } catch { }
  return defaultAccents(beats ?? 4);
}

export function setSongAccentsLocal(songId, accents) {
  if (!songId) return;
  try {
    const map = JSON.parse(localStorage.getItem(SONG_ACCENTS_KEY) || "{}");
    map[songId] = accents;
    localStorage.setItem(SONG_ACCENTS_KEY, JSON.stringify(map));
  } catch { }
}

export function defaultAccents(beats) { return Array.from({ length: beats }, () => "normal"); }
