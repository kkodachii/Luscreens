const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8787;
const ROOM_TTL_MS = 2 * 60 * 1000; // drop if no heartbeat for 2 minutes

/** @type {Map<string, object>} */
const rooms = new Map();

app.use(cors({ origin: true }));
app.use(express.json({ limit: '32kb' }));

function now() {
  return Date.now();
}

function publicRoomView(room) {
  return {
    code: room.code,
    visibility: room.visibility,
    hostName: room.hostName,
    title: room.title || null,
    mediaType: room.mediaType || null,
    mediaId: room.mediaId || null,
    season: room.season ?? null,
    episode: room.episode ?? null,
    memberCount: room.memberCount || 1,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function cleanupExpired() {
  const cutoff = now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if ((room.lastHeartbeat || 0) < cutoff) {
      rooms.delete(code);
    }
  }
}

setInterval(cleanupExpired, 30_000).unref?.();

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, ts: now() });
});

/** List public rooms only */
app.get('/rooms', (_req, res) => {
  cleanupExpired();
  const list = [...rooms.values()]
    .filter((r) => r.visibility === 'public')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(publicRoomView);
  res.json({ rooms: list });
});

/** Register / upsert a room after PeerJS host is ready */
app.post('/rooms', (req, res) => {
  const body = req.body || {};
  const code = String(body.code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!code || code.length < 4) {
    return res.status(400).json({ error: 'Valid room code required' });
  }

  const visibility = body.visibility === 'public' ? 'public' : 'private';
  const existing = rooms.get(code);
  const stamp = now();

  const room = {
    code,
    visibility,
    hostName: String(body.hostName || 'Host').slice(0, 40),
    title: body.title ? String(body.title).slice(0, 120) : existing?.title || null,
    mediaType: body.mediaType || existing?.mediaType || null,
    mediaId: body.mediaId || existing?.mediaId || null,
    season: body.season ?? existing?.season ?? null,
    episode: body.episode ?? existing?.episode ?? null,
    memberCount: Math.max(1, Number(body.memberCount) || existing?.memberCount || 1),
    createdAt: existing?.createdAt || stamp,
    updatedAt: stamp,
    lastHeartbeat: stamp,
  };

  rooms.set(code, room);
  res.status(existing ? 200 : 201).json({ room: publicRoomView(room) });
});

/** Update room metadata (title/media/members) */
app.patch('/rooms/:code', (req, res) => {
  const code = String(req.params.code || '')
    .trim()
    .toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const body = req.body || {};
  if (body.visibility === 'public' || body.visibility === 'private') {
    room.visibility = body.visibility;
  }
  if (body.hostName) room.hostName = String(body.hostName).slice(0, 40);
  if (body.title !== undefined) {
    // Ignore empty strings so early client syncs don't wipe the title
    if (body.title) room.title = String(body.title).slice(0, 120);
  }
  if (body.mediaType !== undefined) room.mediaType = body.mediaType;
  if (body.mediaId !== undefined) room.mediaId = body.mediaId;
  if (body.season !== undefined) room.season = body.season;
  if (body.episode !== undefined) room.episode = body.episode;
  if (body.memberCount !== undefined) {
    room.memberCount = Math.max(1, Number(body.memberCount) || 1);
  }

  room.updatedAt = now();
  room.lastHeartbeat = now();
  rooms.set(code, room);
  res.json({ room: publicRoomView(room) });
});

/** Keep room alive while host is online */
app.post('/rooms/:code/heartbeat', (req, res) => {
  const code = String(req.params.code || '')
    .trim()
    .toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const body = req.body || {};
  if (body.memberCount !== undefined) {
    room.memberCount = Math.max(1, Number(body.memberCount) || 1);
  }
  if (body.title) room.title = String(body.title).slice(0, 120);

  room.lastHeartbeat = now();
  room.updatedAt = now();
  rooms.set(code, room);
  res.json({ ok: true });
});

/** Host leaves / closes party */
app.delete('/rooms/:code', (req, res) => {
  const code = String(req.params.code || '')
    .trim()
    .toUpperCase();
  rooms.delete(code);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Luscreens party-api listening on :${PORT}`);
});
