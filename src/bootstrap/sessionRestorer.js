"use strict";

const logger = require("../config/logger");
const env = require("../config/env");
const remoteAuthStore = require("../services/remoteAuthStore");
const { ensureSession, updateAiConfig } = require("../services/sessionService");
const { loadSessionConfig } = require("../services/sessionConfigService");

function wait(ms) {
  if (!ms) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSessionCode(sessionName) {
  if (!sessionName || typeof sessionName !== "string") {
    return null;
  }
  if (sessionName.startsWith("RemoteAuth-")) {
    return sessionName.slice("RemoteAuth-".length);
  }
  return sessionName;
}

async function applyPersistedAiConfig(code) {
  try {
    const persisted = await loadSessionConfig(code);
    if (!persisted) {
      return;
    }

    const persistedAi = persisted.aiConfig || {};
    const persistedCreds = persisted.credentials || {};
    const geminiCreds = persistedCreds.gemini || {};
    const googleCloudCreds = persistedCreds.googleCloud || {};
    
    // Get Gemini API key
    const apiKey =
      (typeof geminiCreds.apiKey === "string" && geminiCreds.apiKey.trim()) ||
      (typeof persistedAi.apiKey === "string" && persistedAi.apiKey.trim()) ||
      "";

    // Get Google Cloud API keys for voice features
    const speechToTextApiKey =
      (typeof googleCloudCreds.speechToTextApiKey === "string" && googleCloudCreds.speechToTextApiKey.trim()) ||
      "";
    
    const textToSpeechApiKey =
      (typeof googleCloudCreds.textToSpeechApiKey === "string" && googleCloudCreds.textToSpeechApiKey.trim()) ||
      "";

    const toApply = { ...persistedAi };
    if (apiKey) {
      toApply.apiKey = apiKey;
    }
    if (speechToTextApiKey) {
      toApply.speechToTextApiKey = speechToTextApiKey;
    }
    if (textToSpeechApiKey) {
      toApply.textToSpeechApiKey = textToSpeechApiKey;
    }

    if (Object.keys(toApply).length) {
      updateAiConfig(code, toApply);
      logger.debug({ code }, "Applied persisted AI config during session restore");
    }
  } catch (error) {
    logger.debug({ err: error, code }, "Skipped persisted AI config application");
  }
}

async function restoreSessions() {
  if (!env.autoRestoreSessions) {
    logger.debug("Auto restore disabled; skipping session hydration");
    return;
  }

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

  const readyTimeoutMs = Math.max(Number(env.SESSION_READY_TIMEOUT_MS) || 0, 0);

  for (const doc of storedSessions) {
    const storedName = doc?.session;
    const code = normalizeSessionCode(storedName);
    if (!code) {
      continue;
    }

    try {
      const session = await ensureSession(code);
      await applyPersistedAiConfig(code);

      if (session && !session.ready) {
        const waitForReady = new Promise((resolve) => {
          const check = () => {
            if (session.ready) return resolve(true);
            setTimeout(check, 250);
          };
          check();
        });

        const ready = readyTimeoutMs
          ? await Promise.race([
              waitForReady,
              new Promise((res) => setTimeout(() => res(false), readyTimeoutMs)),
            ])
          : await waitForReady;

        if (ready) {
          logger.info({ code, storedName }, "Restored WhatsApp session and client ready");
        } else {
          logger.warn({ code, storedName }, "Session restored but client not ready within timeout");
        }
      } else {
        logger.info({ code, storedName }, "Restored WhatsApp session on startup");
      }
    } catch (error) {
      logger.error({ err: error, code, storedName }, "Failed to restore WhatsApp session on startup");
    }

    if (env.sessionRestoreThrottleMs) {
      await wait(env.sessionRestoreThrottleMs);
    }
  }

  try {
    const { listSessions } = require("../services/sessionService");
    const sessions = listSessions();
    const summary = [];
    for (const [code, state] of sessions.entries()) {
      summary.push({
        code,
        ready: state.ready,
        autoReplyEnabled: state.aiConfig?.autoReplyEnabled,
      });
    }
    logger.info({ restored: summary.length, sessions: summary }, "Session restore summary");
  } catch (error) {
    logger.debug({ err: error }, "Failed to produce session restore summary");
  }
}

module.exports = {
  restoreSessions,
};
