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
const START_COINS = 2500, START_HEARTS = 10;

// ---------- Database ----------
const User = mongoose.model('User', new mongoose.Schema({
  tgId: { type: Number, unique: true, index: true },
  name: String,
  username: String,
  coins: { type: Number, default: START_COINS },
  hearts: { type: Number, default: START_HEARTS },
  createdAt: { type: Date, default: Date.now },
}));

const side = () => ({
  user: Number, name: String, score: Number,
  status: String,                       // playing | done | forfeit
  startedAt: Date, finishedAt: Date,
  result: String,                       // win | loss | draw
  prize: { type: Number, default: 0 },
  claimed: { type: Boolean, default: false },
});
const Match = mongoose.model('Match', new mongoose.Schema({
  status: { type: String, default: 'open', index: true },   // open | complete | dead
  createdAt: { type: Date, default: Date.now, index: true },
  completedAt: Date,
  claimAt: Date,
  a: side(),   // first player: plays "blind", sets the score to beat
  b: side(),   // second player: plays against a's saved score. One match = exactly two players.
}));

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
  if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}
function auth(req, res, next) {
  const u = verifyInitData(String(req.get('x-init-data') || ''));
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.tg = u; next();
}
async function upsertUser(tgUser) {
  return User.findOneAndUpdate(
    { tgId: tgUser.id },
    { $set: { name: tgUser.first_name || 'Player', username: tgUser.username || '' }, $setOnInsert: { tgId: tgUser.id } },
    { upsert: true, new: true }
  );
}

// ---------- Bot ----------
const bot = new Telegraf(BOT_TOKEN);
bot.start((ctx) =>
  ctx.reply('ကြိုဆိုပါတယ်', Markup.inlineKeyboard([Markup.button.webApp('ဂိမ်းထဲဝင်ရန်', WEBAPP_URL)]))
);
const notify = (tgId, text) => bot.telegram.sendMessage(tgId, text).catch(() => {});

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
  }
  return upd;
}

// Runs that were started but never reported (app closed) count as forfeits.
async function sweep() {
  const lim = new Date(Date.now() - STALE_MS);
  await Match.updateMany({ status: 'open', 'a.status': 'playing', 'a.startedAt': { $lt: lim } },
                         { $set: { status: 'dead', 'a.status': 'forfeit', 'a.score': 0 } });
  const stale = await Match.find({ status: 'open', 'a.status': 'done', 'b.status': 'playing', 'b.startedAt': { $lt: lim } });
  for (const m of stale) await completeMatch(m, 0, true);
}
// Starting a new run while an old one is still "playing" = the old one was abandoned -> forfeit it.
async function forfeitActive(uid) {
  const asA = await Match.findOneAndUpdate({ status: 'open', 'a.user': uid, 'a.status': 'playing' },
                                           { $set: { status: 'dead', 'a.status': 'forfeit', 'a.score': 0 } });
  if (asA) return;
  const asB = await Match.findOne({ status: 'open', 'b.user': uid, 'b.status': 'playing' });
  if (asB) await completeMatch(asB, 0, true);
}

// ---------- API ----------
const app = express();
app.use(cors({ origin: WEBAPP_URL.replace(/\/$/, ''), allowedHeaders: ['Content-Type', 'x-init-data'] }));
app.use(express.json());
app.get('/', (_, res) => res.send('Play2Win server OK'));

app.post('/api/auth', async (req, res) => {
  const tgUser = verifyInitData(String(req.body.initData || ''));
  if (!tgUser) return res.status(401).json({ error: 'invalid initData' });
  const u = await upsertUser(tgUser);
  res.json({ name: u.name, coins: u.coins, hearts: u.hearts });
});

// Start a run: charge the entry fee, then join someone's saved score or open a new match.
app.post('/api/duel/start', auth, async (req, res) => {
  try {
    const uid = req.tg.id;
    const user = await upsertUser(req.tg);
    await sweep();
    await forfeitActive(uid);

    const paid = await User.findOneAndUpdate({ tgId: uid, coins: { $gte: FEE } }, { $inc: { coins: -FEE } }, { new: true });
    if (!paid) return res.status(402).json({ error: 'not_enough_coins' });

    try {
      const now = new Date();
      // a match is used once: it needs a finished "a", an empty "b", and "a" must be someone else
      const joined = await Match.findOneAndUpdate(
        { status: 'open', 'b.user': null, 'a.status': 'done', 'a.user': { $ne: uid } },
        { $set: { 'b.user': uid, 'b.name': user.name, 'b.status': 'playing', 'b.startedAt': now, 'b.claimed': false } },
        { sort: { createdAt: 1 }, new: true }
      );
      if (joined) {
        return res.json({ matchId: String(joined._id), seed: String(joined._id), role: 'b',
                          opponent: { name: joined.a.name, score: joined.a.score }, coins: paid.coins });
      }
      const m = await Match.create({ a: { user: uid, name: user.name, status: 'playing', startedAt: now } });
      res.json({ matchId: String(m._id), seed: String(m._id), role: 'a', opponent: null, coins: paid.coins });
    } catch (e) {
      await User.updateOne({ tgId: uid }, { $inc: { coins: FEE } });   // refund if matching failed
      throw e;
    }
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
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
    if (forfeit) score = 0;

    if (role === 'a') {
      const upd = await Match.findOneAndUpdate({ _id: m._id, 'a.status': 'playing' },
        { $set: { 'a.score': score, 'a.status': forfeit ? 'forfeit' : 'done', 'a.finishedAt': new Date(), ...(forfeit ? { status: 'dead' } : {}) } });
      if (!upd) return res.status(409).json({ error: 'not_active' });
      const u = await User.findOne({ tgId: uid });
      return res.json({ result: forfeit ? 'forfeit' : 'waiting', myScore: score, coins: u.coins });
    }
    const done = await completeMatch(m, score, forfeit);
    if (!done) return res.status(409).json({ error: 'not_active' });
    const u = await User.findOne({ tgId: uid });
    res.json({ result: forfeit ? 'forfeit' : done.b.result, myScore: score, oppScore: done.a.score,
               prize: done.b.prize, claimAt: done.claimAt.getTime(), coins: u.coins });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// History list
app.get('/api/duel/history', auth, async (req, res) => {
  try {
    const uid = req.tg.id;
    await sweep();
    const u = await upsertUser(req.tg);
    const ms = await Match.find({ $or: [{ 'a.user': uid }, { 'b.user': uid }], status: { $in: ['open', 'complete'] } })
                          .sort({ createdAt: -1 }).limit(60);
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
    res.json({ items, coins: u.coins });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// Claim a prize (only after the 10-minute timer, only once)
app.post('/api/duel/claim', auth, async (req, res) => {
  try {
    const uid = req.tg.id;
    if (!mongoose.isValidObjectId(req.body.matchId)) return res.status(400).json({ error: 'bad_match' });
    const m = await Match.findById(req.body.matchId);
    if (!m || m.status !== 'complete') return res.status(404).json({ error: 'not_found' });
    const mine = m.a.user === uid ? 'a' : m.b.user === uid ? 'b' : null;
    if (!mine) return res.status(403).json({ error: 'forbidden' });
    const prize = m[mine].prize;
    if (!prize) return res.status(400).json({ error: 'nothing' });
    if (Date.now() < m.claimAt.getTime()) return res.status(425).json({ error: 'too_early' });
    const upd = await Match.updateOne({ _id: m._id, [`${mine}.claimed`]: { $ne: true } }, { $set: { [`${mine}.claimed`]: true } });
    if (!upd.modifiedCount) return res.status(409).json({ error: 'already_claimed' });
    const u = await User.findOneAndUpdate({ tgId: uid }, { $inc: { coins: prize } }, { new: true });
    res.json({ coins: u.coins });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

(async () => {
  await mongoose.connect(MONGODB_URI);
  if (RENDER_EXTERNAL_URL) {
    const path = '/tg/' + crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 24);
    app.use(bot.webhookCallback(path));
    await bot.telegram.setWebhook(RENDER_EXTERNAL_URL + path);
  } else {
    bot.launch();
  }
  app.listen(PORT, () => console.log('Server on', PORT));
})();
