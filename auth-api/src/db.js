const { MongoClient } = require('mongodb');

let client = null;
let db = null;

/**
 * Encode user/password in a Mongo URI so special chars like ! # @ work on Render.
 * Safe if the password is already percent-encoded.
 */
function normalizeMongoUri(uri) {
  const raw = String(uri || '').trim();
  const match = raw.match(/^(mongodb(?:\+srv)?:\/\/)([^:/?#]+):([^@]+)@(.+)$/i);
  if (!match) {
    return raw;
  }

  const [, protocol, user, password, rest] = match;
  let decodedUser = user;
  let decodedPass = password;
  try {
    decodedUser = decodeURIComponent(user);
  } catch {
    // keep as-is
  }
  try {
    decodedPass = decodeURIComponent(password);
  } catch {
    // keep as-is
  }

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
