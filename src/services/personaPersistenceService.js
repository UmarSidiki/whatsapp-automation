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

    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;

    // Insert new message
    await collection.insertOne({
      sessionCode,
      message: trimmedMessage,
      timestamp: new Date(),
    });

    // Efficient cleanup: delete messages beyond the 1000th most recent
    // This uses MongoDB's aggregation pipeline for better performance
    const pipeline = [
      { $match: { sessionCode } },
      { $sort: { timestamp: -1 } },
      { $skip: 1000 },
      { $project: { _id: 1 } }
    ];

    const toDelete = await collection.aggregate(pipeline).toArray();
    if (toDelete.length > 0) {
      await collection.deleteMany({
        _id: { $in: toDelete.map(doc => doc._id) }
      });
    }
  } catch (error) {
    logger.error({ err: error, sessionCode }, "Failed to save persona message");
  }
}

async function loadPersonaMessages(sessionCode, limit = 1000) {
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


module.exports = {
  savePersonaMessage,
  loadPersonaMessages,
};