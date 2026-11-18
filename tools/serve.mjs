// Serveur statique minimal pour tester l'app en local : node tools/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const port = Number(process.argv[2] || 5360);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const outDir = path.resolve(root, '..', 'test-output');
const mock = { calls: 0, duplicates: 0, failAt: new Set() };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // Outil de test : la page envoie une image, on l'enregistre dans test-output/
  if (req.method === 'POST' && url.pathname === '/__save') {
    const name = path.basename(url.searchParams.get('name') || 'out.bin');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, name), Buffer.concat(chunks));
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  // Imitation locale du script Google Apps Script (tests de la file d'envoi)
  if (req.method === 'POST' && url.pathname === '/__mock_upload') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
      let b;
      try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send({ ok: false, error: 'json' }); }
      if (b.key !== 'test-key') return send({ ok: false, error: 'Clé invalide' });
      mock.calls++;
      if (mock.failAt.has(mock.calls)) { res.writeHead(500); return res.end('boom'); }
      const dir = path.join(outDir, 'drive', b.participant !== undefined ? path.basename(b.participant || 'Sans nom') : '', path.basename(b.folder || 'x'), path.basename(b.subfolder || ''));
      if (b.action === 'ping') return send({ ok: true });
      if (b.action === 'file') {
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, path.basename(b.name));
        if (fs.existsSync(f)) mock.duplicates++;
        fs.writeFileSync(f, Buffer.from(b.data, 'base64'));
        return send({ ok: true, url: 'https://drive.example/' + encodeURIComponent(b.name), folderUrl: 'https://drive.example/folder' });
      }
      if (b.action === 'record') {
        fs.mkdirSync(path.join(outDir, 'drive'), { recursive: true });
        fs.appendFileSync(path.join(outDir, 'drive', 'records.jsonl'), JSON.stringify(b.record) + '\n');
        return send({ ok: true });
      }
      send({ ok: false, error: 'action' });
    });
    return;
  }
  if (url.pathname === '/__mock_state') {
    if (url.searchParams.has('failAt')) { mock.failAt = new Set(url.searchParams.get('failAt').split(',').map(Number)); mock.calls = 0; mock.duplicates = 0; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ calls: mock.calls, duplicates: mock.duplicates }));
  }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, () => console.log(`http://localhost:${port}/`));
