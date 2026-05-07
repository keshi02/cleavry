// IndexedDB autosave — IO layer only. application code (main.ts) is
// responsible for reading state to build a Session and writing state
// when restoring. This file just shuttles bytes to and from IDB.
//
// We store the *raw bytes* (origData, workData) rather than re-encoding
// to PNG every time — encode is slow, IDB blobs are fine for the
// hundred-MB scale we're dealing with.

const DB_NAME = 'eraser-autosave';
const STORE = 'sessions';
const KEY = 'current';

export interface AutosaveSession {
  filename: string;
  imgW: number;
  imgH: number;
  origData: ArrayBuffer;
  workData: ArrayBuffer;
  savedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function saveSession(session: AutosaveSession): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(session, KEY);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  } catch (_) { /* best effort */ }
}

export async function loadSession(): Promise<AutosaveSession | null> {
  try {
    const db = await openDB();
    const session = await new Promise<AutosaveSession | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    db.close();
    return session ?? null;
  } catch (_) {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => db.close();
  } catch (_) { /* best effort */ }
}
