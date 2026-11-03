// Persistence hooks: IndexedDB for songs / setlists / spelling chart, localStorage for small prefs.
import { useCallback, useEffect, useRef, useState } from "react";

/* =========================================================================
   Persistence — IndexedDB for songs/setlists, localStorage for small prefs.
   ========================================================================= */
const DB_NAME = "zong-db";

const DB_VERSION = 1;

const STORE_NAME = "kv";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no indexeddb")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function useIndexedDbState(key, seed) {
  const [value, setValue] = useState(seed);
  const [ready, setReady] = useState(false);
  const loadedRef = useRef(false);
  const writableRef = useRef(false);   // true only once the stored value was read successfully
  const queuedRef = useRef([]);        // updates requested before the stored value was read
  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const finish = (stored, ok) => {
      if (cancelled || settled) return;
      settled = true;
      let base = stored !== undefined ? stored : seed;
      loadedRef.current = true;
      writableRef.current = ok;
      // Apply anything requested while loading ON TOP of the stored data, so an early
      // update (e.g. a sync result) can never overwrite what was saved on this device.
      const queued = queuedRef.current;
      queuedRef.current = [];
      queued.forEach((next) => { base = typeof next === "function" ? next(base) : next; });
      setValue(base);
      setReady(true);
      if (ok && (stored === undefined || queued.length)) idbSet(key, base).catch(() => { });
    };
    idbGet(key).then((stored) => finish(stored, true), () => finish(undefined, false));
    // If storage never answers, carry on in memory — but never write in that case, so the
    // data already stored on the device cannot be overwritten by an incomplete copy.
    const timeout = setTimeout(() => finish(undefined, false), 15000);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const persist = useCallback((next) => {
    if (!loadedRef.current) { queuedRef.current.push(next); return; }
    setValue((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      if (writableRef.current) idbSet(key, resolved).catch(() => { });
      return resolved;
    });
  }, [key]);
  return [value, persist, ready];
}

export function useLocalStorageState(key, seed) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? JSON.parse(stored) : seed;
    } catch { return seed; }
  });
  const persist = useCallback((next) => {
    setValue((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      try { localStorage.setItem(key, JSON.stringify(resolved)); } catch { }
      return resolved;
    });
  }, [key]);
  return [value, persist];
}
