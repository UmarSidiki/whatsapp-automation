import logger from "../../config/logger";
import { connectMongo, getCollection } from "../database/mongoService";
import type { Collection, Document } from "mongodb";

export const MAX_MESSAGES_PER_CONTACT = 1000;
const FLUSH_INTERVAL_MS = 30_000;
const MAX_BUFFER_SIZE = MAX_MESSAGES_PER_CONTACT * 2;
const MAX_TOTAL_BUFFER_SIZE = 10000; // Global limit across all contacts to prevent unbounded growth

let initialized = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushPromise: Promise<void> | null = null;

type Direction = "incoming" | "outgoing";

interface MessageEntry {
  sessionCode: string;
  contactId: string;
  direction: Direction;
  message: string;
  timestamp: Date;
  isAiGenerated?: boolean; // Track if message is AI-generated
}

interface Batch {
  sessionCode: string;
  contactId: string;
  messages: MessageEntry[];
}

/** In-memory buffer: `${sessionCode}::${contactId}` → MessageEntry[] */
const pendingMessages = new Map<string, MessageEntry[]>();

/* -------------------------------------------------------------------------- */
/*                               DB Preparation                               */
/* -------------------------------------------------------------------------- */
async function ensureIndexes(): Promise<void> {
  if (initialized) return;

  await connectMongo();

  const contacts = getCollection<Document>("contacts");
  const universal = getCollection<Document>("universalPersonas");

  await Promise.all([
    contacts.createIndex({ sessionCode: 1, contactId: 1 }, { unique: true }),
    contacts.createIndex({ sessionCode: 1, lastMessageAt: -1 }),
    universal.createIndex({ sessionCode: 1 }, { unique: true }),
  ]);

  initialized = true;
}

/* -------------------------------------------------------------------------- */
/*                                   Utils                                    */
/* -------------------------------------------------------------------------- */
function sanitizeMessage(input: unknown): string {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  return trimmed.length <= 4000 ? trimmed : trimmed.slice(0, 4000);
}

function normalizeTimestamp(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const parsed = new Date(String(value));
  return !Number.isNaN(parsed.getTime()) ? parsed : new Date();
}

function getBufferKey(sessionCode: string, contactId: string): string {
  return `${sessionCode}::${contactId}`;
}

function startFlushTimer(): void {
  if (flushTimer) return;

  flushTimer = setInterval(() => {
    flushQueuedMessages().catch((err) => {
      logger.error({ err }, "Periodic chat persistence flush failed");
    });
  }, FLUSH_INTERVAL_MS);

  // allow Node to exit naturally
  const t = flushTimer as any;
  if (typeof t.unref === "function") t.unref();
}

/* -------------------------------------------------------------------------- */
/*                                Public API                                  */
/* -------------------------------------------------------------------------- */

export function queueMessageForPersistence({
  sessionCode,
  contactId,
  direction,
  message,
  timestamp = new Date(),
  isGroup = false,
  isBroadcast = false,
  hasMedia = false,
  isAiGenerated = false,
}: {
  sessionCode: string;
  contactId: string;
  direction: Direction;
  message: unknown;
  timestamp?: unknown;
  isGroup?: boolean;
  isBroadcast?: boolean;
  hasMedia?: boolean;
  isAiGenerated?: boolean;
}): void {
  // skip invalid or non-personal chats
  if (!sessionCode || !contactId || !direction) return;
  if (isGroup || isBroadcast || hasMedia) return;
  
  // Additional safety: skip status/broadcast/newsletter messages by chatId pattern
  if (typeof contactId === "string") {
    if (contactId.includes("@broadcast")) return;
    if (contactId.includes("status@broadcast")) return;
    if (contactId.includes("@newsletter")) return;
  }

  const safeMessage = sanitizeMessage(message);
  if (!safeMessage) return;

  // --- MEMORY LEAK FIX ---
  // Check total buffer size across all contacts before adding
  let totalBufferSize = 0;
  for (const buf of pendingMessages.values()) {
    totalBufferSize += buf.length;
  }

  if (totalBufferSize >= MAX_TOTAL_BUFFER_SIZE) {
    logger.warn(
      { totalBufferSize, maxSize: MAX_TOTAL_BUFFER_SIZE },
      "Global message buffer limit reached, forcing immediate flush"
    );
    // Force immediate flush to prevent memory overflow
    flushQueuedMessages().catch((error) => {
      logger.error({ err: error }, "Emergency flush failed, dropping oldest messages");
      // Emergency: drop oldest messages from largest buffers
      const sorted = Array.from(pendingMessages.entries())
        .sort((a, b) => b[1].length - a[1].length);
      for (let i = 0; i < Math.min(3, sorted.length); i++) {
        const [key, buf] = sorted[i];
        buf.splice(0, Math.floor(buf.length / 2));
        logger.warn({ key, remaining: buf.length }, "Dropped messages to prevent memory overflow");
      }
    });
  }
  // --- END FIX ---

  const key = getBufferKey(sessionCode, contactId);
  const buffer: MessageEntry[] = pendingMessages.get(key) ?? [];

  buffer.push({
    sessionCode,
    contactId,
    direction,
    message: safeMessage,
    timestamp: normalizeTimestamp(timestamp),
    isAiGenerated,
  });

  // Keep memory bounded per contact
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
  }

  pendingMessages.set(key, buffer);
  startFlushTimer();

  // If we hit 1000, flush immediately for that contact
  if (buffer.length >= MAX_MESSAGES_PER_CONTACT) {
    flushQueuedMessages().catch((error) => {
      logger.error(
        { err: error, sessionCode, contactId },
        "Immediate flush failed"
      );
    });
  }
}

/** Flush all pending messages */
export async function flushQueuedMessages(): Promise<void> {
  if (flushPromise) return flushPromise;
  if (!pendingMessages.size) return;

  const batches = drainPendingMessages();
  flushPromise = persistBatches(batches)
    .catch((error) => {
      batches.forEach(requeueBatch);
      throw error;
    })
    .finally(() => {
      flushPromise = null;
    });

  return flushPromise;
}

/** Flush messages of a single session only */
export async function flushSessionMessages(sessionCode: string): Promise<void> {
  if (!sessionCode) return;

  const batches = drainPendingMessages((s) => s === sessionCode);
  if (!batches.length) return;

  await persistBatches(batches).catch((error) => {
    batches.forEach(requeueBatch);
    throw error;
  });
}

/** Graceful shutdown */
export async function shutdownPersistence(): Promise<void> {
  // --- MEMORY LEAK FIX ---
  // Clear timer first to prevent new flushes during shutdown
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  // Wait for any in-flight flush to complete
  if (flushPromise) {
    try {
      await flushPromise;
    } catch (error) {
      logger.error({ err: error }, "In-flight flush failed during shutdown");
    }
  }

  // Final flush of remaining messages
  await flushQueuedMessages();

  // Clear the buffer to release memory
  pendingMessages.clear();
  // --- END FIX ---
}

/* -------------------------------------------------------------------------- */
/*                             Internal Batch Logic                           */
/* -------------------------------------------------------------------------- */
type DrainFilter = (sessionCode: string, contactId: string) => boolean;

function drainPendingMessages(filter?: DrainFilter): Batch[] {
  const drained: Batch[] = [];

  for (const [key, messages] of pendingMessages.entries()) {
    const [sessionCode, contactId] = key.split("::");
    if (filter && !filter(sessionCode, contactId)) continue;

    pendingMessages.delete(key);
    drained.push({ sessionCode, contactId, messages });
  }
  return drained;
}

function requeueBatch(batch: Batch): void {
  const { sessionCode, contactId, messages } = batch;
  if (!messages?.length) return;

  const key = getBufferKey(sessionCode, contactId);
  const buffer: MessageEntry[] = pendingMessages.get(key) ?? [];

  buffer.push(...messages);
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
  }
  pendingMessages.set(key, buffer);
}

/* -------------------------------------------------------------------------- */
/*                              Persistence Logic                             */
/* -------------------------------------------------------------------------- */

async function persistBatches(batches: Batch[]): Promise<void> {
  if (!batches.length) return;

  await ensureIndexes();
  const contactsColl = getCollection<Document>("contacts");

  // Group my replies per session
  const universalBySession = new Map<string, string[]>();

  for (const batch of batches) {
    await persistBatch(contactsColl, batch);

    // Track ONLY human-written outgoing messages (exclude AI-generated)
    const myReplies = batch.messages
      .filter((e) => e.direction === "outgoing" && !e.isAiGenerated)
      .map((e) => e.message);

    if (myReplies.length) {
      const existing = universalBySession.get(batch.sessionCode) ?? [];
      existing.push(...myReplies);
      universalBySession.set(batch.sessionCode, existing);
    }
  }

  // Update universal personas
  await Promise.all(
    Array.from(universalBySession.entries()).map(([sessionCode, msgs]) =>
      updateUniversalPersona(sessionCode, msgs)
    )
  );
}

/** One doc per contact (1000 latest text messages) */
async function persistBatch(
  contacts: Collection<Document>,
  batch: Batch
): Promise<void> {
  const { sessionCode, contactId, messages } = batch;
  if (!messages.length) return;

  // Format messages with clear labels
  // - "User: " for incoming messages
  // - "My reply: " for human-written outgoing messages
  // - "AI reply: " for AI-generated outgoing messages
  const entries = messages
    .filter((m) => m.message && typeof m.message === "string")
    .map((m) => ({
      message:
        m.direction === "incoming"
          ? `User: ${m.message}`
          : m.isAiGenerated
          ? `AI reply: ${m.message}`
          : `My reply: ${m.message}`,
      timestamp: normalizeTimestamp(m.timestamp),
      direction: m.direction, // Keep direction for filtering
      isAiGenerated: m.isAiGenerated, // Keep AI flag for filtering
    }));

  if (!entries.length) return;

  const first = entries[0];
  const last = entries[entries.length - 1];

  // Store entries without direction field in DB
  const dbEntries = entries.map(({ message, timestamp }) => ({
    message,
    timestamp,
  }));

  const update = {
    $setOnInsert: { createdAt: first.timestamp },
    $set: { lastMessageAt: last.timestamp, updatedAt: last.timestamp },
    $inc: { messageCount: entries.length },
    $push: {
      messages: { $each: dbEntries, $slice: -MAX_MESSAGES_PER_CONTACT },
    },
  } as const;

  await contacts.updateOne({ sessionCode, contactId }, update as any, {
    upsert: true,
  });
}

/* -------------------------------------------------------------------------- */
/*                              Retrieval Helpers                             */
/* -------------------------------------------------------------------------- */

export async function getChatMessages(
  sessionCode: string,
  contactId: string
): Promise<{ message: string; timestamp: Date }[]> {
  if (!sessionCode || !contactId) return [];

  await connectMongo();
  const contacts = getCollection<Document>("contacts");

  const doc = await contacts.findOne({ sessionCode, contactId });
  if (!doc || !Array.isArray(doc.messages)) return [];

  return doc.messages
    .map((e: any) => ({
      message: String(e.message ?? ""),
      timestamp: new Date(e.timestamp),
    }))
    .filter((e) => e.message);
}

export async function getUniversalPersona(
  sessionCode: string
): Promise<string[]> {
  if (!sessionCode) return [];

  await connectMongo();
  const universal = getCollection<Document>("universalPersonas");

  const doc = await universal.findOne({ sessionCode });
  if (!doc || !Array.isArray(doc.messages)) return [];

  return doc.messages as string[];
}

/* -------------------------------------------------------------------------- */
/*                       Universal Persona Maintenance                        */
/* -------------------------------------------------------------------------- */

export async function updateUniversalPersona(
  sessionCode: string,
  newMessages: string[]
): Promise<void> {
  if (!sessionCode || !newMessages.length) return;

  await connectMongo();
  const universal = getCollection<Document>("universalPersonas");

  const update = {
    $push: { messages: { $each: newMessages, $slice: -1000 } },
    $set: { updatedAt: new Date() },
  };

  await universal.updateOne({ sessionCode }, update, { upsert: true });
}

/* -------------------------------------------------------------------------- */
/*                                  Exports                                   */
/* -------------------------------------------------------------------------- */

export default {
  queueMessageForPersistence,
  flushQueuedMessages,
  flushSessionMessages,
  shutdownPersistence,
  getChatMessages,
  getUniversalPersona,
  updateUniversalPersona,
  MAX_MESSAGES_PER_CONTACT,
};
