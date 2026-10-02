# ⬡ portal

Reverse proxy — browse any site through a clean mirror.

---

## Deploy on Replit (recommended — free, no install)

1. Go to **replit.com** → New Repl → **Import from GitHub** or drag-and-drop this zip
2. Or: New Repl → **Node.js** → upload these files manually
3. Hit **Run** — Replit installs packages and starts automatically
4. Copy the live URL Replit gives you (looks like `https://portal.yourname.repl.co`)
5. Paste that URL into your school browser — done

> WebSocket relay (for Discord) works on Replit out of the box — the dynamic `wss://` detection handles it automatically.

---

## Run locally (your own laptop)

```
npm install
node server.js
```
Then open `http://localhost:3000`

---

## What works

| Site | Status |
|---|---|
| Reddit | ✅ search, browse, forms |
| CrazyGames | ✅ navigation stays proxied |
| YouTube | ✅ browsing (some videos need HLS support) |
| Wikipedia | ✅ full |
| Discord landing | ✅ styled |
| Discord app | ⚠️ partial — JS chunks too fragmented |
| Roblox | ⚠️ browse only — Cloudflare blocks login |
| Spotify | ⚠️ browse only |

---

## Files

```
portal/
├── server.js          ← everything
├── package.json
├── .replit            ← Replit auto-config
├── .gitignore
├── README.md
└── public/
    └── index.html     ← home UI
```
