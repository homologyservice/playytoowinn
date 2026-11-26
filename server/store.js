// Models that live on the extra databases (avatars, screenshots, balance history) + house statistics + avatar pipeline.
const mongoose = require('mongoose');
const db = require('./db');
const settings = require('./settings');

// ---------- shared models ----------
const avatarSchema = new mongoose.Schema({ tgId: { type: Number, index: true }, src: String, mime: String, data: Buffer, checkedAt: Date, lastUsedAt: { type: Date, index: true }, createdAt: { type: Date, default: Date.now } });
const ledgerSchema = new mongoose.Schema({ tgId: { type: Number, required: true }, type: String, game: String, delta: Number, bal: Number, ref: String, note: String, at: { type: Date, default: Date.now } });
ledgerSchema.index({ tgId: 1, at: -1 }); ledgerSchema.index({ at: -1 }); ledgerSchema.index({ type: 1, at: -1 });
const shotSchema = new mongoose.Schema({ depId: mongoose.Schema.Types.ObjectId, token: { type: String, index: true }, mime: String, data: Buffer, createdAt: { type: Date, default: Date.now, expires: 7 * 86400 } });
const Avatar = db.shared('Avatar', avatarSchema), Ledger = db.shared('Ledger', ledgerSchema), Shot = db.shared('DepositShot', shotSchema);

// ---------- main-database models ----------
const HouseStat = mongoose.model('HouseStat', new mongoose.Schema({ k: { type: String, unique: true }, game: String, day: String, plays: { type: Number, default: 0 }, wagered: { type: Number, default: 0 }, paid: { type: Number, default: 0 } }));
const AdminLog = mongoose.model('AdminLog', new mongoose.Schema({ admin: Number, name: String, action: String, detail: String, at: { type: Date, default: Date.now, index: true } }));

// ---------- ledger: every coin movement, best effort (never blocks or breaks a game) ----------
const LEDGER_ORDER = ['hist', 'img', 'main'];
function tx(tgId, type, delta, bal, ref, game, note) {
  if (!delta) return;
  Ledger.pick(LEDGER_ORDER).create({ tgId, type, game: game || '', delta, bal: bal == null ? null : bal, ref: ref ? String(ref) : '', note: note || '' }).catch((e) => console.error('ledger failed', e && e.message));
}
// wagered = coins staked, paid = coins returned to players. House result = wagered - paid. plays counts one per stake.
let dayKeyFn = () => new Date().toISOString().slice(0, 10);
const setDayKey = (f) => { dayKeyFn = f; };
function stat(game, wagered, paid) {
  const day = dayKeyFn();
  HouseStat.updateOne({ k: game + '|' + day }, { $setOnInsert: { game, day }, $inc: { plays: wagered > 0 ? 1 : 0, wagered: wagered || 0, paid: paid || 0 } }, { upsert: true }).catch((e) => console.error('stat failed', e && e.message));
}
const audit = (admin, action, detail) => AdminLog.create({ admin: admin.id, name: admin.name || '', action, detail: String(detail || '').slice(0, 500) }).catch(() => {});

// ---------- avatars: Telegram profile photo -> 96x96 webp (~2 KB), stored once, cached by the phone ----------
let sharp = null; try { sharp = require('sharp'); } catch (e) { console.error('sharp is not installed: avatars are disabled'); }
const AV_SIZE = 96, AV_RECHECK_MS = 12 * 3600e3;
const OK_HOST = /^https:\/\/(t\.me|[a-z0-9-]+\.telesco\.pe|[a-z0-9-]+\.cdn-telegram\.org|api\.telegram\.org)\//i;
const inflight = new Map(), none = new Map();    // none = users without a photo (asked again after 1 hour)
async function download(url) {
  if (!OK_HOST.test(url)) throw new Error('bad_host');
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'error' });
    if (!r.ok) throw new Error('http_' + r.status);
    if (!/^image\/(jpeg|png|webp)/.test(r.headers.get('content-type') || '')) throw new Error('not_image');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 600 * 1024) throw new Error('too_big');
    return buf;
  } finally { clearTimeout(t); }
}
async function build(bot, tgUser) {
  const tryUrl = async (url) => {
    const raw = await download(url);
    return sharp(raw, { limitInputPixels: 4e6 }).rotate().resize(AV_SIZE, AV_SIZE, { fit: 'cover' }).webp({ quality: 55, effort: 4 }).toBuffer();
  };
  const p = tgUser.photo_url && /\.(jpe?g|png|webp)$/i.test(tgUser.photo_url.split('?')[0]) ? tgUser.photo_url : '';
  if (p) { try { return { src: p, data: await tryUrl(p) }; } catch (e) { /* fall through to the bot API */ } }
  try {
    const ph = await bot.telegram.getUserProfilePhotos(tgUser.id, 0, 1);
    if (ph.total_count > 0) { const sizes = ph.photos[0], pick = sizes.find((s) => s.width >= 160) || sizes[sizes.length - 1]; const link = await bot.telegram.getFileLink(pick.file_id); return { src: 'bot:' + pick.file_unique_id, data: await tryUrl(String(link)) }; }
  } catch (e) { /* no access */ }
  return null;
}
// returns { data, mime } or null (no photo / avatars off)
async function avatarFor(bot, tgUser) {
  if (!sharp) return null;
  const id = tgUser.id, now = Date.now();
  const doc = await Avatar.findOne({ tgId: id });
  const src = tgUser.photo_url || '';
  if (doc && (!src || doc.src === src || (now - doc.checkedAt < AV_RECHECK_MS && doc.src.startsWith('bot:')))) {
    if (now - doc.lastUsedAt > 86400e3) doc.updateOne({ $set: { lastUsedAt: new Date() } }).catch(() => {});   // keeps active players' pictures, lets unused ones expire
    return { data: doc.data, mime: doc.mime };
  }
  if (!doc && none.get(id) > now) return null;
  if (inflight.has(id)) return inflight.get(id);
  const job = (async () => {
    const made = await build(bot, tgUser);
    if (!made) { none.set(id, now + 3600e3); return doc ? { data: doc.data, mime: doc.mime } : null; }
    const fields = { tgId: id, src: made.src, mime: 'image/webp', data: made.data, checkedAt: new Date(), lastUsedAt: new Date() };
    if (doc) await doc.constructor.updateOne({ _id: doc._id }, { $set: fields }); else await Avatar.pick(['img', 'hist', 'main']).updateOne({ tgId: id }, { $set: fields }, { upsert: true });
    return { data: made.data, mime: 'image/webp' };
  })().finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

module.exports = { Avatar, Ledger, Shot, HouseStat, AdminLog, tx, stat, audit, avatarFor, setDayKey, hasSharp: () => !!sharp };
