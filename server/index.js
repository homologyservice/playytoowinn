const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const settings = require('./settings');
const store = require('./store');
const { tx, stat, Shot } = store;

const { BOT_TOKEN, WEBAPP_URL, MONGODB_URI, RENDER_EXTERNAL_URL } = process.env;
const PORT = process.env.PORT || 3000;
if (!BOT_TOKEN || !WEBAPP_URL || !MONGODB_URI) {
  console.error('Missing BOT_TOKEN, WEBAPP_URL or MONGODB_URI'); process.exit(1);
}

// ---------- Game constants ----------
// The numbers that the admin can change live in settings.js (stored in MongoDB). These are read at use time.
const CFG = settings.get;
const duel = () => CFG().games.duel;
const duelPrize = () => settings.duelPrize(duel());
const CLAIM_MS = 10 * 60 * 1000; // prize can be claimed 10 min after the match is decided
const STALE_MS = 15 * 60 * 1000; // a run that never reports back is treated as forfeited
const SWEEP_MS = 30 * 1000;      // how often the stale-run sweep may hit the database
const WAIT_MAX = 5;              // max "slots" a player may have open (waiting matches + prizes not yet claimed)
const HISTORY_MAX = 10;          // history rows kept per player; the oldest finished row is deleted when an 11th arrives
const DAY_OFFSET_MIN = Number(process.env.DAY_OFFSET_MIN || 390);   // "a day" ends at local midnight: default Myanmar time (UTC+6:30)
let BOT_USERNAME = process.env.BOT_USERNAME || '';

// ---------- Database ----------
const User = mongoose.model('User', new mongoose.Schema({
  tgId: { type: Number, unique: true, required: true },     // Telegram numeric id (the real identity)
  username: { type: String, default: '' },                   // Telegram @username without the @ (can be empty / change)
  usernameLower: { type: String, default: '', index: true }, // for lookups
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  name: { type: String, default: 'Player' },                 // display name shown to opponents
  languageCode: { type: String, default: '' },
  isPremium: { type: Boolean, default: false },
  coins: { type: Number, default: () => CFG().limits.startCoins },
  hearts: { type: Number, default: () => CFG().limits.startHearts },
  banned: { type: Boolean, default: false },                 // blocked by an admin
  banReason: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  nameLen: { type: Number, default: 0 },                     // visible characters of `name` (ranking hides 1-letter names)
  invitedBy: Number,                                         // tgId of the player whose invite link this player came through
  qualifiedAt: Date,                                         // first time this player started a coin game (= invite becomes "completed")
  inviteClaimed: { type: Boolean, default: false },          // the inviter has taken the invite reward for this player
  depositTotal: { type: Number, default: 0 },                // coins this player has added through approved top-ups (invite progress)
  plays: { type: Number, default: 0 },                       // games started (profile)
  lastDaily: { type: String, default: '' },                  // day key of the last daily bonus
  lastFreeSpin: { type: String, default: '' },               // day key of the last free daily spin
  freeSpins: { type: Number, default: 0 },                   // spins won from the wheel
}));

const side = () => ({
  user: Number, username: String, name: String, score: Number,
  status: String,                       // playing | done | forfeit
  startedAt: Date, finishedAt: Date,
  result: String,                       // win | loss | draw
  prize: { type: Number, default: 0 },
  claimed: { type: Boolean, default: false },
  revives: { type: Number, default: 0 },   // hearts used to continue after a crash
  gone: { type: Boolean, default: false }, // removed from this player's history (the doc is deleted when both sides are gone)
});
const matchSchema = new mongoose.Schema({
  status: { type: String, default: 'open' },   // open | complete
  createdAt: { type: Date, default: Date.now, index: true },
  completedAt: Date,
  claimAt: Date,
  a: side(),   // first player: plays "blind", sets the score to beat
  b: side(),   // second player: plays against a's saved score. One match = exactly two players.
});
matchSchema.index({ status: 1, 'b.user': 1, 'a.status': 1, createdAt: 1 });   // finding a match to join
matchSchema.index({ 'a.user': 1, status: 1 });
matchSchema.index({ 'b.user': 1, status: 1 });
const Match = mongoose.model('Match', matchSchema);

// ---------- Telegram initData verification ----------
function verifyInitData(initData, maxAgeSec) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > (maxAgeSec || 86400)) return null;
  let user = null;
  try { user = JSON.parse(params.get('user')); } catch { return null; }
  if (!user || !Number.isSafeInteger(Number(user.id))) return null;
  user.id = Number(user.id);
  return user;
}
const ADMIN_IDS = new Set([process.env.ADMIN_ID, process.env.ADMIN1_ID, process.env.ADMIN2_ID, ...String(process.env.ADMIN_IDS || '').split(',')].map((x) => Number(String(x || '').trim())).filter((n) => Number.isSafeInteger(n) && n > 0));
const isAdmin = (id) => ADMIN_IDS.has(Number(id));
const banned = new Set();   // tgIds blocked by an admin (kept in memory, loaded at start, updated by the admin panel)
function gate(u, res) {     // maintenance mode and bans apply to everybody except admins
  if (isAdmin(u.id)) return true;
  if (banned.has(u.id)) { res.status(403).json({ error: 'banned' }); return false; }
  const m = CFG().maintenance;
  if (m.on) { res.status(503).json({ error: 'maintenance', msg: m.msg }); return false; }
  return true;
}
function auth(req, res, next) {
  const u = verifyInitData(String(req.get('x-init-data') || ''));
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  if (!gate(u, res)) return;
  req.tg = u; next();
}
const gameOn = (name) => (req, res, next) => (CFG().games[name].on || isAdmin(req.tg.id) ? next() : res.status(403).json({ error: 'game_off' }));

// Everything Telegram tells us about the player is stored: numeric id + @username + names.
const seg = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (str) => (seg ? Array.from(seg.segment(String(str || '')), (x) => x.segment) : Array.from(String(str || '')));   // Burmese/emoji safe
function maskName(name) {          // last 3 characters -> ***; 3 or fewer -> all stars; 1 character -> not shown at all (null)
  const g = graphemes(name);
  if (g.length <= 1) return null;
  if (g.length <= 3) return '*'.repeat(g.length);
  return g.slice(0, g.length - 3).join('') + '***';
}
const dayKey = (t = Date.now()) => new Date(t + DAY_OFFSET_MIN * 60000).toISOString().slice(0, 10);
const nextDayAt = () => { const d = new Date(Date.now() + DAY_OFFSET_MIN * 60000); d.setUTCHours(24, 0, 0, 0); return d.getTime() - DAY_OFFSET_MIN * 60000; };
store.setDayKey(() => dayKey());
function identity(tgUser) {
  const firstName = String(tgUser.first_name || '').trim().slice(0, 64);
  const lastName = String(tgUser.last_name || '').trim().slice(0, 64);
  const username = String(tgUser.username || '').trim().replace(/^@/, '').slice(0, 64);
  const name = ([firstName, lastName].filter(Boolean).join(' ') || username || 'Player').slice(0, 32);
  return { firstName, lastName, username, usernameLower: username.toLowerCase(), name, nameLen: graphemes(name).length,
           languageCode: String(tgUser.language_code || '').slice(0, 10), isPremium: !!tgUser.is_premium };
}
async function upsertUser(tgUser) {
  const q = { tgId: tgUser.id };
  const upd = { $set: { ...identity(tgUser), lastSeenAt: new Date() } };
  const opt = { upsert: true, new: true, setDefaultsOnInsert: true };
  try { return await User.findOneAndUpdate(q, upd, opt); }
  catch (e) {
    if (e && e.code === 11000) return User.findOneAndUpdate(q, upd, opt);   // two first requests raced: the user now exists
    throw e;
  }
}

// ---------- Bot ----------
const bot = new Telegraf(BOT_TOKEN);
bot.catch((err) => console.error('bot error', err));
bot.start(async (ctx) => {
  if (ctx.from && !ctx.from.is_bot) {
    try {
      const existed = await User.exists({ tgId: ctx.from.id });
      await upsertUser(ctx.from);
      const m = /^inv_(\d{1,15})$/.exec(String(ctx.startPayload || ''));
      // only a brand-new player can be invited, never yourself, and only by a player that exists
      if (!existed && m) {
        const inviter = Number(m[1]);
        if (inviter !== ctx.from.id && await User.exists({ tgId: inviter })) {
          await User.updateOne({ tgId: ctx.from.id, invitedBy: { $exists: false } }, { $set: { invitedBy: inviter } });
        }
      }
    } catch (e) { console.error('start failed', e); }
  }
  return ctx.reply('ကြိုဆိုပါတယ်', Markup.inlineKeyboard([Markup.button.webApp('ဂိမ်းထဲဝင်ရန်', WEBAPP_URL)]));
});
// /adminlogin opens the admin panel (admins only; anyone else gets no reply, so the command is not revealed)
bot.command('adminlogin', async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  console.log('adminlogin', ctx.from.id);
  return ctx.reply('🔐 Admin panel', Markup.inlineKeyboard([Markup.button.webApp('Open admin panel', WEBAPP_URL.replace(/\/$/, '') + '/admin.html')]));
});
// Counts the games a player started (profile). Invites are completed by top-ups instead, see depositMilestone().
const qualify = (uid) => { User.updateOne({ tgId: uid }, { $inc: { plays: 1 } }).catch((e) => console.error('qualify failed', e)); };
const notify = (tgId, text) => bot.telegram.sendMessage(tgId, text).catch(() => {});

// ---------- Small helpers ----------
// Runs fn one at a time per key (one Render instance => an in-process lock is enough).
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev;
  try { return await fn(); }
  finally { release(); if (locks.get(key) === tail) locks.delete(key); }
}

// Slots: a player may hold at most WAIT_MAX of these at once:
//   - a match that is still WAITING for an opponent
//   - a match that finished as a win/draw but whose prize has NOT been claimed yet
// A loss frees its slot immediately. A win frees it only after the prize is claimed.
async function slotInfo(uid) {
  const [waiting, unclaimed] = await Promise.all([
    Match.countDocuments({ status: 'open', 'a.user': uid, 'a.status': 'done', 'a.gone': { $ne: true } }),
    Match.countDocuments({ status: 'complete', 'a.user': uid, 'a.prize': { $gt: 0 }, 'a.claimed': { $ne: true }, 'a.gone': { $ne: true } }),
  ]);
  const used = waiting + unclaimed, blocked = used >= WAIT_MAX;
  return { waiting, unclaimed, used, limit: WAIT_MAX, blocked,
           reason: blocked ? (waiting >= WAIT_MAX ? 'waiting_limit' : 'claim_first') : null };
}

// ---------- History pruning (keeps the database small) ----------
// A player keeps only their latest HISTORY_MAX rows. When an 11th row appears, the OLDEST finished row is removed.
// Rows still waiting for an opponent are never removed (they would lose the player's entry fee).
// If the removed row still had an unclaimed prize, it is paid out automatically, so nobody loses coins.
async function removeSide(m, s) {
  const o = s === 'a' ? 'b' : 'a';
  const prize = m[s].prize || 0;
  if (prize > 0 && !m[s].claimed) {
    const g = await Match.updateOne({ _id: m._id, [`${s}.claimed`]: { $ne: true } }, { $set: { [`${s}.claimed`]: true } });
    if (g.modifiedCount) { await User.updateOne({ tgId: m[s].user }, { $inc: { coins: prize } }); tx(m[s].user, 'duel_prize', prize, null, m._id, 'duel'); stat('duel', 0, prize); }
  }
  if (!m[o].user || m[o].gone) await Match.deleteOne({ _id: m._id });                       // nobody else needs it
  else await Match.updateOne({ _id: m._id }, { $set: { [`${s}.gone`]: true } });            // the other player still sees it
}
async function pruneHistory(uid) {
  return withLock('h' + uid, async () => {
    const ms = await Match.find({
      status: { $in: ['open', 'complete'] },
      $or: [{ 'a.user': uid, 'a.gone': { $ne: true } }, { 'b.user': uid, 'b.gone': { $ne: true } }],
    });
    const rows = [];
    for (const m of ms) {
      const s = m.a.user === uid ? 'a' : 'b';
      if (m.status === 'open') {
        if (s === 'a' && m.a.status === 'done') rows.push({ m, s, at: m.a.finishedAt.getTime(), keep: true });   // waiting row
        continue;                                                                                                 // runs in progress are not history yet
      }
      rows.push({ m, s, at: m.completedAt.getTime(), keep: false });
    }
    let excess = rows.length - HISTORY_MAX;
    if (excess <= 0) return;
    rows.sort((x, y) => x.at - y.at);                  // oldest first
    for (const r of rows) {
      if (excess <= 0) break;
      if (r.keep) continue;
      await removeSide(r.m, r.s);
      excess--;
    }
  });
}
const safePrune = (uid) => (uid ? pruneHistory(uid).catch((e) => console.error('prune failed', e)) : Promise.resolve());

// ---------- Duel logic ----------
function decide(aScore, bScore, bForfeit) {
  if (bForfeit || aScore > bScore) return { a: 'win', b: 'loss' };
  if (aScore < bScore) return { a: 'loss', b: 'win' };
  return { a: 'draw', b: 'draw' };
}
const prizeFor = (r) => (r === 'win' ? duelPrize() : r === 'draw' ? duel().fee : 0);

// Finish match when player B is done. Guarded so it can only happen once.
async function completeMatch(m, bScore, bForfeit) {
  const r = decide(m.a.score, bScore, bForfeit);
  const now = new Date();
  const upd = await Match.findOneAndUpdate(
    { _id: m._id, status: 'open', 'b.status': 'playing' },
    { $set: {
        status: 'complete', completedAt: now, claimAt: new Date(now.getTime() + CLAIM_MS),
        'b.score': bScore, 'b.status': bForfeit ? 'forfeit' : 'done', 'b.finishedAt': now,
        'a.result': r.a, 'b.result': r.b, 'a.prize': prizeFor(r.a), 'b.prize': prizeFor(r.b),
    } },
    { new: true }
  );
  if (upd) {
    const msg = r.a === 'win' ? `Fly & Dodge: you WON ${upd.a.score} - ${bForfeit ? 0 : bScore}! Claim ${duelPrize()} coins in History after 10 minutes.`
              : r.a === 'draw' ? `Fly & Dodge: it's a draw (${upd.a.score} - ${bScore}). Your entry fee comes back, claim it in History after 10 minutes.`
              : `Fly & Dodge: you lost ${upd.a.score} - ${bScore}.`;
    notify(upd.a.user, msg);
    await Promise.all([safePrune(upd.a.user), safePrune(upd.b.user)]);   // both players just got a new history row
  }
  return upd;
}

// Runs that were started but never reported (app closed) count as forfeits.
let lastSweep = 0;
async function sweep(force) {
  const now = Date.now();
  if (!force && now - lastSweep < SWEEP_MS) return;
  lastSweep = now;
  const lim = new Date(now - STALE_MS);
  // an "a" run that never came back has no opponent and no history row: just delete it
  await Match.deleteMany({ status: 'open', 'a.status': 'playing', 'a.startedAt': { $lt: lim } });
  await Match.deleteMany({ status: 'dead' });                                       // rows left by older versions
  await Match.deleteMany({ status: 'complete', 'a.gone': true, 'b.gone': true });   // gone for both players
  const stale = await Match.find({ status: 'open', 'a.status': 'done', 'b.status': 'playing', 'b.startedAt': { $lt: lim } });
  for (const m of stale) await completeMatch(m, 0, true);
}
// Starting a new run while an old one is still "playing" = the old one was abandoned -> forfeit it.
async function forfeitActive(uid) {
  await Match.deleteMany({ status: 'open', 'a.user': uid, 'a.status': 'playing' });
  const asB = await Match.find({ status: 'open', 'b.user': uid, 'b.status': 'playing' });
  for (const m of asB) await completeMatch(m, 0, true);
}

// ---------- API ----------
const app = express();
app.use(cors({ origin: WEBAPP_URL.replace(/\/$/, ''), allowedHeaders: ['Content-Type', 'x-init-data'] }));

// =====================================================================
//  COIN TOP-UP through an admin. The player talks to the admin, then sends a screenshot here.
//  The admin gets the screenshot in Telegram with buttons: Confirm / Reject / Edit amount.
//  Coins are ALWAYS credited to the player who sent the request (the typed username is only shown to the admin).
//  Set ADMIN1_ID / ADMIN2_ID (Telegram user ids; each admin must have pressed /start in the bot once).
// =====================================================================
const PAY_LABEL = { 1: 'KPAY', 2: 'WAVE PAY' };
const envAdmin = (n) => ({ key: String(n), id: Number(process.env['ADMIN' + n + '_ID'] || 0), name: process.env['ADMIN' + n + '_NAME'] || ('Admin ' + n),
  username: String(process.env['ADMIN' + n + '_USERNAME'] || '').replace(/^@/, ''),
  // what the player sees after choosing this platform: "KPAY - 09xxxxxxx / Name : xxxxx"
  pay: { label: process.env['ADMIN' + n + '_PAY_LABEL'] || PAY_LABEL[n], number: process.env['ADMIN' + n + '_PAY_NUMBER'] || '09xxxxxxxxx', name: process.env['ADMIN' + n + '_PAY_NAME'] || 'xxxxx' } });
const ADMINS = { 1: envAdmin(1), 2: envAdmin(2) };
const SHOT_MIN_KB = 50, SHOT_MAX_MB = 5;                 // what the page tells the player (checked on the original file in the page)
const SHOT_FLOOR_BYTES = 10 * 1024, SHOT_CEIL_BYTES = 6 * 1024 * 1024;   // hard limits the server enforces on the uploaded (already compressed) image
const depositSchema = new mongoose.Schema({
  tgId: { type: Number, required: true }, admin: { type: Number, required: true }, username: String,
  amount: { type: Number, required: true }, finalAmount: Number,
  status: { type: String, default: 'pending' },          // pending | approved | rejected | failed
  awaitingEdit: { type: Boolean, default: false },
  adminChat: Number, adminMsg: Number, shotId: String,
  createdAt: { type: Date, default: Date.now }, decidedAt: Date,
});
depositSchema.index({ tgId: 1, createdAt: -1 });
depositSchema.index({ admin: 1, awaitingEdit: 1 });
const Deposit = mongoose.model('Deposit', depositSchema);
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);   // a stuck Telegram call must never freeze the request or its lock
const imgKind = (b) => (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpeg' : b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'png'
  : b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null);
const depView = (d) => ({ id: String(d._id), admin: d.admin, amount: d.finalAmount || d.amount, status: d.status, at: new Date(d.createdAt).getTime() });


// ----- how the screenshot reaches the admin -----
// 1) The picture is kept for a few days under a secret address and Telegram is asked to fetch it itself (a plain JSON call, like a text message).
//    This avoids uploading a file from this server, which hung on some hosts.
// 2) If that does not work, the file is uploaded directly with Node's own fetch/FormData.
const PUBLIC_URL = String(process.env.PUBLIC_URL || RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
app.get('/api/deposit/shot/:file', async (req, res) => {
  try {
    const token = String(req.params.file || '').replace(/\.\w{2,4}$/, '');
    if (!/^[a-f0-9]{48}$/.test(token)) return res.sendStatus(404);
    const row = await Shot.findOne({ token });
    if (!row) return res.sendStatus(404);
    res.set({ 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' }).send(row.data);
  } catch (e) { fail(res, e); }
});
const NO_CHAT = /chat not found|can't initiate|blocked by the user|user is deactivated|forbidden/i;
async function uploadPhotoDirect(chatId, buf, kind, caption, markup) {
  if (typeof fetch !== 'function' || typeof FormData === 'undefined' || typeof Blob === 'undefined') throw new Error('no_native_fetch');
  const fd = new FormData();
  fd.append('chat_id', String(chatId)); fd.append('caption', caption); fd.append('parse_mode', 'HTML'); fd.append('reply_markup', JSON.stringify(markup));
  fd.append('photo', new Blob([buf], { type: MIME[kind] }), 'screenshot.' + (kind === 'jpeg' ? 'jpg' : kind));
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: 'POST', body: fd, signal: ac.signal });
    const j = await r.json();
    if (!j.ok) throw new Error(j.description || 'telegram_error');
    return j.result;
  } catch (e) { throw new Error(e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'upload_failed'); }
  finally { clearTimeout(t); }
}
async function sendShotToAdmin(adminId, depId, buf, kind, caption, markup) {
  if (PUBLIC_URL) {
    try {
      const token = crypto.randomBytes(24).toString('hex');
      await Shot.pick(['img', 'hist', 'main']).create({ depId, token, mime: MIME[kind], data: buf });
      const sent = await withTimeout(bot.telegram.sendPhoto(adminId, `${PUBLIC_URL}/api/deposit/shot/${token}.jpg`, { caption, parse_mode: 'HTML', reply_markup: markup }), 20000);
      console.log('deposit: delivered to admin (by link)');
      return sent;
    } catch (e) {
      console.error('deposit: send by link failed:', e && e.message);
      if (NO_CHAT.test((e && e.message) || '')) throw e;          // the admin never pressed /start: uploading will not help
    }
  }
  const sent = await uploadPhotoDirect(adminId, buf, kind, caption, markup);
  console.log('deposit: delivered to admin (uploaded)');
  return sent;
}
app.get('/health', (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true }));   // the pages ping this so the free server does not fall asleep
app.get('/api/deposit/config', auth, (req, res) => {
  res.json({ admins: [1, 2].map((n) => ({ key: String(n), name: ADMINS[n].name, username: ADMINS[n].username, available: !!ADMINS[n].id, pay: ADMINS[n].pay })),
    min: CFG().limits.depositMin, max: CFG().limits.depositMax, shotMinMb: SHOT_MIN_KB / 1024, shotMaxMb: SHOT_MAX_MB });
});
app.get('/api/deposit/mine', auth, async (req, res) => {
  try { const rows = await Deposit.find({ tgId: req.tg.id, status: { $ne: 'failed' } }).sort({ createdAt: -1 }).limit(5); res.json({ items: rows.map(depView) }); }
  catch (e) { fail(res, e); }
});
// own, bigger body limit (the screenshot travels as base64); the global 10kb parser below never sees this route
app.post('/api/deposit/submit', auth, express.json({ limit: '9mb' }), async (req, res) => {
  try {
    const uid = req.tg.id, b = req.body || {};
    const adm = ADMINS[Number(b.admin)];
    if (!adm || !adm.id) return res.status(503).json({ error: 'admin_unavailable' });
    const amount = Number(b.amount), username = clean(b.username, 64);
    if (!Number.isSafeInteger(amount) || amount < CFG().limits.depositMin || amount > CFG().limits.depositMax) return res.status(400).json({ error: 'bad_amount' });
    if (!username) return res.status(400).json({ error: 'bad_username' });
    const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ''));
    if (!m) return res.status(400).json({ error: 'bad_image' });
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length < SHOT_FLOOR_BYTES) return res.status(400).json({ error: 'image_too_small' });
    if (buf.length > SHOT_CEIL_BYTES) return res.status(413).json({ error: 'image_too_big' });
    const kind = imgKind(buf); if (!kind) return res.status(400).json({ error: 'bad_image' });
    await withLock('dep' + uid, async () => {
      const me = await upsertUser(req.tg);
      if (await Deposit.countDocuments({ tgId: uid, status: 'pending' }) >= CFG().limits.maxPendingDeposits) return res.status(429).json({ error: 'too_many_pending' });
      const d = await Deposit.create({ tgId: uid, admin: adm.key ? Number(adm.key) : 1, username, amount });
      const caption = `💰 <b>Coin top-up request</b>\nPlayer: ${escHtml(me.name)}${me.username ? ' (@' + escHtml(me.username) + ')' : ''}\nTelegram ID: <code>${uid}</code>\nPlatform: <b>${escHtml(adm.pay.label)}</b>\nPayer account name: <b>${escHtml(username)}</b>\nAmount asked: <b>${amount}</b> coins\nRequest: <code>${d._id}</code>`;
      console.log('deposit: sending screenshot', Math.round(buf.length / 1024) + 'KB', 'player', uid, 'admin', adm.key);
      try {
        const markup = { inline_keyboard: [[{ text: `✅ Confirm ${amount}`, callback_data: 'dep:ok:' + d._id }, { text: '❌ Reject', callback_data: 'dep:no:' + d._id }], [{ text: '✏️ Edit amount', callback_data: 'dep:edit:' + d._id }]] };
        const sent = await sendShotToAdmin(adm.id, d._id, buf, kind, caption, markup);
        const ph = sent.photo && sent.photo[sent.photo.length - 1];
        await Deposit.updateOne({ _id: d._id }, { $set: { adminChat: sent.chat.id, adminMsg: sent.message_id, shotId: ph ? ph.file_id : '' } });
      } catch (e) {
        console.error('deposit: admin not reachable:', e && e.message);
        await Deposit.updateOne({ _id: d._id }, { $set: { status: 'failed' } });
        await Shot.deleteMany({ depId: d._id }).catch(() => {});
        const timeout = e && e.message === 'timeout';
        return res.status(timeout ? 504 : 502).json({ error: timeout ? 'admin_timeout' : 'admin_unreachable' });
      }
      res.json({ ok: true, id: String(d._id) });
    });
  } catch (e) { fail(res, e); }
});

// ----- admin buttons (only the chosen admin can use them) -----
const adminOk = (d, from) => d && ADMINS[d.admin] && ADMINS[d.admin].id && ADMINS[d.admin].id === from;
async function depositMilestone(tgId, amount) {   // an approved top-up counts toward the invite; at CFG().limits.inviteMinDeposit the invite is "completed" and the inviter is told
  try {
    const u = await User.findOneAndUpdate({ tgId }, { $inc: { depositTotal: amount } }, { new: true });
    if (!u || u.depositTotal < CFG().limits.inviteMinDeposit || u.qualifiedAt) return;
    const r = await User.updateOne({ tgId, $or: [{ qualifiedAt: { $exists: false } }, { qualifiedAt: null }] }, { $set: { qualifiedAt: new Date() } });
    if (r.modifiedCount && u.invitedBy) notify(u.invitedBy, `🎉 Your friend ${u.name} has added ${CFG().limits.inviteMinDeposit} coins. You can claim ${CFG().limits.inviteReward} coins in Invites.\nသင့်သူငယ်ချင်း ${u.name} က coins ${CFG().limits.inviteMinDeposit} ဖြည့်ပြီးပါပြီ။ Invites ထဲမှာ coins ${CFG().limits.inviteReward} ရယူနိုင်ပါပြီ။`);
  } catch (e) { console.error('depositMilestone failed', e); }
}
async function settleDeposit(id, status, amount) {   // flips pending -> approved/rejected exactly once, then credits
  const set = { status, decidedAt: new Date(), awaitingEdit: false }; if (status === 'approved') set.finalAmount = amount;
  const d = await Deposit.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: set }, { new: true });
  if (!d) return null;
  Shot.deleteMany({ depId: d._id }).catch(() => {});
  if (status === 'approved') {
    try { await User.updateOne({ tgId: d.tgId }, { $inc: { coins: amount } }); }
    catch (e) { await Deposit.updateOne({ _id: d._id }, { $set: { status: 'pending' } }); throw e; }
    tx(d.tgId, 'deposit', amount, null, d._id, '', d.username || '');
    await depositMilestone(d.tgId, amount);
  }
  return d;
}
async function afterDecision(d, text) {   // update the admin message and tell the player
  try { if (d.adminChat) { await bot.telegram.editMessageReplyMarkup(d.adminChat, d.adminMsg, undefined, { inline_keyboard: [] }); await bot.telegram.editMessageCaption(d.adminChat, d.adminMsg, undefined, text, { parse_mode: 'HTML' }); } } catch (e) { /* message may be too old */ }
  if (d.status === 'approved') notify(d.tgId, `✅ ${d.finalAmount} coins were added to your balance.\nသင့်အကောင့်ထဲ ${d.finalAmount} coins ထည့်ပေးပြီးပါပြီ။`);
  else notify(d.tgId, '❌ Your coin top-up request was rejected. Please contact the admin.\nသင့်တောင်းဆိုမှုကို ပယ်ချလိုက်ပါတယ်၊ Admin ကို ဆက်သွယ်ပါ။');
}
bot.action(/^dep:(ok|no|edit):([a-f0-9]{24})$/, async (ctx) => {
  try {
    const [, act, id] = ctx.match;
    const d = await Deposit.findById(id);
    if (!adminOk(d, ctx.from.id)) return ctx.answerCbQuery('Not allowed', { show_alert: true });
    if (d.status !== 'pending') return ctx.answerCbQuery('Already handled');
    if (act === 'ok') {
      const done = await settleDeposit(id, 'approved', d.finalAmount || d.amount);
      if (!done) return ctx.answerCbQuery('Already handled');
      await ctx.answerCbQuery('Confirmed'); return afterDecision(done, `✅ <b>Confirmed</b>: ${done.finalAmount} coins\nPlayer ID: <code>${done.tgId}</code>`);
    }
    if (act === 'no') {
      const done = await settleDeposit(id, 'rejected');
      if (!done) return ctx.answerCbQuery('Already handled');
      await ctx.answerCbQuery('Rejected'); return afterDecision(done, `❌ <b>Rejected</b>\nPlayer ID: <code>${done.tgId}</code>`);
    }
    // edit: the next number this admin sends is the amount that gets credited
    await Deposit.updateMany({ admin: d.admin, awaitingEdit: true }, { $set: { awaitingEdit: false } });
    await Deposit.updateOne({ _id: d._id }, { $set: { awaitingEdit: true } });
    await ctx.answerCbQuery();
    return ctx.reply(`✏️ Send the new amount (a whole number) for request ${id.slice(-6)}.\nThat many coins will be added to the player right away.`, { reply_markup: { force_reply: true } });
  } catch (e) { console.error('deposit action failed', e); ctx.answerCbQuery('Error').catch(() => {}); }
});
bot.on('text', async (ctx, next) => {
  try {
    const n = Object.keys(ADMINS).find((k) => ADMINS[k].id && ADMINS[k].id === ctx.from.id);
    if (!n) return next();
    const d = await Deposit.findOne({ admin: Number(n), awaitingEdit: true, status: 'pending' }).sort({ createdAt: -1 });
    if (!d) return next();
    const txt = ctx.message.text.trim().replace(/[, ]/g, '');
    if (!/^\d{1,9}$/.test(txt)) return ctx.reply('Please send a whole number, for example 300.');
    const amount = Number(txt);
    if (amount < 1 || amount > CFG().limits.depositMax) return ctx.reply(`The amount must be between 1 and ${CFG().limits.depositMax}.`);
    const done = await settleDeposit(d._id, 'approved', amount);
    if (!done) return ctx.reply('That request was already handled.');
    await ctx.reply(`✅ ${amount} coins added to player ${done.tgId}.`);
    return afterDecision(done, `✅ <b>Confirmed (edited)</b>: ${done.finalAmount} coins (asked ${done.amount})\nPlayer ID: <code>${done.tgId}</code>`);
  } catch (e) { console.error('deposit edit failed', e); }
});
app.use(express.json({ limit: '10kb' }));
app.get('/', (_, res) => res.send('Play2Win server OK'));

const fail = (res, e) => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'server_error' }); };

app.post('/api/auth', async (req, res) => {
  try {
    const tgUser = verifyInitData(String((req.body && req.body.initData) || ''));
    if (!tgUser) return res.status(401).json({ error: 'invalid initData' });
    if (!gate(tgUser, res)) return;
    const u = await upsertUser(tgUser);
    const slots = await slotInfo(tgUser.id);
    const off = Object.keys(CFG().games).filter((k) => !CFG().games[k].on);
    res.json({ name: u.name, username: u.username, coins: u.coins, hearts: u.hearts, fee: duel().fee, prize: duelPrize(), off, admin: isAdmin(tgUser.id), ...slots });
  } catch (e) { fail(res, e); }
});

// Start a run: check the slot limit, charge the entry fee, then join someone's saved score or open a new match.
app.post('/api/duel/start', auth, gameOn('duel'), async (req, res) => {
  try {
    const uid = req.tg.id;
    await withLock('u' + uid, async () => {
      const user = await upsertUser(req.tg);
      await sweep();
      await forfeitActive(uid);

      const slots = await slotInfo(uid);
      if (slots.blocked) return res.status(403).json({ error: slots.reason, ...slots });

      const paid = await User.findOneAndUpdate({ tgId: uid, coins: { $gte: duel().fee } }, { $inc: { coins: -duel().fee } }, { new: true });
      if (!paid) return res.status(402).json({ error: 'not_enough_coins' });
      qualify(uid); tx(uid, 'duel_fee', -duel().fee, paid.coins, null, 'duel'); stat('duel', duel().fee, 0);

      try {
        const now = new Date();
        // a match is used once: it needs a finished "a", an empty "b", and "a" must be someone else
        const joined = await Match.findOneAndUpdate(
          { status: 'open', 'b.user': null, 'a.status': 'done', 'a.user': { $ne: uid } },
          { $set: { 'b.user': uid, 'b.username': user.username, 'b.name': user.name, 'b.status': 'playing', 'b.startedAt': now, 'b.claimed': false } },
          { sort: { createdAt: 1 }, new: true }
        );
        if (joined) {
          return res.json({ matchId: String(joined._id), seed: String(joined._id), role: 'b',
                            opponent: { name: joined.a.name, score: joined.a.score }, coins: paid.coins, hearts: paid.hearts });
        }
        const m = await Match.create({ a: { user: uid, username: user.username, name: user.name, status: 'playing', startedAt: now } });
        res.json({ matchId: String(m._id), seed: String(m._id), role: 'a', opponent: null, coins: paid.coins, hearts: paid.hearts });
      } catch (e) {
        await User.updateOne({ tgId: uid }, { $inc: { coins: duel().fee } });   // refund if matching failed
        tx(uid, 'refund', duel().fee, null, null, 'duel'); stat('duel', -duel().fee, 0);
        throw e;
      }
    });
  } catch (e) { fail(res, e); }
});

// Spend 1 heart to continue a run after crashing (score is kept, the client continues from where it crashed).
app.post('/api/duel/revive', auth, async (req, res) => {
  try {
    const uid = req.tg.id;
    if (!mongoose.isValidObjectId(req.body.matchId)) return res.status(400).json({ error: 'bad_match' });
    const m = await Match.findById(req.body.matchId);
    const role = m && m.status === 'open' ? ((m.a.user === uid && m.a.status === 'playing') ? 'a' : (m.b.user === uid && m.b.status === 'playing') ? 'b' : null) : null;
    if (!role) return res.status(409).json({ error: 'not_active' });
    const u = await User.findOneAndUpdate({ tgId: uid, hearts: { $gte: 1 } }, { $inc: { hearts: -1 } }, { new: true });
    if (!u) return res.status(402).json({ error: 'no_hearts' });
    await Match.updateOne({ _id: m._id }, { $inc: { [`${role}.revives`]: 1 } });
    res.json({ hearts: u.hearts });
  } catch (e) { fail(res, e); }
});

// Report the score of a run (or a forfeit).
app.post('/api/duel/finish', auth, async (req, res) => {
  try {
    const uid = req.tg.id;
    if (!mongoose.isValidObjectId(req.body.matchId)) return res.status(400).json({ error: 'bad_match' });
    const m = await Match.findById(req.body.matchId);
    if (!m) return res.status(404).json({ error: 'not_found' });
    const role = (m.a.user === uid && m.a.status === 'playing') ? 'a' : (m.b.user === uid && m.b.status === 'playing') ? 'b' : null;
    if (!role) return res.status(409).json({ error: 'not_active' });

    let score = Math.floor(Number(req.body.score));
    let forfeit = !!req.body.forfeit;
    // basic anti-cheat: you cannot pass more pipes than the elapsed time allows (5s countdown + at least ~0.65s per pipe at top speed)
    const elapsed = Date.now() - m[role].startedAt.getTime();
    if (!forfeit && !(score >= 0 && score <= Math.floor(Math.max(0, elapsed - 5000) / 650) + 1)) forfeit = true;
    if (forfeit || !Number.isFinite(score)) { score = 0; }

    if (role === 'a') {
      if (forfeit) {   // nobody joined this run yet, so there is nothing to keep
        const del = await Match.deleteOne({ _id: m._id, status: 'open', 'a.status': 'playing' });
        if (!del.deletedCount) return res.status(409).json({ error: 'not_active' });
        const [u, slots] = await Promise.all([User.findOne({ tgId: uid }), slotInfo(uid)]);
        return res.json({ result: 'forfeit', myScore: 0, coins: u.coins, ...slots });
      }
      const upd = await Match.findOneAndUpdate({ _id: m._id, 'a.status': 'playing' },
        { $set: { 'a.score': score, 'a.status': 'done', 'a.finishedAt': new Date() } });
      if (!upd) return res.status(409).json({ error: 'not_active' });
      await safePrune(uid);                                  // keep only the latest 10 rows
      const [u, slots] = await Promise.all([User.findOne({ tgId: uid }), slotInfo(uid)]);
      return res.json({ result: 'waiting', myScore: score, coins: u.coins, ...slots });
    }
    const done = await completeMatch(m, score, forfeit);
    if (!done) return res.status(409).json({ error: 'not_active' });
    const [u, slots] = await Promise.all([User.findOne({ tgId: uid }), slotInfo(uid)]);
    res.json({ result: forfeit ? 'forfeit' : done.b.result, myScore: score, oppScore: done.a.score,
               prize: done.b.prize, claimAt: done.claimAt.getTime(), coins: u.coins, ...slots });
  } catch (e) { fail(res, e); }
});

// History list: at most HISTORY_MAX rows, newest first. Every waiting match is listed as "pending".
app.get('/api/duel/history', auth, async (req, res) => {
  try {
    const uid = req.tg.id;
    await sweep();
    const u = await upsertUser(req.tg);
    await safePrune(uid);
    const ms = await Match.find({
      status: { $in: ['open', 'complete'] },
      $or: [{ 'a.user': uid, 'a.gone': { $ne: true } }, { 'b.user': uid, 'b.gone': { $ne: true } }],
    });
    const items = [];
    for (const m of ms) {
      const mine = m.a.user === uid ? 'a' : 'b', other = mine === 'a' ? 'b' : 'a';
      if (m.status === 'open') {
        if (!(mine === 'a' && m.a.status === 'done')) continue;      // only my finished run that is waiting for an opponent
        items.push({ id: String(m._id), opponent: null, myScore: m.a.score, oppScore: null, result: 'pending',
                     prize: 0, claimAt: 0, claimed: false, at: m.a.finishedAt.getTime() });
      } else {
        items.push({ id: String(m._id), opponent: m[other].name, myScore: m[mine].score, oppScore: m[other].score,
                     result: m[mine].result, prize: m[mine].prize, claimAt: m.claimAt.getTime(), claimed: !!m[mine].claimed,
                     at: m.completedAt.getTime() });
      }
    }
    items.sort((x, y) => y.at - x.at);
    const slots = await slotInfo(uid);
    res.json({ items: items.slice(0, HISTORY_MAX), coins: u.coins, hearts: u.hearts, ...slots });
  } catch (e) { fail(res, e); }
});

// Claim a prize (only after the 10-minute timer, only once). Claiming a win frees its slot.
app.post('/api/duel/claim', auth, async (req, res) => {
  try {
    const uid = req.tg.id;
    if (!mongoose.isValidObjectId(req.body.matchId)) return res.status(400).json({ error: 'bad_match' });
    const m = await Match.findById(req.body.matchId);
    if (!m || m.status !== 'complete') return res.status(404).json({ error: 'not_found' });
    const mine = m.a.user === uid ? 'a' : m.b.user === uid ? 'b' : null;
    if (!mine) return res.status(403).json({ error: 'forbidden' });
    if (m[mine].gone) return res.status(404).json({ error: 'not_found' });
    const prize = m[mine].prize;
    if (!prize) return res.status(400).json({ error: 'nothing' });
    if (Date.now() < m.claimAt.getTime()) return res.status(425).json({ error: 'too_early' });
    const upd = await Match.updateOne({ _id: m._id, [`${mine}.claimed`]: { $ne: true } }, { $set: { [`${mine}.claimed`]: true } });
    if (!upd.modifiedCount) return res.status(409).json({ error: 'already_claimed' });
    const u = await User.findOneAndUpdate({ tgId: uid }, { $inc: { coins: prize } }, { new: true });
    tx(uid, 'duel_prize', prize, u.coins, m._id, 'duel'); stat('duel', 0, prize);
    const slots = await slotInfo(uid);
    res.json({ coins: u.coins, ...slots });
  } catch (e) { fail(res, e); }
});


// =====================================================================
//  BOMB POINTS (solo, virtual coins only). The server owns the bombs, the client only sees tiles it picked.
// =====================================================================
const BOMB_TILES = 16;
// Multipliers come from the real odds of the 16-tile board: (1 - edge) / P(surviving k safe picks), so cashing out at ANY step returns (1 - edge) of the stake on average.
// The table is rebuilt only when the admin changes the Bomb settings. It also caps the multiplier (maxMult), and the round cashes out by itself at the cap.
let _bt = { k: '', t: null };
function bombTbl() { const g = CFG().games.bomb, k = JSON.stringify([g.edge, g.minBombs, g.maxBombs, g.maxMult]); if (_bt.k !== k) _bt = { k, t: settings.bombTable(g) }; return _bt.t; }
const bombMult = (bombs, safe) => { if (safe < 1) return 1; const row = bombTbl()[bombs] || bombTbl()[CFG().games.bomb.minBombs]; return row[Math.min(row.length - 1, safe - 1)]; };
// TOTAL paid back at cash-out = entry x multiplier (the entry is included, profit = prize - entry).
// Integer maths on hundredths: 5000 * 1.15 must be 5750, not 5749.999...
const bombPrize = (entry, mult) => Math.floor(entry * Math.round(mult * 100) / 100);

const bombSchema = new mongoose.Schema({
  tgId: { type: Number, required: true },
  entry: Number, bombs: Number,
  mines: [Number],                              // secret until the round ends
  picks: [Number],                              // safe tiles already revealed
  safe: { type: Number, default: 0 },
  status: { type: String, default: 'active' },  // active | cashed | lost
  prize: { type: Number, default: 0 },
  unpaid: { type: Boolean, default: false },    // true only between "round closed as cashed" and "coins credited" (crash safety)
  createdAt: { type: Date, default: Date.now },
  endedAt: Date,
});
bombSchema.index({ tgId: 1, status: 1, createdAt: -1 });
const BombRound = mongoose.model('BombRound', bombSchema);

function bombShuffle(n, k) {   // k distinct random tiles out of n, cryptographically random
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k).sort((x, y) => x - y);
}
const bombView = (r) => {
  const prize = r.safe ? bombPrize(r.entry, bombMult(r.bombs, r.safe)) : 0;
  return { id: String(r._id), entry: r.entry, bombs: r.bombs, picks: r.picks, safe: r.safe,
    mult: bombMult(r.bombs, r.safe), prize, net: prize ? prize - r.entry : 0, nextMult: bombMult(r.bombs, r.safe + 1) };
};
async function bombTrim(uid) {   // keep only the latest BOMB_HISTORY_MAX finished rounds (oldest are deleted)
  const old = await BombRound.find({ tgId: uid, status: { $ne: 'active' }, unpaid: { $ne: true } }).sort({ endedAt: -1, createdAt: -1 }).skip(BOMB_HISTORY_MAX).limit(50);
  if (old.length) await BombRound.deleteMany({ _id: { $in: old.map((r) => r._id) } });
}
// Pay a round that was closed as "cashed". Safe to call any number of times: the coins are added exactly once.
async function bombPay(roundId, uid, prize) {
  const g = await BombRound.updateOne({ _id: roundId, status: 'cashed', unpaid: true }, { $set: { unpaid: false } });
  if (!g.modifiedCount) return;                     // already paid
  try { await User.updateOne({ tgId: uid }, { $inc: { coins: prize } }); }
  catch (e) { await BombRound.updateOne({ _id: roundId }, { $set: { unpaid: true } }); throw e; }   // credit failed: stays payable
  tx(uid, 'bomb_win', prize, null, roundId, 'bomb'); stat('bomb', 0, prize);
}
async function bombPayPending(uid) {                // finishes any payout that was interrupted (server restart, DB hiccup)
  const rows = await BombRound.find({ tgId: uid, status: 'cashed', unpaid: true });
  for (const r of rows) await bombPay(r._id, uid, r.prize);
}
// Close the active round as cashed and credit the coins. Returns the prize, or null if the round was not active any more.
async function bombCashRound(r, now) {
  const prize = bombPrize(r.entry, bombMult(r.bombs, r.safe));
  const upd = await BombRound.updateOne({ _id: r._id, status: 'active' }, { $set: { status: 'cashed', endedAt: now, prize, unpaid: true } });
  if (!upd.modifiedCount) return null;
  await bombPay(r._id, r.tgId, prize);
  return prize;
}

app.get('/api/bomb/state', auth, async (req, res) => {
  try {
    await upsertUser(req.tg);
    await bombPayPending(req.tg.id);
    const u = await User.findOne({ tgId: req.tg.id });
    const r = await BombRound.findOne({ tgId: req.tg.id, status: 'active' });
    res.json({ coins: u.coins, round: r ? bombView(r) : null, table: bombTbl(), entries: CFG().games.bomb.entries, minBombs: CFG().games.bomb.minBombs, maxBombs: CFG().games.bomb.maxBombs, edge: CFG().games.bomb.edge });
  } catch (e) { fail(res, e); }
});

app.post('/api/bomb/start', auth, gameOn('bomb'), async (req, res) => {
  try {
    const uid = req.tg.id, entry = Number(req.body && req.body.entry), bombs = Number(req.body && req.body.bombs);
    const BG = CFG().games.bomb;
    if (!BG.entries.includes(entry) || !Number.isInteger(bombs) || bombs < BG.minBombs || bombs > BG.maxBombs) return res.status(400).json({ error: 'bad_request' });
    await withLock('b' + uid, async () => {
      await upsertUser(req.tg);
      await bombPayPending(uid);
      const open = await BombRound.findOne({ tgId: uid, status: 'active' });
      if (open) return res.status(409).json({ error: 'round_active', round: bombView(open) });
      const paid = await User.findOneAndUpdate({ tgId: uid, coins: { $gte: entry } }, { $inc: { coins: -entry } }, { new: true });
      if (!paid) return res.status(402).json({ error: 'not_enough_coins' });
      qualify(uid); tx(uid, 'bomb_bet', -entry, paid.coins, null, 'bomb'); stat('bomb', entry, 0);
      try {
        const r = await BombRound.create({ tgId: uid, entry, bombs, mines: bombShuffle(BOMB_TILES, bombs) });
        res.json({ coins: paid.coins, round: bombView(r) });
      } catch (e) {
        await User.updateOne({ tgId: uid }, { $inc: { coins: entry } });   // never keep the fee if the round could not be created
        tx(uid, 'refund', entry, null, null, 'bomb'); stat('bomb', -entry, 0);
        throw e;
      }
    });
  } catch (e) { fail(res, e); }
});

app.post('/api/bomb/pick', auth, async (req, res) => {
  try {
    const uid = req.tg.id, tile = Number(req.body && req.body.tile);
    if (!Number.isInteger(tile) || tile < 0 || tile >= BOMB_TILES) return res.status(400).json({ error: 'bad_request' });
    await withLock('b' + uid, async () => {
      const r = await BombRound.findOne({ tgId: uid, status: 'active' });
      if (!r) return res.status(409).json({ error: 'not_active' });
      if (r.picks.includes(tile)) return res.status(409).json({ error: 'already_picked' });
      const now = new Date();
      if (r.mines.includes(tile)) {
        const upd = await BombRound.updateOne({ _id: r._id, status: 'active' }, { $set: { status: 'lost', endedAt: now, prize: 0 } });
        if (!upd.modifiedCount) return res.status(409).json({ error: 'not_active' });
        await bombTrim(uid);
        const u = await User.findOne({ tgId: uid });
        return res.json({ result: 'bomb', tile, mines: r.mines, safe: r.safe, lost: r.entry, coins: u.coins });
      }
      const safe = r.safe + 1, mult = bombMult(r.bombs, safe), prize = bombPrize(r.entry, mult);
      const upd = await BombRound.updateOne({ _id: r._id, status: 'active', safe: r.safe }, { $set: { safe }, $addToSet: { picks: tile } });
      if (!upd.modifiedCount) return res.status(409).json({ error: 'not_active' });
      if (safe >= BOMB_TILES - r.bombs || mult >= CFG().games.bomb.maxMult) {   // every safe tile found, or the multiplier cap reached: cash out automatically
        const paid = await bombCashRound({ _id: r._id, tgId: uid, entry: r.entry, bombs: r.bombs, safe }, now);
        if (paid == null) return res.status(409).json({ error: 'not_active' });
        const u = await User.findOne({ tgId: uid });
        await bombTrim(uid);
        return res.json({ result: 'cleared', tile, safe, mult, prize: paid, net: paid - r.entry, entry: r.entry, mines: r.mines, coins: u.coins });
      }
      res.json({ result: 'safe', tile, safe, mult, prize, net: prize - r.entry, entry: r.entry, nextMult: bombMult(r.bombs, safe + 1) });
    });
  } catch (e) { fail(res, e); }
});

app.post('/api/bomb/cashout', auth, async (req, res) => {
  try {
    const uid = req.tg.id;
    await withLock('b' + uid, async () => {
      const r = await BombRound.findOne({ tgId: uid, status: 'active' });
      if (!r) return res.status(409).json({ error: 'not_active' });
      if (r.safe < 1) return res.status(400).json({ error: 'nothing_to_cash' });
      const prize = await bombCashRound({ _id: r._id, tgId: uid, entry: r.entry, bombs: r.bombs, safe: r.safe }, new Date());
      if (prize == null) return res.status(409).json({ error: 'not_active' });
      const u = await User.findOne({ tgId: uid });
      await bombTrim(uid);
      res.json({ result: 'cashed', prize, net: prize - r.entry, entry: r.entry, safe: r.safe, mult: bombMult(r.bombs, r.safe), mines: r.mines, coins: u.coins });
    });
  } catch (e) { fail(res, e); }
});

app.get('/api/bomb/history', auth, async (req, res) => {
  try {
    await bombPayPending(req.tg.id);
    const rows = await BombRound.find({ tgId: req.tg.id, status: { $ne: 'active' } }).sort({ endedAt: -1, createdAt: -1 }).limit(BOMB_HISTORY_MAX);
    const u = await User.findOne({ tgId: req.tg.id });
    res.json({ coins: u ? u.coins : 0, items: rows.map((r) => ({ id: String(r._id), entry: r.entry, bombs: r.bombs, safe: r.safe,
      result: r.status === 'cashed' ? 'win' : 'loss', prize: r.prize, net: r.status === 'cashed' ? r.prize - r.entry : -r.entry, at: (r.endedAt || r.createdAt).getTime() })) });
  } catch (e) { fail(res, e); }
});

// =====================================================================
//  LUCKY CARDS (solo, virtual coins only). 5 face-down cards, the player picks one.
//  The server shuffles the deck when the round starts; the client only sees the cards after the pick.
//  Card returns are percent of the bet (integers, so every prize is exact).
//  Expected return = (0 + 0 + 50 + 100 + 300) / 5 = 90% of the bet, so the house keeps a margin.
// =====================================================================
// bet sizes and card returns come from the admin settings: gold = 500 x (1 - edge) - 150 percent, so the expected return is exactly (1 - edge)
const luckyCards = () => settings.luckyCards(CFG().games.lucky);
const LUCKY_DECK = ['skull', 'skull', 'bronze', 'silver', 'gold'];
const LUCKY_HISTORY_MAX = 10;
const luckyPrize = (bet, kind) => Math.floor(bet * luckyCards()[kind] / 100);

const luckySchema = new mongoose.Schema({
  tgId: { type: Number, required: true },
  bet: Number,
  deck: [String],                               // secret until the round ends
  picked: { type: Number, default: -1 },
  status: { type: String, default: 'active' },  // active | done
  prize: { type: Number, default: 0 },          // total returned (bet included), 0 = skull
  unpaid: { type: Boolean, default: false },    // true only between "round closed" and "coins credited" (crash safety)
  createdAt: { type: Date, default: Date.now },
  endedAt: Date,
});
luckySchema.index({ tgId: 1, status: 1, createdAt: -1 });
const LuckyRound = mongoose.model('LuckyRound', luckySchema);

function luckyShuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const luckyView = (r) => ({ id: String(r._id), bet: r.bet, count: LUCKY_DECK.length, picked: r.picked, status: r.status,
  cards: r.status === 'done' ? r.deck : null, prize: r.prize, net: r.status === 'done' ? r.prize - r.bet : 0 });
async function luckyTrim(uid) {   // keep only the latest LUCKY_HISTORY_MAX finished rounds
  const old = await LuckyRound.find({ tgId: uid, status: 'done', unpaid: { $ne: true } }).sort({ endedAt: -1, createdAt: -1 }).skip(LUCKY_HISTORY_MAX).limit(50);
  if (old.length) await LuckyRound.deleteMany({ _id: { $in: old.map((r) => r._id) } });
}
// Credit a finished round. Safe to call many times: the coins are added exactly once.
async function luckyPay(roundId, uid, prize) {
  const g = await LuckyRound.updateOne({ _id: roundId, status: 'done', unpaid: true }, { $set: { unpaid: false } });
  if (!g.modifiedCount) return;
  try { await User.updateOne({ tgId: uid }, { $inc: { coins: prize } }); }
  catch (e) { await LuckyRound.updateOne({ _id: roundId }, { $set: { unpaid: true } }); throw e; }
  tx(uid, 'lucky_win', prize, null, roundId, 'lucky'); stat('lucky', 0, prize);
}
async function luckyPayPending(uid) {   // finishes any payout that was interrupted
  const rows = await LuckyRound.find({ tgId: uid, status: 'done', unpaid: true });
  for (const r of rows) await luckyPay(r._id, uid, r.prize);
}

app.get('/api/lucky/state', auth, async (req, res) => {
  try {
    await upsertUser(req.tg);
    await luckyPayPending(req.tg.id);
    const u = await User.findOne({ tgId: req.tg.id });
    const r = await LuckyRound.findOne({ tgId: req.tg.id, status: 'active' });
    res.json({ coins: u.coins, round: r ? luckyView(r) : null, tiers: CFG().games.lucky.tiers, cards: luckyCards(), rtp: settings.luckyRtp(CFG().games.lucky) });
  } catch (e) { fail(res, e); }
});

app.post('/api/lucky/play', auth, gameOn('lucky'), async (req, res) => {
  try {
    const uid = req.tg.id, bet = Number(req.body && req.body.bet);
    if (!CFG().games.lucky.tiers.includes(bet)) return res.status(400).json({ error: 'bad_request' });
    await withLock('l' + uid, async () => {
      await upsertUser(req.tg);
      await luckyPayPending(uid);
      const open = await LuckyRound.findOne({ tgId: uid, status: 'active' });
      if (open) return res.status(409).json({ error: 'round_active', round: luckyView(open) });
      const paid = await User.findOneAndUpdate({ tgId: uid, coins: { $gte: bet } }, { $inc: { coins: -bet } }, { new: true });
      if (!paid) return res.status(402).json({ error: 'not_enough_coins' });
      qualify(uid); tx(uid, 'lucky_bet', -bet, paid.coins, null, 'lucky'); stat('lucky', bet, 0);
      try {
        const r = await LuckyRound.create({ tgId: uid, bet, deck: luckyShuffle(LUCKY_DECK.slice()) });
        res.json({ coins: paid.coins, round: luckyView(r) });
      } catch (e) {
        await User.updateOne({ tgId: uid }, { $inc: { coins: bet } });   // never keep the bet if the round could not be created
        tx(uid, 'refund', bet, null, null, 'lucky'); stat('lucky', -bet, 0);
        throw e;
      }
    });
  } catch (e) { fail(res, e); }
});

app.post('/api/lucky/pick', auth, async (req, res) => {
  try {
    const uid = req.tg.id, index = Number(req.body && req.body.index);
    if (!Number.isInteger(index) || index < 0 || index >= LUCKY_DECK.length) return res.status(400).json({ error: 'bad_request' });
    await withLock('l' + uid, async () => {
      const r = await LuckyRound.findOne({ tgId: uid, status: 'active' });
      if (!r) return res.status(409).json({ error: 'not_active' });
      const kind = r.deck[index], prize = luckyPrize(r.bet, kind);
      const upd = await LuckyRound.updateOne({ _id: r._id, status: 'active' },
        { $set: { status: 'done', picked: index, prize, endedAt: new Date(), unpaid: prize > 0 } });
      if (!upd.modifiedCount) return res.status(409).json({ error: 'not_active' });
      if (prize > 0) {
        try { await luckyPay(r._id, uid, prize); }
        catch (e) { console.error('lucky payout pending, will retry', e); }   // stays unpaid; paid on the next state/play call
      }
      await luckyTrim(uid);
      const u = await User.findOne({ tgId: uid });
      const net = prize - r.bet;
      res.json({ result: net > 0 ? 'win' : net === 0 ? 'even' : 'lose', kind, picked: index, cards: r.deck,
        prize, net, bet: r.bet, coins: u.coins });
    });
  } catch (e) { fail(res, e); }
});

app.get('/api/lucky/history', auth, async (req, res) => {
  try {
    await luckyPayPending(req.tg.id);
    const rows = await LuckyRound.find({ tgId: req.tg.id, status: 'done' }).sort({ endedAt: -1, createdAt: -1 }).limit(LUCKY_HISTORY_MAX);
    const u = await User.findOne({ tgId: req.tg.id });
    res.json({ coins: u ? u.coins : 0, items: rows.map((r) => ({ id: String(r._id), bet: r.bet, kind: r.deck[r.picked],
      prize: r.prize, net: r.prize - r.bet, at: (r.endedAt || r.createdAt).getTime() })) });
  } catch (e) { fail(res, e); }
});

// =====================================================================
//  SLOT MACHINE (solo, virtual coins only). Rules live in server/slots_math.js.
//  The server draws 3 random stops, pays the win, and sends the stops back. The page only animates them.
// =====================================================================
const SlotMath = require('./slots_math');
// presets and the bet range come from the admin settings; the paytable is the built-in one scaled to the chosen edge (settings.slotPay)

const slotSchema = new mongoose.Schema({
  tgId: { type: Number, required: true },
  bet: Number,
  stops: [Number],                              // the 3 reel stops that were drawn
  mult: { type: Number, default: 0 },
  win: { type: Number, default: 0 },            // total returned (0 = no win)
  unpaid: { type: Boolean, default: false },    // true only between "spin resolved" and "coins credited" (crash safety)
  createdAt: { type: Date, default: Date.now },
});
slotSchema.index({ tgId: 1, createdAt: -1 });
const SlotSpin = mongoose.model('SlotSpin', slotSchema);

async function slotPay(spinId, uid, win) {   // safe to call again: credits exactly once
  const g = await SlotSpin.updateOne({ _id: spinId, unpaid: true }, { $set: { unpaid: false } });
  if (!g.modifiedCount) return;
  try { await User.updateOne({ tgId: uid }, { $inc: { coins: win } }); }
  catch (e) { await SlotSpin.updateOne({ _id: spinId }, { $set: { unpaid: true } }); throw e; }
  tx(uid, 'slots_win', win, null, spinId, 'slots'); stat('slots', 0, win);
}
async function slotPayPending(uid) {
  const rows = await SlotSpin.find({ tgId: uid, unpaid: true });
  for (const r of rows) await slotPay(r._id, uid, r.win);
}
const slotBetOk = (bet) => Number.isInteger(bet) && bet >= CFG().games.slots.min && bet <= CFG().games.slots.max;

app.get('/api/slots/state', auth, async (req, res) => {
  try {
    await upsertUser(req.tg);
    await slotPayPending(req.tg.id);
    const u = await User.findOne({ tgId: req.tg.id });
    const SG = CFG().games.slots;
    res.json({ coins: u.coins, presets: SG.presets, min: SG.min, max: SG.max,
      strips: SlotMath.STRIPS, paytable: settings.slotPay(SG) });
  } catch (e) { fail(res, e); }
});

app.post('/api/slots/spin', auth, gameOn('slots'), async (req, res) => {
  try {
    const uid = req.tg.id, bet = Number(req.body && req.body.bet);
    if (!slotBetOk(bet)) return res.status(400).json({ error: 'bad_request' });
    await withLock('s' + uid, async () => {
      await upsertUser(req.tg);
      await slotPayPending(uid);
      const paid = await User.findOneAndUpdate({ tgId: uid, coins: { $gte: bet } }, { $inc: { coins: -bet } }, { new: true });
      if (!paid) return res.status(402).json({ error: 'not_enough_coins' });
      qualify(uid); tx(uid, 'slots_bet', -bet, paid.coins, null, 'slots'); stat('slots', bet, 0);
      const stops = [0, 1, 2].map(() => crypto.randomInt(SlotMath.STRIP_LEN));
      const sym = SlotMath.evaluate(stops).sym;
      const mult = sym ? settings.slotPay(CFG().games.slots)[sym] : 0;       // multiplier in hundredths, so the win is exact
      const win = Math.floor(bet * Math.round(mult * 100) / 100);
      let row;
      try { row = await SlotSpin.create({ tgId: uid, bet, stops, mult, win, unpaid: win > 0 }); }
      catch (e) { await User.updateOne({ tgId: uid }, { $inc: { coins: bet } }); tx(uid, 'refund', bet, null, null, 'slots'); stat('slots', -bet, 0); throw e; }   // never keep the bet if the spin could not be saved
      if (win > 0) {
        try { await slotPay(row._id, uid, win); }
        catch (e) { console.error('slot payout pending, will retry', e); }
      }
      const u = await User.findOne({ tgId: uid });
      res.json({ coins: u.coins, bet, stops, reels: stops.map((s, r) => SlotMath.visible(r, s)),
        line: SlotMath.payline(stops), sym, mult, win, net: win - bet });
    });
  } catch (e) { fail(res, e); }
});


// =====================================================================
//  DAILY BONUS: 100 coins, once per calendar day (day = local midnight, see DAY_OFFSET_MIN)
// =====================================================================
app.get('/api/daily/state', auth, async (req, res) => {
  try {
    const u = await upsertUser(req.tg);
    res.json({ coins: u.coins, amount: CFG().limits.dailyBonus, available: u.lastDaily !== dayKey(), nextAt: nextDayAt() });
  } catch (e) { fail(res, e); }
});
app.post('/api/daily/claim', auth, async (req, res) => {
  try {
    const uid = req.tg.id;
    await upsertUser(req.tg);
    // one atomic update: it only matches while today's bonus has not been taken, so two taps can never pay twice
    const u = await User.findOneAndUpdate({ tgId: uid, lastDaily: { $ne: dayKey() } }, { $set: { lastDaily: dayKey() }, $inc: { coins: CFG().limits.dailyBonus } }, { new: true });
    if (!u) { const cur = await User.findOne({ tgId: uid }); return res.status(409).json({ error: 'already_claimed', coins: cur ? cur.coins : 0, nextAt: nextDayAt() }); }
    tx(uid, 'daily', CFG().limits.dailyBonus, u.coins);
    res.json({ amount: CFG().limits.dailyBonus, coins: u.coins, nextAt: nextDayAt() });
  } catch (e) { fail(res, e); }
});

// =====================================================================
//  SPIN WHEEL. The server picks the prize (the page only animates it).
//  1 free spin a day, then CFG().games.spin.cost coins. "free" prize = one more free spin.
//  Wheel order = clockwise from the top. Chances are per mille and do NOT depend on the wedge size.
// =====================================================================
const SPIN_WEDGES = [{ k: 'coins', v: 100 }, { k: 'try' }, { k: 'coins', v: 200 }, { k: 'free' }, { k: 'coins', v: 300 }, { k: 'try' }, { k: 'coins', v: 250 }, { k: 'coins', v: 500 }];
// odds (per mille) come from settings.spinOdds(): the wedge values are printed on the wheel, so the admin's edge changes the chances
const SPIN_ODDS_NOW = () => settings.spinOdds(CFG().games.spin);
// expected return per paid spin = (0.18*100 + 0.10*200 + 0.05*250 + 0.045*300 + 0.025*500) / (1 - 0.10 free) = 85 coins for a 100-coin spin
const spinSchema = new mongoose.Schema({
  tgId: { type: Number, required: true }, source: String, kind: String, amount: { type: Number, default: 0 }, wedge: Number,
  unpaid: { type: Boolean, default: false }, createdAt: { type: Date, default: Date.now },
});
spinSchema.index({ tgId: 1, createdAt: -1 });
const SpinLog = mongoose.model('SpinLog', spinSchema);
async function spinPay(rowId, uid, kind, amount) {   // credits exactly once, safe to call again
  const g = await SpinLog.updateOne({ _id: rowId, unpaid: true }, { $set: { unpaid: false } });
  if (!g.modifiedCount) return;
  const inc = kind === 'free' ? { freeSpins: 1 } : { coins: amount };
  try { await User.updateOne({ tgId: uid }, { $inc: inc }); }
  catch (e) { await SpinLog.updateOne({ _id: rowId }, { $set: { unpaid: true } }); throw e; }
  if (kind !== 'free') { tx(uid, 'spin_win', amount, null, rowId, 'spin'); stat('spin', 0, amount); }
}
async function spinPayPending(uid) {
  const rows = await SpinLog.find({ tgId: uid, unpaid: true });
  for (const r of rows) await spinPay(r._id, uid, r.kind, r.amount);
}
const spinView = (u) => ({ coins: u.coins, freeSpins: u.freeSpins || 0, freeAvailable: u.lastFreeSpin !== dayKey(), nextFreeAt: nextDayAt(), cost: CFG().games.spin.cost });
app.get('/api/spin/state', auth, async (req, res) => {
  try {
    await upsertUser(req.tg); await spinPayPending(req.tg.id);
    const u = await User.findOne({ tgId: req.tg.id });
    res.json({ ...spinView(u), wedges: SPIN_WEDGES });
  } catch (e) { fail(res, e); }
});
app.post('/api/spin/play', auth, gameOn('spin'), async (req, res) => {
  try {
    const uid = req.tg.id;
    await withLock('p' + uid, async () => {
      await upsertUser(req.tg); await spinPayPending(uid);
      let source = 'bonus';
      let u = await User.findOneAndUpdate({ tgId: uid, freeSpins: { $gt: 0 } }, { $inc: { freeSpins: -1 } }, { new: true });      // 1) a spin won earlier
      if (!u) {
        source = 'daily';
        u = await User.findOneAndUpdate({ tgId: uid, lastFreeSpin: { $ne: dayKey() } }, { $set: { lastFreeSpin: dayKey() } }, { new: true });   // 2) today's free spin
      }
      if (!u) {
        source = 'paid';
        u = await User.findOneAndUpdate({ tgId: uid, coins: { $gte: CFG().games.spin.cost } }, { $inc: { coins: -CFG().games.spin.cost } }, { new: true });           // 3) pay
        if (!u) return res.status(402).json({ error: 'not_enough_coins' });
        tx(uid, 'spin_cost', -CFG().games.spin.cost, u.coins, null, 'spin'); stat('spin', CFG().games.spin.cost, 0);
      }
      const undo = () => (source === 'paid' ? (tx(uid, 'refund', CFG().games.spin.cost, null, null, 'spin'), stat('spin', -CFG().games.spin.cost, 0), User.updateOne({ tgId: uid }, { $inc: { coins: CFG().games.spin.cost } }))
        : source === 'daily' ? User.updateOne({ tgId: uid }, { $set: { lastFreeSpin: '' } }) : User.updateOne({ tgId: uid }, { $inc: { freeSpins: 1 } }));
      let row, prize;
      try {
        const ODDS = SPIN_ODDS_NOW();
        let r = crypto.randomInt(1000); prize = ODDS[ODDS.length - 1];
        for (const o of ODDS) { if (r < o.w) { prize = o; break; } r -= o.w; }
        const slots = SPIN_WEDGES.map((w, i) => i).filter((i) => SPIN_WEDGES[i].k === prize.k && (prize.k !== 'coins' || SPIN_WEDGES[i].v === prize.v));
        const wedge = slots[crypto.randomInt(slots.length)];
        const amount = prize.k === 'coins' ? prize.v : 0;
        row = await SpinLog.create({ tgId: uid, source, kind: prize.k, amount, wedge, unpaid: prize.k !== 'try' });
        if (prize.k !== 'try') { try { await spinPay(row._id, uid, prize.k, amount); } catch (e) { console.error('spin payout pending, will retry', e); } }
        const me = await User.findOne({ tgId: uid });
        return res.json({ wedge, kind: prize.k, amount, source, ...spinView(me) });
      } catch (e) { if (!row) await undo(); throw e; }   // never keep the cost if the spin could not be saved
    });
  } catch (e) { fail(res, e); }
});

// =====================================================================
//  INVITES. Link = https://t.me/<bot>?start=inv_<your id>.
//  pending   = the friend opened the bot through your link
//  completed = the friend has added CFG().limits.inviteMinDeposit coins through approved top-ups (see depositMilestone())  -> you can claim CFG().limits.inviteReward once
// =====================================================================
app.get('/api/invites/state', auth, async (req, res) => {
  try {
    const uid = req.tg.id;
    const me = await upsertUser(req.tg);
    const kids = await User.find({ invitedBy: uid }).sort({ createdAt: -1 }).limit(200).select('tgId name createdAt qualifiedAt inviteClaimed depositTotal').lean();
    const pending = kids.filter((k) => !k.qualifiedAt).map((k) => ({ id: String(k.tgId), name: k.name, at: new Date(k.createdAt).getTime(), deposited: k.depositTotal || 0 }));
    const completed = kids.filter((k) => k.qualifiedAt).map((k) => ({ id: String(k.tgId), name: k.name, claimed: !!k.inviteClaimed, at: new Date(k.qualifiedAt).getTime() }));
    res.json({ coins: me.coins, reward: CFG().limits.inviteReward, minDeposit: CFG().limits.inviteMinDeposit, link: BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=inv_${uid}` : null, pending, completed });
  } catch (e) { fail(res, e); }
});
app.post('/api/invites/claim', auth, async (req, res) => {
  try {
    const uid = req.tg.id, kid = Number(req.body && req.body.id);
    if (!Number.isSafeInteger(kid)) return res.status(400).json({ error: 'bad_request' });
    await withLock('i' + uid, async () => {
      // the flag is flipped first, atomically, so a double tap can only pay once
      const g = await User.findOneAndUpdate({ tgId: kid, invitedBy: uid, qualifiedAt: { $ne: null }, inviteClaimed: { $ne: true } }, { $set: { inviteClaimed: true } });
      if (!g) return res.status(409).json({ error: 'nothing_to_claim' });
      let me;
      try { me = await User.findOneAndUpdate({ tgId: uid }, { $inc: { coins: CFG().limits.inviteReward } }, { new: true }); if (!me) throw new Error('no user'); }
      catch (e) { await User.updateOne({ tgId: kid }, { $set: { inviteClaimed: false } }); throw e; }
      tx(uid, 'invite', CFG().limits.inviteReward, me.coins, kid);
      res.json({ amount: CFG().limits.inviteReward, coins: me.coins });
    });
  } catch (e) { fail(res, e); }
});

// =====================================================================
//  RANKING (most coins). Names are masked on the server: the full name never leaves it.
// =====================================================================
let rankCache = { at: 0, rows: [] };
async function topRows() {
  if (Date.now() - rankCache.at < 15000) return rankCache.rows;
  const rows = await User.find({ nameLen: { $gt: 1 } }).sort({ coins: -1 }).limit(50).select('tgId name coins').lean();
  rankCache = { at: Date.now(), rows: rows.map((r, i) => ({ rank: i + 1, tg: r.tgId, name: maskName(r.name), coins: r.coins })) };
  return rankCache.rows;
}
app.get('/api/ranking', auth, async (req, res) => {
  try {
    const uid = req.tg.id;
    const me = await upsertUser(req.tg);
    const rows = await topRows();
    const rank = (await User.countDocuments({ nameLen: { $gt: 1 }, coins: { $gt: me.coins } })) + 1;
    res.json({ items: rows.map((r) => ({ rank: r.rank, name: r.name, coins: r.coins, me: r.tg === uid })),
      me: { rank, coins: me.coins, name: me.name, listed: me.nameLen > 1 } });
  } catch (e) { fail(res, e); }
});

// =====================================================================
//  PROFILE
// =====================================================================
app.get('/api/profile', auth, async (req, res) => {
  try {
    const uid = req.tg.id;
    const me = await upsertUser(req.tg);
    const [rank, invited, completed] = await Promise.all([
      User.countDocuments({ nameLen: { $gt: 1 }, coins: { $gt: me.coins } }).then((n) => n + 1),
      User.countDocuments({ invitedBy: uid }),
      User.countDocuments({ invitedBy: uid, qualifiedAt: { $ne: null } }),
    ]);
    res.json({ id: uid, name: me.name, username: me.username, coins: me.coins, hearts: me.hearts, rank, plays: me.plays || 0, invited, completed, since: new Date(me.createdAt).getTime() });
  } catch (e) { fail(res, e); }
});


// =====================================================================
//  HEARTS SHOP: hearts are bought with coins. One atomic update (coins -price, hearts +n), so it can never half-happen or be tapped twice.
// =====================================================================
app.get('/api/hearts/state', auth, async (req, res) => {
  try { const u = await upsertUser(req.tg); res.json({ coins: u.coins, hearts: u.hearts, packs: CFG().games.hearts.packs }); } catch (e) { fail(res, e); }
});
app.post('/api/hearts/buy', auth, gameOn('hearts'), async (req, res) => {
  try {
    const pack = CFG().games.hearts.packs.find((p) => p.n === Number(req.body && req.body.n));
    if (!pack) return res.status(400).json({ error: 'bad_pack' });
    await upsertUser(req.tg);
    const u = await User.findOneAndUpdate({ tgId: req.tg.id, coins: { $gte: pack.price } }, { $inc: { coins: -pack.price, hearts: pack.n } }, { new: true });
    if (!u) return res.status(402).json({ error: 'not_enough_coins' });
    tx(req.tg.id, 'hearts', -pack.price, u.coins, null, '', pack.n + ' hearts');
    res.json({ bought: pack.n, price: pack.price, coins: u.coins, hearts: u.hearts });
  } catch (e) { fail(res, e); }
});


// =====================================================================
//  WITHDRAW. The coins are taken from the balance when the request is sent (so they cannot be spent twice).
//  The admin of that platform (KPAY = admin 1, WAVE PAY = admin 2) gets a message with: Paid / Reject (rejecting gives the coins back).
// =====================================================================
const wdSchema = new mongoose.Schema({
  tgId: { type: Number, required: true }, admin: Number, platform: String, accountName: String, phone: String, coins: Number,
  status: { type: String, default: 'pending' },          // pending | paid | rejected | failed
  adminChat: Number, adminMsg: Number, createdAt: { type: Date, default: Date.now }, decidedAt: Date,
});
wdSchema.index({ tgId: 1, createdAt: -1 });
const Withdrawal = mongoose.model('Withdrawal', wdSchema);
const wdView = (w) => ({ id: String(w._id), platform: w.platform, coins: w.coins, status: w.status, at: new Date(w.createdAt).getTime() });
app.get('/api/withdraw/config', auth, async (req, res) => {
  try {
    const u = await upsertUser(req.tg);
    res.json({ min: CFG().limits.withdrawMin, coins: u.coins, platforms: [1, 2].map((n) => ({ key: String(n), label: ADMINS[n].pay.label, available: !!ADMINS[n].id })) });
  } catch (e) { fail(res, e); }
});
app.get('/api/withdraw/mine', auth, async (req, res) => {
  try { const rows = await Withdrawal.find({ tgId: req.tg.id, status: { $ne: 'failed' } }).sort({ createdAt: -1 }).limit(5); res.json({ items: rows.map(wdView) }); }
  catch (e) { fail(res, e); }
});
app.post('/api/withdraw/submit', auth, async (req, res) => {
  try {
    const uid = req.tg.id, b = req.body || {};
    const adm = ADMINS[Number(b.admin)];
    if (!adm || !adm.id) return res.status(503).json({ error: 'admin_unavailable' });
    const coins = Number(b.coins), name = clean(b.name, 64), phone = String(b.phone || '').replace(/[\s-]/g, '');
    if (!Number.isSafeInteger(coins) || coins < CFG().limits.withdrawMin) return res.status(400).json({ error: 'below_minimum' });
    if (!name) return res.status(400).json({ error: 'bad_name' });
    if (!/^\+?\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'bad_phone' });
    await withLock('wd' + uid, async () => {
      const me = await upsertUser(req.tg);
      if (await Withdrawal.countDocuments({ tgId: uid, status: 'pending' }) >= CFG().limits.maxPendingWithdrawals) return res.status(429).json({ error: 'too_many_pending' });
      const held = await User.findOneAndUpdate({ tgId: uid, coins: { $gte: coins } }, { $inc: { coins: -coins } }, { new: true });   // take the coins first
      if (!held) return res.status(402).json({ error: 'not_enough_coins' });
      tx(uid, 'withdraw_hold', -coins, held.coins);
      let w;
      try {
        w = await Withdrawal.create({ tgId: uid, admin: Number(adm.key), platform: adm.pay.label, accountName: name, phone, coins });
        const text = `💸 <b>Withdrawal request</b>\nPlayer: ${escHtml(me.name)}${me.username ? ' (@' + escHtml(me.username) + ')' : ''}\nTelegram ID: <code>${uid}</code>\nPlatform: <b>${escHtml(adm.pay.label)}</b>\nAccount name: <b>${escHtml(name)}</b>\nPhone: <code>${escHtml(phone)}</code>\nCoins: <b>${coins}</b>\nRequest: <code>${w._id}</code>`;
        const sent = await withTimeout(bot.telegram.sendMessage(adm.id, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Paid', callback_data: 'wd:paid:' + w._id }, { text: '❌ Reject (refund)', callback_data: 'wd:no:' + w._id }]] } }), 20000);
        await Withdrawal.updateOne({ _id: w._id }, { $set: { adminChat: sent.chat.id, adminMsg: sent.message_id } });
      } catch (e) {
        console.error('withdraw: admin not reachable:', e && e.message);
        if (w) await Withdrawal.updateOne({ _id: w._id }, { $set: { status: 'failed' } }).catch(() => {});
        await User.updateOne({ tgId: uid }, { $inc: { coins } });          // give the coins back
        tx(uid, 'withdraw_refund', coins);
        return res.status(e && e.message === 'timeout' ? 504 : 502).json({ error: 'admin_unreachable' });
      }
      res.json({ ok: true, id: String(w._id), coins: held.coins });
    });
  } catch (e) { fail(res, e); }
});
async function settleWithdrawal(id, status) {                                // pending -> paid / rejected exactly once; a rejection returns the coins
  const w = await Withdrawal.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status, decidedAt: new Date() } }, { new: true });
  if (!w) return null;
  if (status === 'rejected') {
    try { await User.updateOne({ tgId: w.tgId }, { $inc: { coins: w.coins } }); }
    catch (e) { await Withdrawal.updateOne({ _id: w._id }, { $set: { status: 'pending' } }); throw e; }
    tx(w.tgId, 'withdraw_refund', w.coins, null, w._id);
  }
  return w;
}
async function afterWithdrawal(done, act) {   // update the admin message and tell the player (used by the Telegram buttons and the admin panel)
  const line = act === 'paid' ? `✅ <b>Paid</b>: ${done.coins} coins` : `❌ <b>Rejected</b>: ${done.coins} coins returned to the player`;
  try {
    await bot.telegram.editMessageReplyMarkup(done.adminChat, done.adminMsg, undefined, { inline_keyboard: [] });
    await bot.telegram.editMessageText(done.adminChat, done.adminMsg, undefined, `${line}\nPlayer ID: <code>${done.tgId}</code>\nPlatform: ${escHtml(done.platform)}\nAccount: ${escHtml(done.accountName)} / ${escHtml(done.phone)}`, { parse_mode: 'HTML' });
  } catch (e) { /* message too old */ }
  if (act === 'paid') notify(done.tgId, `✅ Your withdrawal of ${done.coins} coins has been paid to your ${done.platform} account.\nသင့် ${done.platform} အကောင့်သို့ coins ${done.coins} ငွေထုတ်ပေးပြီးပါပြီ။`);
  else notify(done.tgId, `❌ Your withdrawal was rejected and ${done.coins} coins were returned to your balance.\nသင့်ငွေထုတ်တောင်းဆိုမှုကို ပယ်ချပြီး coins ${done.coins} ကို ပြန်လည်ထည့်ပေးလိုက်ပါပြီ။`);
}
bot.action(/^wd:(paid|no):([a-f0-9]{24})$/, async (ctx) => {
  try {
    const [, act, id] = ctx.match;
    const w = await Withdrawal.findById(id);
    if (!adminOk(w, ctx.from.id)) return ctx.answerCbQuery('Not allowed', { show_alert: true });
    if (w.status !== 'pending') return ctx.answerCbQuery('Already handled');
    const done = await settleWithdrawal(id, act === 'paid' ? 'paid' : 'rejected');
    if (!done) return ctx.answerCbQuery('Already handled');
    await ctx.answerCbQuery(act === 'paid' ? 'Marked as paid' : 'Rejected, coins returned');
    await afterWithdrawal(done, act === 'paid' ? 'paid' : 'no');
  } catch (e) { console.error('withdraw action failed', e); ctx.answerCbQuery('Error').catch(() => {}); }
});

// =====================================================================
//  AVATAR: the player's own Telegram picture, shrunk to a tiny webp (see store.js). 204 = no picture, the page keeps its default.
// =====================================================================
app.get('/api/avatar', auth, async (req, res) => {
  try {
    const a = await store.avatarFor(bot, req.tg);
    if (!a) return res.sendStatus(204);
    res.set({ 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=3600' }).send(a.data);
  } catch (e) { console.error('avatar failed', e && e.message); res.sendStatus(204); }
});

// Express error handler (bad JSON etc.) so nothing leaks a stack trace or hangs
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (res.headersSent) return;
  res.status(err && err.status === 400 ? 400 : 500).json({ error: err && err.status === 400 ? 'bad_request' : 'server_error' });
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

async function main() {
  await db.connectAll();
  await settings.load(mongoose);
  db.setFullPct(CFG().storage.fullPct);
  (await User.find({ banned: true }).select('tgId').lean()).forEach((u) => banned.add(u.tgId));
  await db.stats(true).catch(() => {});
  require('./admin').mount({ app, bot, express, auth: { verifyInitData, isAdmin, banned, adminIds: () => [...ADMIN_IDS] }, models: { User, Match, Deposit, Withdrawal, BombRound, LuckyRound, SlotSpin }, settings, store, db,
    helpers: { settleDeposit, afterDecision, settleWithdrawal, afterWithdrawal, notify, escHtml, dayKey, withLock, fail } });
  User.collection.createIndex({ nameLen: 1, coins: -1 }).catch((e) => console.error('index', e));
  User.collection.createIndex({ invitedBy: 1, createdAt: -1 }, { sparse: true }).catch((e) => console.error('index', e));
  bot.telegram.getMe().then((me) => { if (!BOT_USERNAME) BOT_USERNAME = me.username || ''; }).catch((e) => console.error('getMe failed', e));
  if (RENDER_EXTERNAL_URL) {
    const path = '/tg/' + crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 24);
    app.use(bot.webhookCallback(path));
    await bot.telegram.setWebhook(RENDER_EXTERNAL_URL + path);
  } else {
    bot.launch();
  }
  app.listen(PORT, () => console.log('Server on', PORT));
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { BombRound, bombPrize, bombMult, app, User, Match, slotInfo, pruneHistory, completeMatch, verifyInitData, WAIT_MAX, HISTORY_MAX };
