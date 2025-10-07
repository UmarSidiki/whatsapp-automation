"use strict";

const bulkMessageSchema = require("../validation/bulkMessageSchema");
const scheduleMessageSchema = require("../validation/scheduleMessageSchema");
const {
  getSession,
  sendBulkMessages,
  scheduleMessages,
  getScheduledMessages,
  cancelScheduledMessage,
  removeScheduledMessage,
} = require("../services/sessionService");

function validateSession(code) {
  const session = getSession(code);
  if (!session) {
    const error = new Error("Session not found");
    error.statusCode = 404;
    throw error;
  }
  return session;
}

async function handleBulkSend(req, res) {
  validateSession(req.params.code);
  const parseResult = bulkMessageSchema.safeParse(req.body || {});
  if (!parseResult.success) {
    return res.status(400).json({
      error: "Invalid bulk message payload",
      details: parseResult.error.flatten(),
    });
  }

  try {
    const result = await sendBulkMessages(req.params.code, parseResult.data);
    return res.json({ success: true, ...result });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ error: error.message || "Failed to send bulk messages" });
  }
}

async function listScheduled(req, res) {
  validateSession(req.params.code);
  try {
    const jobs = await getScheduledMessages(req.params.code);
    return res.json({ jobs });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ error: error.message || "Failed to load scheduled messages" });
  }
}

async function createSchedule(req, res) {
  validateSession(req.params.code);
  const parseResult = scheduleMessageSchema.safeParse(req.body || {});
  if (!parseResult.success) {
    return res.status(400).json({
      error: "Invalid schedule payload",
      details: parseResult.error.flatten(),
    });
  }

  try {
    const job = await scheduleMessages(req.params.code, parseResult.data);
    return res.status(201).json({ success: true, job });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ error: error.message || "Failed to schedule message" });
  }
}

async function cancelSchedule(req, res) {
  validateSession(req.params.code);
  try {
    const mode = String(req.query.mode || "").toLowerCase();
    const handler = mode === "remove" ? removeScheduledMessage : cancelScheduledMessage;
    const job = await handler(req.params.code, req.params.jobId);
    return res.json({ success: true, job, removed: mode === "remove" });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ error: error.message || "Failed to cancel schedule" });
  }
}

module.exports = {
  handleBulkSend,
  createSchedule,
  listScheduled,
  cancelSchedule,
};
