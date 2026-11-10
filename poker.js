'use strict';
// Mesin Texas Hold'em: logika murni. Kartu = int 0..51: rank = c%13+2, suit = c/13|0 (s,h,d,c).
// Seluruh state bisa di-JSON-kan (JSON.stringify(t) / Table.from) supaya bisa disimpan di Redis dan dipakai fungsi
// serverless yang tidak punya memori. Tidak ada timer: pemanggil mengisi t.now, lalu t.tick() menjalankan event
// terjadwal (timeout giliran, hand berikutnya, runout) yang sudah jatuh tempo.
// Self-test: `node poker.js`
const { randomInt } = require('crypto');
const START = 1000, SB = 10, BB = 20, ONLINE_MS = 20000, GHOST_MS = 30 * 60000;
// waktu bisa dipercepat lewat env untuk pengujian (TURN_MS=1500 NEXT_MS=150 RUNOUT_MS=20)
const TURN_MS = +process.env.TURN_MS || 15000, NEXT_MS = +process.env.NEXT_MS || 7000, RUNOUT_MS = +process.env.RUNOUT_MS || 1500;
const HANDS = ['High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
const BASE = 15 ** 5, cat = s => s / BASE | 0;

function score5(cs) {
  const r = cs.map(c => c % 13 + 2).sort((a, b) => b - a), flush = cs.every(c => (c / 13 | 0) === (cs[0] / 13 | 0)), cnt = {};
  r.forEach(x => cnt[x] = (cnt[x] || 0) + 1);
  const g = Object.keys(cnt).map(Number).sort((a, b) => cnt[b] - cnt[a] || b - a), shape = g.map(x => cnt[x]).join('');
  const hi = g.length === 5 ? (r[0] - r[4] === 4 ? r[0] : r[0] === 14 && r[1] === 5 ? 5 : 0) : 0; // 5 = wheel A-2-3-4-5
  const [c, tb] = hi && flush ? [8, [hi]] : shape === '41' ? [7, g] : shape === '32' ? [6, g] : flush ? [5, g]
    : hi ? [4, [hi]] : shape === '311' ? [3, g] : shape === '221' ? [2, g] : shape === '2111' ? [1, g] : [0, g];
  return tb.concat([0, 0, 0, 0, 0]).slice(0, 5).reduce((a, x) => a * 15 + x, c);
}
// skor terbaik dari semua kombinasi 5 kartu (5-7 kartu masuk)
function best(cs, from = 0, pick = []) {
  if (pick.length === 5) return score5(pick);
  let m = 0;
  for (let i = from; i < cs.length; i++) m = Math.max(m, best(cs, i + 1, [...pick, cs[i]]));
  return m;
}
const handName = (cards, board) => HANDS[cat(best(cards.concat(board)))];

class Table {
  constructor() {
    Object.assign(this, { players: [], board: [], deck: [], phase: 'waiting', dealer: -1, turn: -1, bet: 0, minRaise: BB, due: null, started: false, hands: 0, handNo: 0, now: 0, host: null });
  }
  static from(o) { return Object.assign(new Table(), o); }
  toJSON() { const { now, ...rest } = this; return rest; } // `now` bukan bagian dari state yang disimpan
  newDeck() { const d = [...Array(52).keys()]; for (let i = 51; i > 0; i--) { const j = randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; } return d; }
  get betting() { return ['preflop', 'flop', 'turn', 'river'].includes(this.phase); }
  find(token) { return this.players.find(p => p.token === token); }
  online(p) { return this.now - p.seen < ONLINE_MS; } // online = baru saja menghubungi server
  eligible() { return this.players.filter(p => p.chips > 0 && !p.sitOut && this.online(p) && !p.gone); }
  after(i, f) { const n = this.players.length; for (let k = 1; k <= n; k++) { const j = (i + k + n) % n; if (f(this.players[j])) return j; } return -1; }

  // Hanya satu event terjadwal pada satu waktu; yang terbaru menggantikan yang lama.
  defer(kind, ms) { this.due = { kind, at: this.now + ms }; }
  tick() {
    for (let i = 0; i < 20 && this.due && this.due.at <= this.now; i++) {
      const { kind } = this.due; this.due = null;
      if (kind === 'turn') this.timeout(); else if (kind === 'runout') this.advance(); else this.startHand();
    }
    // pemain hantu (tab ditutup tanpa menekan Keluar) dibuang setelah lama, supaya kursi tidak penuh
    if (!this.betting) for (let i = this.players.length; i--;) if (this.now - this.players[i].seen > GHOST_MS) this.removeAt(i);
    this.maybeStart(); // pemain bisa tiba-tiba "online" tanpa ada event: jadwalkan hand berikutnya
  }

  join(name, token, chips = START) {
    this.players.push({ name, token, chips, seen: this.now, sitOut: false, gone: false, inHand: false, folded: false, allIn: false, acted: false, noRaise: false, show: false, cards: [], bet: 0, total: 0, score: 0, won: 0, last: '' });
    if (!this.players.some(p => p.token === this.host)) this.host = token; // master = pembuat meja (pemain pertama)
    this.maybeStart();
  }
  removeAt(i) {
    const [p] = this.players.splice(i, 1);
    if (i <= this.dealer) this.dealer--;
    if (p.token === this.host) this.host = this.players.length ? this.players[0].token : null; // master pergi: yang paling awal gabung menggantikan
  }
  start(i) { // i = indeks pemain yang menekan Mulai; hanya master yang boleh
    if (i !== undefined && this.players[i].token !== this.host) return 'Hanya master meja yang bisa memulai game';
    if (this.phase !== 'waiting') return 'Game sudah berjalan';
    if (this.eligible().length < 2) return 'Butuh minimal 2 pemain online';
    this.started = true; this.startHand();
  }
  maybeStart() { if (this.started && this.phase === 'waiting' && !this.due && this.eligible().length > 1) this.defer('start', 2500); }

  startHand() {
    if (this.betting) return;
    const el = this.eligible();
    if (el.length < 2) { this.phase = 'waiting'; this.turn = -1; return; }
    for (const p of this.players) Object.assign(p, { inHand: el.includes(p), folded: !el.includes(p), allIn: false, acted: false, noRaise: false, show: false, cards: [], bet: 0, total: 0, score: 0, won: 0, last: '' });
    this.handNo++;
    this.deck = this.newDeck(); this.board = []; this.phase = 'preflop'; this.bet = BB; this.minRaise = BB;
    this.dealer = this.after(this.dealer, p => p.inHand);
    const sb = el.length === 2 ? this.dealer : this.after(this.dealer, p => p.inHand), bb = this.after(sb, p => p.inHand);
    el.forEach(p => p.cards = [this.deck.pop(), this.deck.pop()]);
    this.put(this.players[sb], SB); this.put(this.players[bb], BB);
    this.players[sb].last = 'sb'; this.players[bb].last = 'bb';
    this.step(bb);
  }
  put(p, a) { a = Math.min(a, p.chips); p.chips -= a; p.bet += a; p.total += a; if (!p.chips) p.allIn = true; }

  ctl(i) {
    const p = this.players[i], call = this.bet - p.bet, max = p.bet + p.chips;
    return { call: Math.min(call, p.chips), bet: this.bet, minTo: Math.min(this.bet + this.minRaise, max), maxTo: max, raise: !p.noRaise && p.chips > call };
  }
  setTurn(i) { this.turn = i; this.defer('turn', TURN_MS); }
  timeout() {
    const p = this.players[this.turn];
    if (!p) return;
    p.sitOut = true; // pemain idle: auto check/fold dan istirahat sampai klik "Duduk lagi"
    this.act(this.turn, p.bet === this.bet ? 'check' : 'fold');
  }

  // Mengembalikan string error, atau undefined kalau sukses.
  act(i, type, amount) {
    if (i !== this.turn) return 'Bukan giliranmu';
    const p = this.players[i], toCall = this.bet - p.bet;
    if (type === 'fold') { p.folded = true; p.last = 'fold'; }
    else if (type === 'check') { if (toCall) return 'Tidak bisa check, ada bet'; p.last = 'check'; }
    else if (type === 'call') { const a = Math.min(toCall, p.chips); this.put(p, a); p.last = a ? 'call ' + a : 'check'; }
    else if (type === 'raise') {
      const to = Math.min(Math.floor(+amount), p.bet + p.chips);
      if (!(to > this.bet) || p.noRaise) return 'Raise tidak valid';
      const full = to - this.bet >= this.minRaise;
      if (!full && to < p.bet + p.chips) return `Minimal raise ke ${this.bet + this.minRaise}`;
      p.last = (this.bet ? 'raise ' : 'bet ') + to;
      this.put(p, to - p.bet);
      if (full) { this.minRaise = to - this.bet; for (const q of this.players) q.acted = q.noRaise = false; }
      else for (const q of this.players) { if (q.acted) q.noRaise = true; q.acted = false; } // all-in pendek tidak membuka raise lagi
      this.bet = to;
    } else return 'Aksi tidak dikenal';
    p.acted = true;
    this.step(i);
  }

  step(from) {
    const con = this.players.filter(p => p.inHand && !p.folded);
    if (con.length < 2) return this.finish(con);
    const live = con.filter(p => !p.allIn);
    if (live.every(p => p.acted && p.bet === this.bet) || (live.length < 2 && live.every(p => p.bet >= this.bet))) return this.advance();
    this.setTurn(this.after(from, p => p.inHand && !p.folded && !p.allIn));
  }
  advance() {
    for (const p of this.players) Object.assign(p, { bet: 0, acted: false, noRaise: false, last: p.folded ? p.last : '' }); // label aksi per ronde
    this.bet = 0; this.minRaise = BB;
    if (this.phase === 'river') return this.showdown();
    for (let k = this.phase === 'preflop' ? 3 : 1; k--;) this.board.push(this.deck.pop()); // ponytail: tanpa burn card
    this.phase = { preflop: 'flop', flop: 'turn', turn: 'river' }[this.phase];
    const con = this.players.filter(p => p.inHand && !p.folded);
    if (con.filter(p => !p.allIn).length > 1) return this.setTurn(this.after(this.dealer, p => p.inHand && !p.folded && !p.allIn));
    con.forEach(p => p.show = true); // semua all-in: buka kartu, board dibuka bertahap
    this.turn = -1; this.defer('runout', RUNOUT_MS);
  }
  showdown() {
    const con = this.players.filter(p => p.inHand && !p.folded);
    con.forEach(p => { p.show = true; p.score = best(p.cards.concat(this.board)); });
    this.finish(con);
  }
  // Bagi pot (main + side pot) ke pemenang. con = pemain yang masih bertahan.
  finish(con) {
    // taruhan yang tidak ada yang menyamai dikembalikan dulu (bukan "kemenangan")
    const [a, b] = [...this.players].sort((x, y) => y.total - x.total);
    if (b && a.total > b.total && a.inHand && !a.folded) { const r = a.total - b.total; a.chips += r; a.total -= r; }
    const n = this.players.length, all = this.players.filter(p => p.total > 0);
    const levels = [...new Set(con.map(p => p.total))].sort((x, y) => x - y), seat = p => (this.players.indexOf(p) - this.dealer - 1 + n) % n;
    let prev = 0;
    levels.forEach((L, k) => {
      const cap = k === levels.length - 1 ? Infinity : L; // level terakhir menyerap sisa kontribusi pemain fold
      const pot = all.reduce((s, p) => s + Math.min(p.total, cap) - Math.min(p.total, prev), 0);
      const el = con.filter(p => p.total >= L), top = Math.max(...el.map(p => p.score));
      const ws = el.filter(p => p.score === top).sort((x, y) => seat(x) - seat(y)), share = Math.floor(pot / ws.length), rem = pot - share * ws.length;
      ws.forEach((p, j) => { const g = share + (j < rem ? 1 : 0); p.chips += g; p.won += g; }); // sisa chip ganjil ke pemenang pertama sesudah dealer
      prev = L;
    });
    for (const p of this.players) { p.bet = 0; if (!p.folded) p.last = ''; }
    this.phase = 'showdown'; this.turn = -1; this.hands++;
    for (let i = this.players.length; i--;) if (this.players[i].gone) this.removeAt(i);
    this.defer('next', NEXT_MS);
  }

  leave(i) {
    const p = this.players[i];
    if (!this.betting) return this.removeAt(i);
    p.gone = p.sitOut = true; // dihapus setelah hand selesai (index pemain tidak boleh bergeser di tengah hand)
    if (p.inHand && !p.folded) {
      if (i === this.turn) return this.act(i, 'fold');
      p.folded = true; p.last = 'fold';
      const con = this.players.filter(q => q.inHand && !q.folded);
      if (con.length < 2) return this.finish(con);
    }
  }
  rebuy(i) {
    const p = this.players[i];
    if (p.chips > 0 || (this.betting && p.inHand && !p.folded)) return 'Belum bisa beli chips sekarang';
    p.chips = START; this.maybeStart();
  }
  sitIn(i) { this.players[i].sitOut = false; this.maybeStart(); }

  // State untuk satu pemain: kartu lawan disembunyikan sampai showdown; token dan dek tidak pernah ikut.
  view(me) {
    const i = this.players.indexOf(me), N = this.players;
    const hand = q => (q === me ? q.inHand && !q.folded : q.show && !q.folded) && this.board.length > 2 ? handName(q.cards, this.board) : '';
    const v = {
      me: i, phase: this.phase, board: this.board, started: this.started, dealer: this.dealer, turn: this.turn,
      ms: TURN_MS, sb: SB, bb: BB, start: START, no: this.handNo, host: me.token === this.host,
      pot: this.betting ? N.reduce((s, q) => s + q.total, 0) : 0,
      left: this.turn >= 0 && this.due ? Math.max(0, this.due.at - this.now) : 0,
      players: N.map(q => ({
        name: q.name, chips: q.chips, bet: q.bet, folded: q.folded, allIn: q.allIn, inHand: q.inHand, sitOut: q.sitOut,
        online: this.online(q), gone: q.gone, won: q.won, hand: hand(q), last: q.last, master: q.token === this.host,
        cards: q === me || q.show ? q.cards : q.inHand && !q.folded ? [-1, -1] : [],
      })),
    };
    if (this.turn === i) v.ctl = this.ctl(i);
    return v;
  }
}

module.exports = { Table, START, SB, BB, TURN_MS };

if (require.main === module) {
  const assert = require('assert');
  const C = s => s.split(' ').map(x => 'shdc'.indexOf(x[1]) * 13 + '23456789TJQKA'.indexOf(x[0]));
  const S = s => best(C(s));
  assert(S('As Ks Qs Js Ts 2d 3c') > S('9h 9d 9s 9c 2d 3c 4c'));  // straight flush > quads
  assert(S('Kh Kd Kc 2s 2h 9d 3c') > S('Ah 9h 7h 4h 2h Kd Kc'));  // full house > flush
  assert(S('Ah 2d 3c 4s 5h 9d Kc') < S('2d 3c 4s 5h 6h 9d Kc'));  // wheel < 6-high straight
  assert(S('Ah 2d 3c 4s 5h 9d Kc') > S('Ah Ad 3c 4s 9h Jd Kc'));  // wheel > pair
  assert(S('Ah Ad Kc 4s 5h 9d 2c') > S('Ah Ad Qc 4s 5h 9d 2c'));  // kicker
  assert.equal(handName(C('Ah Ad'), C('Ac Ks Kh')), 'Full House');

  // ---- alat uji: waktu dikendalikan manual, tidak ada timer sungguhan ----
  const mk = chips => { const t = new Table(); t.now = 1e6; chips.forEach((c, i) => t.join('P' + i, 'tok' + i, c)); return t; };
  const run = (t, ms) => { t.now += ms; t.players.forEach(p => { if (!p.off) p.seen = t.now; }); t.tick(); }; // pemain yang tidak off terus "online"
  const off = (t, i, v = true) => { t.players[i].off = v; t.players[i].seen = v ? -1e12 : t.now; };
  const drain = t => { while (t.phase !== 'showdown' && t.due) run(t, Math.max(0, t.due.at - t.now)); }; // majukan waktu sampai hand selesai
  const nxt = t => { while (!t.betting && t.due) run(t, Math.max(0, t.due.at - t.now)); };                // ...sampai hand berikutnya dibagi
  const ok = (t, i, ...a) => assert.equal(t.act(i, ...a), undefined, `aksi ${a} oleh P${i} harus sukses`);
  const bad = (t, i, ...a) => assert.equal(typeof t.act(i, ...a), 'string', `aksi ${a} oleh P${i} harus ditolak`);
  const rig = (t, s) => { const seq = C(s); t.newDeck = () => seq.slice().reverse(); }; // kartu dibagi urut: tiap pemain 2, lalu board
  const stacks = t => t.players.map(p => p.chips);
  const reload = (t, now) => { const u = Table.from(JSON.parse(JSON.stringify(t))); u.now = now; return u; }; // seperti fungsi serverless: state dimuat ulang tiap request

  { // side pot: all-in 100 / 300 / 500, kekuatan tangan P0 > P1 > P2
    const t = mk([100, 300, 500]); rig(t, 'As Ah Kd Kc 7c 2d 3h 8s 9d Tc 4h'); t.start();
    ok(t, 0, 'raise', 100); ok(t, 1, 'raise', 300); ok(t, 2, 'raise', 500); drain(t);
    assert.deepEqual(stacks(t), [300, 400, 200]);
  }

  { // heads-up: dealer = SB bertindak duluan preflop, BB punya option, postflop BB duluan
    const t = mk([1000, 1000]); t.start();
    assert.deepEqual([t.dealer, t.turn], [0, 0]);
    assert.deepEqual(t.players.map(p => p.bet), [10, 20]);
    ok(t, 0, 'call'); assert.equal(t.turn, 1);
    ok(t, 1, 'check'); assert.deepEqual([t.phase, t.turn], ['flop', 1]);
    ok(t, 1, 'check'); ok(t, 0, 'check'); assert.equal(t.phase, 'turn');
  }

  { // 3 pemain: urutan blind, SB duluan postflop, menang tanpa showdown, taruhan tak disamai dikembalikan, tombol dealer berputar
    const t = mk([1000, 1000, 1000]); t.start();
    assert.deepEqual([t.dealer, t.turn], [0, 0]);
    ok(t, 0, 'fold'); ok(t, 1, 'call'); assert.equal(t.turn, 2); ok(t, 2, 'check');
    assert.deepEqual([t.phase, t.turn], ['flop', 1]);
    ok(t, 1, 'raise', 40); ok(t, 2, 'fold');
    assert.equal(t.phase, 'showdown');
    assert.deepEqual(stacks(t), [1000, 1020, 980]);
    assert.deepEqual(t.players.map(p => p.won), [0, 40, 0]);
    assert(t.players.every(p => !p.show));
    nxt(t); assert.equal(t.dealer, 1);
  }

  { // min-raise: kenaikan harus >= kenaikan terakhir
    const t = mk([1000, 1000, 1000]); t.start();
    bad(t, 0, 'raise', 30); ok(t, 0, 'raise', 60);
    bad(t, 1, 'raise', 80); assert.equal(t.ctl(1).minTo, 100);
    ok(t, 1, 'raise', 100); assert.equal(t.ctl(2).minTo, 140);
  }

  { // all-in pendek (bukan full raise) tidak membuka raise lagi untuk yang sudah bertindak
    const t = mk([1000, 1000, 130]); t.start();
    ok(t, 0, 'raise', 100); ok(t, 1, 'call'); ok(t, 2, 'raise', 130);
    assert.equal(t.turn, 0);
    assert.deepEqual([t.ctl(0).raise, t.ctl(0).call], [false, 30]);
    bad(t, 0, 'raise', 400); ok(t, 0, 'call'); ok(t, 1, 'call');
    assert.equal(t.phase, 'flop');
  }

  { // taruhan besar yang hanya disamai sebagian: sisanya dikembalikan, bukan dihitung menang
    const t = mk([1000, 100]); rig(t, '2c 7d As Ah Kh 9d 4c 5s 3d'); t.start();
    ok(t, 0, 'raise', 1000); ok(t, 1, 'call'); drain(t);
    assert.deepEqual(stacks(t), [900, 200]);
    assert.deepEqual(t.players.map(p => p.won), [0, 200]);
  }

  { // seri: pot dibagi rata
    const t = mk([1000, 1000]); rig(t, '2c 3d 4h 5h As Ks Qs Js Ts'); t.start();
    ok(t, 0, 'raise', 1000); ok(t, 1, 'call'); drain(t);
    assert.deepEqual(stacks(t), [1000, 1000]);
  }

  { // bangkrut lalu beli chips lagi (tidak boleh saat masih all-in di hand berjalan)
    const t = mk([1000, 1000]); rig(t, '2c 7d As Ah Kh 9d 4c 5s 3d'); t.start();
    ok(t, 0, 'raise', 1000); ok(t, 1, 'call');
    assert.equal(typeof t.rebuy(0), 'string'); drain(t);
    assert.deepEqual(stacks(t), [0, 2000]);
    assert.equal(typeof t.rebuy(1), 'string'); assert.equal(t.rebuy(0), undefined);
    assert.equal(t.players[0].chips, START);
  }

  { // keluar di tengah hand: otomatis fold, game lanjut, pemain dihapus setelah hand selesai
    const t = mk([1000, 1000, 1000]); t.start();
    t.leave(2); assert.equal(t.players[2].folded, true);
    t.leave(0); assert.equal(t.phase, 'showdown');
    assert.deepEqual(t.players.map(p => p.name), ['P1']);
  }

  { // timeout: auto fold lalu istirahat (tidak dibagi kartu di hand berikutnya)
    const t = mk([1000, 1000, 1000]); t.start();
    t.timeout();
    assert.deepEqual([t.players[0].folded, t.players[0].sitOut], [true, true]);
    ok(t, 1, 'fold'); nxt(t);
    assert.deepEqual(t.players.map(p => p.inHand), [false, true, true]);
  }

  { // timer malas: belum jatuh tempo = tidak terjadi apa-apa; jatuh tempo = auto fold dan istirahat
    const t = mk([1000, 1000, 1000]); t.start();
    run(t, TURN_MS - 1); assert.equal(t.players[0].folded, false);
    run(t, 1); assert.deepEqual([t.players[0].folded, t.players[0].sitOut], [true, true]);
    assert.equal(t.turn, 1);
  }

  { // pemain baru di tengah hand dan pemain offline tidak dibagi kartu
    const t = mk([1000, 1000]); t.start();
    t.join('Z', 'z');
    assert.equal(t.players[2].inHand, false);
    ok(t, 0, 'fold'); off(t, 1); nxt(t);
    assert.deepEqual(t.players.map(p => p.inHand), [true, false, true]);
  }

  { // pemain yang berhenti menghubungi server dianggap offline setelah beberapa detik
    const t = mk([1000, 1000, 1000]);
    assert.equal(t.eligible().length, 3);
    t.now += ONLINE_MS + 1; t.players[0].seen = t.now; t.players[1].seen = t.now;
    assert.equal(t.eligible().length, 2);
  }

  { // pemain hantu (menghilang tanpa keluar) dibuang setelah lama, kecuali sedang di tengah hand
    const t = mk([1000, 1000, 1000]);
    t.now += GHOST_MS + 1; t.players[0].seen = t.now; t.players[1].seen = t.now; t.tick();
    assert.deepEqual(t.players.map(p => p.name), ['P0', 'P1']);
  }

  { // hanya master meja (pemain pertama) yang boleh memulai; kalau master hilang, pemain berikutnya menggantikan
    const t = mk([1000, 1000, 1000]);
    assert.deepEqual(t.players.map(p => t.view(p).host), [true, false, false]);
    assert.deepEqual(t.view(t.players[1]).players.map(p => p.master), [true, false, false]);
    assert.equal(typeof t.start(1), 'string'); assert.equal(t.phase, 'waiting');
    assert.equal(t.start(0), undefined); assert.equal(t.phase, 'preflop');
    const u = mk([1000, 1000, 1000]); u.removeAt(0);
    assert.equal(u.host, 'tok1'); assert.equal(u.view(u.players[0]).host, true);
    const v = mk([1000]); v.removeAt(0); assert.equal(v.host, null); v.join('Baru', 'tokB'); assert.equal(v.host, 'tokB');
  }

  { // privasi: kartu lawan, token, dan dek tidak bocor ke pemain lain
    const t = mk([1000, 1000, 1000]); t.start();
    const v = t.view(t.players[0]), s = JSON.stringify(v);
    assert.deepEqual(v.players[1].cards, [-1, -1]);
    assert.deepEqual(v.players[0].cards, t.players[0].cards);
    assert(!/tok\d|deck/.test(s), 'token/dek bocor di view');
  }

  { // fuzz: aksi acak, state selalu dimuat ulang dari JSON seperti di serverless; total chip tetap, tidak boleh macet
    let t = mk([100, 250, 1000, 40, 700]);
    const R = n => Math.random() * n | 0;
    let total = 2090, g = 0;
    t.start();
    while (t.hands < 3000 && ++g < 3e6) {
      t = reload(t, t.now);
      if (t.turn >= 0) {
        const i = t.turn, c = t.ctl(i), r = Math.random();
        if (c.call && r < .2) { assert(typeof t.act(i, 'check') === 'string'); assert.equal(t.turn, i); } // ilegal ditolak
        if (r < .1) t.act(i, 'fold');
        else if (r < .55 || !c.raise) t.act(i, c.call ? 'call' : 'check');
        else assert.equal(t.act(i, 'raise', c.minTo + R(c.maxTo - c.minTo + 1)), undefined);
      } else if (t.due) run(t, Math.max(0, t.due.at - t.now));
      else t.players.forEach((p, i) => { if (!p.chips && !t.rebuy(i)) total += START; }); // semua tetap bisa main
      assert(t.players.every(p => p.chips >= 0));
      if (!t.betting) assert.equal(t.players.reduce((s, p) => s + p.chips, 0), total);
    }
    assert(t.hands >= 3000, 'game macet');
  }

  { // fuzz kejadian: masuk/keluar/offline/timeout/sit-in/beli chips bercampur dengan aksi acak (dengan muat ulang state)
    let t = mk([500, 500, 500, 500]);
    const R = n => Math.random() * n | 0, sum = f => t.players.reduce((s, p) => s + f(p), 0);
    let total = 2000, cashed = 0, nid = 0, g = 0;
    const rm = Table.prototype.removeAt; Table.prototype.removeAt = function (i) { cashed += this.players[i].chips; rm.call(this, i); }; // chip pemain keluar dibawa pulang
    const add = () => { t.join('N' + nid, 'n' + nid++); total += START; };
    t.start();
    while (t.hands < 1500 && ++g < 4e6) {
      t = reload(t, t.now);
      const r = Math.random(), stay = t.players.filter(p => !p.gone).length;
      if (r < .004 && t.players.length < 9) add();
      else if (r < .008 && stay > 2) t.leave(R(t.players.length));
      else if (r < .012) { const i = R(t.players.length); off(t, i, !t.players[i].off); }
      else if (r < .016 && t.turn >= 0) t.timeout();
      else if (r < .02) t.sitIn(R(t.players.length));
      else if (t.turn >= 0) {
        const i = t.turn, c = t.ctl(i), x = Math.random();
        if (x < .12) ok(t, i, 'fold');
        else if (x < .55 || !c.raise) ok(t, i, c.call ? 'call' : 'check');
        else ok(t, i, 'raise', c.minTo + R(c.maxTo - c.minTo + 1));
      } else if (t.due) run(t, Math.max(0, t.due.at - t.now));
      else { // tidak ada yang jalan: pulihkan semua pemain supaya game lanjut
        if (t.players.length < 3) add();
        t.players.forEach((p, i) => { off(t, i, false); t.sitIn(i); if (!p.chips && !t.rebuy(i)) total += START; });
        if (!t.due && !t.betting) t.start();
      }
      assert(t.players.every(p => p.chips >= 0) && t.dealer >= -1 && t.dealer < t.players.length);
      if (t.betting) assert.equal(sum(p => p.chips + p.total) + cashed, total);
      else assert.equal(sum(p => p.chips) + cashed, total);
      if (t.turn >= 0) { const p = t.players[t.turn]; assert(p.inHand && !p.folded && !p.allIn, 'giliran jatuh ke pemain yang salah'); }
    }
    assert(t.hands >= 1500, 'game macet');
    Table.prototype.removeAt = rm;
  }
  console.log('semua tes lulus');
}
