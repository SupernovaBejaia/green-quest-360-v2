/**
 * Green Quest 360 — réception des photos dans Google Drive (V1 + V2).
 *
 * La V1 et la V2 partagent ce projet, mais chacune a SON déploiement :
 *   - V1 : déploiement « Green Quest 360 v1 » (version 1, ne pas modifier)
 *   - V2 : déploiement « Green Quest 360 v2 »
 * Modifier ce code ne change pas un déploiement existant tant qu'on ne le met pas à jour.
 *
 * Organisation dans le Drive :
 *   Green Quest Cartographie/
 *     Relevés Green Quest 360            (Google Sheet : une ligne par photo, avec GPS)
 *     2026-11-18/…                       (V1 : un dossier par jour)
 *     Amina Bélaïd/                      (V2 : un dossier par participant)
 *       2026-11-20 10h32 (ab12)/
 *         …_360.jpg                      (assemblée sur le téléphone)
 *         …_360_HD.jpg                   (version propre, faite automatiquement par le robot)
 *         meta.json, sources/
 *
 * Clé du robot (version propre automatique) : Paramètres du projet > Propriétés du script > BOT_KEY.
 * Elle n'est écrite nulle part dans le code public.
 */

const ROOT_FOLDER_ID = '1aT-aEzUjJ7kY0h8F_VtU7A-v7ZEpCfBk'; // Drive : Green Quest Cartographie
const KEY = 'gq360-D4V6lQUFeiTDT4ffM7FVC2xi';               // clé des téléphones (publique dans l'app)

const CATEGORY_LABELS = {
  waste_before: 'Déchets — avant nettoyage',
  waste_after: 'Déchets — après nettoyage',
  heritage: 'Lieu historique',
  other: 'Autre',
};
const HEADERS = ['Date', 'Participant', 'Équipe', 'Type', 'Lieu', 'Remarque', 'Latitude', 'Longitude', 'Précision GPS (m)', 'Photo 360', 'Dossier', 'Photos sources', 'ID', 'Photo 360 propre (HD)', 'Version'];

function doGet() {
  return json_({ ok: true, app: 'Green Quest 360', info: 'Service de réception actif.' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (String(body.action || '').indexOf('bot_') === 0) {
      const botKey = PropertiesService.getScriptProperties().getProperty('BOT_KEY');
      if (!botKey || body.key !== botKey) return json_({ ok: false, error: 'Clé robot invalide' });
      if (body.action === 'bot_pending') return json_(botPending_());
      if (body.action === 'bot_files') return json_(botFiles_(body));
      if (body.action === 'bot_get') return json_(botGet_(body));
      if (body.action === 'bot_put') return json_(botPut_(body));
      if (body.action === 'bot_fail') return json_(botFail_(body));
      return json_({ ok: false, error: 'Action robot inconnue' });
    }
    if (body.key !== KEY) return json_({ ok: false, error: 'Clé invalide' });
    if (body.action === 'ping') return json_({ ok: true });
    if (body.action === 'file') return json_(saveFile_(body));
    if (body.action === 'record') return json_(saveRecord_(body));
    return json_({ ok: false, error: 'Action inconnue' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

const safe_ = (s) => String(s || '').replace(/[\/\\]/g, '-').replace(/^\s+|\s+$/g, '').slice(0, 120);

// V1 : racine / jour / photo.  V2 : racine / participant / photo.
function captureFolder_(b) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
    const folderName = safe_(b.folder);
    if (b.participant !== undefined) {
      const who = safe_(b.participant) || 'Sans nom';
      return childFolder_(childFolder_(root, who), folderName);
    }
    return childFolder_(childFolder_(root, folderName.slice(0, 10)), folderName);
  } finally {
    lock.releaseLock();
  }
}

function saveFile_(b) {
  const captureFolder = captureFolder_(b);
  let folder = captureFolder;
  if (b.subfolder) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { folder = childFolder_(captureFolder, safe_(b.subfolder)); } finally { lock.releaseLock(); }
  }
  const name = safe_(b.name);
  // Renvoi après coupure réseau : si le fichier existe déjà, on ne le duplique pas.
  const existing = folder.getFilesByName(name);
  let file;
  if (existing.hasNext()) {
    file = existing.next();
  } else {
    const bytes = Utilities.base64Decode(b.data);
    file = folder.createFile(Utilities.newBlob(bytes, b.mime || 'application/octet-stream', name));
  }
  return { ok: true, id: file.getId(), url: file.getUrl(), folderUrl: captureFolder.getUrl(), folderId: captureFolder.getId() };
}

function sheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SHEET_ID');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Relevés Green Quest 360');
    DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(ROOT_FOLDER_ID));
    props.setProperty('SHEET_ID', ss.getId());
    const sh0 = ss.getSheets()[0];
    sh0.setName('Relevés');
    sh0.setFrozenRows(1);
  }
  const sh = ss.getSheetByName('Relevés') || ss.getSheets()[0];
  // En-têtes (complète les colonnes ajoutées par la V2 sans toucher aux lignes existantes)
  const head = sh.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (head.join('|') !== HEADERS.join('|')) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  }
  return sh;
}

function rowOfId_(sh, id) {
  const n = sh.getLastRow();
  if (n < 2) return -1;
  const ids = sh.getRange(2, 13, n - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return -1;
}

function saveRecord_(b) {
  const r = b.record || {};
  const folder = captureFolder_(b); // prend et relâche son propre verrou
  const v2 = b.participant !== undefined;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_();
    if (rowOfId_(sh, r.id) === -1) {
      sh.appendRow([
        r.date ? new Date(r.date) : new Date(), r.participant || '', r.team || '', CATEGORY_LABELS[r.category] || r.category || '',
        r.place || '', r.note || '', r.lat, r.lon, r.accuracy, r.panoUrl || '', folder.getUrl(), r.shots || '', r.id,
        '', v2 ? 'V2' : 'V1',
      ]);
      // V2 avec photos sources : file d'attente pour la version propre automatique
      if (v2 && r.hasSources) {
        const props = PropertiesService.getScriptProperties();
        const q = JSON.parse(props.getProperty('HD_QUEUE') || '[]');
        if (q.indexOf(folder.getId()) === -1) q.push(folder.getId());
        props.setProperty('HD_QUEUE', JSON.stringify(q));
      }
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

// ---------- Robot « version propre » ----------

function botPending_() {
  const q = JSON.parse(PropertiesService.getScriptProperties().getProperty('HD_QUEUE') || '[]');
  return { ok: true, folders: q.slice(0, 10) };
}

function botFiles_(b) {
  const folder = DriveApp.getFolderById(b.folderId);
  const list = (f, prefix) => { const out = []; const it = f.getFiles(); while (it.hasNext()) { const x = it.next(); out.push({ id: x.getId(), name: prefix + x.getName(), size: x.getSize() }); } return out; };
  let files = list(folder, '');
  const subs = folder.getFoldersByName('sources');
  if (subs.hasNext()) files = files.concat(list(subs.next(), 'sources/'));
  return { ok: true, name: folder.getName(), files: files };
}

function botGet_(b) {
  const f = DriveApp.getFileById(b.fileId);
  return { ok: true, name: f.getName(), data: Utilities.base64Encode(f.getBlob().getBytes()) };
}

function dequeue_(folderId) {
  const props = PropertiesService.getScriptProperties();
  const q = JSON.parse(props.getProperty('HD_QUEUE') || '[]').filter(function (x) { return x !== folderId; });
  props.setProperty('HD_QUEUE', JSON.stringify(q));
}

function botPut_(b) {
  const folder = DriveApp.getFolderById(b.folderId);
  const name = safe_(b.name);
  const old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b.data), 'image/jpeg', name));
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_();
    const row = b.captureId ? rowOfId_(sh, b.captureId) : -1;
    if (row > 0) sh.getRange(row, 14).setValue(file.getUrl());
    dequeue_(b.folderId);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, url: file.getUrl() };
}

function botFail_(b) {
  const folder = DriveApp.getFolderById(b.folderId);
  folder.createFile('hd_erreur.txt', String(b.message || 'erreur').slice(0, 5000));
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { dequeue_(b.folderId); } finally { lock.releaseLock(); }
  return { ok: true };
}
