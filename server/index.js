const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { Telegraf, Markup } = require('telegraf');

const { BOT_TOKEN, WEBAPP_URL, MONGODB_URI, RENDER_EXTERNAL_URL } = process.env;
const PORT = process.env.PORT || 3000;
if (!BOT_TOKEN || !WEBAPP_URL || !MONGODB_URI) {
  console.error('Missing BOT_TOKEN, WEBAPP_URL or MONGODB_URI'); process.exit(1);
}

// ---------- Game constants ----------
const FEE = 500;                 // entry fee (virtual coins)
const PRIZE = 900;               // winner prize
const CLAIM_MS = 10 * 60 * 1000; // prize can be claimed 10 min after the match is decided
const STALE_MS = 15 * 60 * 1000; // a run that never reports back is treated as forfeited
const SWEEP_MS = 30 * 1000;      // how often the stale-run sweep may hit the database
const START_COINS = 2500, START_HEARTS = 2;   // new users only
const WAIT_MAX = 5;              // max "slots" a player may have open (waiting matches + prizes not yet claimed)
const HISTORY_MAX = 10;          // history rows kept per player; the oldest finished row is deleted when an 11th arrives

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
  coins: { type: Number, default: START_COINS },
  hearts: { type: Number, default: START_HEARTS },
  createdAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
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
function verifyInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  let user = null;
  try { user = JSON.parse(params.get('user')); } catch { return null; }
  if (!user || !Number.isSafeInteger(Number(user.id))) return null;
  user.id = Number(user.id);
  return user;
}
function auth(req, res, next) {
  const u = verifyInitData(String(req.get('x-init-data') || ''));
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.tg = u; next();
}

// Everything Telegram tells us about the player is stored: numeric id + @username + names.
function identity(tgUser) {
  const firstName = String(tgUser.first_name || '').trim().slice(0, 64);
  const lastName = String(tgUser.last_name || '').trim().slice(0, 64);
  const username = String(tgUser.username || '').trim().replace(/^@/, '').slice(0, 64);
  const name = ([firstName, lastName].filter(Boolean).join(' ') || username || 'Player').slice(0, 32);
  return { firstName, lastName, username, usernameLower: username.toLowerCase(), name,
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
bot.start((ctx) => {
  if (ctx.from && !ctx.from.is_bot) upsertUser(ctx.from).catch((e) => console.error('upsert on /start failed', e));
  return ctx.reply('ကြိုဆိုပါတယ်', Markup.inlineKeyboard([Markup.button.webApp('ဂိမ်းထဲဝင်ရန်', WEBAPP_URL)]));
});
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
    if (g.modifiedCount) await User.updateOne({ tgId: m[s].user }, { $inc: { coins: prize } });
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
const prizeFor = (r) => (r === 'win' ? PRIZE : r === 'draw' ? FEE : 0);

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
    const msg = r.a === 'win' ? `Fly & Dodge: you WON ${upd.a.score} - ${bForfeit ? 0 : bScore}! Claim ${PRIZE} coins in History after 10 minutes.`
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
app.use(express.json({ limit: '10kb' }));
app.get('/', (_, res) => res.send('Play2Win server OK'));

const fail = (res, e) => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'server_error' }); };

app.post('/api/auth', async (req, res) => {
  try {
    const tgUser = verifyInitData(String((req.body && req.body.initData) || ''));
    if (!tgUser) return res.status(401).json({ error: 'invalid initData' });
    const u = await upsertUser(tgUser);
    const slots = await slotInfo(tgUser.id);
    res.json({ name: u.name, username: u.username, coins: u.coins, hearts: u.hearts, ...slots });
  } catch (e) { fail(res, e); }
});

// Start a run: check the slot limit, charge the entry fee, then join someone's saved score or open a new match.
app.post('/api/duel/start', auth, async (req, res) => {
  try {
    const uid = req.tg.id;
    await withLock('u' + uid, async () => {
      const user = await upsertUser(req.tg);
      await sweep();
      await forfeitActive(uid);

      const slots = await slotInfo(uid);
      if (slots.blocked) return res.status(403).json({ error: slots.reason, ...slots });

      const paid = await User.findOneAndUpdate({ tgId: uid, coins: { $gte: FEE } }, { $inc: { coins: -FEE } }, { new: true });
      if (!paid) return res.status(402).json({ error: 'not_enough_coins' });

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
        await User.updateOne({ tgId: uid }, { $inc: { coins: FEE } });   // refund if matching failed
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
    const slots = await slotInfo(uid);
    res.json({ coins: u.coins, ...slots });
  } catch (e) { fail(res, e); }
});


// =====================================================================
//  BOMB POINTS (solo, virtual coins only). The server owns the bombs, the client only sees tiles it picked.
// =====================================================================
const BOMB_ENTRIES = [1000, 2000, 5000, 15000];
const BOMB_MIN = 3, BOMB_MAX = 15, BOMB_TILES = 16;
const BOMB_LADDER = [1.2, 1.25, 1.35, 1.4, 1.5, 1.8, 2, 2.5, 3, 3.5, 4, 4.6, 5];   // not selectable: it just rises with each safe pick
const BOMB_HISTORY_MAX = 10;
// bombs=3 starts at 1.2x, 4 at 1.25x, 5 at 1.35x ...; every further safe pick climbs one step (capped at 5x)
const bombMult = (bombs, safe) => safe < 1 ? 1 : BOMB_LADDER[Math.min(BOMB_LADDER.length - 1, bombs - BOMB_MIN + safe - 1)];
const bombPrize = (entry, mult) => Math.floor(entry * mult);

const BombRound = mongoose.model('BombRound', new mongoose.Schema({
  tgId: { type: Number, required: true },
  entry: Number, bombs: Number,
  mines: [Number],                              // secret until the round ends
  picks: [Number],                              // safe tiles already revealed
  safe: { type: Number, default: 0 },
  status: { type: String, default: 'active' },  // active | cashed | lost
  prize: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  endedAt: Date,
}));
BombRound.collection.createIndex({ tgId: 1, status: 1, createdAt: -1 }).catch(() => {});

function bombShuffle(n, k) {   // k distinct random tiles out of n, cryptographically random
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k).sort((x, y) => x - y);
}
const bombView = (r) => ({ id: String(r._id), entry: r.entry, bombs: r.bombs, picks: r.picks, safe: r.safe,
  mult: bombMult(r.bombs, r.safe), prize: r.safe ? bombPrize(r.entry, bombMult(r.bombs, r.safe)) : 0,
  nextMult: bombMult(r.bombs, r.safe + 1) });
async function bombTrim(uid) {   // keep only the latest BOMB_HISTORY_MAX finished rounds (oldest are deleted)
  const old = await BombRound.find({ tgId: uid, status: { $ne: 'active' } }).sort({ endedAt: -1, createdAt: -1 }).skip(BOMB_HISTORY_MAX).limit(50);
  if (old.length) await BombRound.deleteMany({ _id: { $in: old.map((r) => r._id) } });
}

app.get('/api/bomb/state', auth, async (req, res) => {
  try {
    const u = await upsertUser(req.tg);
    const r = await BombRound.findOne({ tgId: req.tg.id, status: 'active' });
    res.json({ coins: u.coins, round: r ? bombView(r) : null });
  } catch (e) { fail(res, e); }
});

app.post('/api/bomb/start', auth, async (req, res) => {
  try {
    const uid = req.tg.id, entry = Number(req.body && req.body.entry), bombs = Number(req.body && req.body.bombs);
    if (!BOMB_ENTRIES.includes(entry) || !Number.isInteger(bombs) || bombs < BOMB_MIN || bombs > BOMB_MAX) return res.status(400).json({ error: 'bad_request' });
    await withLock('b' + uid, async () => {
      await upsertUser(req.tg);
      const open = await BombRound.findOne({ tgId: uid, status: 'active' });
      if (open) return res.status(409).json({ error: 'round_active', round: bombView(open) });
      const paid = await User.findOneAndUpdate({ tgId: uid, coins: { $gte: entry } }, { $inc: { coins: -entry } }, { new: true });
      if (!paid) return res.status(402).json({ error: 'not_enough_coins' });
      try {
        const r = await BombRound.create({ tgId: uid, entry, bombs, mines: bombShuffle(BOMB_TILES, bombs) });
        res.json({ coins: paid.coins, round: bombView(r) });
      } catch (e) {
        await User.updateOne({ tgId: uid }, { $inc: { coins: entry } });   // never keep the fee if the round could not be created
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
      if (safe >= BOMB_TILES - r.bombs) {   // every safe tile found: cash out automatically
        const done = await BombRound.updateOne({ _id: r._id, status: 'active' }, { $set: { status: 'cashed', endedAt: now, prize } });
        if (!done.modifiedCount) return res.status(409).json({ error: 'not_active' });
        const u = await User.findOneAndUpdate({ tgId: uid }, { $inc: { coins: prize } }, { new: true });
        await bombTrim(uid);
        return res.json({ result: 'cleared', tile, safe, mult, prize, mines: r.mines, coins: u.coins });
      }
      res.json({ result: 'safe', tile, safe, mult, prize, nextMult: bombMult(r.bombs, safe + 1) });
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
      const prize = bombPrize(r.entry, bombMult(r.bombs, r.safe));
      const upd = await BombRound.updateOne({ _id: r._id, status: 'active' }, { $set: { status: 'cashed', endedAt: new Date(), prize } });
      if (!upd.modifiedCount) return res.status(409).json({ error: 'not_active' });
      const u = await User.findOneAndUpdate({ tgId: uid }, { $inc: { coins: prize } }, { new: true });
      await bombTrim(uid);
      res.json({ result: 'cashed', prize, safe: r.safe, mult: bombMult(r.bombs, r.safe), mines: r.mines, coins: u.coins });
    });
  } catch (e) { fail(res, e); }
});

app.get('/api/bomb/history', auth, async (req, res) => {
  try {
    const rows = await BombRound.find({ tgId: req.tg.id, status: { $ne: 'active' } }).sort({ endedAt: -1, createdAt: -1 }).limit(BOMB_HISTORY_MAX);
    const u = await User.findOne({ tgId: req.tg.id });
    res.json({ coins: u ? u.coins : 0, items: rows.map((r) => ({ id: String(r._id), entry: r.entry, bombs: r.bombs, safe: r.safe,
      result: r.status === 'cashed' ? 'win' : 'loss', prize: r.prize, at: (r.endedAt || r.createdAt).getTime() })) });
  } catch (e) { fail(res, e); }
});

// Express error handler (bad JSON etc.) so nothing leaks a stack trace or hangs
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (res.headersSent) return;
  res.status(err && err.status === 400 ? 400 : 500).json({ error: err && err.status === 400 ? 'bad_request' : 'server_error' });
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

async function main() {
  await mongoose.connect(MONGODB_URI);
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

module.exports = { BombRound, bombMult, app, User, Match, slotInfo, pruneHistory, completeMatch, verifyInitData, WAIT_MAX, HISTORY_MAX };
