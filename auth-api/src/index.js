const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { connectMongo } = require('./db');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 8788;
const JWT_SECRET = process.env.JWT_SECRET || 'luscreens-dev-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
const MONGODB_URI = process.env.MONGODB_URI || '';
/** Comma-separated admin emails (default: kean@gmail.com) */
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || 'kean@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
  };
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(normalizeEmail(email));
}

function adminMiddleware(req, res, next) {
  if (!isAdminEmail(req.auth?.email)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'luscreens-auth-api',
    message: 'This is the auth API, not the Luscreens website.',
    storage: store.storageMode(),
    health: '/health',
    endpoints: [
      'POST /auth/register',
      'POST /auth/login',
      'GET /auth/me',
      'GET /auth/admin/users',
      'GET /me/library',
      'PUT /me/library',
    ],
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'auth-api',
    storage: store.storageMode(),
    ts: Date.now(),
  });
});

app.post('/auth/register', async (req, res) => {
  try {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const name = String(body.name || '').trim().slice(0, 40) || 'User';

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await store.findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email,
      name,
      passwordHash,
      createdAt: Date.now(),
    };
    await store.createUser(user);

    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    console.error('register failed', err);
    res.status(500).json({ error: 'Could not create account' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');

    if (!isValidEmail(email) || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await store.findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('login failed', err);
    res.status(500).json({ error: 'Could not log in' });
  }
});

app.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await store.findUserById(req.auth.sub);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    res.json({
      user: {
        ...publicUser(user),
        isAdmin: isAdminEmail(user.email),
      },
    });
  } catch (err) {
    console.error('me failed', err);
    res.status(500).json({ error: 'Could not load profile' });
  }
});

/** Admin only: list all registered users (no password hashes) */
app.get('/auth/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await store.listUsers();
    res.json({ users, total: users.length });
  } catch (err) {
    console.error('admin users failed', err);
    res.status(500).json({ error: 'Could not load users' });
  }
});

/** Per-user history / recently played / watchlist */
app.get('/me/library', authMiddleware, async (req, res) => {
  try {
    const library = await store.getUserLibrary(req.auth.sub);
    res.json({ library });
  } catch (err) {
    console.error('get library failed', err);
    res.status(500).json({ error: 'Could not load library' });
  }
});

app.put('/me/library', authMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const saved = await store.setUserLibrary(req.auth.sub, {
      progress: body.progress,
      watchlist: body.watchlist,
    });
    res.json({ library: saved });
  } catch (err) {
    console.error('put library failed', err);
    res.status(500).json({ error: 'Could not save library' });
  }
});

async function start() {
  if (MONGODB_URI) {
    try {
      await connectMongo(MONGODB_URI);
      console.log('Connected to MongoDB');
    } catch (err) {
      // Keep the API alive on Render while Atlas access is fixed
      console.error(err && err.message ? err.message : err);
      console.error(
        'Falling back to JSON file storage. Fix Atlas Network Access (allow 0.0.0.0/0), then redeploy.'
      );
      // Clear URI for this process so store.useMongo() is false
      delete process.env.MONGODB_URI;
      store.ensureFileStore();
    }
  } else {
    store.ensureFileStore();
    console.warn(
      'MONGODB_URI not set — using local JSON files (accounts will not survive redeploy).'
    );
  }

  app.listen(PORT, () => {
    console.log(`Luscreens auth-api listening on :${PORT} (storage: ${store.storageMode()})`);
  });
}

start().catch((err) => {
  console.error('Failed to start auth-api', err);
  process.exit(1);
});
