const { MongoClient } = require('mongodb');

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
 * Build URI from parts (avoids Render mangling passwords with ! in a full URI).
 * Env: MONGODB_USER, MONGODB_PASSWORD, MONGODB_HOST (e.g. cluster0.zzf92lo.mongodb.net)
 */
function buildUriFromParts() {
  const user = process.env.MONGODB_USER;
  const password = process.env.MONGODB_PASSWORD;
  const host = (process.env.MONGODB_HOST || '').replace(/^mongodb(\+srv)?:\/\//, '').replace(/\/$/, '');
  const dbName = process.env.MONGODB_DB || 'luscreens';
  if (!user || !password || !host) {
    return null;
  }
  return (
    `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}/${dbName}?retryWrites=true&w=majority&appName=Cluster0`
  );
}

/**
 * Encode user/password in a Mongo URI so special chars like ! # @ work on Render.
 * Safe if the password is already percent-encoded.
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

  // Ensure a database name exists (Atlas often copies URI ending with / only)
  let hostAndPath = rest;
  const [pathPart, queryPart] = rest.split('?');
  const hostOnly = pathPart.replace(/\/$/, '');
  const pathAfterHost = hostOnly.includes('/') ? hostOnly.slice(hostOnly.indexOf('/') + 1) : '';
  if (!pathAfterHost) {
    const host = hostOnly;
    const qs = queryPart
      ? `?${queryPart}`
      : '?retryWrites=true&w=majority';
    hostAndPath = `${host}/luscreens${qs.startsWith('?') ? qs : `?${qs}`}`;
  }

  return `${protocol}${encodeURIComponent(decodedUser)}:${encodeURIComponent(decodedPass)}@${hostAndPath}`;
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

  client = new MongoClient(normalized, {
    serverSelectionTimeoutMS: 20000,
    connectTimeoutMS: 20000,
    // Render / some hosts break on IPv6 — force IPv4
    family: 4,
    autoSelectFamily: false,
  });

  try {
    await client.connect();
    db = client.db();
    await db.command({ ping: 1 });
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('users').createIndex({ id: 1 }, { unique: true });
    await db.collection('libraries').createIndex({ userId: 1 }, { unique: true });
    return db;
  } catch (err) {
    await closeMongo().catch(() => {});
    const tip = [
      'MongoDB connection failed.',
      '1) Atlas → Network Access → Add IP → Allow Access from Anywhere (0.0.0.0/0)',
      '2) Atlas → Database Access → user/password are correct',
      '3) MONGODB_URI password special chars are OK (app auto-encodes ! # etc.)',
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
