/* Shared helpers: Telegram, stage scaling, API (live server or in-browser demo) */
const tg = window.Telegram && Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); try { tg.setHeaderColor('#4a46b8'); tg.setBackgroundColor('#4a46b8'); } catch (e) {} }
const $ = id => document.getElementById(id);
const Q = new URLSearchParams(location.search);

/* TELEGRAM ONLY: outside Telegram (plain browser, no login data) the game shows an error and nothing else loads. The server refuses such requests too. */
if (!(tg && tg.initData && tg.platform !== 'unknown')) {
  document.documentElement.style.background = '#2b2780';
  document.body.innerHTML = '<div style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:28px;text-align:center;font:600 20px/1.45 sans-serif;color:#fff;background:#2b2780"><div style="font-size:54px">⛔</div><div>Error: this game only works inside Telegram.</div><div style="opacity:.85;font-size:17px">Please open it from the bot.<br>ဤဂိမ်းကို Telegram ထဲမှ bot ကနေသာ ဖွင့်ပြီး ကစားနိုင်ပါသည်။</div></div>';
  throw new Error('telegram_only');
}

let FEE = 500, PRIZE = 900;   // the real numbers come from the server (admin settings) with the first api.me() call
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
const LIVE = !!(API_URL && !API_URL.includes('YOUR-SERVER'));

function blockScreen(msg) {
  let d = $('p2wBlock');
  if (!d) { d = document.createElement('div'); d.id = 'p2wBlock'; d.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:28px;text-align:center;white-space:pre-line;font:600 20px/1.5 sans-serif;color:#fff;background:#2b2780'; document.body.appendChild(d); }
  d.textContent = msg;
}
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
    if (!r.ok) {
      if (j.error === 'maintenance') blockScreen(j.msg || 'Maintenance - please come back soon.');
      else if (j.error === 'banned') blockScreen('Your account is blocked. Please contact the admin.\nသင့်အကောင့်ကို ပိတ်ထားပါသည်။ Admin ကို ဆက်သွယ်ပါ။');
      else if (j.error === 'game_off') toast('This game is paused right now');
      const err = new Error(j.error || 'network_error'); err.data = j; throw err;
    }
    return j;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('timeout');
    throw e;
  } finally { clearTimeout(timer); }
}

/* Bomb Points rules (the server is the source of truth; these are only used until the server answers).
   multiplier = (1 - edge) / P(surviving k safe picks), rounded down to 2 decimals, same formula as server/settings.js */
const BOMB_ENTRIES = [1000, 2000, 5000, 15000];
let BOMB_MIN = 3, BOMB_MAX = 15, BOMB_TABLE = null;
function bombRow(b) {
  if (BOMB_TABLE && BOMB_TABLE[b]) return BOMB_TABLE[b];
  const row = []; let p = 1;
  for (let s = 1; s <= 16 - b; s++) { p *= (16 - b - (s - 1)) / (16 - (s - 1)); row.push(Math.min(100, Math.max(1.01, Math.floor(0.9 / p * 100) / 100))); }
  return row;
}
const bombPrize = (entry, mult) => Math.floor(entry * Math.round(mult * 100) / 100);   // total returned (entry included); exact, no float error

/* Lucky Cards rules (filled from the server) */
const LUCKY_TIERS = [200, 500, 1000, 3000, 5000];
const LUCKY_CARDS = { skull: 0, bronze: 50, silver: 100, gold: 300 };   // percent of the bet that comes back
const luckyPrize = (bet, kind) => Math.floor(bet * LUCKY_CARDS[kind] / 100);

/* Slot Machine limits (same as server/index.js; the math itself is in slots_math.js) */
const SLOT_BET_PRESETS = [50, 100, 200, 500, 600];
let SLOT_BET_MIN = 10, SLOT_BET_MAX = 5000;

/* Daily bonus, spin wheel, invites (same numbers as server/index.js; the server decides, these are for display + demo mode) */
const DAILY_BONUS = 100, SPIN_COST = 100, INVITE_REWARD = 200, INVITE_MIN_DEPOSIT = 1000, DAY_OFFSET_MIN = 390;   // a "day" ends at Myanmar midnight (UTC+6:30)
const dayKey = (t = Date.now()) => new Date(t + DAY_OFFSET_MIN * 60000).toISOString().slice(0, 10);
const nextDayAt = () => { const d = new Date(Date.now() + DAY_OFFSET_MIN * 60000); d.setUTCHours(24, 0, 0, 0); return d.getTime() - DAY_OFFSET_MIN * 60000; };
/* wheel order = clockwise from the top; chances are per mille */
const SPIN_WEDGES = [{ k: 'coins', v: 100 }, { k: 'try' }, { k: 'coins', v: 200 }, { k: 'free' }, { k: 'coins', v: 300 }, { k: 'try' }, { k: 'coins', v: 250 }, { k: 'coins', v: 500 }];
const SPIN_ODDS = [{ k: 'try', w: 500 }, { k: 'free', w: 100 }, { k: 'coins', v: 100, w: 180 }, { k: 'coins', v: 200, w: 100 }, { k: 'coins', v: 250, w: 50 }, { k: 'coins', v: 300, w: 45 }, { k: 'coins', v: 500, w: 25 }];
const HEART_PACKS = [{ n: 1, price: 700 }, { n: 2, price: 1400 }, { n: 3, price: 2000 }, { n: 5, price: 3400 }, { n: 10, price: 6000 }];   // replaced by the server's prices
const mmss2 = ms => { const t = Math.max(0, Math.ceil(ms / 1000)); return String(Math.floor(t / 3600)).padStart(2, '0') + ':' + String(Math.floor(t / 60) % 60).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
/* name masking for the ranking: last 3 characters -> ***, 3 or fewer -> all stars, 1 character -> hidden (null). Burmese/emoji safe. */
const _seg = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = str => _seg ? Array.from(_seg.segment(String(str || '')), x => x.segment) : Array.from(String(str || ''));
function maskName(name) { const g = graphemes(name); if (g.length <= 1) return null; if (g.length <= 3) return '*'.repeat(g.length); return g.slice(0, g.length - 3).join('') + '***'; }
const escHtml = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));   // names come from Telegram: never put them in HTML raw

const WAIT_MAX = 5, HISTORY_MAX = 10;

const api = {
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
};

/* The first api.me() of a page also brings the live duel numbers: replace the printed "500 COINS" / "+900 COINS" texts */
function setDuelNumbers(fee, prize) {
  FEE = fee; PRIZE = prize;
  if (fee === 500 && prize === 900) return;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const v = n.nodeValue; if (/\b500 (COINS|coins)\b|\+900 COINS/.test(v)) n.nodeValue = v.replace(/\+900 COINS/g, '+' + prize + ' COINS').replace(/\b500 (COINS|coins)\b/g, fee + ' $1'); }
}
{ const _me = api.me; api.me = async () => { const u = await _me(); if (u && u.fee) setDuelNumbers(u.fee, u.prize); return u; }; }

/* MY PROFILE PICTURE: the server makes a tiny webp (about 2 KB) from the Telegram photo; the phone keeps it for 12 hours,
   so a page opens with the picture instantly and the server is asked only twice a day. Put data-me-av on any <img> that should show it. */
const Avatar = (() => {
  const uid = tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id, K = 'p2w_av_' + uid;
  let cur = ''; try { const c = JSON.parse(localStorage.getItem(K)); if (c && c.d) cur = c.d; } catch (e) {}
  const apply = () => { if (cur) document.querySelectorAll('img[data-me-av]').forEach(i => { if (i.getAttribute('src') !== cur) i.src = cur; }); };
  const fresh = () => { try { const c = JSON.parse(localStorage.getItem(K)); return c && Date.now() - c.t < 12 * 3600e3; } catch (e) { return false; } };
  async function fetchIt() {
    if (fresh() || !LIVE) return;
    try {
      const r = await fetch(API_URL + '/api/avatar', { headers: { 'x-init-data': tg.initData } });
      if (r.status === 204 || !r.ok) { localStorage.setItem(K, JSON.stringify({ t: Date.now(), d: cur })); return; }
      const blob = await r.blob(), d = await new Promise(ok => { const f = new FileReader(); f.onload = () => ok(String(f.result)); f.onerror = () => ok(''); f.readAsDataURL(blob); });
      if (d) { cur = d; try { localStorage.setItem(K, JSON.stringify({ t: Date.now(), d })); } catch (e) {} apply(); }
    } catch (e) { /* the default picture stays */ }
  }
  document.addEventListener('DOMContentLoaded', () => { apply(); fetchIt(); }); if (document.readyState !== 'loading') { apply(); fetchIt(); }
  return { apply };
})();

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
  [/^Expected return is (\d+)% of the bet\.$/, m => 'ပျမ်းမျှ ပြန်ရမှု လောင်းကြေးရဲ့ ' + m[1] + '% ဖြစ်ပါတယ်။'],
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
