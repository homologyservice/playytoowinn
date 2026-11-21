/* Shared helpers: Telegram, stage scaling, API (live server or in-browser demo) */
const tg = window.Telegram && Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); try { tg.setHeaderColor('#4a46b8'); tg.setBackgroundColor('#4a46b8'); } catch (e) {} }
const $ = id => document.getElementById(id);
const Q = new URLSearchParams(location.search);

const FEE = 500, PRIZE = 900;
const CLAIM_MS = Q.get('fast') ? 10000 : 10 * 60 * 1000;   // ?fast=1 -> 10s claim timer for testing
const fmt = n => n >= 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : n >= 1000 ? n.toLocaleString('en-US') : String(n);

function toast(msg) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}
function haptic(kind) {
  try { Sfx.play(kind === 'success' ? 'win' : kind === 'error' ? 'lose' : kind === 'heavy' ? 'thump' : kind === 'medium' ? 'tap' : 'soft'); } catch (e) {}
  try { if (!SET.vib) return; tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred(kind || 'light'); } catch (e) {}
}

/* Scale 720x1280 design stage to fit the screen */
function fitStage(el) {
  const f = () => {
    const w = innerWidth, h = innerHeight, s = Math.min(w / 720, h / 1280);
    el.style.transform = `translate(${(w - 720 * s) / 2}px,${(h - 1280 * s) / 2}px) scale(${s})`;
    el._scale = s;
  };
  f(); addEventListener('resize', f); if (tg) tg.onEvent('viewportChanged', f);
}

/* ---------------- API ---------------- */
const API_URL = (window.P2W_API || '').replace(/\/$/, '');
const LIVE = !!(API_URL && !API_URL.includes('YOUR-SERVER') && tg && tg.initData) && !Q.get('demo');

async function call(path, body, timeoutMs) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs || 30000);   // never wait forever
  try {
    const r = await fetch(API_URL + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'x-init-data': tg.initData },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const err = new Error(j.error || 'network_error'); err.data = j; throw err; }
    return j;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('timeout');
    throw e;
  } finally { clearTimeout(timer); }
}

/* Bomb Points rules (the server is the source of truth; these are for display + demo mode) */
const BOMB_ENTRIES = [1000, 2000, 5000, 15000];
const BOMB_LADDER = [1.10, 1.20, 1.30, 1.42, 1.55, 1.72, 1.95, 2.25, 2.65, 3.15, 3.75, 4.40, 5.00];   // same as server/index.js (the page also takes it from the server)
const bombMult = (bombs, safe) => safe < 1 ? 1 : BOMB_LADDER[Math.min(BOMB_LADDER.length - 1, bombs - 3 + safe - 1)];
const bombPrize = (entry, mult) => Math.floor(entry * Math.round(mult * 100) / 100);   // total returned (entry included); exact, no float error

/* Lucky Cards rules (same as server/index.js; the server is the source of truth) */
const LUCKY_TIERS = [200, 500, 1000, 3000, 5000];
const LUCKY_CARDS = { skull: 0, bronze: 50, silver: 100, gold: 300 };   // percent of the bet that comes back
const LUCKY_DECK = ['skull', 'skull', 'bronze', 'silver', 'gold'];
const luckyPrize = (bet, kind) => Math.floor(bet * LUCKY_CARDS[kind] / 100);

/* Slot Machine limits (same as server/index.js; the math itself is in slots_math.js) */
const SLOT_BET_PRESETS = [50, 100, 200, 500, 600];
const SLOT_BET_MIN = 10, SLOT_BET_MAX = 5000;

/* Daily bonus, spin wheel, invites (same numbers as server/index.js; the server decides, these are for display + demo mode) */
const DAILY_BONUS = 100, SPIN_COST = 100, INVITE_REWARD = 200, INVITE_MIN_DEPOSIT = 1000, DAY_OFFSET_MIN = 390;   // a "day" ends at Myanmar midnight (UTC+6:30)
const dayKey = (t = Date.now()) => new Date(t + DAY_OFFSET_MIN * 60000).toISOString().slice(0, 10);
const nextDayAt = () => { const d = new Date(Date.now() + DAY_OFFSET_MIN * 60000); d.setUTCHours(24, 0, 0, 0); return d.getTime() - DAY_OFFSET_MIN * 60000; };
/* wheel order = clockwise from the top; chances are per mille */
const SPIN_WEDGES = [{ k: 'coins', v: 100 }, { k: 'try' }, { k: 'coins', v: 200 }, { k: 'free' }, { k: 'coins', v: 300 }, { k: 'try' }, { k: 'coins', v: 250 }, { k: 'coins', v: 500 }];
const SPIN_ODDS = [{ k: 'try', w: 500 }, { k: 'free', w: 100 }, { k: 'coins', v: 100, w: 180 }, { k: 'coins', v: 200, w: 100 }, { k: 'coins', v: 250, w: 50 }, { k: 'coins', v: 300, w: 45 }, { k: 'coins', v: 500, w: 25 }];
const HEART_PACKS = [{ n: 1, price: 700 }, { n: 2, price: 1400 }, { n: 3, price: 2000 }, { n: 5, price: 3400 }, { n: 10, price: 6000 }];   // same as the server
const mmss2 = ms => { const t = Math.max(0, Math.ceil(ms / 1000)); return String(Math.floor(t / 3600)).padStart(2, '0') + ':' + String(Math.floor(t / 60) % 60).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
/* name masking for the ranking: last 3 characters -> ***, 3 or fewer -> all stars, 1 character -> hidden (null). Burmese/emoji safe. */
const _seg = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = str => _seg ? Array.from(_seg.segment(String(str || '')), x => x.segment) : Array.from(String(str || ''));
function maskName(name) { const g = graphemes(name); if (g.length <= 1) return null; if (g.length <= 3) return '*'.repeat(g.length); return g.slice(0, g.length - 3).join('') + '***'; }
const escHtml = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));   // names come from Telegram: never put them in HTML raw

/* Demo mode: everything runs in this browser (localStorage). Used before the server is connected.
   It follows the same rules as the server: max 5 open slots, max 10 history rows. */
const WAIT_MAX = 5, HISTORY_MAX = 10;
const Mock = (() => {
  const K = 'p2w_demo_v3';
  const load = () => { try { return JSON.parse(localStorage.getItem(K)) || null; } catch (e) { return null; } };
  const save = s => { try { localStorage.setItem(K, JSON.stringify(s)); } catch (e) {} };
  let s = load() || { coins: 2500, hearts: 2, matches: [], active: null };
  const name = () => (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.first_name) || 'Player';
  const rid = () => Math.random().toString(36).slice(2, 10);
  const oppName = () => 'Player ' + (1000 + Math.floor(Math.random() * 9000));
  const bomb = () => (s.bomb = s.bomb || { round: null, hist: [] });
  const lk = () => (s.lucky = s.lucky || { round: null, hist: [] });
  const lview = r => ({ id: r.id, bet: r.bet, count: LUCKY_DECK.length, picked: -1, status: 'active', cards: null, prize: 0, net: 0 });
  const bview = r => ({ id: r.id, entry: r.entry, bombs: r.bombs, picks: r.picks, safe: r.safe,
    mult: bombMult(r.bombs, r.safe), prize: r.safe ? bombPrize(r.entry, bombMult(r.bombs, r.safe)) : 0, net: r.safe ? bombPrize(r.entry, bombMult(r.bombs, r.safe)) - r.entry : 0, nextMult: bombMult(r.bombs, r.safe + 1) });
  function bend(b, r, result, prize) { // finish a round and keep only the latest 10 (oldest deleted)
    b.round = null; b.hist.unshift({ id: r.id, entry: r.entry, bombs: r.bombs, safe: r.safe, result, prize, net: result === 'win' ? prize - r.entry : -r.entry, at: Date.now() });
    b.hist = b.hist.slice(0, 10);
  }
  function settle() { // pending matches get an opponent after 20s (demo only)
    const now = Date.now();
    s.matches.forEach(m => {
      if (m.result === 'pending' && now - m.at > 20000) {
        m.oppScore = Math.max(0, m.myScore + Math.floor(Math.random() * 20) - 10);
        m.opponent = oppName(); m.result = m.myScore > m.oppScore ? 'win' : m.myScore < m.oppScore ? 'loss' : 'draw';
        m.prize = m.result === 'win' ? PRIZE : m.result === 'draw' ? FEE : 0; m.claimAt = now + CLAIM_MS; m.at = now;
      }
    });
    save(s);
  }
  // slots = matches waiting for an opponent + won/drawn matches (that were waiting) whose prize is not claimed yet
  function slots() {
    const waiting = s.matches.filter(m => m.result === 'pending').length;
    const unclaimed = s.matches.filter(m => m.asA && m.result !== 'pending' && m.prize > 0 && !m.claimed).length;
    const used = waiting + unclaimed, blocked = used >= WAIT_MAX;
    return { waiting, unclaimed, used, limit: WAIT_MAX, blocked, reason: blocked ? (waiting >= WAIT_MAX ? 'waiting_limit' : 'claim_first') : null };
  }
  function prune() { // keep the latest 10; remove the oldest FINISHED row (waiting rows stay); unclaimed prize is paid out
    while (s.matches.length > HISTORY_MAX) {
      let idx = -1, oldest = Infinity;
      s.matches.forEach((m, i) => { if (m.result !== 'pending' && m.at < oldest) { oldest = m.at; idx = i; } });
      if (idx < 0) break;
      const m = s.matches[idx];
      if (m.prize > 0 && !m.claimed) s.coins += m.prize;
      s.matches.splice(idx, 1);
    }
  }
  return {
    async me() { settle(); prune(); save(s); return { name: name(), coins: s.coins, hearts: s.hearts, ...slots() }; },
    async start() {
      settle();
      const sl = slots(); if (sl.blocked) throw new Error(sl.reason);
      if (s.coins < FEE) throw new Error('not_enough_coins');
      s.coins -= FEE;
      const has = !Q.get('wait') && Math.random() < 0.35;   // ?wait=1 -> never finds an opponent (to test the 5-slot limit)
      const opp = has ? { name: oppName(), score: 6 + Math.floor(Math.random() * 30) } : null;
      s.active = { id: rid(), opp, at: Date.now() }; save(s);
      return { matchId: s.active.id, seed: s.active.id, role: has ? 'b' : 'a', opponent: opp, coins: s.coins, hearts: s.hearts };
    },
    async finish({ matchId, score, forfeit }) {
      const a = s.active; if (!a || a.id !== matchId) throw new Error('not_active');
      s.active = null;
      if (forfeit) {
        if (a.opp) { s.matches.unshift({ id: a.id, opponent: a.opp.name, myScore: 0, oppScore: a.opp.score, result: 'loss', prize: 0, claimAt: Date.now(), claimed: false, at: Date.now(), asA: false }); prune(); }
        save(s); return { result: 'forfeit', coins: s.coins, ...slots() };
      }
      if (!a.opp) {
        s.matches.unshift({ id: a.id, opponent: null, myScore: score, oppScore: null, result: 'pending', prize: 0, claimAt: 0, claimed: false, at: Date.now(), asA: true });
        prune(); save(s); return { result: 'waiting', myScore: score, coins: s.coins, ...slots() };
      }
      const r = score > a.opp.score ? 'win' : score < a.opp.score ? 'loss' : 'draw';
      const prize = r === 'win' ? PRIZE : r === 'draw' ? FEE : 0, claimAt = Date.now() + CLAIM_MS;
      s.matches.unshift({ id: a.id, opponent: a.opp.name, myScore: score, oppScore: a.opp.score, result: r, prize, claimAt, claimed: false, at: Date.now(), asA: false });
      prune(); save(s);
      return { result: r, myScore: score, oppScore: a.opp.score, prize, claimAt, coins: s.coins, ...slots() };
    },
    async revive(matchId) {
      if (!s.active || s.active.id !== matchId) throw new Error('not_active');
      if (s.hearts < 1) throw new Error('no_hearts');
      s.hearts -= 1; save(s); return { hearts: s.hearts };
    },
    async history() {
      settle(); prune(); save(s);
      const items = s.matches.slice().sort((x, y) => y.at - x.at).slice(0, HISTORY_MAX);
      return { items, coins: s.coins, hearts: s.hearts, ...slots() };
    },
    /* ---- Bomb Points (demo): same rules as the server ---- */
    async bombState() { const b = bomb(); return { coins: s.coins, round: b.round ? bview(b.round) : null, ladder: BOMB_LADDER, entries: BOMB_ENTRIES }; },
    async bombStart({ entry, bombs }) {
      const b = bomb();
      if (!BOMB_ENTRIES.includes(entry) || !(bombs >= 3 && bombs <= 15)) throw new Error('bad_request');
      if (b.round) throw new Error('round_active');
      if (s.coins < entry) throw new Error('not_enough_coins');
      s.coins -= entry;
      const t = Array.from({ length: 16 }, (_, i) => i).sort(() => Math.random() - .5);
      b.round = { id: rid(), entry, bombs, mines: t.slice(0, bombs), picks: [], safe: 0, at: Date.now() };
      save(s); return { coins: s.coins, round: bview(b.round) };
    },
    async bombPick({ tile }) {
      const b = bomb(), r = b.round; if (!r) throw new Error('not_active');
      if (r.picks.includes(tile)) throw new Error('already_picked');
      if (r.mines.includes(tile)) { bend(b, r, 'loss', 0); save(s); return { result: 'bomb', tile, mines: r.mines, safe: r.safe, lost: r.entry, coins: s.coins }; }
      r.picks.push(tile); r.safe++;
      const mult = bombMult(r.bombs, r.safe), prize = bombPrize(r.entry, mult);
      if (r.safe >= 16 - r.bombs) { s.coins += prize; bend(b, r, 'win', prize); save(s); return { result: 'cleared', tile, safe: r.safe, mult, prize, net: prize - r.entry, entry: r.entry, mines: r.mines, coins: s.coins }; }
      save(s); return { result: 'safe', tile, safe: r.safe, mult, prize, net: prize - r.entry, entry: r.entry, nextMult: bombMult(r.bombs, r.safe + 1) };
    },
    async bombCashout() {
      const b = bomb(), r = b.round; if (!r) throw new Error('not_active'); if (r.safe < 1) throw new Error('nothing_to_cash');
      const mult = bombMult(r.bombs, r.safe), prize = bombPrize(r.entry, mult);
      s.coins += prize; bend(b, r, 'win', prize); save(s);
      return { result: 'cashed', prize, net: prize - r.entry, entry: r.entry, safe: r.safe, mult, mines: r.mines, coins: s.coins };
    },
    async bombHistory() { return { coins: s.coins, items: bomb().hist.slice(0, 10) }; },
    async claim(id) {
      const m = s.matches.find(x => x.id === id);
      if (!m || m.claimed || !m.prize) throw new Error('nothing');
      if (Date.now() < m.claimAt) throw new Error('too_early');
      m.claimed = true; s.coins += m.prize; save(s); return { coins: s.coins, ...slots() };
    },
    /* ---- Lucky Cards (demo): same rules as the server ---- */
    async luckyState() { const l = lk(); return { coins: s.coins, round: l.round ? lview(l.round) : null, tiers: LUCKY_TIERS, cards: LUCKY_CARDS }; },
    async luckyPlay({ bet }) {
      const l = lk();
      if (!LUCKY_TIERS.includes(bet)) throw new Error('bad_request');
      if (l.round) throw new Error('round_active');
      if (s.coins < bet) throw new Error('not_enough_coins');
      s.coins -= bet;
      l.round = { id: rid(), bet, deck: LUCKY_DECK.slice().sort(() => Math.random() - .5) }; save(s);
      return { coins: s.coins, round: lview(l.round) };
    },
    async luckyPick({ index }) {
      const l = lk(), r = l.round; if (!r) throw new Error('not_active');
      if (!(index >= 0 && index < r.deck.length)) throw new Error('bad_request');
      const kind = r.deck[index], prize = luckyPrize(r.bet, kind), net = prize - r.bet;
      s.coins += prize; l.round = null;
      l.hist.unshift({ id: r.id, bet: r.bet, kind, prize, net, at: Date.now() }); l.hist = l.hist.slice(0, 10);
      save(s);
      return { result: net > 0 ? 'win' : net === 0 ? 'even' : 'lose', kind, picked: index, cards: r.deck, prize, net, bet: r.bet, coins: s.coins };
    },
    async luckyHistory() { return { coins: s.coins, items: lk().hist.slice(0, 10) }; },
    /* ---- Slot Machine (demo): same math as the server ---- */
    async slotState() { return { coins: s.coins, presets: SLOT_BET_PRESETS, min: SLOT_BET_MIN, max: SLOT_BET_MAX, strips: SlotMath.STRIPS, paytable: SlotMath.PAYTABLE }; },
    async slotSpin({ bet }) {
      if (!Number.isInteger(bet) || bet < SLOT_BET_MIN || bet > SLOT_BET_MAX) throw new Error('bad_request');
      if (s.coins < bet) throw new Error('not_enough_coins');
      s.coins -= bet;
      const stops = [0, 1, 2].map(() => Math.floor(Math.random() * SlotMath.STRIP_LEN));
      const { mult, sym } = SlotMath.evaluate(stops); const win = bet * mult;
      s.coins += win; save(s);
      return { coins: s.coins, bet, stops, reels: stops.map((x, r) => SlotMath.visible(r, x)), line: SlotMath.payline(stops), sym, mult, win, net: win - bet };
    },
    /* ---- Daily bonus / Spin / Invites / Ranking / Profile (demo) ---- */
    async dailyState() { return { coins: s.coins, amount: DAILY_BONUS, available: s.lastDaily !== dayKey(), nextAt: nextDayAt() }; },
    async dailyClaim() {
      if (s.lastDaily === dayKey()) { const e = new Error('already_claimed'); e.data = { nextAt: nextDayAt(), coins: s.coins }; throw e; }
      s.lastDaily = dayKey(); s.coins += DAILY_BONUS; save(s); return { amount: DAILY_BONUS, coins: s.coins, nextAt: nextDayAt() };
    },
    _spinView() { return { coins: s.coins, freeSpins: s.freeSpins || 0, freeAvailable: s.lastFreeSpin !== dayKey(), nextFreeAt: nextDayAt(), cost: SPIN_COST }; },
    async spinState() { return { ...this._spinView(), wedges: SPIN_WEDGES }; },
    async spinPlay() {
      let source;
      if ((s.freeSpins || 0) > 0) { s.freeSpins--; source = 'bonus'; }
      else if (s.lastFreeSpin !== dayKey()) { s.lastFreeSpin = dayKey(); source = 'daily'; }
      else { if (s.coins < SPIN_COST) throw new Error('not_enough_coins'); s.coins -= SPIN_COST; source = 'paid'; }
      let r = Math.floor(Math.random() * 1000), prize = SPIN_ODDS[SPIN_ODDS.length - 1];
      for (const o of SPIN_ODDS) { if (r < o.w) { prize = o; break; } r -= o.w; }
      const idx = SPIN_WEDGES.map((w, i) => i).filter(i => SPIN_WEDGES[i].k === prize.k && (prize.k !== 'coins' || SPIN_WEDGES[i].v === prize.v));
      const wedge = idx[Math.floor(Math.random() * idx.length)], amount = prize.k === 'coins' ? prize.v : 0;
      if (prize.k === 'coins') s.coins += amount; if (prize.k === 'free') s.freeSpins = (s.freeSpins || 0) + 1;
      save(s); return { wedge, kind: prize.k, amount, source, ...this._spinView() };
    },
    _inv() {   // demo friends: two are still adding coins, two completed (one already claimed)
      if (!s.inv) s.inv = { list: [
        { id: '1', name: 'Aung Kyaw', at: Date.now() - 3600e3 * 5, done: false, dep: 400 },
        { id: '2', name: 'Su Su Hlaing', at: Date.now() - 3600e3 * 26, done: false, dep: 0 },
        { id: '3', name: 'Min Thant', at: Date.now() - 3600e3 * 50, done: true, claimed: false },
        { id: '4', name: 'မောင်မောင်', at: Date.now() - 3600e3 * 90, done: true, claimed: true }] };
      return s.inv;
    },
    async invitesState() {
      const l = this._inv().list; save(s);
      return { coins: s.coins, reward: INVITE_REWARD, minDeposit: INVITE_MIN_DEPOSIT, link: 'https://t.me/Play2WinBot?start=inv_123456789',
        pending: l.filter(x => !x.done).map(x => ({ id: x.id, name: x.name, at: x.at, deposited: x.dep || 0 })), completed: l.filter(x => x.done).map(x => ({ id: x.id, name: x.name, claimed: !!x.claimed, at: x.at })) };
    },
    async invitesClaim(id) {
      const f = this._inv().list.find(x => x.id === String(id) && x.done && !x.claimed); if (!f) throw new Error('nothing_to_claim');
      f.claimed = true; s.coins += INVITE_REWARD; save(s); return { amount: INVITE_REWARD, coins: s.coins };
    },
    async ranking() {
      const others = [['Michael Thompson', 48200], ['Ko Ko Aung', 41350], ['Thida', 36900], ['Sophia Martinez', 31200], ['Zaw Min Htet', 27850], ['A', 26000], ['Lin Lin', 21400], ['Nyein Chan', 18900], ['Emma', 15200], ['Htet Aung Lin', 12100], ['Jo', 9800], ['Kyaw Swar', 7600]]
        .map(([n, c]) => ({ name: maskName(n), coins: c })).filter(x => x.name);
      const me = { name: name(), coins: s.coins }, all = others.concat([{ ...me, me: true, name: maskName(me.name) || '*' }]).sort((a, b) => b.coins - a.coins);
      const items = all.map((x, i) => ({ rank: i + 1, name: x.name, coins: x.coins, me: !!x.me }));
      return { items, me: { rank: items.find(x => x.me).rank, coins: s.coins, name: me.name, listed: graphemes(me.name).length > 1 } };
    },
    async withdrawConfig() { return { min: 5000, coins: s.coins, platforms: [{ key: '1', label: 'KPAY', available: true }, { key: '2', label: 'WAVE PAY', available: true }] }; },
    async withdrawMine() { return { items: s.wds || [] }; },
    async withdrawSubmit(b) {
      if (b.coins < 5000) throw new Error('below_minimum'); if (s.coins < b.coins) throw new Error('not_enough_coins');
      s.coins -= b.coins; s.wds = [{ id: String(Date.now()), platform: b.admin === '2' ? 'WAVE PAY' : 'KPAY', coins: b.coins, status: 'pending', at: Date.now() }].concat(s.wds || []).slice(0, 5); save(s); return { ok: true, coins: s.coins };
    },
    async heartsState() { return { coins: s.coins, hearts: s.hearts, packs: HEART_PACKS }; },
    async heartsBuy(n) {
      const p = HEART_PACKS.find(x => x.n === Number(n)); if (!p) throw new Error('bad_pack'); if (s.coins < p.price) throw new Error('not_enough_coins');
      s.coins -= p.price; s.hearts += p.n; save(s); return { bought: p.n, price: p.price, coins: s.coins, hearts: s.hearts };
    },
    async depositConfig() { return { admins: [{ key: '1', name: 'KPAY', username: '', available: true, pay: { label: 'KPAY', number: '09xxxxxxxxx', name: 'xxxxx' } }, { key: '2', name: 'WAVE PAY', username: '', available: true, pay: { label: 'WAVE PAY', number: '09xxxxxxxxx', name: 'xxxxx' } }], min: 100, max: 1000000, shotMinMb: 0.05, shotMaxMb: 5 }; },
    async depositMine() { return { items: s.deps || [] }; },
    async depositSubmit(b) { s.deps = [{ id: String(Date.now()), admin: Number(b.admin), amount: b.amount, status: 'pending', at: Date.now() }].concat(s.deps || []).slice(0, 5); save(s); return { ok: true }; },
    async profile() {
      const l = this._inv().list;
      return { id: 123456789, name: name(), username: '', coins: s.coins, hearts: s.hearts, rank: (await this.ranking()).me.rank, plays: s.matches.length + (s.bomb ? s.bomb.hist.length : 0) + (s.lucky ? s.lucky.hist.length : 0),
        invited: l.length, completed: l.filter(x => x.done).length, since: Date.now() - 86400e3 * 12 };
    },
  };
})();

const api = LIVE ? {
  me: () => call('/api/auth', { initData: tg.initData }),
  start: () => call('/api/duel/start', {}),
  finish: b => call('/api/duel/finish', b),
  revive: id => call('/api/duel/revive', { matchId: id }),
  history: () => call('/api/duel/history'),
  claim: id => call('/api/duel/claim', { matchId: id }),
  bombState: () => call('/api/bomb/state'),
  bombStart: b => call('/api/bomb/start', b),
  bombPick: b => call('/api/bomb/pick', b),
  bombCashout: () => call('/api/bomb/cashout', {}),
  bombHistory: () => call('/api/bomb/history'),
  luckyState: () => call('/api/lucky/state'),
  luckyPlay: b => call('/api/lucky/play', b),
  luckyPick: b => call('/api/lucky/pick', b),
  luckyHistory: () => call('/api/lucky/history'),
  slotState: () => call('/api/slots/state'),
  slotSpin: b => call('/api/slots/spin', b),
  dailyState: () => call('/api/daily/state'),
  dailyClaim: () => call('/api/daily/claim', {}),
  spinState: () => call('/api/spin/state'),
  spinPlay: () => call('/api/spin/play', {}),
  invitesState: () => call('/api/invites/state'),
  invitesClaim: id => call('/api/invites/claim', { id: Number(id) }),
  ranking: () => call('/api/ranking'),
  profile: () => call('/api/profile'),
  withdrawConfig: () => call('/api/withdraw/config'),
  withdrawMine: () => call('/api/withdraw/mine'),
  withdrawSubmit: b => call('/api/withdraw/submit', b),
  heartsState: () => call('/api/hearts/state'),
  heartsBuy: n => call('/api/hearts/buy', { n }),
  depositConfig: () => call('/api/deposit/config'),
  depositMine: () => call('/api/deposit/mine'),
  depositSubmit: b => call('/api/deposit/submit', b, 60000),
} : Mock;

/* Badge: shows WHY the pages are not connected to the server (so it is easy to fix) */
const DEMO_WHY = LIVE ? '' :
  Q.get('demo') ? 'demo=1 in the URL' :
  !API_URL ? 'config.js has no server URL' :
  API_URL.includes('YOUR-SERVER') ? 'config.js still says YOUR-SERVER: put your Render URL in web/config.js' :
  !tg ? 'Telegram script not loaded' :
  !tg.initData ? 'not opened from the bot button (no Telegram login data)' : 'unknown';
if (!LIVE) addEventListener('DOMContentLoaded', () => {
  const d = document.createElement('div');
  d.textContent = 'DEMO MODE: ' + DEMO_WHY;
  d.style.cssText = 'position:fixed;left:6px;right:6px;top:3px;z-index:999;background:rgba(255,70,70,.9);color:#fff;font:700 11px/1.25 sans-serif;padding:3px 8px;border-radius:10px;pointer-events:none;text-align:center';
  document.body.appendChild(d);
});

/* Pictures that fail to load: try ONCE more with a fresh URL (a phone can remember an old 404), then hide them instead of showing the browser's broken-image box.
   Add data-keep to an <img> that has its own fallback. Also covers pictures that failed before this script ran. */
function _fixImg(i) {
  if (i.hasAttribute('data-keep') || !i.getAttribute('src')) return;
  if (!i.dataset.retry) { i.dataset.retry = '1'; i.src = i.src.split('?')[0] + '?r=' + Date.now(); } else i.style.visibility = 'hidden';
}
addEventListener('error', e => { if (e.target && e.target.tagName === 'IMG') _fixImg(e.target); }, true);
addEventListener('load', e => { const t = e.target; if (t && t.tagName === 'IMG' && t.style.visibility === 'hidden') { t.style.visibility = ''; delete t.dataset.retry; } }, true);
function _sweepImgs() { document.querySelectorAll('img').forEach(i => { if (i.complete && i.naturalWidth === 0) _fixImg(i); }); }
document.addEventListener('DOMContentLoaded', _sweepImgs); addEventListener('load', () => { _sweepImgs(); setTimeout(_sweepImgs, 2000); });

/* =====================================================================
   SETTINGS (stored on the phone): sound volume, vibration, language, reduced animations
   ===================================================================== */
const SET = {
  get vol() { const v = Number(localStorage.getItem('p2w_vol')); return Number.isFinite(v) && localStorage.getItem('p2w_vol') !== null ? Math.min(100, Math.max(0, v)) : 60; },
  set vol(v) { localStorage.setItem('p2w_vol', String(v)); },
  get vib() { return localStorage.getItem('p2w_vib') !== '0'; },
  set vib(v) { localStorage.setItem('p2w_vib', v ? '1' : '0'); },
  get lang() {
    const l = localStorage.getItem('p2w_lang');
    if (l === 'my' || l === 'en') return l;
    const tl = tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code;   // first run: follow the phone's Telegram language
    return tl === 'my' ? 'my' : 'en';
  },
  set lang(v) { localStorage.setItem('p2w_lang', v); },
  get calm() { return localStorage.getItem('p2w_calm') === '1'; },
  set calm(v) { localStorage.setItem('p2w_calm', v ? '1' : '0'); },
  reset() { ['p2w_vol', 'p2w_vib', 'p2w_lang', 'p2w_calm'].forEach(k => localStorage.removeItem(k)); },
};
const LANG = SET.lang;
document.documentElement.lang = LANG === 'my' ? 'my' : 'en';
if (SET.calm) { const st = document.createElement('style'); st.textContent = '*,*::before,*::after{animation-duration:.001s!important;animation-iteration-count:1!important;transition-duration:.001s!important}'; document.head.appendChild(st); }

/* =====================================================================
   SOUND: small synthesized effects (no sound files needed). The volume slider in Settings controls all of them.
   ===================================================================== */
const Sfx = (() => {
  let ctx = null;
  const ensure = () => { if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } } if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; };
  const tone = (c, f, t0, d, type, g, f2) => {
    const o = c.createOscillator(), a = c.createGain(), t = c.currentTime + t0;
    o.type = type || 'sine'; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
    a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(g, t + 0.012); a.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(a); a.connect(c.destination); o.start(t); o.stop(t + d + 0.02);
  };
  const BANK = {
    tap:   (c, v) => tone(c, 720, 0, 0.05, 'triangle', 0.10 * v),
    soft:  (c, v) => tone(c, 520, 0, 0.06, 'triangle', 0.08 * v),
    thump: (c, v) => tone(c, 150, 0, 0.16, 'sine', 0.28 * v, 60),
    win:   (c, v) => [523, 659, 784, 1047].forEach((f, i) => tone(c, f, i * 0.085, 0.22, 'triangle', 0.16 * v)),
    lose:  (c, v) => { tone(c, 300, 0, 0.22, 'sawtooth', 0.09 * v, 160); },
    coin:  (c, v) => { tone(c, 1318, 0, 0.07, 'square', 0.06 * v); tone(c, 1760, 0.07, 0.14, 'square', 0.06 * v); },
  };
  return {
    play(name) { const v = SET.vol / 100; if (!v) return; const c = ensure(); if (c && BANK[name]) BANK[name](c, v * v + 0.05 * v); },
    unlock() { ensure(); },
  };
})();
addEventListener('pointerdown', () => Sfx.unlock(), { once: true });

/* =====================================================================
   LANGUAGE (English / Myanmar). The page text is written in English; when Myanmar is chosen every known text is replaced by this dictionary,
   also text that appears later (popups, toasts). Text that is not in the dictionary stays English. Names and numbers are never touched.
   Mark an element with data-notr to keep it untranslated. Text baked into pictures (some banners/buttons) cannot be translated.
   ===================================================================== */
const MY = {
  /* general */
  'OK': 'အိုကေ', 'CANCEL': 'မလုပ်တော့ပါ', 'BUY': 'ဝယ်မည်', 'COPY': 'ကူးယူမည်', 'SUBMIT': 'တင်သွင်းမည်', 'CLOSE': 'ပိတ်မည်', 'YES': 'ဟုတ်ကဲ့', 'NO': 'မဟုတ်ပါ',
  'START': 'စတင်မည်', 'PLAY': 'ကစားမည်', 'PLAY AGAIN': 'ထပ်ကစားမည်', 'PLAY GAME': 'ကစားမည်', 'LOBBY': 'ပင်မခန်း', 'Remove': 'ဖယ်ရှားမည်', 'Loading…': 'ခဏစောင့်ပါ…', 'SENDING…': 'ပို့နေသည်…',
  'Not enough coins': 'coins မလုံလောက်ပါ', 'ADD COINS': 'coins ဖြည့်မည်', 'Add coins': 'coins ဖြည့်ရန်', 'Buy hearts': 'အသဲဝယ်ရန်', 'You': 'သင်', 'Player': 'ကစားသမား', 'ID': 'ID',
  'ID copied': 'ID ကူးယူပြီးပါပြီ', 'Could not copy': 'ကူးယူ၍မရပါ', 'Number copied': 'နံပါတ် ကူးယူပြီးပါပြီ', 'Link copied!': 'လင့်ခ် ကူးယူပြီးပါပြီ!',
  /* home + nav */
  'Ranking': 'အဆင့်', 'History': 'မှတ်တမ်း', 'Spin': 'ဘီးလှည့်', 'Tutorials': 'လမ်းညွှန်', 'Daily': 'နေ့စဉ်', 'Bonus': 'ဆုလာဒ်', 'First Pay': 'ပထမဆုံး', 'pack': 'ပက်ကေ့ဂျ်',
  'Bomb Points': 'ဗုံးပွိုင့်', 'Lucky Cards': 'ကံကောင်းကတ်', 'Slot Machine': 'စလော့မရှင်း', 'Games': 'ဂိမ်းများ', 'Withdraw': 'ငွေထုတ်', 'Home': 'ပင်မ', 'Invites': 'ဖိတ်ခေါ်', 'Profile': 'ပရိုဖိုင်',
  'DAILY BONUS': 'နေ့စဉ်ဆုလာဒ်', 'COLLECTED': 'ရယူပြီးပါပြီ', 'Next bonus in': 'နောက်ဆုလာဒ်ကို', 'Could not collect, try again': 'ရယူ၍မရပါ၊ ပြန်ကြိုးစားပါ',
  /* settings */
  'SETTINGS': 'ဆက်တင်များ', 'Sound': 'အသံ', 'Sound volume': 'အသံအတိုးအလျော့', 'Vibration': 'တုန်ခါမှု', 'Language': 'ဘာသာစကား', 'Reduce animations': 'လှုပ်ရှားမှု လျှော့ရန်',
  'Slower phones run smoother': 'ဖုန်းနှေးရင် ပိုချောမောပါမယ်', 'Reset settings': 'ဆက်တင် ပြန်ညှိမည်', 'About': 'အကြောင်း', 'Version': 'ဗားရှင်း', 'Off': 'ပိတ်', 'On': 'ဖွင့်',
  'Confirm withdrawal': 'ငွေထုတ်ခြင်း အတည်ပြုပါ', 'CONFIRM': 'အတည်ပြုမည်', 'The coins are taken from your balance now. If the admin rejects the request they are returned.': 'coins ကို သင့်လက်ကျန်ထဲကနေ ယခုနှုတ်ယူပါမယ်။ Admin က ပယ်ချရင် ပြန်ထည့်ပေးပါမယ်။',
  'Your withdrawal request was sent to the admin. You will get a message in Telegram when it is paid.': 'ငွေထုတ်တောင်းဆိုမှုကို Admin ဆီ ပို့ပြီးပါပြီ။ ငွေပေးချေပြီးရင် Telegram မှာ စာပို့ပေးပါမယ်။',
  'Settings reset': 'ဆက်တင်များ မူလအတိုင်း ပြန်ထားပြီးပါပြီ', 'Language changed': 'ဘာသာစကား ပြောင်းပြီးပါပြီ', 'Myanmar': 'မြန်မာ', 'English': 'English',
  'Help & support': 'အကူအညီ', 'Terms of use': 'အသုံးပြုမှု စည်းမျဉ်း',
  /* profile */
  'PROFILE': 'ပရိုဖိုင်', 'Games played': 'ကစားခဲ့သော ဂိမ်း', 'Friends invited': 'ဖိတ်ထားသော သူငယ်ချင်း', 'Invites completed': 'ပြီးစီးသော ဖိတ်ခေါ်မှု', 'Invite friends': 'သူငယ်ချင်းများကို ဖိတ်ရန်',
  'Could not load the profile': 'ပရိုဖိုင် မရယူနိုင်ပါ',
  /* invites */
  'INVITES': 'ဖိတ်ခေါ်ရန်', 'Invite a friend and get': 'သူငယ်ချင်း ဖိတ်ပြီး ရယူပါ', 'Share your link': 'လင့်ခ် မျှဝေပါ', 'More games coming soon': 'ဂိမ်းအသစ်များ မကြာမီ လာမည်', 'Claim': 'ရယူပါ',
  'PENDING': 'စောင့်ဆိုင်းဆဲ', 'COMPLETED': 'ပြီးစီး', 'REWARD!': 'ဆုလာဒ်!', 'CLAIMED': 'ရယူပြီး', 'Already claimed': 'ရယူပြီးသားပါ', 'Link is not ready yet': 'လင့်ခ် မပြင်ဆင်ရသေးပါ',
  'Friends move to Completed after their first game': 'သူငယ်ချင်းက ပထမဆုံးဂိမ်း ကစားပြီးရင် ပြီးစီးထဲ ရောက်ပါမယ်', 'No friends waiting': 'စောင့်ဆိုင်းနေသူ မရှိသေးပါ',
  'Share your link to invite a friend': 'သူငယ်ချင်းကို ဖိတ်ရန် သင့်လင့်ခ်ကို မျှဝေပါ', 'No completed invites yet': 'ပြီးစီးသော ဖိတ်ခေါ်မှု မရှိသေးပါ',
  'When a friend plays their first game it shows up here': 'သူငယ်ချင်း ပထမဆုံးဂိမ်း ကစားပြီးရင် ဒီမှာ ပေါ်လာပါမယ်', 'Thanks for inviting a friend!': 'သူငယ်ချင်းကို ဖိတ်ပေးလို့ ကျေးဇူးတင်ပါတယ်!',
  'Could not claim, try again': 'ရယူ၍မရပါ၊ ပြန်ကြိုးစားပါ', 'Could not load invites': 'ဖိတ်ခေါ်မှု မရယူနိုင်ပါ', 'Loading…': 'ခဏစောင့်ပါ…',
  /* ranking */
  'RANKING': 'အဆင့်', 'Top players by coins': 'coins အများဆုံး ကစားသမားများ', 'No players yet': 'ကစားသမား မရှိသေးပါ', 'Could not load the ranking': 'အဆင့်စာရင်း မရယူနိုင်ပါ',
  'Keep playing to climb': 'ဆက်ကစားပြီး အဆင့်တင်ပါ', 'One-letter names are not shown in the list': 'အက္ခရာတစ်လုံးတည်းနာမည်ကို စာရင်းထဲ မပြပါ',
  /* spin */
  'LUCKY SPIN': 'ကံစမ်းဘီး', 'FREE SPIN': 'အခမဲ့ လှည့်မည်', 'SPIN': 'လှည့်မည်', 'SPINNING…': 'လှည့်နေသည်…', 'Daily free spin': 'နေ့စဉ် အခမဲ့လှည့်ခွင့်', 'Bonus spin': 'ဘောနပ်စ်လှည့်ခွင့်',
  'Your free spin of the day is ready!': 'ဒီနေ့အတွက် အခမဲ့လှည့်ခွင့် ရပါပြီ!', 'Next free spin in': 'နောက်အခမဲ့လှည့်ခွင့်ကို', 'YOU WON!': 'နိုင်ပါပြီ!', 'BIG WIN!': 'အကြီးအကျယ် နိုင်ပါပြီ!',
  'FREE SPIN!': 'အခမဲ့လှည့်ခွင့်!', 'TRY AGAIN': 'ထပ်ကြိုးစားပါ', 'COLLECT': 'ရယူမည်', 'Added to your balance': 'သင့်လက်ကျန်ထဲ ထည့်ပေးပြီးပါပြီ', 'SPIN AGAIN': 'ထပ်လှည့်မည်',
  'You won a free spin.': 'အခမဲ့လှည့်ခွင့် တစ်ကြိမ် ရပါပြီ။', 'It costs nothing!': 'ဘာမှ မကုန်ကျပါ!', 'No prize this time.': 'ဒီတစ်ခါ ဆုမရပါ။', 'Good luck on the next one!': 'နောက်တစ်ခါ ကံကောင်းပါစေ!',
  'Could not load the wheel': 'ဘီးကို မရယူနိုင်ပါ', 'Could not spin, try again': 'မလှည့်နိုင်ပါ၊ ပြန်ကြိုးစားပါ', '1 free spin every day · extra spins': 'တစ်နေ့ ၁ ကြိမ် အခမဲ့ · ထပ်လှည့်ရင်',
  /* hearts */
  'HEARTS': 'အသဲများ', 'You have': 'သင့်မှာ', 'hearts': 'အသဲ ရှိပါတယ်', 'HEART': 'အသဲ', 'BEST VALUE': 'တန်ဖိုးအရှိဆုံး', 'hearts added!': 'အသဲ ထည့်ပေးပြီးပါပြီ!', 'heart added!': 'အသဲ ထည့်ပေးပြီးပါပြီ!',
  'Could not buy, try again': 'မဝယ်နိုင်ပါ၊ ပြန်ကြိုးစားပါ', 'Could not load the shop': 'ဆိုင်ကို မရယူနိုင်ပါ',
  /* add coins / withdraw */
  'Select a platform to add coins': 'coins ဖြည့်ရန် platform ရွေးချယ်ပါ', 'Select a platform to withdraw': 'ငွေထုတ်ရန် platform ရွေးချယ်ပါ', 'Tap to choose': 'နှိပ်၍ ရွေးပါ', 'Not available': 'မရနိုင်ပါ',
  'COPY NUMBER': 'နံပါတ် ကူးယူမည်', 'Coins to add': 'ဖြည့်မည့် coins', 'Coins to withdraw': 'ထုတ်မည့် coins', 'Screenshot': 'Screenshot', 'Attach screenshot': 'Screenshot ထည့်ရန်', 'Your requests': 'သင့်တောင်းဆိုမှုများ',
  'Attach the payment screenshot here.': 'ငွေပေးချေထားသော screenshot ကို ဒီမှာ ထည့်ပါ။', 'Pay to this account, then attach the screenshot, fill in the details and press Submit.': 'ဒီအကောင့်သို့ ငွေပေးချေပြီး screenshot ထည့်ကာ အချက်အလက်များဖြည့်ပြီး Submit ကို နှိပ်ပါ။',
  'REQUEST SENT': 'တောင်းဆိုမှု ပို့ပြီးပါပြီ', 'The admin will check your screenshot. You will get a message in Telegram when your coins are added.': 'Admin က screenshot ကို စစ်ပါလိမ့်မယ်။ coins ထည့်ပြီးရင် Telegram မှာ စာပို့ပေးပါမယ်။',
  'WAITING': 'စောင့်ဆိုင်းဆဲ', 'ADDED': 'ထည့်ပြီး', 'REJECTED': 'ပယ်ချခံရ', 'PAID': 'ပေးချေပြီး', 'WITHDRAW': 'ငွေထုတ်ရန်', 'Your balance': 'သင့်လက်ကျန်', 'Your withdrawals': 'သင့်ငွေထုတ်မှုများ',
  'Please choose a JPG, PNG or WebP picture': 'JPG၊ PNG သို့မဟုတ် WebP ပုံကို ရွေးပါ', 'Could not read this picture': 'ဒီပုံကို မဖတ်နိုင်ပါ', 'Could not load, please try again': 'မရယူနိုင်ပါ၊ ပြန်ကြိုးစားပါ',
  'Could not send, please try again': 'မပို့နိုင်ပါ၊ ပြန်ကြိုးစားပါ', 'Withdrawal request sent': 'ငွေထုတ်တောင်းဆိုမှု ပို့ပြီးပါပြီ', 'You need at least 5,000 coins to withdraw': 'ငွေထုတ်ရန် coins အနည်းဆုံး 5,000 လိုပါတယ်',
  /* history + Fly & Dodge */
  'Tournament History': 'ပြိုင်ပွဲမှတ်တမ်း', 'ALL': 'အားလုံး', 'WINS': 'အနိုင်', 'LOSSES': 'အရှုံး', 'No matches yet': 'ပွဲ မရှိသေးပါ', 'Play Fly & Dodge to see your history': 'Fly & Dodge ကစားပြီး မှတ်တမ်းကြည့်ပါ',
  'Could not load history': 'မှတ်တမ်း မရယူနိုင်ပါ', 'YOU': 'သင်', 'OPPONENT': 'ပြိုင်ဘက်', 'From a previous run': 'ယခင်ပွဲမှ', 'ENTRY FEE:': 'ဝင်ကြေး:', 'Play your run first.': 'အရင် ကိုယ့်ပွဲကို ကစားပါ။',
  'Compare scores after.': 'ပြီးမှ ရမှတ်နှိုင်းယှဉ်မယ်။', 'SCORE TO BEAT': 'ကျော်ရမည့် ရမှတ်', 'WIN': 'အနိုင်', 'GET READY!': 'အဆင်သင့်ပြင်ပါ!', 'OPPONENT BEATEN!': 'ပြိုင်ဘက်ကို အနိုင်ယူပြီး!',
  'USE A HEART?': 'အသဲတစ်ခု သုံးမလား?', 'GIVE UP': 'လက်လျှော့မည်', 'EXIT?': 'ထွက်မလား?', 'Leave this match?': 'ဒီပွဲကနေ ထွက်မလား?', 'Searching opponent…': 'ပြိုင်ဘက်ရှာနေသည်…', 'WAITING…': 'စောင့်နေသည်…',
  'Waiting for other players': 'အခြားကစားသမားကို စောင့်နေသည်', 'No opponent yet — set your best score!': 'ပြိုင်ဘက် မရှိသေးပါ - သင့်အကောင်းဆုံးရမှတ်ကို ရယူပါ!', 'Your score becomes the target': 'သင့်ရမှတ်က ပစ်မှတ် ဖြစ်လာမယ်',
  'Connection problem — retrying…': 'ချိတ်ဆက်မှု ပြဿနာ - ပြန်ကြိုးစားနေသည်…', 'Could not save the result': 'ရလဒ်ကို မသိမ်းနိုင်ပါ', 'Score': 'ရမှတ်', 'Waiting…': 'စောင့်နေသည်…',
  /* bomb points */
  'CHOOSE YOUR ENTRY': 'ဝင်ကြေး ရွေးပါ', 'BALANCE:': 'လက်ကျန်:', 'BALANCE': 'လက်ကျန်', 'CHOOSE BOMB COUNT': 'ဗုံးအရေအတွက် ရွေးပါ', 'BOMBS': 'ဗုံး', 'COIN MULTIPLIERS': 'coin အဆများ',
  'SOLO ROUND': 'တစ်ဦးချင်း ပွဲ', 'AVOID BOMBS • COLLECT COINS': 'ဗုံးကိုရှောင် • coins စုပါ', 'BOMB HISTORY': 'ဗုံးဂိမ်း မှတ်တမ်း', 'Latest 10 rounds': 'နောက်ဆုံး ၁၀ ပွဲ',
  'Hit a bomb and the entry fee is lost.': 'ဗုံးနင်းမိရင် ဝင်ကြေး ဆုံးပါမယ်။', 'Choose from 3 to 15 bombs before you start the round.': 'ပွဲမစခင် ဗုံး ၃ ခုကနေ ၁၅ ခုအထိ ရွေးပါ။',
  'Multiplier increases after each safe coin pick.': 'လုံခြုံသော coin တစ်ခုရွေးတိုင်း အဆတိုးလာပါမယ်။', 'Reveal a coin, then cash out whenever you want to keep your prize.': 'coin ဖွင့်ပြီး လိုချင်တဲ့အချိန် ငွေထုတ်ယူလို့ရပါတယ်။',
  /* lucky cards */
  'CHOOSE YOUR BET': 'လောင်းကြေး ရွေးပါ', 'Card returns (coins)': 'ကတ်ပြန်ပေးမှု (coins)', 'PICK ONE CARD': 'ကတ်တစ်ကတ် ရွေးပါ', 'CARD RETURNS': 'ကတ်ပြန်ပေးမှု', 'LUCKY HISTORY': 'ကံကောင်းကတ် မှတ်တမ်း', 'BET': 'လောင်းကြေး',
  'Expected return is 90% of the bet.': 'ပျမ်းမျှ ပြန်ရမှု လောင်းကြေးရဲ့ ၉၀% ဖြစ်ပါတယ်။', 'The cards are already set. Your choice only decides which one you see.': 'ကတ်တွေ ကြိုသတ်မှတ်ပြီးသားပါ။ သင့်ရွေးချယ်မှုက ဘယ်ကတ်ကို မြင်ရမလဲဆိုတာပဲ ဆုံးဖြတ်ပါတယ်။',
  'Skull = bet lost · Bronze = half back': 'ဦးခေါင်းခွံ = လောင်းကြေးဆုံး · ကြေးဝါ = တစ်ဝက်ပြန်ရ', 'You have an open round. Pick a card to finish it.': 'မပြီးသေးသော ပွဲရှိနေပါတယ်။ ကတ်တစ်ကတ်ရွေးပြီး အဆုံးသတ်ပါ။',
  /* slots */
  'Lucky Slots': 'ကံကောင်းစလော့', 'AUTO': 'အလိုအလျောက်', 'PAYTABLE': 'ဆုဇယား', 'AUTO SPIN': 'အလိုအလျောက်လှည့်', 'Number of spins': 'လှည့်မည့် အကြိမ်ရေ', 'How it works:': 'ကစားနည်း:',
  'No win this time. Try again!': 'ဒီတစ်ခါ မနိုင်ပါ။ ထပ်ကြိုးစားပါ!', 'Auto spin will stop after this spin.': 'ဒီလှည့်ပြီးရင် အလိုအလျောက်လှည့်ခြင်း ရပ်ပါမယ်။', 'Bet must be a whole number': 'လောင်းကြေးက ကိန်းပြည့် ဖြစ်ရပါမယ်',
  'Auto spin also stops when you do not have enough coins for the bet.': 'လောင်းကြေးအတွက် coins မလုံလောက်ရင်လည်း အလိုအလျောက်လှည့်ခြင်း ရပ်ပါမယ်။',
};
/* texts that contain numbers: [pattern, replacement]. $1.. = the numbers found; a function gets the match and may call tr() */
const tr = (s) => { const k = String(s); return LANG === 'my' ? (MY[k] || trx(k)) : k; };
const MYX = [
  [/^You got (\d[\d,]*) coins!$/, m => 'coins ' + m[1] + ' ရရှိပါပြီ!'],
  [/^(.+) - coming soon$/, m => tr(m[1]) + ' - မကြာမီ လာမည်'],
  [/^CLAIM (\d[\d,]*)$/, m => 'ရယူမည် ' + m[1]],
  [/^PENDING \((\d+)\)$/, m => 'စောင့်ဆိုင်းဆဲ (' + m[1] + ')'], [/^COMPLETED \((\d+)\)$/, m => 'ပြီးစီး (' + m[1] + ')'],
  [/^(Joined|Played|Completed) (\d+) (min|h|d) ago$/, m => ({ Joined: 'ဝင်ရောက်ခဲ့သည်', Played: 'ကစားခဲ့သည်', Completed: 'ပြီးစီးခဲ့သည်' })[m[1]] + ' ' + m[2] + ' ' + ({ min: 'မိနစ်', h: 'နာရီ', d: 'ရက်' })[m[3]] + ' အကြာ'],
  [/^Friend adds (\d[\d,]*) coins$/, m => 'သူငယ်ချင်း coins ' + m[1] + ' ဖြည့်ပါ'],
  [/^Friends move to Completed after they add (\d[\d,]*) coins$/, m => 'သူငယ်ချင်းက coins ' + m[1] + ' ဖြည့်ပြီးရင် ပြီးစီးထဲ ရောက်ပါမယ်'],
  [/^When a friend adds (\d[\d,]*) coins it shows up here$/, m => 'သူငယ်ချင်းက coins ' + m[1] + ' ဖြည့်ပြီးရင် ဒီမှာ ပေါ်လာပါမယ်'],
  [/^(\d+) rewards? ready to claim!$/, m => 'ရယူရန် ဆုလာဒ် ' + m[1] + ' ခု ရှိပါတယ်!'], [/^Claim (\d[\d,]*) coins for every friend who played\.$/, m => 'ကစားခဲ့သော သူငယ်ချင်းတိုင်းအတွက် coins ' + m[1] + ' ရယူပါ။'],
  [/^Cost (\d[\d,]*)$/, m => 'ကုန်ကျ ' + m[1]], [/^Bonus spins: (\d+)$/, m => 'ဘောနပ်စ်လှည့်ခွင့်: ' + m[1]],
  [/^Buy (\d+) hearts?\?$/, m => 'အသဲ ' + m[1] + ' ခု ဝယ်မလား?'], [/^(\d[\d,]*) coins each$/, m => 'တစ်ခုကို coins ' + m[1]], [/^SAVE (\d+)%$/, m => m[1] + '% သက်သာ'],
  [/^Not enough coins - you need (\d[\d,]*) more$/, m => 'coins မလုံလောက်ပါ - ' + m[1] + ' ထပ်လိုပါတယ်'],
  [/^Playing for (\d+) days?$/, m => 'ကစားနေသည်မှာ ' + m[1] + ' ရက်'], [/^Your (KPay|Wave) account name$/, m => 'သင့် ' + m[1] + ' အကောင့်နာမည်'], [/^Your (KPay|Wave) phone number$/, m => 'သင့် ' + m[1] + ' ဖုန်းနံပါတ်'],
  [/^Enter your (KPay|Wave) account name$/, m => 'သင့် ' + m[1] + ' အကောင့်နာမည် ရိုက်ထည့်ပါ'], [/^Enter your (KPay|Wave) phone number$/, m => 'သင့် ' + m[1] + ' ဖုန်းနံပါတ် ရိုက်ထည့်ပါ'],
  [/^Min (\d[\d,]*) · Max (\d[\d,]*) coins$/, m => 'အနည်းဆုံး ' + m[1] + ' · အများဆုံး ' + m[2] + ' coins'], [/^Minimum (\d[\d,]*) coins$/, m => 'အနည်းဆုံး coins ' + m[1]],
  [/^Amount must be between (\d[\d,]*) and (\d[\d,]*)$/, m => 'ပမာဏက ' + m[1] + ' နဲ့ ' + m[2] + ' ကြား ဖြစ်ရပါမယ်'],
  [/^Next bonus in (\d\d:\d\d:\d\d)$/, m => 'နောက်ဆုလာဒ်ကို ' + m[1] + ' အကြာတွင် ရယူနိုင်ပါမယ်'], [/^Next free spin in (\d\d:\d\d:\d\d)$/, m => 'နောက်အခမဲ့လှည့်ခွင့်ကို ' + m[1] + ' အကြာတွင် ရပါမယ်'],
  [/^(\d[\d,]*) of your (\d[\d,]*) bet came back\.$/, m => 'လောင်းကြေး ' + m[2] + ' ထဲက ' + m[1] + ' ပြန်ရပါတယ်။'],
  [/^COMPLETED \((\d+)\) •$/, m => 'ပြီးစီး (' + m[1] + ') •'], [/^You are in the top (\d+)$/, m => 'ထိပ်ဆုံး ' + m[1] + ' ထဲမှာ ရှိပါတယ်'], [/^(\d[\d,]*) coins$/, m => 'coins ' + m[1]],
  [/^Withdraw (\d[\d,]*) coins to (.+)\?$/, m => m[2] + ' သို့ coins ' + m[1] + ' ထုတ်မလား?'], [/^Minimum is (\d[\d,]*) coins$/, m => 'အနည်းဆုံး coins ' + m[1] + ' ဖြစ်ပါတယ်'],
  [/^Bronze star$/, () => 'ကြေးဝါကြယ်'], [/^Silver star$/, () => 'ငွေကြယ်'], [/^Gold star$/, () => 'ရွှေကြယ်'],
  [/^(\d+) – (\d+) BOMBS$/, m => 'ဗုံး ' + m[1] + ' – ' + m[2]], [/^(\d+) BOMBS$/, m => 'ဗုံး ' + m[1] + ' ခု'], [/^PLAY · (\d[\d,]*) COINS$/, m => 'ကစားမည် · ' + m[1] + ' COINS'],
  [/^Waiting matches: (\d+)\/(\d+)$/, m => 'စောင့်နေသောပွဲ: ' + m[1] + '/' + m[2]], [/^START IN (\d+)s?$/, m => m[1] + ' စက္ကန့်နေမှ စမည်'], [/^Your Score: (\d+)$/, m => 'သင့်ရမှတ်: ' + m[1]],
];
function trx(k) { for (const [re, f] of MYX) { const m = re.exec(k); if (m) return f(m); } return k; }
function _trNode(n) {
  const v = n.nodeValue; if (!v) return; const k = v.trim(); if (!k) return;
  const p = n.parentElement; if (!p || /^(SCRIPT|STYLE|TEXTAREA|OPTION)$/.test(p.tagName) || p.closest('[data-notr]')) return;
  const t = MY[k] || trx(k); if (t !== k) n.nodeValue = v.replace(k, t);
}
function _trTree(root) {
  if (!root) return;
  if (root.nodeType === 3) return _trNode(root);
  if (root.nodeType !== 1) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) _trNode(n);
  if (root.matches && root.matches('[placeholder]')) _trAttr(root); root.querySelectorAll && root.querySelectorAll('[placeholder]').forEach(_trAttr);
}
function _trAttr(el) { const v = el.getAttribute('placeholder'); if (v) { const t = MY[v] || trx(v); if (t !== v) el.setAttribute('placeholder', t); } }
if (LANG === 'my') {
  const hs = document.createElement('style'); hs.textContent = '.mm,.mmx,#dMm{display:none!important}'; document.head.appendChild(hs);
  const run = () => { _trTree(document.body); new MutationObserver(ms => ms.forEach(m => {
    if (m.type === 'characterData') _trNode(m.target); else if (m.type === 'attributes') _trAttr(m.target); else m.addedNodes.forEach(_trTree);
  })).observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['placeholder'] }); };
  if (document.body) run(); else addEventListener('DOMContentLoaded', run);
}
