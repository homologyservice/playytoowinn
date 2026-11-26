// Admin API. Everything here needs a Telegram login (initData, max 1 hour old) from an admin id (ADMIN_ID / ADMIN1_ID / ADMIN2_ID / ADMIN_IDS).
// The panel itself is web/admin.html, opened from the bot with /adminlogin.
const mongoose = require('mongoose');

function mount({ app, bot, express, auth: A, models: M, settings, store, db, helpers: H }) {
  const { User, Deposit, Withdrawal } = M;
  const { Ledger, HouseStat, AdminLog, audit } = store;
  const CFG = settings.get;
  const r = express.Router();

  // ---- admin login check ----
  r.use((req, res, next) => {
    const u = A.verifyInitData(String(req.get('x-init-data') || ''), 3600);
    if (!u) return res.status(401).json({ error: 'unauthorized' });
    if (!A.isAdmin(u.id)) { console.warn('admin api: refused', u.id); return res.status(403).json({ error: 'forbidden' }); }
    req.admin = { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id) };
    next();
  });
  r.use(express.json({ limit: '20kb' }));
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (e && e.message && /^(bad_|bomb_|slots_|deposit_)/.test(e.message)) return res.status(400).json({ error: e.message }); H.fail(res, e); } };
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const day = (n) => H.dayKey(Date.now() - n * 86400000);

  // ---- overview / house pool ----
  r.get('/overview', wrap(async (req, res) => {
    const since = new Date(Date.now() - 86400000), startToday = new Date(Date.now() - (Date.now() + 390 * 60000) % 86400000);
    const [users, newToday, active, coinsAgg, pdep, pwd, depAgg, wdAgg, hs, dbs, banned] = await Promise.all([
      User.estimatedDocumentCount(), User.countDocuments({ createdAt: { $gte: startToday } }), User.countDocuments({ lastSeenAt: { $gte: since } }),
      User.aggregate([{ $group: { _id: null, coins: { $sum: '$coins' }, hearts: { $sum: '$hearts' } } }]),
      Deposit.countDocuments({ status: 'pending' }), Withdrawal.countDocuments({ status: 'pending' }),
      Deposit.aggregate([{ $match: { status: 'approved' } }, { $group: { _id: { $cond: [{ $gte: ['$decidedAt', startToday] }, 'today', 'all'] }, n: { $sum: 1 }, coins: { $sum: '$finalAmount' } } }]),
      Withdrawal.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: { $cond: [{ $gte: ['$decidedAt', startToday] }, 'today', 'all'] }, n: { $sum: 1 }, coins: { $sum: '$coins' } } }]),
      HouseStat.find({ day: { $gte: day(30) } }).lean(), db.stats(), User.countDocuments({ banned: true }),
    ]);
    const sum = (rows) => { const o = { today: 0, all: 0, todayN: 0, allN: 0 }; rows.forEach((x) => { if (x._id === 'today') { o.today = x.coins; o.todayN = x.n; } o.all += x.coins; o.allN += x.n; }); return o; };
    const games = {}, today = H.dayKey(), d7 = day(6);
    for (const g of Object.keys(CFG().games)) games[g] = { today: { plays: 0, wagered: 0, paid: 0 }, d7: { plays: 0, wagered: 0, paid: 0 }, d30: { plays: 0, wagered: 0, paid: 0 } };
    hs.forEach((x) => { const t = games[x.game]; if (!t) return; for (const [k, ok] of [['today', x.day === today], ['d7', x.day >= d7], ['d30', true]]) if (ok) { t[k].plays += x.plays; t[k].wagered += x.wagered; t[k].paid += x.paid; } });
    res.json({ users, newToday, active24h: active, banned, coinsInCirculation: (coinsAgg[0] || {}).coins || 0, heartsInCirculation: (coinsAgg[0] || {}).hearts || 0,
      pendingDeposits: pdep, pendingWithdrawals: pwd, deposits: sum(depAgg), withdrawals: sum(wdAgg), games, db: dbs, settings: CFG(), derived: settings.derived(), sharp: store.hasSharp() });
  }));

  // ---- settings ----
  r.get('/settings', wrap(async (req, res) => res.json({ settings: CFG(), defaults: settings.DEFAULTS, derived: settings.derived() })));
  r.post('/settings', wrap(async (req, res) => {
    const before = JSON.stringify(CFG());
    const clean = await settings.save(req.body || {}, req.admin);
    db.setFullPct(CFG().storage.fullPct);
    audit(req.admin, 'settings', JSON.stringify(clean));
    res.json({ ok: true, changed: before !== JSON.stringify(CFG()), settings: CFG(), derived: settings.derived() });
  }));

  // ---- users ----
  const userView = (u) => ({ tgId: u.tgId, name: u.name, username: u.username, coins: u.coins, hearts: u.hearts, plays: u.plays || 0, depositTotal: u.depositTotal || 0,
    banned: !!u.banned, banReason: u.banReason || '', premium: !!u.isPremium, lang: u.languageCode, invitedBy: u.invitedBy || null, freeSpins: u.freeSpins || 0, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt });
  r.get('/users', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().replace(/^@/, ''), sort = { coins: { coins: -1 }, new: { createdAt: -1 }, seen: { lastSeenAt: -1 }, plays: { plays: -1 }, dep: { depositTotal: -1 } }[req.query.sort] || { lastSeenAt: -1 };
    const f = {};
    if (req.query.banned === '1') f.banned = true;
    if (q) { const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); f.$or = [{ usernameLower: new RegExp('^' + esc.toLowerCase()) }, { name: new RegExp(esc, 'i') }]; if (/^\d{3,15}$/.test(q)) f.$or.push({ tgId: Number(q) }); }
    const page = Math.max(0, num(req.query.page, 0)), size = 25;
    const [rows, total] = await Promise.all([User.find(f).sort(sort).skip(page * size).limit(size).lean(), User.countDocuments(f)]);
    res.json({ total, page, size, items: rows.map(userView) });
  }));
  r.get('/users/:id', wrap(async (req, res) => {
    const id = Number(req.params.id); if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'bad_id' });
    const u = await User.findOne({ tgId: id }).lean(); if (!u) return res.status(404).json({ error: 'not_found' });
    const [ledger, deps, wds, kids] = await Promise.all([
      Ledger.find({ tgId: id }, { sort: { at: -1 }, limit: 60 }),
      Deposit.find({ tgId: id, status: { $ne: 'failed' } }).sort({ createdAt: -1 }).limit(10).lean(),
      Withdrawal.find({ tgId: id, status: { $ne: 'failed' } }).sort({ createdAt: -1 }).limit(10).lean(),
      User.countDocuments({ invitedBy: id }),
    ]);
    const net = ledger.filter((x) => /_(bet|win|cost)$|^duel_/.test(x.type)).reduce((a, x) => a + x.delta, 0);
    res.json({ user: userView(u), invited: kids, ledger: ledger.map((x) => ({ type: x.type, game: x.game, delta: x.delta, bal: x.bal, note: x.note, at: x.at, db: x._db })),
      gameNetLast60: net, deposits: deps.map((d) => ({ id: String(d._id), amount: d.finalAmount || d.amount, status: d.status, at: d.createdAt })),
      withdrawals: wds.map((w) => ({ id: String(w._id), platform: w.platform, coins: w.coins, status: w.status, at: w.createdAt })) });
  }));
  // add or remove coins/hearts (or set the exact balance); every change is written to the player's history and the audit log
  r.post('/users/:id/adjust', wrap(async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, reason = String(b.reason || '').slice(0, 120);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'bad_id' });
    const u0 = await User.findOne({ tgId: id }).lean(); if (!u0) return res.status(404).json({ error: 'not_found' });
    let dc = b.mode === 'set' ? num(b.coins, 0) - u0.coins : Math.trunc(num(b.coins, 0)), dh = b.mode === 'set' ? num(b.hearts, u0.hearts) - u0.hearts : Math.trunc(num(b.hearts, 0));
    if (!dc && !dh) return res.status(400).json({ error: 'bad_amount' });
    if (Math.abs(dc) > 1e8 || Math.abs(dh) > 1e5) return res.status(400).json({ error: 'bad_amount' });
    const f = { tgId: id }; if (dc < 0) f.coins = { $gte: -dc }; if (dh < 0) f.hearts = { $gte: -dh };
    const u = await User.findOneAndUpdate(f, { $inc: { coins: dc, hearts: dh } }, { new: true });
    if (!u) return res.status(409).json({ error: 'not_enough' });
    if (dc) store.tx(id, 'admin', dc, u.coins, null, '', reason || 'admin ' + req.admin.id);
    audit(req.admin, 'adjust', `user ${id} coins ${dc} hearts ${dh} (${reason})`);
    if (b.notify) H.notify(id, dc > 0 ? `🎁 ${dc} coins were added to your balance.` : dc < 0 ? `${-dc} coins were taken from your balance.` : `Your hearts were updated.`);
    res.json({ ok: true, user: userView(u) });
  }));
  r.post('/users/:id/ban', wrap(async (req, res) => {
    const id = Number(req.params.id), on = !!(req.body && req.body.banned);
    if (!Number.isSafeInteger(id) || A.isAdmin(id)) return res.status(400).json({ error: 'bad_id' });
    const u = await User.findOneAndUpdate({ tgId: id }, { $set: { banned: on, banReason: on ? String(req.body.reason || '').slice(0, 120) : '' } }, { new: true });
    if (!u) return res.status(404).json({ error: 'not_found' });
    on ? A.banned.add(id) : A.banned.delete(id);
    audit(req.admin, on ? 'ban' : 'unban', `user ${id} ${req.body.reason || ''}`);
    res.json({ ok: true, user: userView(u) });
  }));
  r.post('/users/:id/message', wrap(async (req, res) => {
    const id = Number(req.params.id), text = String((req.body && req.body.text) || '').trim().slice(0, 1000);
    if (!Number.isSafeInteger(id) || !text) return res.status(400).json({ error: 'bad_request' });
    await bot.telegram.sendMessage(id, text).then(() => res.json({ ok: true }), () => res.status(502).json({ error: 'not_delivered' }));
    audit(req.admin, 'message', `user ${id}`);
  }));

  // ---- deposits / withdrawals (same rules as the Telegram buttons) ----
  const depRow = (d) => ({ id: String(d._id), tgId: d.tgId, admin: d.admin, username: d.username, amount: d.amount, finalAmount: d.finalAmount || null, status: d.status, at: d.createdAt, decidedAt: d.decidedAt || null });
  r.get('/deposits', wrap(async (req, res) => {
    const f = req.query.status ? { status: String(req.query.status) } : { status: { $ne: 'failed' } };
    const rows = await Deposit.find(f).sort({ createdAt: -1 }).limit(60).lean();
    const names = Object.fromEntries((await User.find({ tgId: { $in: rows.map((x) => x.tgId) } }).select('tgId name').lean()).map((u) => [u.tgId, u.name]));
    res.json({ items: rows.map((d) => ({ ...depRow(d), name: names[d.tgId] || '' })) });
  }));
  r.post('/deposits/:id/:act', wrap(async (req, res) => {
    const { id, act } = req.params; if (!mongoose.isValidObjectId(id) || !['approve', 'reject'].includes(act)) return res.status(400).json({ error: 'bad_request' });
    const d = await Deposit.findById(id); if (!d) return res.status(404).json({ error: 'not_found' });
    const amount = act === 'approve' ? (req.body && req.body.amount ? Math.trunc(Number(req.body.amount)) : d.finalAmount || d.amount) : 0;
    if (act === 'approve' && !(amount >= 1 && amount <= CFG().limits.depositMax)) return res.status(400).json({ error: 'bad_amount' });
    const done = await H.settleDeposit(id, act === 'approve' ? 'approved' : 'rejected', amount);
    if (!done) return res.status(409).json({ error: 'already_handled' });
    audit(req.admin, 'deposit_' + act, `${id} user ${done.tgId} ${amount || ''}`);
    await H.afterDecision(done, act === 'approve' ? `✅ <b>Confirmed (panel)</b>: ${done.finalAmount} coins\nPlayer ID: <code>${done.tgId}</code>` : `❌ <b>Rejected (panel)</b>\nPlayer ID: <code>${done.tgId}</code>`);
    res.json({ ok: true });
  }));
  r.get('/withdrawals', wrap(async (req, res) => {
    const f = req.query.status ? { status: String(req.query.status) } : { status: { $ne: 'failed' } };
    const rows = await Withdrawal.find(f).sort({ createdAt: -1 }).limit(60).lean();
    const names = Object.fromEntries((await User.find({ tgId: { $in: rows.map((x) => x.tgId) } }).select('tgId name depositTotal').lean()).map((u) => [u.tgId, u]));
    res.json({ items: rows.map((w) => ({ id: String(w._id), tgId: w.tgId, name: (names[w.tgId] || {}).name || '', deposited: (names[w.tgId] || {}).depositTotal || 0, platform: w.platform, accountName: w.accountName, phone: w.phone, coins: w.coins, status: w.status, at: w.createdAt })) });
  }));
  r.post('/withdrawals/:id/:act', wrap(async (req, res) => {
    const { id, act } = req.params; if (!mongoose.isValidObjectId(id) || !['paid', 'reject'].includes(act)) return res.status(400).json({ error: 'bad_request' });
    const done = await H.settleWithdrawal(id, act === 'paid' ? 'paid' : 'rejected');
    if (!done) return res.status(409).json({ error: 'already_handled' });
    audit(req.admin, 'withdraw_' + act, `${id} user ${done.tgId} ${done.coins}`);
    await H.afterWithdrawal(done, act === 'paid' ? 'paid' : 'no');
    res.json({ ok: true });
  }));

  // ---- balance history + risk watch ----
  r.get('/ledger', wrap(async (req, res) => {
    const f = {}; if (req.query.tgId) f.tgId = Number(req.query.tgId); if (req.query.type) f.type = String(req.query.type);
    const rows = await Ledger.find(f, { sort: { at: -1 }, limit: Math.min(200, num(req.query.limit, 80)) });
    res.json({ items: rows.map((x) => ({ tgId: x.tgId, type: x.type, game: x.game, delta: x.delta, bal: x.bal, note: x.note, at: x.at })) });
  }));
  // players with the biggest game winnings / losses over the last N hours, and big pending withdrawals
  r.get('/risk', wrap(async (req, res) => {
    const hours = Math.min(720, Math.max(1, num(req.query.hours, 24))), since = new Date(Date.now() - hours * 3600e3);
    const per = await Promise.all(Ledger.list().map(({ model }) => model.aggregate([{ $match: { at: { $gte: since }, game: { $in: ['duel', 'bomb', 'lucky', 'slots', 'spin'] } } }, { $group: { _id: '$tgId', net: { $sum: '$delta' }, n: { $sum: 1 } } }])));
    const m = new Map(); per.flat().forEach((x) => { const c = m.get(x._id) || { tgId: x._id, net: 0, n: 0 }; c.net += x.net; c.n += x.n; m.set(x._id, c); });
    const all = [...m.values()], names = Object.fromEntries((await User.find({ tgId: { $in: all.map((x) => x.tgId) } }).select('tgId name coins depositTotal').lean()).map((u) => [u.tgId, u]));
    const fill = (x) => ({ ...x, name: (names[x.tgId] || {}).name || '', coins: (names[x.tgId] || {}).coins || 0, deposited: (names[x.tgId] || {}).depositTotal || 0 });
    const winners = all.filter((x) => x.net > 0).sort((a, b) => b.net - a.net).slice(0, 10).map(fill), losers = all.filter((x) => x.net < 0).sort((a, b) => a.net - b.net).slice(0, 10).map(fill);
    const bigWd = await Withdrawal.find({ status: 'pending' }).sort({ coins: -1 }).limit(10).lean();
    res.json({ hours, winners, losers, bigWithdrawals: bigWd.map((w) => ({ id: String(w._id), tgId: w.tgId, coins: w.coins, platform: w.platform })) });
  }));

  // ---- broadcast (one message to everybody, ~20 per second so Telegram does not block the bot) ----
  let job = null;
  r.post('/broadcast', wrap(async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim().slice(0, 1500);
    if (!text) return res.status(400).json({ error: 'bad_request' });
    if (job && !job.done) return res.status(409).json({ error: 'busy' });
    const only = req.body.only === 'active7' ? { lastSeenAt: { $gte: new Date(Date.now() - 7 * 86400000) } } : {};
    const total = await User.countDocuments({ banned: { $ne: true }, ...only });
    job = { total, sent: 0, failed: 0, done: false, at: Date.now() };
    audit(req.admin, 'broadcast', text.slice(0, 120));
    res.json({ ok: true, total });
    (async () => {
      const cur = User.find({ banned: { $ne: true }, ...only }).select('tgId').lean().cursor();
      for await (const u of cur) {
        await bot.telegram.sendMessage(u.tgId, text).then(() => { job.sent++; }, () => { job.failed++; });
        await new Promise((ok) => setTimeout(ok, 50));
      }
      job.done = true;
    })().catch((e) => { console.error('broadcast failed', e); job.done = true; });
  }));
  r.get('/broadcast', (req, res) => res.json(job || { done: true, total: 0, sent: 0, failed: 0 }));

  // ---- databases: usage, cross-database counts, clean-up and moving rows between them ----
  r.get('/db', wrap(async (req, res) => {
    const [stats, avatars, ledger, shots] = await Promise.all([db.stats(true), store.Avatar.counts(), store.Ledger.counts(), store.Shot.counts()]);
    res.json({ stats, avatars, ledger, shots, roles: db.roles.map((x) => ({ role: x, db: db.conns[x].name })), keep: CFG().storage });
  }));
  const MODELS = { avatar: store.Avatar, ledger: store.Ledger, shot: store.Shot };
  r.post('/db/action', wrap(async (req, res) => {
    const b = req.body || {}, out = {};
    if (b.action === 'prune_ledger') out.deleted = await store.Ledger.deleteMany({ at: { $lt: new Date(Date.now() - Math.max(1, num(b.days, CFG().storage.ledgerKeepDays)) * 86400000) } });
    else if (b.action === 'prune_avatars') out.deleted = await store.Avatar.deleteMany({ lastUsedAt: { $lt: new Date(Date.now() - Math.max(1, num(b.days, CFG().storage.avatarKeepDays)) * 86400000) } });
    else if (b.action === 'move') {
      const m = MODELS[b.what]; if (!m) return res.status(400).json({ error: 'bad_request' });
      const old = b.olderDays ? { at: { $lt: new Date(Date.now() - num(b.olderDays, 0) * 86400000) } } : {};
      out.moved = await m.move(b.from, b.to, b.what === 'ledger' ? old : {}, Math.min(20000, num(b.limit, 2000)));
    } else return res.status(400).json({ error: 'bad_request' });
    audit(req.admin, 'db_' + b.action, JSON.stringify(b));
    await db.stats(true);
    res.json({ ok: true, ...out });
  }));

  r.get('/audit', wrap(async (req, res) => res.json({ items: (await AdminLog.find().sort({ at: -1 }).limit(80).lean()).map((x) => ({ admin: x.admin, name: x.name, action: x.action, detail: x.detail, at: x.at })) })));

  app.use('/api/admin', r);

  // ---- hourly housekeeping: keep the databases small ----
  let lastWarn = 0;
  const clean = async () => {
    try {
      const S = CFG().storage;
      await store.Ledger.deleteMany({ at: { $lt: new Date(Date.now() - S.ledgerKeepDays * 86400000) } });
      await store.Avatar.deleteMany({ lastUsedAt: { $lt: new Date(Date.now() - S.avatarKeepDays * 86400000) } });
      await HouseStat.deleteMany({ day: { $lt: H.dayKey(Date.now() - 400 * 86400000) } });
      await AdminLog.deleteMany({ at: { $lt: new Date(Date.now() - 180 * 86400000) } });
      const st = await db.stats(true), full = st.filter((x) => x.ok && x.pct >= S.fullPct);
      if (full.length && Date.now() - lastWarn > 6 * 3600e3) { lastWarn = Date.now(); for (const f of full) for (const a of A.adminIds()) H.notify(a, `⚠️ Database ${f.role} (${f.db}) is ${f.pct}% full.`); }
    } catch (e) { console.error('housekeeping failed', e && e.message); }
  };
  setTimeout(clean, 60000); setInterval(clean, 3600e3);
}
module.exports = { mount };
