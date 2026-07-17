try {
  require('dotenv').config();
} catch {
  // dotenv is optional in production when env vars are injected by the host
}

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { connectMongo } = require('./db');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 8788;
const JWT_SECRET = process.env.JWT_SECRET || 'luscreens-dev-secret-change-me';
/** Default / remember-me token lifetime */
const JWT_EXPIRES_REMEMBER =
  process.env.JWT_EXPIRES_REMEMBER || process.env.JWT_EXPIRES || '30d';
/** Session-only token when Remember me is unchecked */
const JWT_EXPIRES_SESSION = process.env.JWT_EXPIRES_SESSION || '12h';
/** Optional — powers /ai/recommend without putting the key in the Angular app */
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free';
/** Comma-separated fallbacks when the primary free model is rate-limited */
const OPENROUTER_FALLBACK_MODELS = String(
  process.env.OPENROUTER_FALLBACK_MODELS || 'openrouter/free'
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const MONGODB_URI = process.env.MONGODB_URI || '';
const hasMongoConfig = !!(
  MONGODB_URI ||
  (process.env.MONGODB_USER && process.env.MONGODB_PASSWORD && process.env.MONGODB_HOST)
);
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

function signToken(user, rememberMe = true) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: rememberMe ? JWT_EXPIRES_REMEMBER : JWT_EXPIRES_SESSION }
  );
}

function wantsRememberMe(body) {
  if (!body || typeof body !== 'object') {
    return true;
  }
  if (body.rememberMe === false || body.rememberMe === 'false' || body.rememberMe === 0) {
    return false;
  }
  return true;
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
      'GET /auth/admin/users/:userId/library',
      'POST /ai/recommend',
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
    ai: OPENROUTER_API_KEY ? 'configured' : 'missing',
    ts: Date.now(),
  });
});

function parseAiTitles(content) {
  let text = String(content || '').trim();
  if (!text) {
    return [];
  }

  // Strip fenced code / thinking blocks some models wrap around answers
  text = text
    .replace(/```(?:json|text)?\s*([\s\S]*?)```/gi, '$1')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .trim();

  // Prefer a JSON array if the model returns one
  const jsonMatch = text.match(/\[[\s\S]*?\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        const fromJson = parsed
          .map((item) => String(item || '').replace(/\s*\(\d{4}\)\s*$/, '').trim())
          .filter(Boolean)
          .slice(0, 5);
        if (fromJson.length) {
          return fromJson;
        }
      }
    } catch {
      // fall through to line/comma parsing
    }
  }

  return text
    .replace(/^\s*[-*\d.)]+\s*/gm, '')
    .split(/[\n,;|]+/)
    .map((part) =>
      part
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/\s*\(\d{4}\)\s*$/, '')
        .replace(/^(?:title|movie|show)\s*:\s*/i, '')
        .trim()
    )
    .filter((t) => t && t.length < 120 && !/^here (are|is)\b/i.test(t))
    .slice(0, 5);
}

function extractMessageContent(data) {
  const message = data?.choices?.[0]?.message || {};
  const content = message.content;
  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        return part?.text || part?.content || '';
      })
      .join('')
      .trim();
    if (joined) {
      return joined;
    }
  }
  // Some reasoning models put the final answer elsewhere
  if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
    return message.reasoning.trim();
  }
  return '';
}

async function callOpenRouterRecommend(model, prompt, exclude) {
  const userParts = [
    'Recommend 1 to 5 real movie or TV show titles that exist on TMDB.',
    `User request: ${prompt}`,
    'Reply with ONLY a JSON array of title strings, like ["Inception","Interstellar"].',
    'No numbering, no markdown, no explanation.',
  ];
  if (exclude.length) {
    userParts.push(`Do not suggest these titles: ${exclude.join(', ')}.`);
  }

  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://luscreens.app',
      'X-Title': 'Luscreens',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: userParts.join('\n') }],
      stream: false,
      temperature: 0.4,
    }),
  });

  const data = await upstream.json().catch(() => ({}));
  return { upstream, data };
}

/**
 * AI title recommendations via OpenRouter (server-side key).
 * Body: { prompt: string, exclude?: string[] }
 */
app.post('/ai/recommend', async (req, res) => {
  try {
    if (!OPENROUTER_API_KEY) {
      return res.status(503).json({
        error: 'AI not configured. Set OPENROUTER_API_KEY on the auth API.',
      });
    }

    const body = req.body || {};
    const prompt = String(body.prompt || '').trim().slice(0, 500);
    const exclude = Array.isArray(body.exclude)
      ? body.exclude.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 20)
      : [];

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const models = [
      OPENROUTER_MODEL,
      ...OPENROUTER_FALLBACK_MODELS.filter((m) => m !== OPENROUTER_MODEL),
    ];

    let lastError = 'OpenRouter request failed';
    for (const model of models) {
      try {
        const { upstream, data } = await callOpenRouterRecommend(model, prompt, exclude);
        if (!upstream.ok) {
          lastError =
            data?.error?.message ||
            data?.error?.metadata?.raw ||
            data?.error ||
            `OpenRouter error (${upstream.status})`;
          lastError = String(lastError);
          // Rate-limited / overloaded free models → try next
          if (upstream.status === 429 || upstream.status === 502 || upstream.status === 503) {
            console.warn(`ai recommend model busy (${model}):`, lastError);
            continue;
          }
          return res.status(502).json({ error: lastError });
        }

        const content = extractMessageContent(data);
        const titles = parseAiTitles(content);
        if (!titles.length) {
          lastError = 'AI returned no titles';
          console.warn(`ai recommend empty titles (${model}):`, content.slice(0, 200));
          continue;
        }

        return res.json({ titles, model });
      } catch (err) {
        lastError = err?.message || 'OpenRouter request failed';
        console.warn(`ai recommend model error (${model}):`, lastError);
      }
    }

    return res.status(502).json({ error: String(lastError) });
  } catch (err) {
    console.error('ai recommend failed', err);
    res.status(500).json({ error: 'Could not get AI recommendations' });
  }
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

    const rememberMe = wantsRememberMe(body);
    const token = signToken(user, rememberMe);
    res.status(201).json({ token, user: publicUser(user), rememberMe });
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

    const rememberMe = wantsRememberMe(body);
    const token = signToken(user, rememberMe);
    res.json({ token, user: publicUser(user), rememberMe });
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

/** Admin only: read another user's watch history / watchlist (read-only) */
app.get('/auth/admin/users/:userId/library', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'Missing user id' });
    }
    const user = await store.findUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const library = await store.getUserLibrary(userId);
    res.json({ user: publicUser(user), library });
  } catch (err) {
    console.error('admin user library failed', err);
    res.status(500).json({ error: 'Could not load user library' });
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
  if (hasMongoConfig) {
    try {
      await connectMongo(MONGODB_URI || 'mongodb+srv://from-parts');
      console.log('Connected to MongoDB');
    } catch (err) {
      // Keep the API alive on Render while Atlas access is fixed
      console.error(err && err.message ? err.message : err);
      console.error(
        'Falling back to JSON file storage. Fix Atlas Network Access (allow 0.0.0.0/0), then redeploy.'
      );
      // Clear URI for this process so store.useMongo() is false
      delete process.env.MONGODB_URI;
      delete process.env.MONGODB_USER;
      delete process.env.MONGODB_PASSWORD;
      delete process.env.MONGODB_HOST;
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
