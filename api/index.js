'use strict';
// Fungsi Vercel: satu endpoint /api. State meja disimpan di Redis (Upstash lewat integrasi Vercel Marketplace).
const { api } = require('../handler');
const store = require('../store').redis();

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!store) return res.status(503).json({ error: 'Redis belum terhubung ke project Vercel ini' });
  try {
    const body = req.method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}) : {};
    res.status(200).json(await api(store, { method: req.method, query: req.query || {}, body }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
};
