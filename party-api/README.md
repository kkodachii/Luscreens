# Luscreens Party API

Lobby registry + **PeerJS signaling** for watch parties.  
Playback sync uses PeerJS DataConnections; this service lists rooms and brokers peer IDs.

## Local

```bash
cd party-api
npm install
npm start
```

- Health: `http://localhost:8787/health`
- PeerJS path: `/peerjs`

## Render (Free)

1. Push this repo to GitHub
2. Render → **New Web Service** → connect repo
3. Settings:
   - **Language:** Node
   - **Root Directory:** `party-api`
   - **Build Command:** `npm install` (or leave default — `build` is a no-op)
   - **Start Command:** `npm start`
   - **Instance:** Free
   - **Region:** Singapore (or closest)
4. Deploy → copy the service URL (e.g. `https://luscreens.onrender.com`)
5. Put that URL in Angular env as `partyApiUrl`

### Notes

- Free instances sleep after idle; first request may take ~30–60s
- Rooms are **in-memory** (lost on restart / sleep) — fine for a lobby MVP
- Public rooms expire ~2 minutes after the host stops heartbeating
- Angular PeerJS clients connect to `partyApiUrl/peerjs` (not 0.peerjs.com)
- WebSockets must be enabled (Render supports them by default)
