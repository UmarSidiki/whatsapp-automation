"use strict";

const logger = require("../config/logger");
const { connectMongo, getCollection } = require("./mongoService");

let initialized = false;

async function ensureIndexes() {
  if (initialized) {
    return;
  }

  await connectMongo();
  const collection = getCollection("personas");
  await collection.createIndex({ sessionCode: 1, timestamp: -1 }, { background: true });
  await collection.createIndex({ sessionCode: 1 }, { background: true });
  initialized = true;
}

async function savePersonaMessage(sessionCode, message) {
  if (!sessionCode || !message || typeof message !== "string") {
    return;
  }

  try {
    await ensureIndexes();
    const collection = getCollection("personas");

    await collection.insertOne({
      sessionCode,
      message: message.trim(),
      timestamp: new Date(),
    });

    // Keep only the most recent 700 messages per session
    const count = await collection.countDocuments({ sessionCode });
    if (count > 700) {
      const toDelete = count - 700;
      const oldestDocs = await collection
        .find({ sessionCode })
        .sort({ timestamp: 1 })
        .limit(toDelete)
        .toArray();

      if (oldestDocs.length) {
        await collection.deleteMany({
          _id: { $in: oldestDocs.map(doc => doc._id) }
        });
      }
    }
  } catch (error) {
    logger.error({ err: error, sessionCode }, "Failed to save persona message");
  }
}

async function loadPersonaMessages(sessionCode, limit = 500) {
  if (!sessionCode) {
    return [];
  }

  try {
    await ensureIndexes();
    const collection = getCollection("personas");

    const docs = await collection
      .find({ sessionCode })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    return docs.map(doc => doc.message).reverse(); // Return in chronological order
  } catch (error) {
    logger.error({ err: error, sessionCode }, "Failed to load persona messages");
    return [];
  }
}

async function clearPersonaMessages(sessionCode) {
  if (!sessionCode) {
    return;
  }

  try {
    await ensureIndexes();
    const collection = getCollection("personas");
    await collection.deleteMany({ sessionCode });
  } catch (error) {
    logger.error({ err: error, sessionCode }, "Failed to clear persona messages");
  }
}

module.exports = {
  savePersonaMessage,
  loadPersonaMessages,
  clearPersonaMessages,
};