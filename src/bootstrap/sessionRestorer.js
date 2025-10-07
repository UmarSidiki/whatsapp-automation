"use strict";

const logger = require("../config/logger");
const remoteAuthStore = require("../services/remoteAuthStore");
const { ensureSession } = require("../services/sessionService");

async function restoreSessions() {
  let storedSessions = [];
  try {
    storedSessions = await remoteAuthStore.list();
  } catch (error) {
    logger.error({ err: error }, "Failed to load persisted WhatsApp sessions");
    return;
  }

  if (!Array.isArray(storedSessions) || storedSessions.length === 0) {
    logger.debug("No persisted WhatsApp sessions found to restore");
    return;
  }

  for (const doc of storedSessions) {
    const sessionCode = doc?.session;
    if (!sessionCode) {
      continue;
    }

    try {
      await ensureSession(sessionCode);
      logger.info({ code: sessionCode }, "Restored WhatsApp session on startup");
    } catch (error) {
      logger.error({ err: error, code: sessionCode }, "Failed to restore WhatsApp session on startup");
    }
  }
}

module.exports = {
  restoreSessions,
};
