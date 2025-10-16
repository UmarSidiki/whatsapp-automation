"use strict";

const logger = require("../../config/logger");
const { connectMongo, getCollection } = require("../mongoService");

const MAX_MESSAGES_PER_CONTACT = 100;
const FLUSH_INTERVAL_MS = 30_000;
const MAX_BUFFER_SIZE = MAX_MESSAGES_PER_CONTACT * 2;
const MAX_TOTAL_PENDING_MESSAGES = 10000; // Global limit

let initialized = false;
let flushTimer = null;
let flushPromise = null;

const pendingMessages = new Map();

async function ensureIndexes() {
  if (initialized) return;

  await connectMongo();

  const contacts = getCollection("contacts");

  await Promise.all([
    contacts.createIndex({ sessionCode: 1, contactId: 1 }, { unique: true }),
    contacts.createIndex({ sessionCode: 1, lastMessageAt: -1 }),
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

  // Do not store group chat messages for AI enhancement
  if (typeof contactId === "string" && contactId.includes("@g.us")) {
    return;
  }

  // Check global pending messages limit
  let totalPending = 0;
  for (const buffer of pendingMessages.values()) {
    totalPending += buffer.length;
  }
  if (totalPending >= MAX_TOTAL_PENDING_MESSAGES) {
    logger.warn(
      { totalPending, max: MAX_TOTAL_PENDING_MESSAGES },
      "Pending messages limit reached, dropping message"
    );
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

  for (const batch of batches) {
    await persistBatch(contacts, batch);
  }
}
/**
 * Load past messages from persistence for a given session and contact.
 * @param {string} sessionCode
 * @param {string} contactId
 * @param {{limit?: number}} options
 * @returns {Promise<Array<{role: string, text: string, timestamp: Date}>>}
 */
async function loadMessages(sessionCode, contactId, { limit = MAX_MESSAGES_PER_CONTACT } = {}) {
  await ensureIndexes();
  const contacts = getCollection("contacts");
  const doc = await contacts.findOne(
    { sessionCode, contactId },
    { projection: { messages: 1 } }
  );
  if (!doc || !Array.isArray(doc.messages)) return [];
  return doc.messages.slice(-limit).map(entry => ({
    role: entry.direction === "incoming" ? "user" : "assistant",
    text: entry.message,
    timestamp: entry.timestamp,
  }));
}

async function persistBatch(contacts, batch) {
  const { sessionCode, contactId, messages } = batch;
  if (!messages.length) {
    return;
  }

  const entries = messages
    .map((entry) => ({
      direction: entry.direction,
      message: entry.message,
      timestamp: normalizeTimestamp(entry.timestamp),
    }))
    .filter((entry) => entry.message);

  if (!entries.length) {
    return;
  }

  const directionCounts = entries.reduce((acc, entry) => {
    acc[entry.direction] = (acc[entry.direction] || 0) + 1;
    return acc;
  }, {});

  const first = entries[0];
  const last = entries[entries.length - 1];
  const increments = { messageCount: entries.length };
  for (const [direction, count] of Object.entries(directionCounts)) {
    increments[`counts.${direction}`] = count;
  }

  const update = {
    $setOnInsert: {
      createdAt: first.timestamp,
      firstDirection: first.direction,
    },
    $set: {
      lastMessageAt: last.timestamp,
      lastDirection: last.direction,
      updatedAt: last.timestamp,
    },
    $inc: increments,
    $push: {
      messages: {
        $each: entries,
        $slice: -MAX_MESSAGES_PER_CONTACT,
      },
    },
  };

  await contacts.updateOne({ sessionCode, contactId }, update, { upsert: true });
}

module.exports = {
  queueMessageForPersistence,
  flushQueuedMessages,
  flushSessionMessages,
  shutdownPersistence,
  loadMessages,
  MAX_MESSAGES_PER_CONTACT,
};
