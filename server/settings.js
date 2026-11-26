// Live game settings (edited from the admin panel, stored in MongoDB, cached in memory).
// Every default equals the value the game used before, so nothing changes until an admin edits it.
const SlotMath = require('./slots_math');

const SLOT_BASE_RTP = SlotMath.rtpExact();           // 0.9265 with the built-in strips and paytable
const DEFAULTS = {
  maintenance: { on: false, msg: 'Maintenance - please come back soon.' },
  limits: { startCoins: 2500, startHearts: 2, dailyBonus: 100, inviteReward: 200, inviteMinDeposit: 1000,
    depositMin: 100, depositMax: 1000000, withdrawMin: 5000, maxPendingDeposits: 3, maxPendingWithdrawals: 2 },
  storage: { fullPct: 85, ledgerKeepDays: 60, avatarKeepDays: 45 },
  games: {
    duel:  { on: true, fee: 500, edge: 10 },                                   // prize = 2 x fee x (1 - edge)
    bomb:  { on: true, edge: 10, entries: [1000, 2000, 5000, 15000], minBombs: 3, maxBombs: 15, maxMult: 100 },
    lucky: { on: true, edge: 10, tiers: [200, 500, 1000, 3000, 5000] },
    slots: { on: true, edge: +((1 - SLOT_BASE_RTP) * 100).toFixed(2), presets: [50, 100, 200, 500, 600], min: 10, max: 5000 },
    spin:  { on: true, edge: 15, cost: 100 },
    hearts: { on: true, packs: [{ n: 1, price: 700 }, { n: 2, price: 1400 }, { n: 3, price: 2000 }, { n: 5, price: 3400 }, { n: 10, price: 6000 }] },
  },
};

// ---------- pure math helpers (shared by the games and by the admin preview) ----------
const rtpOf = (edge) => 1 - edge / 100;
const duelPrize = (g) => Math.floor(2 * g.fee * rtpOf(g.edge));
// Bomb Points: payout = (1 - edge) / P(surviving k picks), rounded DOWN to 2 decimals. Expected return of cashing out at any step is (1 - edge).
function bombTable(g) {
  const T = {};
  for (let b = g.minBombs; b <= g.maxBombs; b++) {
    const row = []; let p = 1;
    for (let s = 1; s <= 16 - b; s++) {
      p *= (16 - b - (s - 1)) / (16 - (s - 1));
      row.push(Math.min(g.maxMult, Math.max(1.01, Math.floor(rtpOf(g.edge) / p * 100) / 100)));
    }
    T[b] = row;
  }
  return T;
}
// Lucky Cards: deck skull, skull, bronze 50%, silver 100%, gold X%. RTP = (150 + X) / 500  =>  X = 500 x RTP - 150
const luckyCards = (g) => ({ skull: 0, bronze: 50, silver: 100, gold: Math.max(100, Math.round(500 * rtpOf(g.edge) - 150)) });
const luckyRtp = (g) => (150 + luckyCards(g).gold) / 500;
// Slots: the paytable is multiplied so that RTP = 1 - edge (multipliers kept in hundredths, so every win is exact)
function slotPay(g) {
  const k = rtpOf(g.edge) / SLOT_BASE_RTP, out = {};
  for (const s of Object.keys(SlotMath.PAYTABLE)) out[s] = Math.max(1, Math.round(SlotMath.PAYTABLE[s] * k * 100)) / 100;
  return out;
}
function slotRtp(g) {   // exact RTP of the (rounded) table
  const P = slotPay(g), n = {}; SlotMath.SYMS.forEach((s) => { n[s] = SlotMath.COUNTS[s] / SlotMath.STRIP_LEN; });
  let ev = 0;
  SlotMath.SYMS.forEach((s) => { ev += s === 'wild' ? n.wild ** 3 * P.wild : ((n[s] + n.wild) ** 3 - n.wild ** 3) * P[s]; });
  return ev;
}
// Spin wheel: the wedge values are printed on the wheel, so the edge changes the ODDS (per mille). "try again" absorbs the rest.
const SPIN_BASE = [{ k: 'coins', v: 100, w: 180 }, { k: 'coins', v: 200, w: 100 }, { k: 'coins', v: 250, w: 50 }, { k: 'coins', v: 300, w: 45 }, { k: 'coins', v: 500, w: 25 }];
const SPIN_FREE_W = 100;
function spinOdds(g) {
  const s0 = SPIN_BASE.reduce((a, o) => a + o.w * o.v, 0) / 1000;                       // 76.5 coins
  let k = rtpOf(g.edge) * g.cost * (1 - SPIN_FREE_W / 1000) / s0;                         // scale of the coin chances
  const maxK = (1000 - SPIN_FREE_W) / SPIN_BASE.reduce((a, o) => a + o.w, 0);
  k = Math.min(k, maxK);
  const coins = SPIN_BASE.map((o) => ({ ...o, w: Math.max(1, Math.round(o.w * k)) }));
  const used = coins.reduce((a, o) => a + o.w, 0) + SPIN_FREE_W;
  return [{ k: 'try', w: 1000 - used }, { k: 'free', w: SPIN_FREE_W }, ...coins];
}
const spinRtp = (g) => { const o = spinOdds(g); return o.filter((x) => x.k === 'coins').reduce((a, x) => a + x.w * x.v, 0) / 1000 / (1 - SPIN_FREE_W / 1000) / g.cost; };

// ---------- store ----------
let cur = JSON.parse(JSON.stringify(DEFAULTS)), model = null;
const merge = (d, s) => { for (const k of Object.keys(d)) { if (s && s[k] !== undefined) { if (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k])) merge(d[k], s[k]); else d[k] = s[k]; } } return d; };
const get = () => cur;
async function load(mongoose) {
  model = mongoose.model('Config', new mongoose.Schema({ key: { type: String, unique: true }, data: mongoose.Schema.Types.Mixed, updatedAt: Date }));
  const row = await model.findOne({ key: 'settings' }).lean();
  cur = merge(JSON.parse(JSON.stringify(DEFAULTS)), row && row.data);
}

// ---------- validation: only known fields, clamped to safe ranges ----------
const num = (v, lo, hi, dec) => { v = Number(v); if (!Number.isFinite(v)) throw new Error('bad_number'); v = Math.min(hi, Math.max(lo, v)); return dec ? +v.toFixed(dec) : Math.round(v); };
const list = (a, lo, hi, exact) => { if (!Array.isArray(a) || a.length !== exact) throw new Error('bad_list'); const o = [...new Set(a.map((x) => num(x, lo, hi)))].sort((x, y) => x - y); return o; };
function sanitize(p) {
  const o = {};
  if (p.maintenance) o.maintenance = { on: !!p.maintenance.on, msg: String(p.maintenance.msg || '').slice(0, 200) };
  if (p.limits) {
    const L = p.limits, r = {};
    const f = { startCoins: [0, 1e7], startHearts: [0, 1000], dailyBonus: [0, 1e6], inviteReward: [0, 1e6], inviteMinDeposit: [0, 1e7], depositMin: [1, 1e7], depositMax: [1, 1e9], withdrawMin: [1, 1e9], maxPendingDeposits: [1, 20], maxPendingWithdrawals: [1, 20] };
    for (const k of Object.keys(f)) if (L[k] !== undefined) r[k] = num(L[k], f[k][0], f[k][1]);
    o.limits = r;
  }
  if (p.storage) {
    const S = p.storage, r = {};
    if (S.fullPct !== undefined) r.fullPct = num(S.fullPct, 30, 98); if (S.ledgerKeepDays !== undefined) r.ledgerKeepDays = num(S.ledgerKeepDays, 3, 3650); if (S.avatarKeepDays !== undefined) r.avatarKeepDays = num(S.avatarKeepDays, 3, 3650);
    o.storage = r;
  }
  if (p.games) {
    o.games = {};
    const G = p.games;
    for (const name of Object.keys(DEFAULTS.games)) {
      if (!G[name]) continue; const g = G[name], r = {};
      if (g.on !== undefined) r.on = !!g.on;
      if (g.edge !== undefined) r.edge = num(g.edge, name === 'lucky' ? 1 : 0, name === 'lucky' ? 50 : 60, 2);
      if (name === 'duel' && g.fee !== undefined) r.fee = num(g.fee, 10, 1e6);
      if (name === 'bomb') { if (g.entries) r.entries = list(g.entries, 10, 1e6, 4); if (g.minBombs !== undefined) r.minBombs = num(g.minBombs, 1, 14); if (g.maxBombs !== undefined) r.maxBombs = num(g.maxBombs, 2, 15); if (g.maxMult !== undefined) r.maxMult = num(g.maxMult, 2, 1000); }
      if (name === 'lucky' && g.tiers) r.tiers = list(g.tiers, 10, 1e6, 5);
      if (name === 'slots') { if (g.presets) r.presets = list(g.presets, 1, 1e6, 5); if (g.min !== undefined) r.min = num(g.min, 1, 1e6); if (g.max !== undefined) r.max = num(g.max, 1, 1e7); }
      if (name === 'spin' && g.cost !== undefined) r.cost = num(g.cost, 1, 1e6);
      if (name === 'hearts' && g.packs) { const N = [1, 2, 3, 5, 10]; if (!Array.isArray(g.packs) || g.packs.length !== 5) throw new Error('bad_list'); r.packs = N.map((n, i) => ({ n, price: num(g.packs[i].price, 1, 1e7) })); }   // the pack pictures exist for 1, 2, 3, 5 and 10 hearts: only the prices change
      o.games[name] = r;
    }
  }
  return o;
}
async function save(patch, who) {
  const clean = sanitize(patch), next = merge(JSON.parse(JSON.stringify(cur)), clean);
  const b = next.games.bomb; if (b.minBombs > b.maxBombs) throw new Error('bomb_range');
  const s = next.games.slots; if (s.min > s.max) throw new Error('slots_range');
  if (next.limits.depositMin > next.limits.depositMax) throw new Error('deposit_range');
  cur = next;
  await model.updateOne({ key: 'settings' }, { $set: { data: cur, updatedAt: new Date() } }, { upsert: true });
  return clean;
}
// what the admin screen shows next to each edge field (computed from the CURRENT settings)
function derived() {
  const g = cur.games, bt = bombTable(g.bomb), lc = luckyCards(g.lucky);
  return {
    duel: { prize: duelPrize(g.duel), houseTakes: 2 * g.duel.fee - duelPrize(g.duel), rtp: rtpOf(g.duel.edge) },
    bomb: { rtp: rtpOf(g.bomb.edge), maxPrizeMult: Math.max(...Object.values(bt).map((r) => Math.max(...r))), sample3: bt[g.bomb.minBombs] },
    lucky: { cards: lc, rtp: luckyRtp(g.lucky) },
    slots: { baseRtp: SLOT_BASE_RTP, rtp: slotRtp(g.slots), paytable: slotPay(g.slots) },
    spin: { rtp: spinRtp(g.spin), odds: spinOdds(g.spin) },
  };
}
module.exports = { DEFAULTS, SLOT_BASE_RTP, get, load, save, derived, duelPrize, bombTable, luckyCards, slotPay, slotRtp, spinOdds, spinRtp, rtpOf };
