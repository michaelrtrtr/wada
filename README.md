# ⬡ portal v2

Local reverse-proxy mirror with WebSocket relay, cookie forwarding, and full SPA interception.

---

## Setup

1. Install **Node.js** → https://nodejs.org (grab LTS)
2. Unzip, open terminal inside the folder, run:

```
npm install
node server.js
```

3. Open `http://localhost:3000`

---

## What's fixed in v2

| Site | Problem | Fix |
|---|---|---|
| Discord | white screen, broken assets | WebSocket relay + inline script URL rewriting |
| Roblox | can't log in | Cookie forwarding (strip domain lock) |
| CrazyGames | redirected to real site | location.href setter shim + window.open override |
| Any SPA | API calls bypassing proxy | fetch + XHR interceptors |

---

## Honest limits

- **Discord**: real-time relay works but their JS bundles load extra chunks dynamically — some pieces may still miss. Basic browsing and messaging should work.
- **Roblox**: login should work now. Some game-launch flows use launchers/executables, those can't be proxied.
- **CrazyGames**: staying on the portal is fixed. Games that load from a completely separate domain (not crazygames.com) will still redirect out — nothing to do there without proxying every external domain too.
- **HTTPS-only APIs**: some sites reject requests that don't come from their own domain at the API level (CORS + token validation). Can't fix that without MITM SSL, which is a whole other architecture.

---

## Files

```
portal/
├── server.js        ← proxy server + WS relay
├── package.json
├── README.md
└── public/
    └── index.html   ← home UI
```
