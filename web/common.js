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
function haptic(kind) { try { if (localStorage.getItem('p2w_vib') === '0') return; tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred(kind || 'light'); } catch (e) {} }

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

async function call(path, body) {
  const r = await fetch(API_URL + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-init-data': tg.initData },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(j.error || 'network_error'); err.data = j; throw err; }
  return j;
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
const DAILY_BONUS = 100, SPIN_COST = 100, INVITE_REWARD = 2000, DAY_OFFSET_MIN = 390;   // a "day" ends at Myanmar midnight (UTC+6:30)
const dayKey = (t = Date.now()) => new Date(t + DAY_OFFSET_MIN * 60000).toISOString().slice(0, 10);
const nextDayAt = () => { const d = new Date(Date.now() + DAY_OFFSET_MIN * 60000); d.setUTCHours(24, 0, 0, 0); return d.getTime() - DAY_OFFSET_MIN * 60000; };
/* wheel order = clockwise from the top; chances are per mille */
const SPIN_WEDGES = [{ k: 'coins', v: 100 }, { k: 'try' }, { k: 'coins', v: 200 }, { k: 'free' }, { k: 'coins', v: 300 }, { k: 'try' }, { k: 'coins', v: 250 }, { k: 'coins', v: 500 }];
const SPIN_ODDS = [{ k: 'try', w: 500 }, { k: 'free', w: 100 }, { k: 'coins', v: 100, w: 180 }, { k: 'coins', v: 200, w: 100 }, { k: 'coins', v: 250, w: 50 }, { k: 'coins', v: 300, w: 45 }, { k: 'coins', v: 500, w: 25 }];
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
    _inv() {   // demo friends: two waiting, two completed (one already claimed)
      if (!s.inv) s.inv = { list: [
        { id: '1', name: 'Aung Kyaw', at: Date.now() - 3600e3 * 5, done: false },
        { id: '2', name: 'Su Su Hlaing', at: Date.now() - 3600e3 * 26, done: false },
        { id: '3', name: 'Min Thant', at: Date.now() - 3600e3 * 50, done: true, claimed: false },
        { id: '4', name: 'မောင်မောင်', at: Date.now() - 3600e3 * 90, done: true, claimed: true }] };
      return s.inv;
    },
    async invitesState() {
      const l = this._inv().list; save(s);
      return { coins: s.coins, reward: INVITE_REWARD, link: 'https://t.me/Play2WinBot?start=inv_123456789',
        pending: l.filter(x => !x.done).map(x => ({ id: x.id, name: x.name, at: x.at })), completed: l.filter(x => x.done).map(x => ({ id: x.id, name: x.name, claimed: !!x.claimed, at: x.at })) };
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
