// Three MongoDB connections, one job each:
//   main = users, matches, game rounds, deposits, settings   (MONGODB_URI)
//   img  = avatars + deposit screenshots                     (MONGODB_IMG_URI)
//   hist = balance history (ledger)                          (MONGODB_HIST_URI)
// If an extra URI is missing, that role simply uses the main database, so the app still works with one DB.
// "Shared" models (avatar, ledger, screenshots) exist on all three databases:
//   writes go to the preferred database and spill over to the next one when it is nearly full,
//   reads look in all of them, and the admin panel can move rows from one database to another.
const mongoose = require('mongoose');

const URIS = { main: process.env.MONGODB_URI, img: process.env.MONGODB_IMG_URI, hist: process.env.MONGODB_HIST_URI };
const conns = { main: mongoose.connection };
for (const r of ['img', 'hist']) conns[r] = URIS[r] ? mongoose.createConnection(URIS[r]) : conns.main;

const roles = Object.keys(conns);
const distinct = () => { const seen = new Set(), out = []; for (const r of roles) if (!seen.has(conns[r])) { seen.add(conns[r]); out.push(r); } return out; };   // one entry per real database
const QUOTA = (r) => Number(process.env['DB_' + r.toUpperCase() + '_QUOTA_MB'] || process.env.DB_QUOTA_MB || 512);

let fullPct = 85;                       // set from the admin settings
const setFullPct = (n) => { fullPct = n; };

async function connectAll() {
  await mongoose.connect(URIS.main);
  await Promise.all(distinct().filter((r) => r !== 'main').map((r) => conns[r].asPromise()));
}

// ----- storage usage (cached, Atlas counts data + indexes) -----
let cache = { at: 0, rows: [] };
async function stats(force) {
  if (!force && Date.now() - cache.at < 60000 && cache.rows.length) return cache.rows;
  const rows = [];
  for (const r of distinct()) {
    try {
      const s = await conns[r].db.stats();
      const used = (s.storageSize + s.indexSize) / 1048576, quota = QUOTA(r);
      rows.push({ role: r, shared: roles.filter((x) => conns[x] === conns[r]), db: conns[r].name, usedMB: +used.toFixed(2), quotaMB: quota, pct: +(used / quota * 100).toFixed(1), objects: s.objects, collections: s.collections, ok: true });
    } catch (e) { rows.push({ role: r, shared: [r], db: conns[r].name, usedMB: 0, quotaMB: QUOTA(r), pct: 0, objects: 0, collections: 0, ok: false, error: String(e.message || e) }); }
  }
  cache = { at: Date.now(), rows };
  return rows;
}
const pctOf = (r) => { const row = cache.rows.find((x) => x.shared.includes(r)); return row ? row.pct : 0; };

// ----- shared models -----
function shared(name, schema, indexes) {
  const models = {};
  for (const r of distinct()) {
    const m = conns[r].model(name, schema);
    models[r] = m;
  }
  const list = () => distinct().map((r) => ({ role: r, model: models[r] }));
  return {
    name, models, list,
    // first database in `order` that still has room (or the emptiest one when all are full)
    pick(order) {
      const cand = order.filter((r) => models[r] || conns[r]).map((r) => (models[r] ? r : distinct().find((d) => conns[d] === conns[r])));
      const uniq = [...new Set(cand)];
      const ok = uniq.find((r) => pctOf(r) < fullPct);
      if (ok) return models[ok];
      return models[uniq.slice().sort((a, b) => pctOf(a) - pctOf(b))[0]];
    },
    async findOne(filter, sort) {
      for (const { model } of list()) { const q = model.findOne(filter); if (sort) q.sort(sort); const d = await q; if (d) return d; }
      return null;
    },
    async find(filter, { sort, limit } = {}) {
      const parts = await Promise.all(list().map(async ({ role, model }) => { const q = model.find(filter).lean(); if (sort) q.sort(sort); if (limit) q.limit(limit); return (await q).map((d) => ({ ...d, _db: role })); }));
      let all = [].concat(...parts);
      if (sort) { const [[k, dir]] = Object.entries(sort); all.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir); }
      return limit ? all.slice(0, limit) : all;
    },
    async count(filter) { return (await Promise.all(list().map(({ model }) => model.countDocuments(filter)))).reduce((a, b) => a + b, 0); },
    async deleteMany(filter) { let n = 0; for (const { model } of list()) n += (await model.deleteMany(filter)).deletedCount || 0; return n; },
    async counts() { const o = {}; for (const { role, model } of list()) o[role] = await model.estimatedDocumentCount(); return o; },
    // move up to `limit` rows from one database to another (copy first, then delete from the source)
    async move(from, to, filter, limit) {
      const a = models[from], b = models[to];
      if (!a || !b || a === b) throw new Error('bad_move');
      const docs = await a.find(filter || {}).limit(limit || 1000).lean();
      if (!docs.length) return 0;
      try { await b.insertMany(docs, { ordered: false }); } catch (e) { if (!(e && (e.code === 11000 || e.writeErrors))) throw e; }
      await a.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
      return docs.length;
    },
  };
}

module.exports = { conns, roles, distinct, connectAll, stats, shared, setFullPct, QUOTA };
