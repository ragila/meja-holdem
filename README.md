# Meja Hold'em

Texas Hold'em multiplayer berbasis web, lengkap dengan chip. Bisa dimainkan bareng di satu WiFi (server lokal) atau online (Vercel + Redis). Tanpa dependency npm.

## Fitur

- Sampai 9 pemain per meja, blind 10/20, modal awal 1000 chip, rebuy kalau habis.
- Meja dibuat dengan kode (3–16 huruf kecil/angka/strip). Bagikan tautan `#kode` untuk mengundang teman.
- Hanya master meja (pembuat kode, bertanda ♛) yang bisa memulai game.
- Waktu giliran 15 detik. Kalau habis, pemain otomatis check (atau fold kalau ada taruhan) dan diistirahatkan.
- Aturan lengkap: side pot, all-in pendek, min-raise, aturan heads-up, pengembalian taruhan yang tidak di-call.
- Animasi kartu, dealer animasi, dan efek suara chip/kartu (disintesis Web Audio, tanpa file audio).
- Tombol mata untuk menyembunyikan kartu sendiri dari orang yang mengintip layar; tahan kartu untuk mengintip.

## Main di satu WiFi

Butuh Node.js 18 ke atas.

```bash
node server.js
```

Server mencetak alamat seperti `http://192.168.x.x:3000`. Buka alamat itu dari HP/laptop lain yang satu WiFi. Port bisa diganti dengan `PORT=8080 node server.js`. State meja disimpan di memori, jadi hilang saat server dimatikan.

## Main online (Vercel)

1. Deploy: `npx vercel deploy --prod` (pertama kali akan diminta login ke Vercel)
2. Di dashboard Vercel, tambahkan Upstash Redis lewat Storage/Marketplace dan hubungkan ke project. Integrasi itu mengisi `KV_REST_API_URL` dan `KV_REST_API_TOKEN` (atau `UPSTASH_REDIS_REST_URL` dan `UPSTASH_REDIS_REST_TOKEN`).
3. Deploy ulang supaya variabelnya terbaca.

Tanpa Redis, `/api` menjawab 503. Meja yang tidak disentuh 6 jam terhapus otomatis.

## Tes

```bash
node poker.js
```

Menjalankan tes mesin permainan (peringkat tangan, side pot, timer, privasi kartu, dan fuzz ribuan hand). Berhasil kalau mencetak `semua tes lulus`.

## Struktur

| File | Isi |
| --- | --- |
| `poker.js` | Mesin permainan tanpa state global + tesnya |
| `handler.js` | Logika API (`GET`/`POST /api`), dipakai lokal dan di Vercel |
| `store.js` | Penyimpanan: memori (lokal) atau Redis lewat REST (Vercel) |
| `server.js` | Server lokal untuk main di satu WiFi |
| `api/index.js` | Fungsi serverless Vercel |
| `public/index.html` | Seluruh tampilan dan logika klien |

Waktu giliran bisa diubah dengan variabel lingkungan `TURN_MS` (milidetik).

Ini permainan dengan chip mainan, bukan uang sungguhan.
