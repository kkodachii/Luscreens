# Luscreens Party API

Lobby registry for **public / private** watch parties.  
Playback sync still uses PeerJS in the Angular app — this API only lists and tracks rooms.

## Local

```bash
cd party-api
npm install
npm start
```

Health: `http://localhost:8787/health`

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
4. Deploy → copy the service URL (e.g. `https://luscreens-party-api.onrender.com`)
5. Put that URL in Angular env as `partyApiUrl`

### Notes

- Free instances sleep after idle; first request may take ~30–60s
- Rooms are **in-memory** (lost on restart / sleep) — fine for a lobby MVP
- Public rooms expire ~2 minutes after the host stops heartbeating
