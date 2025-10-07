"use strict";

const logger = require("../config/logger");
const { connectMongo, getCollection } = require("./mongoService");

let initialized = false;

async function ensureIndexes() {
  if (initialized) {
    return;
  }

  await connectMongo();
  const collection = getCollection("sessionConfigs");
  await collection.createIndex({ sessionCode: 1 }, { unique: true });
  initialized = true;
}

async function loadSessionConfig(sessionCode) {
  if (!sessionCode) {
    return null;
  }
  try {
    await ensureIndexes();
    const collection = getCollection("sessionConfigs");
    return await collection.findOne({ sessionCode });
  } catch (error) {
    logger.error({ err: error, sessionCode }, "Failed to load session config");
    return null;
  }
}

async function saveCustomReplies(sessionCode, customReplies) {
  if (!sessionCode) {
    throw new Error("sessionCode is required");
  }
  await ensureIndexes();
  const collection = getCollection("sessionConfigs");
  const now = new Date();

  await collection.updateOne(
    { sessionCode },
    {
      $set: {
        customReplies: Array.isArray(customReplies) ? customReplies : [],
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true }
  );
}

module.exports = {
  loadSessionConfig,
  saveCustomReplies,
};
