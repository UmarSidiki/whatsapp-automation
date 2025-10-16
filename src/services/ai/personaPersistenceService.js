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

async function savePersonaMessage(sessionCode, data) {
  if (!sessionCode || !data) {
    return;
  }

  try {
    await ensureIndexes();
    const collection = getCollection("personas");

    let document;
    if (typeof data === "string") {
      // Backward compatibility: if string, treat as outgoing message only
      const trimmedMessage = data.trim();
      if (!trimmedMessage) return;
      document = {
        sessionCode,
        outgoing: trimmedMessage,
        timestamp: new Date(),
      };
    } else if (typeof data === "object") {
      // New format: conversation pair
      const { incoming, outgoing } = data;
      if (!outgoing || typeof outgoing !== "string") return;
      const trimmedOutgoing = outgoing.trim();
      if (!trimmedOutgoing) return;
      document = {
        sessionCode,
        incoming: incoming && typeof incoming === "string" ? incoming.trim() : null,
        outgoing: trimmedOutgoing,
        timestamp: new Date(),
      };
    } else {
      return;
    }

    // Insert new message
    await collection.insertOne(document);

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

    // Return in chronological order, supporting both old and new formats
    return docs.map(doc => ({
      incoming: doc.incoming || null,
      outgoing: doc.outgoing || doc.message || "", // Fallback for old format
      timestamp: doc.timestamp,
    })).reverse();
  } catch (error) {
    logger.error({ err: error, sessionCode }, "Failed to load persona messages");
    return [];
  }
}


module.exports = {
  savePersonaMessage,
  loadPersonaMessages,
};