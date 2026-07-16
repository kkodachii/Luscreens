const { MongoClient, ServerApiVersion } = require('mongodb');

let client = null;
let db = null;

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

/**
 * Build URI from parts (avoids Render mangling passwords in a full URI).
 * Env: MONGODB_USER, MONGODB_PASSWORD, MONGODB_HOST
 */
function buildUriFromParts() {
  const user = process.env.MONGODB_USER;
  const password = process.env.MONGODB_PASSWORD;
  const host = (process.env.MONGODB_HOST || '')
    .replace(/^mongodb(\+srv)?:\/\//, '')
    .replace(/\/$/, '')
    .split('/')[0];
  if (!user || !password || !host) {
    return null;
  }
  // Match Atlas sample style (db selected after connect)
  return (
    `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}/?appName=Cluster0`
  );
}

/**
 * Encode user/password in a Mongo URI so special chars work on Render.
 */
function normalizeMongoUri(uri) {
  const fromParts = buildUriFromParts();
  const raw = String(fromParts || uri || '').trim();
  const match = raw.match(/^(mongodb(?:\+srv)?:\/\/)([^:/?#]+):([^@]+)@(.+)$/i);
  if (!match) {
    return raw;
  }

  const [, protocol, user, password, rest] = match;
  const decodedUser = safeDecode(user);
  const decodedPass = safeDecode(password);

  return `${protocol}${encodeURIComponent(decodedUser)}:${encodeURIComponent(decodedPass)}@${rest}`;
}

function maskMongoUri(uri) {
  return String(uri || '').replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

async function connectMongo(uri) {
  if (db) {
    return db;
  }

  const normalized = normalizeMongoUri(uri);
  console.log(`Connecting to MongoDB: ${maskMongoUri(normalized)}`);

  // Same options as Atlas "Connect → Drivers → Node.js" sample
  client = new MongoClient(normalized, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
    serverSelectionTimeoutMS: 20000,
    connectTimeoutMS: 20000,
  });

  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    const dbName = process.env.MONGODB_DB || 'luscreens';
    db = client.db(dbName);
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('users').createIndex({ id: 1 }, { unique: true });
    await db.collection('libraries').createIndex({ userId: 1 }, { unique: true });
    console.log(`MongoDB ping ok — using database "${dbName}"`);
    return db;
  } catch (err) {
    await closeMongo().catch(() => {});
    const tip = [
      'MongoDB connection failed.',
      '1) Atlas → Network Access → Add IP → Allow Access from Anywhere (0.0.0.0/0) — MUST be Active',
      '2) Do this on the SAME project as this cluster (y9bxwea)',
      '3) Database Access → user/password match Render env',
      '4) Cluster is not paused',
      `Error: ${err && err.message ? err.message : err}`,
    ].join('\n');
    const wrapped = new Error(tip);
    wrapped.cause = err;
    throw wrapped;
  }
}

function getDb() {
  if (!db) {
    throw new Error('MongoDB is not connected');
  }
  return db;
}

async function closeMongo() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = {
  connectMongo,
  getDb,
  closeMongo,
  normalizeMongoUri,
  maskMongoUri,
};
