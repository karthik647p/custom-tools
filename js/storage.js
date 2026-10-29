// Small settings in localStorage; big blobs (custom alarm sounds) in IndexedDB.
const PREFIX = 'ct:';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch { /* storage full or blocked: app still works, just doesn't remember */ }
}

const DB = 'ct-files';
const STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req.result); };
    t.onerror = t.onabort = () => { db.close(); reject(t.error); };
  });
}

export const putFile = (key, blob, name) => tx('readwrite', (s) => s.put({ blob, name }, key));
export const getFile = (key) => tx('readonly', (s) => s.get(key)).catch(() => undefined);
export const delFile = (key) => tx('readwrite', (s) => s.delete(key));
