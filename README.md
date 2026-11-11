# Play2Win

Telegram Mini App game. `web/` = frontend (Vercel). `server/` = bot + API (Render). Database = MongoDB Atlas.

```
play2win/
  web/      -> Vercel   (Root Directory = web)
  server/   -> Render   (Root Directory = server)
```

## 1. MongoDB Atlas
1. Create a free cluster (M0).
2. Database Access -> add a user (username + password).
3. Network Access -> Add IP `0.0.0.0/0` (Render has no fixed IP).
4. Connect -> Drivers -> copy the string and add the DB name:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/play2win?retryWrites=true&w=majority`
   (If the password has special characters, URL-encode them.)

## 2. Telegram bot
1. @BotFather -> `/newbot` -> copy the token (keep it secret).
2. Get your admin numeric ID from @userinfobot.

## 3. Vercel (frontend)
1. Import the GitHub repo. Set **Root Directory = `web`**. Framework preset = Other. No build command.
2. Deploy -> you get `https://xxxx.vercel.app`.
3. Vercel needs **no environment variables**.
   The server URL is set in `web/config.js` (`window.P2W_API`) after step 4.

## 4. Render (bot + API)
1. New -> Web Service -> pick the repo. **Root Directory = `server`**.
   Build Command `npm install`, Start Command `npm start`.
   (Or use New -> Blueprint, which reads `render.yaml`.)
2. Environment variables:

| Key | Value |
|---|---|
| `BOT_TOKEN` | token from BotFather |
| `ADMIN_ID` | your Telegram numeric ID |
| `WEBAPP_URL` | your Vercel URL, e.g. `https://xxxx.vercel.app` (no trailing slash) |
| `MONGODB_URI` | the Atlas connection string from step 1 |

   `RENDER_EXTERNAL_URL` is set by Render automatically (the bot uses it for the webhook). Do not add it yourself.
3. Deploy -> you get `https://play2win-server.onrender.com`.
4. Edit `web/config.js`, put that URL in, commit and push. Vercel redeploys.

## 5. Test
Open your bot -> `/start` -> tap **ဂိမ်းထဲဝင်ရန်**.

## Local development
```
cd server
cp .env.example .env     # fill it in
node --env-file=.env index.js   # polling mode (Node 20+)
cd ../web && python3 -m http.server 8000
```
For Telegram to open local pages you need an https tunnel (e.g. ngrok) as `WEBAPP_URL`.

## Notes
- Render free plan sleeps after ~15 min idle; the first request after that is slow.
- Never commit `.env` or the bot token.

## Fly & Dodge Async Duel
- `web/duel.html` lobby + game + result, `web/history.html` tournament history.
- Rules: entry fee 500 coins; winner prize 900 (claim 10 min after the match is decided); draw returns 500; leaving a match = loss.
- A match has exactly two players. Player A plays first and the score is saved; the next different player is matched to it and plays against that score. After that the match is closed and never reused.
- While `web/config.js` still contains `YOUR-SERVER`, or when opened outside Telegram, the pages run in **demo mode** (coins/history kept in the browser only). Add `?fast=1` to the URL to make the claim timer 10 seconds for testing.
- Server checks scores against elapsed time (basic anti-cheat). Full replay verification is not implemented yet.
