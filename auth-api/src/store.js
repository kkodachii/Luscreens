/**
 * Storage for users + libraries.
 * Uses MongoDB when MONGODB_URI is set; otherwise JSON files (local only).
 */
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');

function useMongo() {
  return !!(
    process.env.MONGODB_URI ||
    (process.env.MONGODB_USER && process.env.MONGODB_PASSWORD && process.env.MONGODB_HOST)
  );
}

function ensureFileStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, '[]', 'utf8');
  }
  if (!fs.existsSync(LIBRARY_FILE)) {
    fs.writeFileSync(LIBRARY_FILE, '{}', 'utf8');
  }
}

function readUsersFile() {
  ensureFileStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeUsersFile(users) {
  ensureFileStore();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function readLibraryFile() {
  ensureFileStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLibraryFile(library) {
  ensureFileStore();
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(library), 'utf8');
}

function emptyLibrary() {
  return {
    progress: {},
    watchlist: {},
    updatedAt: null,
  };
}

async function findUserByEmail(email) {
  if (useMongo()) {
    return getDb().collection('users').findOne({ email });
  }
  return readUsersFile().find((u) => u.email === email) || null;
}

async function findUserById(id) {
  if (useMongo()) {
    return getDb().collection('users').findOne({ id });
  }
  return readUsersFile().find((u) => u.id === id) || null;
}

async function createUser(user) {
  if (useMongo()) {
    await getDb().collection('users').insertOne({
      id: user.id,
      email: user.email,
      name: user.name,
      passwordHash: user.passwordHash,
      createdAt: user.createdAt,
    });
    return user;
  }
  const users = readUsersFile();
  users.push(user);
  writeUsersFile(users);
  return user;
}

async function listUsers() {
  if (useMongo()) {
    return getDb()
      .collection('users')
      .find({}, { projection: { _id: 0, passwordHash: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
  }
  return readUsersFile()
    .map(({ passwordHash, ...rest }) => rest)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function getUserLibrary(userId) {
  if (useMongo()) {
    const entry = await getDb().collection('libraries').findOne({ userId });
    if (!entry) {
      return emptyLibrary();
    }
    return {
      progress: entry.progress && typeof entry.progress === 'object' ? entry.progress : {},
      watchlist: entry.watchlist && typeof entry.watchlist === 'object' ? entry.watchlist : {},
      updatedAt: entry.updatedAt || null,
    };
  }

  const library = readLibraryFile();
  const entry = library[userId] || {};
  return {
    progress: entry.progress && typeof entry.progress === 'object' ? entry.progress : {},
    watchlist: entry.watchlist && typeof entry.watchlist === 'object' ? entry.watchlist : {},
    updatedAt: entry.updatedAt || null,
  };
}

async function setUserLibrary(userId, patch) {
  const current = await getUserLibrary(userId);
  const next = {
    progress:
      patch.progress && typeof patch.progress === 'object'
        ? patch.progress
        : current.progress || {},
    watchlist:
      patch.watchlist && typeof patch.watchlist === 'object'
        ? patch.watchlist
        : current.watchlist || {},
    updatedAt: Date.now(),
  };

  if (useMongo()) {
    await getDb().collection('libraries').updateOne(
      { userId },
      { $set: { userId, ...next } },
      { upsert: true }
    );
    return next;
  }

  const library = readLibraryFile();
  library[userId] = next;
  writeLibraryFile(library);
  return next;
}

function storageMode() {
  return useMongo() ? 'mongodb' : 'json-file';
}

module.exports = {
  useMongo,
  storageMode,
  findUserByEmail,
  findUserById,
  createUser,
  listUsers,
  getUserLibrary,
  setUserLibrary,
  ensureFileStore,
};
