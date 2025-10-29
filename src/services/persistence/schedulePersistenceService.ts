"use strict";

import { connectMongo, getCollection } from "../database/mongoService";

let initialized = false;

interface ScheduledJobUpdate {
  message?: string;
  numbers?: string[];
  sendAt?: any;
  status?: string;
  results?: any[];
  error?: any;
  sentAt?: any;
  cancelledAt?: any;
}

function toDate(value, fallback = null) {
  if (!value) {
    return fallback;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

async function ensureIndexes() {
  if (initialized) {
    return;
  }

  await connectMongo();
  const collection = getCollection("scheduledMessages");
  await Promise.all([
    collection.createIndex({ sessionCode: 1, jobId: 1 }, { unique: true }),
    collection.createIndex({ sessionCode: 1, sendAt: 1 }),
    collection.createIndex({ status: 1, sendAt: 1 }),
  ]);
  initialized = true;
}

async function saveScheduledJob(sessionCode, job) {
  await ensureIndexes();
  const collection = getCollection("scheduledMessages");
  const now = new Date();

  await collection.updateOne(
    { sessionCode, jobId: job.id },
    {
      $set: {
        message: job.message,
        numbers: Array.isArray(job.numbers) ? job.numbers : [],
        sendAt: toDate(job.sendAt, now),
        status: job.status,
        results: job.results || [],
        error: job.error,
        sentAt: toDate(job.sentAt),
        cancelledAt: toDate(job.cancelledAt),
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: toDate(job.createdAt, now),
      },
    },
    { upsert: true }
  );
}

async function updateScheduledJob(sessionCode, jobId, update: ScheduledJobUpdate) {
  await ensureIndexes();
  const collection = getCollection("scheduledMessages");
  const now = new Date();
  const normalized: any = { updatedAt: now };

  if (typeof update.message === "string") {
    normalized.message = update.message;
  }
  if (Array.isArray(update.numbers)) {
    normalized.numbers = update.numbers;
  }
  if (update.sendAt) {
    normalized.sendAt = toDate(update.sendAt, now);
  }
  if (update.status) {
    normalized.status = update.status;
  }
  if (update.results) {
    normalized.results = update.results;
  }
  if (Object.prototype.hasOwnProperty.call(update, "error")) {
    normalized.error = update.error;
  }
  if (update.sentAt) {
    normalized.sentAt = toDate(update.sentAt);
  }
  if (update.cancelledAt) {
    normalized.cancelledAt = toDate(update.cancelledAt);
  }

  await collection.updateOne({ sessionCode, jobId }, { $set: normalized });
}

async function deleteScheduledJob(sessionCode, jobId) {
  await ensureIndexes();
  const collection = getCollection("scheduledMessages");
  const result = await collection.deleteOne({ sessionCode, jobId });
  return result.deletedCount > 0;
}

async function listScheduledJobs(sessionCode) {
  await ensureIndexes();
  const collection = getCollection("scheduledMessages");
  return collection
    .find({ sessionCode })
    .sort({ sendAt: 1 })
    .toArray();
}

async function loadActiveScheduledJobs(sessionCode) {
  await ensureIndexes();
  const collection = getCollection("scheduledMessages");
  return collection
    .find({ sessionCode, status: { $in: ["scheduled", "sending"] } })
    .sort({ sendAt: 1 })
    .toArray();
}

export {
  saveScheduledJob,
  updateScheduledJob,
  deleteScheduledJob,
  listScheduledJobs,
  loadActiveScheduledJobs,
};
