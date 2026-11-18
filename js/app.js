import { t, setLang, getLang, applyDir } from './i18n.js';
import { CONFIG } from './config.js';
import { CaptureScreen, requestMotionPermission, releaseOrientation, orientationSession } from './capture.js';
import { PanoViewer } from './viewer.js';
import { stitchShots, encodePano } from './pipeline.js';
import { saveCapture, getCapture, listCaptures, putBlob, getBlob, deleteCapture, askPersistence, storageEstimate } from './db.js';
import { uploadPending, onUploadChange, uploadConfigured, startAutoUpload, testConnection, getSendSources, setSendSources, panoFileName, registerBackgroundSync } from './upload.js';
import { DEFAULT_FOV_LONG, focalNormFromFov, makeTargets } from './targets.js';

const SIM = new URLSearchParams(location.search).has('sim');
const app = document.getElementById('app');
let viewer = null;

// ---------- Utilitaires ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel) => app.querySelector(sel);
const profile = () => { try { return JSON.parse(localStorage.getItem('gq2_profile') || 'null'); } catch { return null; } };
const setProfile = (p) => { try { localStorage.setItem('gq2_profile', JSON.stringify(p)); } catch {} };
const getFocal = () => { try { const v = parseFloat(localStorage.getItem('gq2_focal')); if (v > 0.5 && v < 1.3) return v; } catch {} return focalNormFromFov(DEFAULT_FOV_LONG); };
const setFocal = (v) => { try { localStorage.setItem('gq2_focal', String(v)); } catch {} };
const fmtDate = (ts) => new Date(ts).toLocaleString(getLang() === 'ar' ? 'ar-DZ' : 'fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + ' Go' : Math.round(b / 1e6) + ' Mo');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function cleanupViewer() { if (viewer) { viewer.destroy(); viewer = null; } }

function toast(msg, ms = 3500) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('on');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('on'), ms);
}

// ---------- Position GPS (fonctionne sans Internet) ----------
let lastFix = null;
function startGps() {
  if (!navigator.geolocation) return;
  try {
    navigator.geolocation.getCurrentPosition((p) => { lastFix = p; }, () => {}, { enableHighAccuracy: true, timeout: 30000, maximumAge: 60000 });
  } catch {}
}
function currentFix(timeout = 8000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    let done = false;
    const finish = (p) => { if (!done) { done = true; resolve(p); } };
    setTimeout(() => finish(lastFix), timeout);
    navigator.geolocation.getCurrentPosition((p) => { lastFix = p; finish(p); }, () => finish(lastFix), { enableHighAccuracy: true, timeout, maximumAge: 30000 });
  });
}

// ---------- Écrans ----------

function screenSetup() {
  cleanupViewer();
  const p = profile() || {};
  app.innerHTML = `
    <div class="page center">
      ${langSwitch()}
      <img class="logo" src="icons/icon-192.png" alt="">
      <h1>${t('welcome')}</h1>
      <p class="muted">${t('welcomeText')}</p>
      <label class="field"><span>${t('name')}</span><input id="pname" autocomplete="name" value="${esc(p.name)}"></label>
      <label class="field"><span>${t('team')}</span><input id="pteam" value="${esc(p.team)}"></label>
      <button class="btn primary big" id="go">${t('continue')}</button>
    </div>`;
  bindLang();
  $('#go').onclick = () => {
    const name = $('#pname').value.trim();
    if (!name) { $('#pname').focus(); return; }
    setProfile({ name, team: $('#pteam').value.trim() });
    screenHome();
  };
}

function langSwitch() {
  return `<div class="lang"><button data-l="fr" class="${getLang() === 'fr' ? 'on' : ''}">FR</button><button data-l="ar" class="${getLang() === 'ar' ? 'on' : ''}">عربي</button></div>`;
}
function bindLang(rerender) {
  app.querySelectorAll('.lang button').forEach((b) => (b.onclick = () => { setLang(b.dataset.l); (rerender || screenSetup)(); }));
}

async function screenHome() {
  cleanupViewer();
  const caps = await listCaptures();
  const pending = caps.filter((c) => c.status !== 'sent').length;
  app.innerHTML = `
    <div class="page">
      <header class="top">
        <div><div class="title">${t('appName')} <span class="v2tag">V2 test</span></div><div class="muted small">${esc(profile()?.name)}${profile()?.team ? ' · ' + esc(profile().team) : ''}</div></div>
        <div class="row">
          <span class="net ${navigator.onLine ? 'on' : ''}">${navigator.onLine ? t('online') : t('offline')}</span>
          <button class="icon" id="settings" aria-label="${t('settings')}">⚙</button>
        </div>
      </header>
      <button class="btn primary huge" id="new"><span class="ring360">360°</span>${t('newPhoto')}</button>
      ${installHint()}
      <div class="section-head">
        <h2>${t('myPhotos')}</h2>
        ${pending && uploadConfigured() ? `<button class="btn small" id="sendall" ${navigator.onLine ? '' : 'disabled'}>${t('sendAll', { n: pending })}</button>` : ''}
      </div>
      <div class="list" id="list">${caps.length ? '' : `<p class="muted">${t('none')}</p>`}</div>
    </div>`;
  const list = $('#list');
  for (const c of caps) {
    const el = document.createElement('button');
    el.className = 'item'; el.dataset.id = c.id;
    el.innerHTML = `<img alt=""><div class="item-body"><div class="item-title">${t('photo360')} · ${fmtDate(c.createdAt)}</div>
      <div class="status st-${c.status}">${statusText(c)}</div></div>`;
    el.onclick = () => screenDetail(c.id);
    list.appendChild(el);
    getBlob(`${c.id}/thumb`).then((b) => { if (b) el.querySelector('img').src = URL.createObjectURL(b); });
  }
  $('#new').onclick = screenNew;
  $('#settings').onclick = screenSettings;
  const sa = $('#sendall');
  if (sa) sa.onclick = () => { sa.disabled = true; sa.textContent = t('sendingN'); uploadPending().then(() => screenHome()); };
}

function statusText(c) {
  if (c.status === 'sent') return t('st_sent');
  if (c.status === 'sending') return t('st_sending', { p: c.progress || 0 });
  if (c.status === 'error') return t('st_error');
  return uploadConfigured() ? t('st_local') : t('st_noconfig');
}

function installHint() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return '';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (ios) return `<p class="hint">📲 ${t('installIos')}</p>`;
  if (deferredInstall) return `<button class="btn ghost" id="install" onclick="window.__install()">📲 ${t('install')}</button>`;
  return '';
}
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
window.__install = async () => { if (!deferredInstall) return; deferredInstall.prompt(); deferredInstall = null; };

function screenNew() {
  cleanupViewer();
  app.innerHTML = `
    <div class="page">
      <header class="top"><button class="icon" id="back">‹</button><div class="title">${t('tipsTitle')}</div><span></span></header>
      <p class="muted">${t('tipsIntro')}</p>
      <div class="tip-list">
        ${TIPS.map((k, i) => `<div class="tip"><div class="tip-ic">${TIP_ICONS[i]}</div><div><div class="tip-t">${t(k + '_t')}</div><div class="tip-d">${t(k + '_d')}</div>
          ${i === 0 ? `<div class="howto-img" aria-hidden="true">${pivotSvg()}</div>` : ''}</div></div>`).join('')}
      </div>
      <button class="btn primary big sticky" id="start">${t('start')}</button>
    </div>`;
  $('#back').onclick = screenHome;
  $('#start').onclick = () => {
    // Doit être déclenché directement par le geste (exigence iOS)
    const perm = SIM ? Promise.resolve('granted') : requestMotionPermission();
    startGps();
    const meta = {};
    perm.then((p) => {
      if (p !== 'granted') { toast(t('permDenied'), 6000); return; }
      screenCapture(meta);
    });
  };
}

const TIPS = ['tipPivot', 'tipUpright', 'tipDistance', 'tipAim', 'tipStill', 'tipLight', 'tipSpot', 'tipWait'];
const TIP_ICONS = ['🔄', '📱', '📏', '🎯', '🚶', '☀️', '📍', '⏳'];

function pivotSvg() {
  return `<svg viewBox="0 0 220 110" width="220" height="110">
    <circle cx="110" cy="55" r="40" fill="none" stroke="currentColor" stroke-dasharray="4 5" opacity=".5"/>
    <rect x="103" y="42" width="14" height="26" rx="3" fill="#2ecc71"/>
    <circle cx="110" cy="55" r="3" fill="#fff"/>
    <g fill="currentColor" opacity=".85"><ellipse cx="110" cy="100" rx="9" ry="5"/><ellipse cx="66" cy="78" rx="9" ry="5" transform="rotate(50 66 78)"/><ellipse cx="154" cy="78" rx="9" ry="5" transform="rotate(-50 154 78)"/></g>
    <path d="M150 24 A48 48 0 0 1 160 62" fill="none" stroke="#2ecc71" stroke-width="3" marker-end="url(#a)"/>
    <defs><marker id="a" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="#2ecc71"/></marker></defs>
  </svg>`;
}

async function screenCapture(meta) {
  cleanupViewer();
  document.body.classList.add('fullscreen');
  let simMod = null;
  if (SIM) simMod = await import('./sim.js');
  const id = uid();
  const cap = new CaptureScreen(app, {
    sim: simMod,
    focalNorm: getFocal(),
    onCancel: () => { releaseOrientation(); document.body.classList.remove('fullscreen'); screenHome(); },
    onError: (msg) => { releaseOrientation(); document.body.classList.remove('fullscreen'); screenHome().then(() => toast(msg, 7000)); },
    onFinish: (res) => { document.body.classList.remove('fullscreen'); processCapture(id, meta, res); },
  });
  await cap.start();
}

// ---------- Assemblage ----------

async function processCapture(id, meta, res) {
  const p = profile() || {};
  app.innerHTML = `
    <div class="page center">
      <div class="spinner"></div>
      <h2>${t('stitching')}</h2>
      <div class="bar"><div class="bar-fill" style="width:0%"></div></div>
      <p class="muted" id="stage">${t('st_prepare')}</p>
      <p class="muted small">${t('keepOpen')}</p>
    </div>`;
  let wake; try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  // Sauvegarde immédiate des photos sources : rien n'est perdu même si l'app se ferme.
  const fixP = currentFix();
  const capture = {
    id, createdAt: res.createdAt || Date.now(), status: 'stitching',
    meta: { ...meta, participant: p.name || '', team: p.team || '' },
    shots: res.shots.map((s) => ({ R: s.R, w: s.w, h: s.h, target: s.target, t: s.t, sharp: s.sharp, blurry: s.blurry })),
    sim: res.sim, refYaw: res.refYaw, session: res.session, retakes: res.retakes || 0,
  };
  for (let i = 0; i < res.shots.length; i++) await putBlob(`${id}/shot_${i}`, res.shots[i].blob);
  await saveCapture(capture);

  const weights = { prepare: [0, 0.15], features: [0.15, 0.2], match: [0.2, 0.55], optimize: [0.55, 0.62], render: [0.62, 0.97] };
  const fill = $('.bar-fill'), stage = $('#stage');
  try {
    const out = await stitchShots(res.shots, {
      focalNorm: getFocal(), outW: CONFIG.panoWidth,
      onProgress: (st, f) => { const [a, b] = weights[st] || [0, 1]; fill.style.width = `${Math.round((a + (b - a) * f) * 100)}%`; stage.textContent = t('st_' + st); },
    });
    const fix = await fixP;
    capture.location = fix ? { lat: fix.coords.latitude, lon: fix.coords.longitude, accuracy: Math.round(fix.coords.accuracy), alt: fix.coords.altitude ?? null } : null;
    const enc = await encodePano(out, capture.location);
    await putBlob(`${id}/pano`, enc.pano);
    await putBlob(`${id}/thumb`, enc.thumb);
    capture.panoW = out.w; capture.focalNorm = out.focalNorm; capture.stitch = out.stats;
    // Orientation affinée de chaque photo : l'assemblage HD automatique repart de là.
    capture.shots.forEach((s, i) => { s.Rref = out.rotations[i]; s.gain = out.gains[i]; s.q = out.perImage?.[i]; });
    capture.weak = weakShots(capture);
    capture.status = 'review';
    await saveCapture(capture);
    if (out.stats.refined && !res.sim) setFocal(out.focalNorm);
    try { wake?.release(); } catch {}
    screenReview(capture, enc.canvas);
  } catch (e) {
    console.error(e);
    try { wake?.release(); } catch {}
    capture.status = 'failed'; capture.error = String(e.message || e); await saveCapture(capture);
    app.innerHTML = `<div class="page center"><h2>${t('error')}</h2><p class="muted small">${esc(capture.error)}</p>
      <button class="btn primary" id="retry">${t('retry')}</button><button class="btn ghost" id="home">${t('back')}</button></div>`;
    $('#retry').onclick = () => restitch(id);
    $('#home').onclick = screenHome;
  }
}

async function restitch(id) {
  const c = await getCapture(id);
  const shots = [];
  for (let i = 0; i < c.shots.length; i++) shots.push({ ...c.shots[i], blob: await getBlob(`${id}/shot_${i}`) });
  await deleteCapture(id);
  processCapture(id, {}, { shots, sim: c.sim, refYaw: c.refYaw, session: c.session, createdAt: c.createdAt, retakes: c.retakes });
}

// Contrôle qualité après assemblage : quelles photos sont mal raccordées ?
// - erreur de raccord moyenne élevée (le téléphone a bougé, objet trop proche, personne qui passe) ;
// - ou très peu de points communs alors que l'image est texturée (photo décalée, floue) ;
// - ou photo restée floue malgré 2 essais.
// Le ciel (zénith) et les zones unies sont ignorés : il n'y a rien à y raccorder.
const TARGETS = makeTargets();
function weakShots(c) {
  if (!c.stitch?.refined) return [];
  const out = [];
  c.shots.forEach((s) => {
    const tg = TARGETS[s.target];
    if (!tg || tg.ring === 3) return;
    const q = s.q || {};
    const misaligned = q.err != null && q.err > 2.0;
    const isolated = q.feats >= 25 && q.n < 6;
    if (misaligned || isolated || s.blurry) out.push(s.target);
  });
  return out;
}

async function startRetake(c) {
  document.body.classList.add('fullscreen');
  const simMod = SIM ? await import('./sim.js') : null;
  const cap = new CaptureScreen(app, {
    sim: simMod, focalNorm: c.focalNorm || getFocal(),
    retake: { targets: c.weak, refYaw: c.refYaw },
    onCancel: () => { document.body.classList.remove('fullscreen'); screenDetail(c.id); },
    onError: (msg) => { document.body.classList.remove('fullscreen'); screenDetail(c.id).then(() => toast(msg, 7000)); },
    onFinish: async (res) => {
      document.body.classList.remove('fullscreen');
      const fresh = new Map(res.shots.map((s) => [s.target, s]));
      const shots = [];
      for (let i = 0; i < c.shots.length; i++) {
        const s = c.shots[i];
        if (fresh.has(s.target)) continue;
        shots.push({ ...s, blob: await getBlob(`${c.id}/shot_${i}`) });
      }
      shots.push(...fresh.values());
      await deleteCapture(c.id);
      processCapture(c.id, {}, { shots, sim: c.sim, refYaw: c.refYaw, session: c.session, createdAt: c.createdAt, retakes: (c.retakes || 0) + 1 });
    },
  });
  await cap.start();
}

function screenReview(c, canvas) {
  cleanupViewer();
  const partial = !c.stitch?.refined;
  // La reprise ciblée n'est possible que tant que le capteur n'a pas été coupé (même repère).
  const canRetake = c.weak?.length && c.weak.length <= 8 && orientationSession() && orientationSession() === c.session;
  app.innerHTML = `
    <div class="page">
      <header class="top"><span></span><div class="title">${t('result')}</div><span></span></header>
      <div class="viewer"><canvas id="pv"></canvas><span class="badge360">360°</span></div>
      ${partial ? `<p class="warn">${t('partial')}</p>` : ''}
      ${!partial && c.weak?.length ? `<div class="qc">
        <div class="qc-t">⚠️ ${t('qcWeak', { n: c.weak.length })}</div>
        <div class="muted small">${canRetake ? t('qcWeakHelp') : (c.weak.length > 8 ? t('qcTooMany') : t('qcNoRetake'))}</div>
        ${canRetake ? `<button class="btn primary" id="retake">${t('qcRetake', { n: c.weak.length })}</button>` : ''}
      </div>` : ''}
      ${!partial && !c.weak?.length ? `<p class="ok">✅ ${t('qcGood')}</p>` : ''}
      <p class="muted small">${c.location ? `📍 ${c.location.lat.toFixed(5)}, ${c.location.lon.toFixed(5)} (±${c.location.accuracy} m)` : t('noLocation')}</p>
      <div class="row gap">
        <button class="btn ghost" id="redo">${t('redo')}</button>
        <button class="btn primary grow" id="save">${t('save')}</button>
      </div>
    </div>`;
  try { viewer = new PanoViewer($('#pv')); viewer.setImage(canvas); } catch (e) { console.warn(e); }
  $('#redo').onclick = async () => { releaseOrientation(); await deleteCapture(c.id); screenNew(); };
  const rt = $('#retake');
  if (rt) rt.onclick = () => { cleanupViewer(); startRetake(c); };
  $('#save').onclick = async () => {
    releaseOrientation();
    c.status = 'ready';
    await saveCapture(c);
    toast(t('saved'), 4000);
    screenHome();
    registerBackgroundSync();
    uploadPending();
  };
}

async function screenDetail(id) {
  cleanupViewer();
  const c = await getCapture(id);
  if (!c) return screenHome();
  if (c.status === 'stitching' || c.status === 'failed') return restitch(id);
  const blob = await getBlob(`${id}/pano`);
  app.innerHTML = `
    <div class="page">
      <header class="top"><button class="icon" id="back">‹</button><div class="title">${t('photo360')}</div><span></span></header>
      <div class="viewer"><canvas id="pv"></canvas><span class="badge360">360°</span></div>
      <div class="info">
        <div class="muted small">${fmtDate(c.createdAt)} · ${c.shots.length} ${t('shots')}</div>
        <div class="muted small">${c.location ? `📍 ${c.location.lat.toFixed(5)}, ${c.location.lon.toFixed(5)}` : t('noLocation')}</div>
        <div class="status st-${c.status}" id="st">${statusText(c)}</div>
        ${c.status === 'review' ? `<p class="warn small">${t('save')} ?</p>` : ''}
      </div>
      <div class="row gap wrap">
        ${c.status === 'review' ? `<button class="btn primary grow" id="save">${t('save')}</button>` : ''}
        ${c.status !== 'sent' && c.status !== 'review' && uploadConfigured() ? `<button class="btn primary grow" id="send" ${navigator.onLine ? '' : 'disabled'}>${t('send')}</button>` : ''}
        <button class="btn ghost" id="dl">${t('download')}</button>
        <button class="btn danger" id="del">${t('delete')}</button>
      </div>
    </div>`;
  if (blob) {
    try {
      viewer = new PanoViewer($('#pv'));
      const bmp = await createImageBitmap(blob);
      viewer.setImage(bmp);
    } catch (e) { console.warn(e); }
  }
  $('#back').onclick = screenHome;
  const save = $('#save');
  if (save) save.onclick = async () => { c.status = 'ready'; await saveCapture(c); uploadPending(); screenDetail(id); };
  const send = $('#send');
  if (send) send.onclick = async () => { send.disabled = true; if (c.status === 'error') { c.status = 'ready'; await saveCapture(c); } uploadPending().then(() => screenDetail(id)); };
  $('#dl').onclick = () => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = panoFileName(c);
    document.body.appendChild(a); a.click(); a.remove();
  };
  $('#del').onclick = async () => { if (confirm(t('confirmDelete'))) { await deleteCapture(id); screenHome(); } };
}

async function screenSettings() {
  cleanupViewer();
  const p = profile() || {};
  const est = await storageEstimate();
  app.innerHTML = `
    <div class="page">
      <header class="top"><button class="icon" id="back">‹</button><div class="title">${t('settings')}</div><span></span></header>
      ${langSwitch()}
      <label class="field"><span>${t('name')}</span><input id="pname" value="${esc(p.name)}"></label>
      <label class="field"><span>${t('team')}</span><input id="pteam" value="${esc(p.team)}"></label>
      <label class="check"><input type="checkbox" id="src" ${getSendSources() ? 'checked' : ''}><span>${t('sendSources')}</span></label>
      ${est ? `<p class="muted small">${t('storage', { u: fmtSize(est.usage || 0) })}</p>` : ''}
      ${uploadConfigured() ? `<button class="btn ghost" id="test">${t('testConn')}</button>` : `<p class="warn small">${t('st_noconfig')}</p>`}
      <p class="muted small">${t('about')}</p>
      <button class="btn primary big" id="ok">${t('continue')}</button>
    </div>`;
  bindLang(screenSettings);
  $('#back').onclick = screenHome;
  const test = $('#test');
  if (test) test.onclick = async () => { test.disabled = true; const ok = await testConnection(); toast(ok ? t('connOk') : t('connFail')); test.disabled = false; };
  $('#ok').onclick = () => {
    setProfile({ name: $('#pname').value.trim() || p.name, team: $('#pteam').value.trim() });
    setSendSources($('#src').checked);
    screenHome();
  };
}

// ---------- Démarrage ----------

function updateNet() {
  const el = document.querySelector('.net');
  if (el) { el.classList.toggle('on', navigator.onLine); el.textContent = navigator.onLine ? t('online') : t('offline'); }
}

async function main() {
  applyDir();
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  onUploadChange((c) => {
    const item = app.querySelector(`.item[data-id="${c.id}"] .status`);
    if (item) { item.textContent = statusText(c); item.className = `status st-${c.status}`; }
    const st = app.querySelector('#st');
    if (st) st.textContent = statusText(c);
  });
  const FORCE_SW = new URLSearchParams(location.search).has('sw');
  if ('serviceWorker' in navigator && ((!SIM && location.hostname !== 'localhost') || FORCE_SW)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Envoi terminé en arrière-plan par le service worker : on rafraîchit la liste.
  navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'uploaded' && app.querySelector('#list')) screenHome(); });
  askPersistence();
  startAutoUpload();
  // Aperçus pour le développement local : /?demo&lang=ar#new
  const qs = new URLSearchParams(location.search);
  if (qs.has('demo') && ['localhost', '127.0.0.1'].includes(location.hostname)) {
    setProfile({ name: 'Amina', team: 'Équipe Casbah' });
    if (qs.get('lang')) setLang(qs.get('lang'));
    const scr = { '#new': screenNew, '#settings': screenSettings, '#capture': () => screenCapture({}) }[location.hash];
    if (scr) return scr();
  }
  if (!profile()?.name) screenSetup(); else screenHome();
}

main();
