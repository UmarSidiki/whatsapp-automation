"use strict";

const logger = require("../config/logger");
const { MIN_SCHEDULE_DELAY_MS, MAX_SCHEDULE_DELAY_MS, SCHEDULE_RETRY_DELAY_MS } = require("../constants");
const { saveScheduledJob, updateScheduledJob, deleteScheduledJob, listScheduledJobs } = require("./schedulePersistenceService");

/**
 * Ensure scheduled jobs map exists for session
 */
function ensureScheduledJobs(session) {
  if (!session.scheduledJobs) {
    session.scheduledJobs = new Map();
  }
  return session.scheduledJobs;
}

/**
 * Schedule messages for future sending
 */
async function scheduleMessages(session, payload, sessionCode) {
  const numbers = normalizeNumbers(payload.numbers);
  if (!numbers.length) {
    throw new Error("No valid numbers provided");
  }

  const sendAtMs = payload.sendAt.getTime();
  const delay = sendAtMs - Date.now();
  if (delay < MIN_SCHEDULE_DELAY_MS) {
    throw new Error("Schedule time must be at least 10 seconds in the future");
  }
  if (delay > MAX_SCHEDULE_DELAY_MS) {
    throw new Error("Schedule time cannot be more than 7 days ahead");
  }

  const jobs = ensureScheduledJobs(session);
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const job = {
    id: jobId,
    message: payload.message,
    numbers,
    sendAt: new Date(sendAtMs).toISOString(),
    createdAt: new Date().toISOString(),
    status: "scheduled",
    results: [],
  };

  jobs.set(jobId, job);
  scheduleJobExecution(sessionCode, session, job);

  try {
    await saveScheduledJob(sessionCode, job);
  } catch (error) {
    logger.error(
      { err: error, sessionCode, jobId },
      "Failed to persist scheduled message"
    );
  }

  return serializeScheduledJob(job);
}

/**
 * Get all scheduled messages for session
 */
async function getScheduledMessages(sessionCode) {
  try {
    const documents = await listScheduledJobs(sessionCode);
    return documents.map((doc) => serializeScheduledJob(documentToJob(doc)));
  } catch (error) {
    logger.error({ err: error, sessionCode }, "Failed to list scheduled messages");
    throw new Error("Failed to load scheduled messages");
  }
}

/**
 * Cancel a scheduled message
 */
async function cancelScheduledMessage(session, sessionCode, jobId) {
  const jobs = ensureScheduledJobs(session);
  const job = jobs.get(jobId);
  if (!job) {
    throw new Error("Scheduled message not found");
  }

  if (job.timeoutId) {
    clearTimeout(job.timeoutId);
    job.timeoutId = null;
  }

  if (job.status === "scheduled" || job.status === "sending") {
    job.status = "cancelled";
    job.cancelledAt = new Date().toISOString();
    job.error = undefined;
    try {
      await updateScheduledJob(sessionCode, jobId, {
        status: job.status,
        cancelledAt: new Date(job.cancelledAt),
        error: null,
      });
    } catch (error) {
      logger.error(
        { err: error, sessionCode, jobId },
        "Failed to persist cancellation"
      );
    }
  }

  return serializeScheduledJob(job);
}

/**
 * Remove a scheduled message
 */
async function removeScheduledMessage(session, sessionCode, jobId) {
  const jobs = ensureScheduledJobs(session);
  const job = jobs.get(jobId);
  if (!job) {
    throw new Error("Scheduled message not found");
  }

  if (job.status === "sending") {
    const error = new Error("Cannot remove a job that is currently sending");
    error.statusCode = 409;
    throw error;
  }

  if (job.timeoutId) {
    clearTimeout(job.timeoutId);
  }

  jobs.delete(jobId);

  try {
    const removed = await deleteScheduledJob(sessionCode, jobId);
    if (!removed) {
      logger.warn(
        { sessionCode, jobId },
        "Scheduled message not found in persistence while removing"
      );
    }
  } catch (error) {
    logger.error(
      { err: error, sessionCode, jobId },
      "Failed to delete scheduled message"
    );
  }

  return serializeScheduledJob(job);
}

/**
 * Schedule job execution
 */
function scheduleJobExecution(sessionCode, session, job, overrideDelay) {
  if (job.status !== "scheduled") {
    return;
  }

  if (job.timeoutId) {
    clearTimeout(job.timeoutId);
    job.timeoutId = null;
  }

  const sendTime = new Date(job.sendAt).getTime();
  const delay =
    typeof overrideDelay === "number"
      ? Math.max(overrideDelay, 0)
      : Math.max(sendTime - Date.now(), 0);

  const run = async () => {
    job.timeoutId = null;
    job.status = "sending";
    job.error = undefined;

    try {
      await updateScheduledJob(sessionCode, job.id, {
        status: "sending",
        error: null,
      });
    } catch (error) {
      logger.error(
        { err: error, sessionCode, jobId: job.id },
        "Failed to mark job as sending"
      );
    }

    if (!session.ready) {
      job.status = "scheduled";
      try {
        await updateScheduledJob(sessionCode, job.id, { status: "scheduled" });
      } catch (error) {
        logger.error(
          { err: error, sessionCode, jobId: job.id },
          "Failed to reschedule job while client not ready"
        );
      }
      scheduleJobExecution(sessionCode, session, job, SCHEDULE_RETRY_DELAY_MS);
      return;
    }

    try {
      const results = await performBulkSend(session, job.message, job.numbers, sessionCode);
      job.status = "sent";
      job.sentAt = new Date().toISOString();
      job.results = results;
      try {
        await updateScheduledJob(sessionCode, job.id, {
          status: "sent",
          sentAt: new Date(job.sentAt),
          results,
          error: null,
        });
      } catch (error) {
        logger.error(
          { err: error, sessionCode, jobId: job.id },
          "Failed to persist sent job state"
        );
      }
    } catch (error) {
      job.status = "failed";
      job.error = error.message;
      job.sentAt = new Date().toISOString();
      try {
        await updateScheduledJob(sessionCode, job.id, {
          status: "failed",
          error: error.message,
          sentAt: new Date(job.sentAt),
        });
      } catch (persistError) {
        logger.error(
          { err: persistError, sessionCode, jobId: job.id },
          "Failed to persist failed job state"
        );
      }
      logger.error(
        { err: error, sessionCode, jobId: job.id },
        "Scheduled message failed"
      );
    }
  };

  const runner = () => {
    run().catch((error) => {
      logger.error(
        { err: error, sessionCode, jobId: job.id },
        "Scheduled message execution error"
      );
    });
  };

  if (delay > 0) {
    job.timeoutId = setTimeout(runner, delay);
    if (job.timeoutId && typeof job.timeoutId.unref === "function") {
      job.timeoutId.unref();
    }
  } else {
    setImmediate(runner);
  }
}

/**
 * Clear all scheduled jobs for session
 */
function clearScheduledJobs(session) {
  if (!session.scheduledJobs) {
    return;
  }
  for (const job of session.scheduledJobs.values()) {
    if (job.timeoutId) {
      clearTimeout(job.timeoutId);
    }
  }
  session.scheduledJobs.clear();
}

/**
 * Hydrate scheduled jobs from persistence
 */
async function hydrateScheduledJobs(sessionCode, session) {
  const jobs = ensureScheduledJobs(session);
  jobs.clear();

  try {
    const documents = await listScheduledJobs(sessionCode);
    for (const doc of documents) {
      const job = documentToJob(doc);
      jobs.set(job.id, job);

      if (job.status === "sending") {
        job.status = "scheduled";
        job.error = undefined;
        try {
          await updateScheduledJob(sessionCode, job.id, {
            status: "scheduled",
            error: null,
          });
        } catch (error) {
          logger.error(
            { err: error, sessionCode, jobId: job.id },
            "Failed to reset in-flight job"
          );
        }
      }

      if (job.status === "scheduled") {
        scheduleJobExecution(sessionCode, session, job);
      }
    }
  } catch (error) {
    logger.error({ err: error, sessionCode }, "Failed to hydrate scheduled jobs");
  }
}

/**
 * Convert document to job object
 */
function documentToJob(doc) {
  const fallback = new Date();
  return {
    id: doc.jobId,
    message: doc.message,
    numbers: Array.isArray(doc.numbers) ? doc.numbers : [],
    sendAt: (doc.sendAt || fallback).toISOString(),
    createdAt: (doc.createdAt || fallback).toISOString(),
    status: doc.status || "scheduled",
    results: Array.isArray(doc.results) ? doc.results : [],
    error: doc.error || undefined,
    sentAt: doc.sentAt ? doc.sentAt.toISOString() : undefined,
    cancelledAt: doc.cancelledAt ? doc.cancelledAt.toISOString() : undefined,
    timeoutId: null,
  };
}

/**
 * Serialize job for API response
 */
function serializeScheduledJob(job) {
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    numbers: job.numbers,
    sendAt: job.sendAt,
    createdAt: job.createdAt,
    sentAt: job.sentAt,
    cancelledAt: job.cancelledAt,
    error: job.error,
    results: job.results,
  };
}

/**
 * Perform bulk send operation
 */
async function performBulkSend(session, message, numbers) {
  const results = [];
  for (const number of numbers) {
    try {
      await session.client.sendMessage(number, message);
      results.push({ number, success: true });
    } catch (error) {
      logger.error({ err: error, number }, "Failed to send message");
      results.push({ number, success: false, error: error.message });
    }
  }
  return results;
}

/**
 * Normalize phone numbers
 */
function normalizeNumbers(numbers) {
  if (!Array.isArray(numbers)) {
    return [];
  }

  const seen = new Set();
  const formatted = [];
  for (const raw of numbers) {
    const formattedNumber = formatPhoneNumber(raw);
    if (formattedNumber && !seen.has(formattedNumber)) {
      seen.add(formattedNumber);
      formatted.push(formattedNumber);
    }
  }
  return formatted;
}

/**
 * Format phone number
 */
function formatPhoneNumber(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return null;
  }
  if (/@(c|g)\.us$/i.test(value)) {
    return value;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length < 8) {
    return null;
  }
  return `${digits}@c.us`;
}

module.exports = {
  ensureScheduledJobs,
  scheduleMessages,
  getScheduledMessages,
  cancelScheduledMessage,
  removeScheduledMessage,
  scheduleJobExecution,
  clearScheduledJobs,
  hydrateScheduledJobs,
  documentToJob,
  serializeScheduledJob,
  performBulkSend,
  normalizeNumbers,
  formatPhoneNumber,
};