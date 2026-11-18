// Moteur d'envoi vers Google Drive, partagé entre la page et le service worker.
// Script classique (pas un module) : chargé par <script> dans la page, et par importScripts()
// dans le service worker, qui peut ainsi envoyer les photos en arrière-plan quand le réseau revient
// (Android / Chrome, via Background Sync), même si l'app est fermée.
(function (global) {
  'use strict';
  const DB_NAME = 'gq360v2', DB_VERSION = 2;

  // ---------- IndexedDB ----------
  let dbp = null;
  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
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
    return openDb().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      let out;
      Promise.resolve(fn(t.objectStore(store))).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const db = {
    getCapture: (id) => tx('captures', 'readonly', (s) => reqP(s.get(id))),
    listCaptures: () => tx('captures', 'readonly', (s) => reqP(s.getAll())),
    saveCapture: (c) => tx('captures', 'readwrite', (s) => { s.put(c); }),
    getBlob: (k) => tx('blobs', 'readonly', (s) => reqP(s.get(k))),
    getSetting: (k) => tx('settings', 'readonly', (s) => reqP(s.get(k))),
    setSetting: (k, v) => tx('settings', 'readwrite', (s) => { s.put(v, k); }),
  };

  // ---------- Outils ----------
  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const utf8b64 = (str) => blobToBase64(new Blob([str], { type: 'application/json' }));
  const pad = (n) => String(n).padStart(2, '0');
  const stampOf = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}h${pad(d.getMinutes())}`; };
  const clean = (s) => (s || '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 30);

  // Dossier Drive : <participant> / <date heure (id)>
  function folderNameFor(c) { return `${stampOf(c.createdAt)} (${c.id.slice(-4)})`; }
  function participantOf(c) { return (c.meta.participant || '').trim() || 'Sans nom'; }
  function panoFileName(c) { return `${stampOf(c.createdAt).replace(' ', '_')}_${clean(c.meta.participant) || 'anonyme'}_360.jpg`; }

  async function call(cfg, body, timeoutMs = 120000) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // text/plain : requête "simple", pas de pré-vérification CORS (indispensable avec Apps Script).
      const res = await fetch(cfg.uploadUrl, { method: 'POST', body: JSON.stringify(Object.assign({ key: cfg.uploadKey }, body)), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctrl.signal, redirect: 'follow' });
      const txt = await res.text();
      let json;
      try { json = JSON.parse(txt); } catch (e) { throw new Error('Réponse inattendue du serveur'); }
      if (!json.ok) throw new Error(json.error || 'Erreur serveur');
      return json;
    } finally { clearTimeout(to); }
  }

  function metaJson(c) {
    return JSON.stringify({
      id: c.id, createdAt: new Date(c.createdAt).toISOString(), app: 'Green Quest 360', version: 2,
      participant: participantOf(c), team: c.meta.team || '', location: c.location || null,
      pano: { width: c.panoW, height: c.panoW / 2, file: panoFileName(c) },
      stitch: c.stitch, focalNorm: c.focalNorm, refYaw: c.refYaw, retakes: c.retakes || 0,
      shots: c.shots.map((s, i) => ({
        file: `sources/source_${pad(i + 1)}.jpg`, target: s.target, w: s.w, h: s.h,
        R: s.R, Rref: s.Rref || null, gain: s.gain ?? null, quality: s.q || null, sharp: s.sharp ?? null, blurry: !!s.blurry,
      })),
    }, null, 1);
  }

  async function uploadOne(cfg, c, emit) {
    const base = { participant: participantOf(c), folder: folderNameFor(c) };
    const withSources = !!cfg.withSources;
    const files = [{ key: `${c.id}/pano`, name: panoFileName(c), mime: 'image/jpeg', main: true }];
    if (withSources) c.shots.forEach((s, i) => files.push({ key: `${c.id}/shot_${i}`, name: `source_${pad(i + 1)}.jpg`, mime: 'image/jpeg', dir: 'sources' }));
    c.uploaded = c.uploaded || {};
    const total = files.length + 2;
    let done = 0;
    const step = async () => { done++; c.progress = Math.round((done / total) * 100); await db.saveCapture(c); emit(c); };
    const sendFile = async (f) => {
      if (c.uploaded[f.name]) { await step(); return; }
      const blob = await db.getBlob(f.key);
      if (!blob) { await step(); return; }
      const r = await call(cfg, Object.assign({ action: 'file', subfolder: f.dir || '', name: f.name, mime: f.mime, data: await blobToBase64(blob) }, base));
      c.uploaded[f.name] = r.url || true;
      if (f.main) c.remote = { panoUrl: r.url, folderUrl: r.folderUrl };
      await step();
    };
    // La photo 360 puis la première source passent seules (elles créent les dossiers côté Drive),
    // le reste part 3 par 3. Au premier échec, on laisse finir les envois en cours puis on s'arrête.
    await sendFile(files[0]);
    if (files[1]) await sendFile(files[1]);
    const rest = files.slice(2);
    let failure = null;
    const worker = async () => { while (rest.length && !failure) { try { await sendFile(rest.shift()); } catch (e) { failure = failure || e; } } };
    await Promise.all([worker(), worker(), worker()]);
    if (failure) throw failure;
    if (!c.uploaded['meta.json']) {
      const r = await call(cfg, Object.assign({ action: 'file', subfolder: '', name: 'meta.json', mime: 'application/json', data: await utf8b64(metaJson(c)) }, base));
      c.uploaded['meta.json'] = r.url || true;
    }
    await step();
    if (!c.uploaded.__record) {
      await call(cfg, Object.assign({ action: 'record', record: {
        id: c.id, date: new Date(c.createdAt).toISOString(), participant: participantOf(c), team: c.meta.team || '',
        category: '', place: '', note: '',
        lat: c.location ? c.location.lat : '', lon: c.location ? c.location.lon : '', accuracy: c.location ? c.location.accuracy : '',
        panoUrl: (c.remote && c.remote.panoUrl) || '', shots: c.shots.length, hasSources: withSources,
      } }, base));
      c.uploaded.__record = true;
    }
    await step();
    c.status = 'sent'; c.sentAt = Date.now(); c.error = null;
    await db.saveCapture(c); emit(c);
  }

  // Envoie tout ce qui attend. Un seul envoi à la fois, entre la page ET le service worker.
  async function uploadAll(opts) {
    const emit = (opts && opts.onChange) || (() => {});
    const cfg = (opts && opts.config) || (await db.getSetting('upload'));
    if (!cfg || !cfg.uploadUrl || !cfg.uploadKey) return { skipped: 'config' };
    const run = async () => {
      const all = (await db.listCaptures()).sort((a, b) => a.createdAt - b.createdAt);
      let lastError = null;
      for (const c0 of all) {
        if (!['ready', 'error', 'sending'].includes(c0.status)) continue;
        const c = await db.getCapture(c0.id);
        try {
          c.status = 'sending'; c.progress = c.progress || 0; await db.saveCapture(c); emit(c);
          await uploadOne(cfg, c, emit);
        } catch (e) {
          c.status = 'error'; c.error = String((e && e.message) || e); await db.saveCapture(c); emit(c);
          lastError = e;
          if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
        }
      }
      if (lastError) throw lastError;
      return { ok: true };
    };
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return navigator.locks.request('gq360v2-upload', { ifAvailable: true }, (lock) => (lock ? run() : { skipped: 'busy' }));
    }
    return run();
  }

  global.GQUploadCore = { db, uploadAll, folderNameFor, participantOf, panoFileName, call, metaJson };
})(typeof self !== 'undefined' ? self : window);
