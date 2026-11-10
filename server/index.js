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

// ---------- Database ----------
const User = mongoose.model('User', new mongoose.Schema({
  tgId: { type: Number, unique: true, index: true },
  name: String,
  username: String,
  coins: { type: Number, default: 2500 },
  hearts: { type: Number, default: 10 },
  createdAt: { type: Date, default: Date.now },
}));

// ---------- Verify Telegram Mini App initData ----------
function verifyInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null; // older than 24h
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

// ---------- Bot ----------
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) =>
  ctx.reply(
    'ကြိုဆိုပါတယ်',
    Markup.inlineKeyboard([Markup.button.webApp('ဂိမ်းထဲဝင်ရန်', WEBAPP_URL)])
  )
);

// ---------- API ----------
const app = express();
app.use(cors({ origin: WEBAPP_URL.replace(/\/$/, '') }));
app.use(express.json());

app.get('/', (_, res) => res.send('Play2Win server OK'));

app.post('/api/auth', async (req, res) => {
  const tgUser = verifyInitData(String(req.body.initData || ''));
  if (!tgUser) return res.status(401).json({ error: 'invalid initData' });
  const u = await User.findOneAndUpdate(
    { tgId: tgUser.id },
    { $set: { name: tgUser.first_name || 'Player', username: tgUser.username || '' }, $setOnInsert: { tgId: tgUser.id } },
    { upsert: true, new: true }
  );
  res.json({ name: u.name, coins: u.coins, hearts: u.hearts });
});

(async () => {
  await mongoose.connect(MONGODB_URI);
  if (RENDER_EXTERNAL_URL) {
    const path = '/tg/' + crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 24);
    app.use(bot.webhookCallback(path));
    await bot.telegram.setWebhook(RENDER_EXTERNAL_URL + path);
  } else {
    bot.launch(); // local development uses polling
  }
  app.listen(PORT, () => console.log('Server on', PORT));
})();
