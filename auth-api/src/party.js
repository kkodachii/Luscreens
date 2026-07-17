/**
 * In-memory watch-party relay via HTTP long-poll.
 * Works across Wi‑Fi / cellular — no WebRTC/NAT required.
 */
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const MEMBER_TTL_MS = 60_000;
const MAX_EVENTS = 200;

/** @type {Map<string, any>} */
const rooms = new Map();

function now() {
  return Date.now();
}

function generateCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

function normalizeCode(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return '';
  }
  try {
    if (raw.includes('party=')) {
      const url = new URL(raw, 'https://luscreens.app');
      const fromQuery = url.searchParams.get('party');
      if (fromQuery) {
        return fromQuery.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      }
    }
  } catch {
    // fall through
  }
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function newMemberId() {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function publicMembers(room) {
  return [...room.members.values()].map((m) => ({
    peerId: m.id,
    displayName: m.displayName,
    isHost: m.isHost,
  }));
}

function touchMember(room, memberId) {
  const member = room.members.get(memberId);
  if (member) {
    member.lastSeen = now();
  }
}

function flushWaiters(room, payload) {
  const waiters = room.waiters || [];
  room.waiters = [];
  for (const w of waiters) {
    try {
      clearTimeout(w.timer);
      w.resolve(payload);
    } catch {
      // ignore
    }
  }
}

function pruneRoom(room) {
  const t = now();
  for (const [id, member] of room.members) {
    if (t - member.lastSeen > MEMBER_TTL_MS) {
      room.members.delete(id);
    }
  }
  if (!room.members.has(room.hostId)) {
    rooms.delete(room.code);
    flushWaiters(room, { closed: true });
    return false;
  }
  return true;
}

function pushEvent(room, fromId, command) {
  room.seq += 1;
  const event = {
    seq: room.seq,
    at: now(),
    from: fromId,
    command,
  };
  room.events.push(event);
  if (room.events.length > MAX_EVENTS) {
    room.events.splice(0, room.events.length - MAX_EVENTS);
  }
  room.updatedAt = event.at;
  flushWaiters(room, {
    events: [event],
    members: publicMembers(room),
    media: room.media,
    seq: room.seq,
  });
  return event;
}

function getRoom(code) {
  const room = rooms.get(code);
  if (!room) {
    return null;
  }
  if (now() - room.updatedAt > ROOM_TTL_MS) {
    rooms.delete(code);
    return null;
  }
  if (!pruneRoom(room)) {
    return null;
  }
  return room;
}

function createRoom(displayName, existingCode) {
  const name = String(displayName || 'Host').trim().slice(0, 40) || 'Host';
  let code = existingCode ? normalizeCode(existingCode) : generateCode();
  if (!code) {
    const err = new Error('Invalid room code');
    err.status = 400;
    throw err;
  }

  const existing = rooms.get(code);
  if (existing && existingCode) {
    // Host restore — reclaim code
    rooms.delete(code);
  } else if (existing) {
    code = generateCode();
  }

  const hostId = newMemberId();
  const room = {
    code,
    hostId,
    media: null,
    members: new Map([
      [
        hostId,
        {
          id: hostId,
          displayName: name,
          isHost: true,
          lastSeen: now(),
        },
      ],
    ]),
    events: [],
    seq: 0,
    waiters: [],
    updatedAt: now(),
  };
  rooms.set(code, room);
  return { room, memberId: hostId };
}

function joinRoom(codeInput, displayName) {
  const code = normalizeCode(codeInput);
  const room = getRoom(code);
  if (!room) {
    const err = new Error(
      'Room not found. Ask the host to start the party again and use the new code.'
    );
    err.status = 404;
    throw err;
  }
  const name = String(displayName || 'Guest').trim().slice(0, 40) || 'Guest';
  const memberId = newMemberId();
  room.members.set(memberId, {
    id: memberId,
    displayName: name,
    isHost: false,
    lastSeen: now(),
  });
  room.updatedAt = now();
  pushEvent(room, memberId, {
    action: 'hello',
    displayName: name,
    media: room.media || undefined,
    sentAt: now(),
  });
  return { room, memberId };
}

function mountPartyRoutes(app) {
  app.post('/party/create', (req, res) => {
    try {
      const body = req.body || {};
      const { room, memberId } = createRoom(body.displayName, body.roomCode);
      res.json({
        code: room.code,
        memberId,
        members: publicMembers(room),
        media: room.media,
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Could not create party' });
    }
  });

  app.post('/party/join', (req, res) => {
    try {
      const body = req.body || {};
      const { room, memberId } = joinRoom(body.code || body.roomCode, body.displayName);
      res.json({
        code: room.code,
        memberId,
        members: publicMembers(room),
        media: room.media,
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Could not join party' });
    }
  });

  app.post('/party/leave', (req, res) => {
    try {
      const body = req.body || {};
      const code = normalizeCode(body.code);
      const memberId = String(body.memberId || '');
      const room = rooms.get(code);
      if (room && memberId) {
        room.members.delete(memberId);
        room.updatedAt = now();
        if (memberId === room.hostId || room.members.size === 0) {
          rooms.delete(code);
          flushWaiters(room, { closed: true });
        } else {
          flushWaiters(room, {
            events: [],
            members: publicMembers(room),
            media: room.media,
            seq: room.seq,
          });
        }
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Could not leave party' });
    }
  });

  app.post('/party/send', (req, res) => {
    try {
      const body = req.body || {};
      const code = normalizeCode(body.code);
      const memberId = String(body.memberId || '');
      const command = body.command;
      const room = getRoom(code);
      if (!room) {
        return res.status(404).json({ error: 'Room not found' });
      }
      if (!room.members.has(memberId)) {
        return res.status(403).json({ error: 'Not in this party' });
      }
      touchMember(room, memberId);
      if (!command || !command.action) {
        return res.status(400).json({ error: 'Invalid command' });
      }

      if (command.media && memberId === room.hostId) {
        room.media = command.media;
      }

      pushEvent(room, memberId, command);
      res.json({ ok: true, seq: room.seq });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Could not send' });
    }
  });

  app.post('/party/media', (req, res) => {
    try {
      const body = req.body || {};
      const code = normalizeCode(body.code);
      const memberId = String(body.memberId || '');
      const room = getRoom(code);
      if (!room) {
        return res.status(404).json({ error: 'Room not found' });
      }
      if (memberId !== room.hostId) {
        return res.status(403).json({ error: 'Only host can set media' });
      }
      touchMember(room, memberId);
      room.media = body.media || null;
      room.updatedAt = now();
      pushEvent(room, memberId, {
        action: 'media',
        media: room.media || undefined,
        sentAt: now(),
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Could not update media' });
    }
  });

  app.get('/party/poll', async (req, res) => {
    try {
      const code = normalizeCode(req.query.code);
      const memberId = String(req.query.memberId || '');
      const after = Number(req.query.after || 0) || 0;
      const waitMs = Math.min(15000, Math.max(0, Number(req.query.waitMs || 12000) || 12000));

      const room = getRoom(code);
      if (!room) {
        return res.status(404).json({ error: 'Room not found', closed: true });
      }
      if (!room.members.has(memberId)) {
        return res.status(403).json({ error: 'Not in this party' });
      }
      touchMember(room, memberId);

      const pending = room.events.filter((e) => e.seq > after);
      if (pending.length || waitMs === 0) {
        return res.json({
          events: pending,
          members: publicMembers(room),
          media: room.media,
          seq: room.seq,
        });
      }

      const payload = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          room.waiters = (room.waiters || []).filter((w) => w.resolve !== resolve);
          resolve({
            events: [],
            members: publicMembers(room),
            media: room.media,
            seq: room.seq,
          });
        }, waitMs);

        room.waiters.push({ resolve, timer });
      });

      if (!rooms.has(code)) {
        return res.status(404).json({ error: 'Room closed', closed: true });
      }
      touchMember(room, memberId);
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: err.message || 'Poll failed' });
    }
  });
}

module.exports = { mountPartyRoutes };
