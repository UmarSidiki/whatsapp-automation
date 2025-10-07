"use strict";

const { ObjectId } = require("mongodb");
const logger = require("../config/logger");
const { connectMongo, getCollection } = require("./mongoService");

const MAX_MESSAGES_PER_CONTACT = 100;
const FLUSH_INTERVAL_MS = 30_000;
const MAX_BUFFER_SIZE = MAX_MESSAGES_PER_CONTACT * 2;

let initialized = false;
let flushTimer = null;
let flushPromise = null;

const pendingMessages = new Map();

async function ensureIndexes() {
  if (initialized) return;

  await connectMongo();

  const contacts = getCollection("contacts");
  const messages = getCollection("messages");

  await Promise.all([
    contacts.createIndex({ sessionCode: 1, contactId: 1 }, { unique: true }),
    contacts.createIndex({ messageCount: -1, lastMessageAt: -1 }),
    messages.createIndex({ sessionCode: 1, contactId: 1, timestamp: -1 }),
  ]);

  initialized = true;
}

function sanitizeMessage(input) {
  if (typeof input !== "string") {
    return "";
  }
  const trimmed = input.trim();
  if (trimmed.length <= 4000) {
    return trimmed;
  }
  return trimmed.slice(0, 4000);
}

function normalizeTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }
  return new Date();
}

function getBufferKey(sessionCode, contactId) {
  return `${sessionCode}::${contactId}`;
}

function startFlushTimer() {
  if (flushTimer) {
    return;
  }
  flushTimer = setInterval(() => {
    flushQueuedMessages().catch((error) => {
      logger.error({ err: error }, "Periodic chat persistence flush failed");
    });
  }, FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === "function") {
    flushTimer.unref();
  }
}

function queueMessageForPersistence({
  sessionCode,
  contactId,
  direction,
  message,
  timestamp = new Date(),
}) {
  if (!sessionCode || !contactId || !direction) {
    return;
  }

  const safeMessage = sanitizeMessage(message);
  const normalizedTimestamp = normalizeTimestamp(timestamp);
  const key = getBufferKey(sessionCode, contactId);
  const buffer = pendingMessages.get(key) || [];

  buffer.push({
    sessionCode,
    contactId,
    direction,
    message: safeMessage,
    timestamp: normalizedTimestamp,
  });

  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
  }

  pendingMessages.set(key, buffer);
  startFlushTimer();

  if (buffer.length >= MAX_MESSAGES_PER_CONTACT) {
    flushQueuedMessages().catch((error) => {
      logger.error({ err: error, sessionCode, contactId }, "Immediate chat flush failed");
    });
  }
}

async function flushQueuedMessages() {
  if (flushPromise) {
    return flushPromise;
  }
  if (!pendingMessages.size) {
    return;
  }

  const batches = drainPendingMessages();
  flushPromise = persistBatches(batches)
    .catch((error) => {
      // Requeue messages if persistence fails
      for (const batch of batches) {
        requeueBatch(batch);
      }
      throw error;
    })
    .finally(() => {
      flushPromise = null;
    });

  await flushPromise;
}

async function flushSessionMessages(sessionCode) {
  if (!sessionCode) {
    return;
  }
  const batches = drainPendingMessages((pendingSessionCode) => pendingSessionCode === sessionCode);
  if (!batches.length) {
    return;
  }
  try {
    await persistBatches(batches);
  } catch (error) {
    for (const batch of batches) {
      requeueBatch(batch);
    }
    throw error;
  }
}

async function shutdownPersistence() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushQueuedMessages();
}

function drainPendingMessages(filterFn) {
  const drained = [];
  for (const [key, messages] of pendingMessages.entries()) {
    const [sessionCode, contactId] = key.split("::");
    if (typeof filterFn === "function" && !filterFn(sessionCode, contactId)) {
      continue;
    }
    pendingMessages.delete(key);
    drained.push({ sessionCode, contactId, messages });
  }
  return drained;
}

function requeueBatch(batch) {
  if (!batch || !Array.isArray(batch.messages) || !batch.messages.length) {
    return;
  }
  const key = getBufferKey(batch.sessionCode, batch.contactId);
  const buffer = pendingMessages.get(key) || [];
  buffer.push(...batch.messages);
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
  }
  pendingMessages.set(key, buffer);
}

async function persistBatches(batches) {
  if (!batches.length) {
    return;
  }

  await ensureIndexes();
  const contacts = getCollection("contacts");
  const messages = getCollection("messages");

  for (const batch of batches) {
    await persistBatch(contacts, messages, batch);
  }
}

async function persistBatch(contacts, messagesCollection, batch) {
  const { sessionCode, contactId, messages } = batch;
  if (!messages.length) {
    return;
  }

  const docs = messages.map((entry) => ({
    _id: new ObjectId(),
    sessionCode,
    contactId,
    direction: entry.direction,
    message: entry.message,
    timestamp: normalizeTimestamp(entry.timestamp),
  }));

  const directionCounts = docs.reduce((acc, entry) => {
    acc[entry.direction] = (acc[entry.direction] || 0) + 1;
    return acc;
  }, {});

  const first = docs[0];
  const last = docs[docs.length - 1];
  const increments = { messageCount: docs.length };
  for (const [direction, count] of Object.entries(directionCounts)) {
    increments[`counts.${direction}`] = count;
  }

  await contacts.updateOne(
    { sessionCode, contactId },
    {
      $setOnInsert: {
        createdAt: first.timestamp,
        firstDirection: first.direction,
      },
      $set: {
        lastMessageAt: last.timestamp,
        lastDirection: last.direction,
      },
      $inc: increments,
    },
    { upsert: true }
  );

  try {
    await messagesCollection.insertMany(docs, { ordered: false });
  } catch (error) {
    logger.warn(
      { err: error, sessionCode, contactId },
      "Chat message insert encountered duplicates"
    );
  }

  await trimMessages(messagesCollection, sessionCode, contactId);
}

async function trimMessages(messagesCollection, sessionCode, contactId) {
  const cursor = messagesCollection
    .find({ sessionCode, contactId })
    .project({ _id: 1 })
    .sort({ timestamp: -1, _id: -1 })
    .skip(MAX_MESSAGES_PER_CONTACT);

  const stale = await cursor.toArray();
  if (!stale.length) {
    return;
  }

  const ids = stale.map((doc) => doc._id);
  await messagesCollection.deleteMany({ _id: { $in: ids } });
}

module.exports = {
  queueMessageForPersistence,
  flushQueuedMessages,
  flushSessionMessages,
  shutdownPersistence,
  MAX_MESSAGES_PER_CONTACT,
};
