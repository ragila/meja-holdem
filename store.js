'use strict';
// Penyimpanan state meja. Antarmuka: load(room) -> {raw, ver}; save(room, raw, ver) -> versi baru, atau null kalau
// ada yang menulis lebih dulu (compare-and-set). memory(): server lokal. redis(): Upstash/Vercel KV lewat REST (tanpa dependency).
const TTL = 6 * 3600; // meja yang tidak disentuh 6 jam dihapus otomatis

function memory() {
  const m = new Map(); // room -> { raw, ver }
  const yieldTurn = () => new Promise(r => setImmediate(r)); // beri kesempatan request lain menyela, supaya jalur tabrakan (CAS) ikut teruji
  return {
    async load(room) { await yieldTurn(); const e = m.get(room); return { raw: e ? e.raw : null, ver: e ? e.ver : 0 }; },
    async save(room, raw, ver) { await yieldTurn(); const e = m.get(room); if ((e ? e.ver : 0) !== ver) return null; m.set(room, { raw, ver: ver + 1 }); return ver + 1; },
  };
}

// cek versi + tulis state secara atomik di sisi Redis
const LUA = "if (redis.call('GET',KEYS[2]) or '0') == ARGV[1] then redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[4]) redis.call('SET',KEYS[2],ARGV[3],'EX',ARGV[4]) return 1 end return 0";

function redis(url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN) {
  if (!url || !token) return null;
  const cmd = async args => {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(args) });
    const j = await r.json();
    if (j.error) throw new Error('redis: ' + j.error);
    return j.result;
  };
  const keys = room => [`poker:${room}:s`, `poker:${room}:v`];
  return {
    async load(room) { const [s, v] = keys(room); const [raw, ver] = await cmd(['MGET', s, v]); return { raw, ver: +ver || 0 }; },
    async save(room, raw, ver) {
      const [s, v] = keys(room);
      const ok = await cmd(['EVAL', LUA, 2, s, v, String(ver), raw, String(ver + 1), String(TTL)]);
      return ok ? ver + 1 : null;
    },
  };
}

module.exports = { memory, redis };
