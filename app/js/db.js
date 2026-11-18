// Stockage local (IndexedDB) : tout reste sur le téléphone tant que ce n'est pas envoyé.
const DB_NAME = 'gq360v2', VERSION = 2; // distinct de la V1 (même domaine) ; même schéma que upload-core.js
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('captures')) db.createObjectStore('captures', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const saveCapture = (c) => tx('captures', 'readwrite', (s) => { s.put(c); });
export const getCapture = (id) => tx('captures', 'readonly', (s) => reqP(s.get(id)));
export const listCaptures = () => tx('captures', 'readonly', (s) => reqP(s.getAll())).then((a) => a.sort((x, y) => y.createdAt - x.createdAt));
export const putBlob = (key, blob) => tx('blobs', 'readwrite', (s) => { s.put(blob, key); });
export const getBlob = (key) => tx('blobs', 'readonly', (s) => reqP(s.get(key)));

export async function deleteCapture(id) {
  const c = await getCapture(id);
  await tx('blobs', 'readwrite', (s) => {
    s.delete(`${id}/pano`); s.delete(`${id}/thumb`);
    for (let i = 0; i < (c?.shots?.length || 60); i++) s.delete(`${id}/shot_${i}`);
  });
  await tx('captures', 'readwrite', (s) => { s.delete(id); });
}

// Demande au navigateur de ne pas effacer nos données si l'espace manque.
export async function askPersistence() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch {}
  return false;
}

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
