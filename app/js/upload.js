// Côté page : file d'envoi vers Google Drive (le moteur est dans upload-core.js, partagé avec le
// service worker pour l'envoi en arrière-plan).
import { CONFIG } from './config.js';

const core = window.GQUploadCore;
let running = null;
const listeners = new Set();
export const onUploadChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (c) => listeners.forEach((fn) => fn(c));

export const uploadConfigured = () => !!(CONFIG.uploadUrl && CONFIG.uploadKey);
export const folderNameFor = (c) => core.folderNameFor(c);
export const panoFileName = (c) => core.panoFileName(c);

const cfg = () => ({ uploadUrl: CONFIG.uploadUrl, uploadKey: CONFIG.uploadKey, withSources: getSendSources() });

// Le service worker n'a pas accès à config.js : on lui laisse la configuration dans IndexedDB.
export function syncConfig() { return core.db.setSetting('upload', cfg()).catch(() => {}); }

// Android / Chrome : demande au navigateur de relancer l'envoi dès que le réseau revient,
// même si l'app est fermée. Sans effet (et sans erreur) sur iPhone.
export async function registerBackgroundSync() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg && reg.sync) await reg.sync.register('gq-upload');
  } catch {}
}

export async function testConnection() {
  if (!uploadConfigured()) return false;
  try { const r = await core.call(cfg(), { action: 'ping' }, 20000); return !!r.ok; } catch { return false; }
}

export function uploadPending() {
  if (running) return running;
  if (!uploadConfigured()) return Promise.resolve();
  if (!navigator.onLine) { registerBackgroundSync(); return Promise.resolve(); }
  running = core.uploadAll({ config: cfg(), onChange: emit })
    .catch(() => registerBackgroundSync())
    .finally(() => { running = null; });
  return running;
}

export function getSendSources() {
  try { const v = localStorage.getItem('gq2_sources'); return v == null ? CONFIG.sendSourcesDefault : v === '1'; } catch { return CONFIG.sendSourcesDefault; }
}
export function setSendSources(v) { try { localStorage.setItem('gq2_sources', v ? '1' : '0'); } catch {} syncConfig(); }

// Reprise automatique : au retour du réseau, et régulièrement tant que l'app est ouverte.
export function startAutoUpload() {
  syncConfig();
  window.addEventListener('online', () => uploadPending());
  setInterval(() => { if (navigator.onLine) uploadPending(); }, 60000);
  setTimeout(() => uploadPending(), 3000);
}
