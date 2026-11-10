'use strict';
// Server lokal: halaman + API (state di memori) untuk main di satu WiFi tanpa Vercel. Jalankan: node server.js
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { api } = require('./handler');
const store = require('./store').memory();
const PORT = +process.env.PORT || 3000;

const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
  if (u.pathname === '/api' && (req.method === 'GET' || req.method === 'POST')) {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e4) req.destroy(); }).on('end', async () => {
      try {
        const body = req.method === 'POST' ? JSON.parse(b || '{}') : {};
        json(res, 200, await api(store, { method: req.method, query: Object.fromEntries(u.searchParams), body }));
      } catch (e) { json(res, 500, { error: 'Server error: ' + e.message }); }
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, '0.0.0.0', () => {
  console.log('Poker jalan! Buka dari perangkat yang satu WiFi:');
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) console.log(`  http://${a.address}:${PORT}`);
});
