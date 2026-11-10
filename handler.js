'use strict';
// Logika API, dipakai server lokal (server.js) dan fungsi Vercel (api/index.js).
//   GET  /api?room=&token=&v=   -> state meja untuk pemain itu ({same:true} kalau versi tidak berubah)
//   POST /api {room,token,type} -> join | start | fold | check | call | raise | rebuy | sitin | leave
const crypto = require('crypto');
const { Table } = require('./poker');
const MAX = 9, ROOM_RE = /^[a-z0-9-]{3,16}$/;

// Jalankan fn pada state terbaru lalu simpan kalau berubah. Optimistic locking: kalau request lain menulis lebih dulu,
// ulangi dengan state baru (fn harus hanya mengubah t). Event yang sudah jatuh tempo dijalankan dulu (t.tick).
async function mutate(store, room, fn, create = false) {
  for (let i = 0; i < 25; i++) {
    if (i) await new Promise(r => setTimeout(r, Math.random() * 12 * i)); // jeda acak yang membesar supaya yang bertabrakan tidak bentrok lagi
    const { raw, ver } = await store.load(room);
    if (!raw && !create) return { t: null };
    const t = raw ? Table.from(JSON.parse(raw)) : new Table();
    t.now = Date.now();
    t.tick();
    const out = fn(t);
    const next = JSON.stringify(t);
    if (next === raw) return { t, out, ver };
    const nv = await store.save(room, next, ver);
    if (nv !== null) return { t, out, ver: nv };
  }
  throw new Error('terlalu banyak tabrakan penulisan, coba lagi');
}

const withView = (r, token, out) => { const p = r.t && r.t.find(token); return p ? { ...out, v: r.ver, s: r.t.view(p) } : out; };

async function getState(store, room, token, v) {
  const r = await mutate(store, room, t => { const p = t.find(token); if (p && t.now - p.seen > 5000) p.seen = t.now; });
  const p = r.t && r.t.find(token);
  if (!p) return { gone: true };
  return v !== undefined && +v === r.ver ? { same: true, v: r.ver } : { v: r.ver, s: r.t.view(p) };
}

async function act(store, room, b) {
  const token = String(b.token || '');
  if (b.type === 'join') {
    const name = String(b.name || '').trim().slice(0, 12) || 'Pemain';
    const r = await mutate(store, room, t => {
      const ex = t.find(token);
      if (ex) { ex.seen = t.now; return { token }; }
      if (t.players.length >= MAX) return { error: `Meja penuh (maks ${MAX} pemain)` };
      const tok = crypto.randomUUID();
      t.join(name, tok);
      return { token: tok };
    }, true);
    return withView(r, r.out.token, r.out);
  }
  const r = await mutate(store, room, t => {
    const p = t.find(token);
    if (!p) return { error: 'Sesi tidak ditemukan, muat ulang halaman', gone: true };
    p.seen = t.now;
    if (!p.gone && ['fold', 'check', 'call', 'raise'].includes(b.type)) p.sitOut = false; // pemain yang beraksi berarti sudah kembali
    const i = t.players.indexOf(p);
    const err = b.type === 'start' ? t.start(i) : b.type === 'rebuy' ? t.rebuy(i) : b.type === 'sitin' ? t.sitIn(i)
      : b.type === 'leave' ? t.leave(i) : t.act(i, b.type, b.amount);
    return err ? { error: err } : { ok: true };
  });
  if (!r.t) return { error: 'Meja tidak ditemukan', gone: true };
  return withView(r, token, r.out);
}

async function api(store, { method, query = {}, body = {} }) {
  const b = method === 'GET' ? query : body;
  const room = String(b.room || '').toLowerCase();
  if (!ROOM_RE.test(room)) return { error: 'Kode meja harus 3-16 huruf/angka' };
  if (method === 'GET') return getState(store, room, String(b.token || ''), b.v);
  if (method === 'POST') return act(store, room, { ...b, room });
  return { error: 'Metode tidak didukung' };
}

module.exports = { api };
