const { MongoClient } = require('mongodb');

let client = null;
let db = null;

async function connectMongo(uri) {
  if (db) {
    return db;
  }
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15000,
  });
  await client.connect();
  db = client.db();
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('users').createIndex({ id: 1 }, { unique: true });
  await db.collection('libraries').createIndex({ userId: 1 }, { unique: true });
  return db;
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
};
