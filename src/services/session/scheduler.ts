import logger from "../../config/logger";
import { MIN_SCHEDULE_DELAY_MS, MAX_SCHEDULE_DELAY_MS } from "../../constants";
import { sessions } from "./sessionManager";
import { normalizeNumbers } from "./utils";

const SCHEDULE_RETRY_DELAY_MS = 5_000;

function ensureScheduledJobs(session) {
  if (!session.scheduledJobs) {
    session.scheduledJobs = new Map();
  }
  return session.scheduledJobs;
}

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

async function scheduleMessages(code, payload) {
  const session = sessions.get(code);
  if (!session) {
    throw new Error("Session not found");
  }
  if (!session.ready) {
    throw new Error("Session is not ready yet");
  }

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
  scheduleJobExecution(code, session, job, undefined);

  try {
    const { saveScheduledJob } = await import("../persistence/schedulePersistenceService");
    await saveScheduledJob(code, job);
  } catch (error) {
    logger.error(
      { err: error, code, jobId },
      "Failed to persist scheduled message"
    );
  }

  return serializeScheduledJob(job);
}

async function getScheduledMessages(code) {
  const session = sessions.get(code);
  if (!session) {
    throw new Error("Session not found");
  }

  try {
    const { listScheduledJobs } = await import("../persistence/schedulePersistenceService");
    const documents = await listScheduledJobs(code);
    return documents.map((doc) => serializeScheduledJob(documentToJob(doc)));
  } catch (error) {
    logger.error({ err: error, code }, "Failed to list scheduled messages");
    throw new Error("Failed to load scheduled messages");
  }
}

async function cancelScheduledMessage(code, jobId) {
  const session = sessions.get(code);
  if (!session) {
    throw new Error("Session not found");
  }
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
      const { updateScheduledJob } = await import("../persistence/schedulePersistenceService");
      await updateScheduledJob(code, jobId, {
        status: job.status,
        cancelledAt: new Date(job.cancelledAt),
        error: null,
      });
    } catch (error) {
      logger.error(
        { err: error, code, jobId },
        "Failed to persist cancellation"
      );
    }
  }

  return serializeScheduledJob(job);
}

async function removeScheduledMessage(code, jobId) {
  const session = sessions.get(code);
  if (!session) {
    throw new Error("Session not found");
  }
  const jobs = ensureScheduledJobs(session);
  const job = jobs.get(jobId);
  if (!job) {
    throw new Error("Scheduled message not found");
  }

  if (job.status === "sending") {
    const error = new Error("Cannot remove a job that is currently sending");
    (error as Error & { statusCode: number }).statusCode = 409;
    throw error;
  }

  if (job.timeoutId) {
    clearTimeout(job.timeoutId);
  }

  jobs.delete(jobId);

  try {
    const { deleteScheduledJob } = await import("../persistence/schedulePersistenceService");
    const removed = await deleteScheduledJob(code, jobId);
    if (!removed) {
      logger.warn(
        { code, jobId },
        "Scheduled message not found in persistence while removing"
      );
    }
  } catch (error) {
    logger.error(
      { err: error, code, jobId },
      "Failed to delete scheduled message"
    );
  }

  return serializeScheduledJob(job);
}

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

function scheduleJobExecution(code, session, job, overrideDelay) {
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
      const { updateScheduledJob } = await import("../persistence/schedulePersistenceService");
      await updateScheduledJob(code, job.id, {
        status: "sending",
        error: null,
      });
    } catch (error) {
      logger.error(
        { err: error, code, jobId: job.id },
        "Failed to mark job as sending"
      );
    }

    if (!session.ready) {
      job.status = "scheduled";
      try {
        const { updateScheduledJob } = await import("../persistence/schedulePersistenceService");
        await updateScheduledJob(code, job.id, { status: "scheduled" });
      } catch (error) {
        logger.error(
          { err: error, code, jobId: job.id },
          "Failed to reschedule job while client not ready"
        );
      }
      scheduleJobExecution(code, session, job, SCHEDULE_RETRY_DELAY_MS);
      return;
    }

    try {
      const { performBulkSend } = await import("./utils");
      const results = await performBulkSend(
        session,
        job.message,
        job.numbers,
        code
      );
      job.status = "sent";
      job.sentAt = new Date().toISOString();
      job.results = results;
      try {
        const { updateScheduledJob } = await import("../persistence/schedulePersistenceService");
        await updateScheduledJob(code, job.id, {
          status: "sent",
          sentAt: new Date(job.sentAt),
          results,
          error: null,
        });
      } catch (error) {
        logger.error(
          { err: error, code, jobId: job.id },
          "Failed to persist sent job state"
        );
      }
    } catch (error) {
      job.status = "failed";
      job.error = error.message;
      job.sentAt = new Date().toISOString();
      try {
        const { updateScheduledJob } = await import("../persistence/schedulePersistenceService");
        await updateScheduledJob(code, job.id, {
          status: "failed",
          error: error.message,
          sentAt: new Date(job.sentAt),
        });
      } catch (persistError) {
        logger.error(
          { err: persistError, code, jobId: job.id },
          "Failed to persist failed job state"
        );
      }
      logger.error(
        { err: error, code, jobId: job.id },
        "Scheduled message failed"
      );
    }
  };

  const runner = () => {
    run().catch((error) => {
      logger.error(
        { err: error, code, jobId: job.id },
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

export {
  scheduleMessages,
  getScheduledMessages,
  cancelScheduledMessage,
  removeScheduledMessage,
  ensureScheduledJobs,
  clearScheduledJobs,
  documentToJob,
  scheduleJobExecution,
  serializeScheduledJob,
};