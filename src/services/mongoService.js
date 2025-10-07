"use strict";

const { MongoClient } = require("mongodb");
const env = require("../config/env");
const logger = require("../config/logger");

let client;
let db;

async function connectMongo() {
  if (db) {
    return db;
  }

  const uri = env.MONGO_URI;
  const dbName = env.MONGO_DB_NAME;

  if (!uri || !dbName) {
    throw new Error("MongoDB configuration missing");
  }

  client = new MongoClient(uri, {
    maxPoolSize: 10,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5000,
  });

  try {
    await client.connect();
    db = client.db(dbName);
    logger.info({ dbName }, "MongoDB connected");
    return db;
  } catch (error) {
    logger.fatal({ err: error }, "Failed to connect to MongoDB");
    throw error;
  }
}

function getDb() {
  if (!db) {
    throw new Error("MongoDB not initialized");
  }
  return db;
}

function getCollection(name) {
  const database = getDb();
  return database.collection(name);
}

async function closeMongo() {
  if (client) {
    try {
      await client.close();
      logger.info("MongoDB connection closed");
    } catch (error) {
      logger.error({ err: error }, "Failed to close MongoDB connection");
    } finally {
      client = null;
      db = null;
    }
  }
}

module.exports = {
  connectMongo,
  getDb,
  getCollection,
  closeMongo,
};
