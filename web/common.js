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
function haptic(kind) { try { tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred(kind || 'light'); } catch (e) {} }

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
  if (!r.ok) throw new Error(j.error || 'network_error');
  return j;
}

/* Demo mode: everything runs in this browser (localStorage). Used before the server is connected. */
const Mock = (() => {
  const K = 'p2w_demo_v1';
  const load = () => { try { return JSON.parse(localStorage.getItem(K)) || null; } catch (e) { return null; } };
  const save = s => { try { localStorage.setItem(K, JSON.stringify(s)); } catch (e) {} };
  let s = load() || { coins: 2500, hearts: 10, matches: [], active: null };
  const name = () => (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.first_name) || 'Player';
  const rid = () => Math.random().toString(36).slice(2, 10);
  const oppName = () => 'Player ' + (1000 + Math.floor(Math.random() * 9000));
  function settle() { // pending matches get an opponent after 20s (demo only)
    const now = Date.now();
    s.matches.forEach(m => {
      if (m.result === 'pending' && now - m.at > 20000) {
        m.oppScore = Math.max(0, m.myScore + Math.floor(Math.random() * 20) - 10);
        m.opponent = oppName(); m.result = m.myScore > m.oppScore ? 'win' : m.myScore < m.oppScore ? 'loss' : 'draw';
        m.prize = m.result === 'win' ? PRIZE : m.result === 'draw' ? FEE : 0; m.claimAt = now + CLAIM_MS;
      }
    });
    save(s);
  }
  return {
    async me() { return { name: name(), coins: s.coins, hearts: s.hearts }; },
    async start() {
      if (s.coins < FEE) throw new Error('not_enough_coins');
      s.coins -= FEE;
      const has = Math.random() < 0.6;
      const opp = has ? { name: oppName(), score: 6 + Math.floor(Math.random() * 30) } : null;
      s.active = { id: rid(), opp, at: Date.now() }; save(s);
      return { matchId: s.active.id, seed: s.active.id, role: has ? 'b' : 'a', opponent: opp, coins: s.coins };
    },
    async finish({ matchId, score, forfeit }) {
      const a = s.active; if (!a || a.id !== matchId) throw new Error('not_active');
      s.active = null;
      if (forfeit) { save(s); return { result: 'forfeit', coins: s.coins }; }
      if (!a.opp) {
        s.matches.unshift({ id: a.id, opponent: null, myScore: score, oppScore: null, result: 'pending', prize: 0, claimAt: 0, claimed: false, at: Date.now() });
        save(s); return { result: 'waiting', myScore: score, coins: s.coins };
      }
      const r = score > a.opp.score ? 'win' : score < a.opp.score ? 'loss' : 'draw';
      const prize = r === 'win' ? PRIZE : r === 'draw' ? FEE : 0, claimAt = Date.now() + CLAIM_MS;
      s.matches.unshift({ id: a.id, opponent: a.opp.name, myScore: score, oppScore: a.opp.score, result: r, prize, claimAt, claimed: false, at: Date.now() });
      save(s);
      return { result: r, myScore: score, oppScore: a.opp.score, prize, claimAt, coins: s.coins };
    },
    async history() { settle(); return { items: s.matches.slice(0, 50), coins: s.coins }; },
    async claim(id) {
      const m = s.matches.find(x => x.id === id);
      if (!m || m.claimed || !m.prize) throw new Error('nothing');
      if (Date.now() < m.claimAt) throw new Error('too_early');
      m.claimed = true; s.coins += m.prize; save(s); return { coins: s.coins };
    },
  };
})();

const api = LIVE ? {
  me: () => call('/api/auth', { initData: tg.initData }),
  start: () => call('/api/duel/start', {}),
  finish: b => call('/api/duel/finish', b),
  history: () => call('/api/duel/history'),
  claim: id => call('/api/duel/claim', { matchId: id }),
} : Mock;
