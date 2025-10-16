"use strict";

const env = require("../config/env");
const logger = require("../config/logger");
const { fetchFn } = require("../utils/http");
const {
  QR_REFRESH_INTERVAL_MS,
  DEFAULT_CONTEXT_WINDOW,
} = require("../constants");
const { flushSessionMessages } = require("./messaging/chatPersistenceService");
const { loadSessionConfig, saveAiConfig } = require("./sessionConfigService");
const {
  loadPersonaMessages,
} = require("./ai/personaPersistenceService");
const remoteAuthStore = require("./remoteAuthStore");
const messageHandler = require("./messaging/messageHandler");
const chatHistoryManager = require("./messaging/chatHistoryManager");
const scheduledJobManager = require("./scheduling/scheduledJobManager");

const sessions = new Map();

let qrCodeLib = null;
let whatsappDeps = null;

// Constants moved to appropriate modules
const MIN_CONTEXT_WINDOW = 5;
const MAX_CONTEXT_WINDOW = 1000;

function getQrCodeLib() {
  if (!qrCodeLib) {
    qrCodeLib = require("qrcode");
  }
  return qrCodeLib;
}

function getWhatsAppDeps() {
  if (!whatsappDeps) {
    whatsappDeps = require("whatsapp-web.js");
  }
  return whatsappDeps;
}

const PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-first-run",
  "--no-zygote",
  "--disable-features=Translate,TranslateUI,VizDisplayCompositor",
  "--disable-ipc-flooding-protection",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-features=UserMediaScreenCapturing",
  "--memory-pressure-off",
  "--max_old_space_size=256",
];

const AUTH_CODES_URL =
  "https://cdn.jsdelivr.net/gh/UmarSidiki/Multi-Tool@refs/heads/master/wp-ai-codes.json";
const AUTH_CODES_REFRESH_MS = 5 * 60 * 1000;

const DEFAULT_AI_CONFIG = {
  apiKey: "",
  model: "",
  systemPrompt: undefined,
  autoReplyEnabled: true,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  customReplies: [],
};

let cachedAuthCodes = [];
let authCodesFetchedAt = 0;
let authCodesPromise = null;

async function fetchAuthCodesFromSource() {
  const response = await fetchFn(AUTH_CODES_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const error = new Error(
      `Auth code source responded with ${response.status}`
    );
    error.statusCode = response.status;
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  const list = Array.isArray(payload?.secret_code) ? payload.secret_code : [];

  const normalized = list
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  cachedAuthCodes = normalized;
  authCodesFetchedAt = Date.now();

  if (!normalized.length) {
    logger.warn(
      { source: AUTH_CODES_URL },
      "Auth code source returned no codes"
    );
  }

  return cachedAuthCodes;
}

async function loadAuthCodes({ force = false } = {}) {
  const isCacheFresh =
    !force &&
    cachedAuthCodes.length &&
    Date.now() - authCodesFetchedAt < AUTH_CODES_REFRESH_MS;

  if (isCacheFresh) {
    return cachedAuthCodes;
  }

  if (!authCodesPromise) {
    authCodesPromise = fetchAuthCodesFromSource()
      .catch((error) => {
        logger.error(
          { err: error, source: AUTH_CODES_URL },
          "Failed to load auth codes from CDN"
        );
        if (!cachedAuthCodes.length) {
          authCodesFetchedAt = 0;
        }
        return cachedAuthCodes;
      })
      .finally(() => {
        authCodesPromise = null;
      });
  }

  return authCodesPromise;
}

loadAuthCodes().catch(() => {
  /* Initialization errors already logged */
});

async function isAuthorized(code) {
  const trimmed = typeof code === "string" ? code.trim() : "";
  if (!trimmed) {
    return false;
  }
  const codes = await loadAuthCodes();
  return codes.includes(trimmed);
}

function getSession(code) {
  return sessions.get(code);
}

function listSessions() {
  return sessions;
}



async function ensureSession(code) {
  if (sessions.has(code)) {
    return sessions.get(code);
  }

  const { Client, RemoteAuth } = getWhatsAppDeps();

  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: code,
      store: remoteAuthStore,
      backupSyncIntervalMs: env.remoteAuthBackupMs,
      dataPath: env.remoteAuthDataPath,
    }),
    puppeteer: {
      headless: env.puppeteerHeadless,
      args: PUPPETEER_ARGS,
    },
  });

  const state = {
    client,
    qr: null,
    ready: false,
    startedAt: Date.now(),
    aiConfig: null,
    botNumber: null, // Store bot's phone number for owner detection
    persona: [], // Owner persona messages for AI style learning
    globalStop: { active: false, since: 0 },
    stopList: new Map(),
    lastQrTimestamp: 0,
    chatHistory: new Map(),
    scheduledJobs: new Map(),
    destroyed: false,
  };

  registerEventHandlers(code, state);
  sessions.set(code, state);

  try {
    await client.initialize();
    await hydrateSessionState(code, state);
    // Wait briefly for the client to become ready or fail authentication so callers get a usable session
    try {
      const readyPromise = new Promise((resolve, reject) => {
        const onReady = () => {
          cleanup();
          // Start intervals when ready
          chatHistoryManager.startHistoryPruneInterval(sessions);
          resolve(true);
        };
        const onAuthFailure = (msg) => {
          cleanup();
          reject(new Error(`auth_failure: ${String(msg)}`));
        };
        const onDisconnect = (reason) => {
          // disconnect may occur before ready; treat as failure to become ready
          cleanup();
          reject(new Error(`disconnected: ${String(reason)}`));
        };

        function cleanup() {
          state.client.removeListener("ready", onReady);
          state.client.removeListener("auth_failure", onAuthFailure);
          state.client.removeListener("disconnected", onDisconnect);
        }

        state.client.on("ready", onReady);
        state.client.on("auth_failure", onAuthFailure);
        state.client.on("disconnected", onDisconnect);
      });

      await Promise.race([
        readyPromise,
        new Promise(
          (res) => setTimeout(() => res(false), 60000) // 60 seconds
        ),
      ]);
    } catch (err) {
      logger.warn(
        { err, code },
        "Client did not become ready during ensureSession wait"
      );
    }
    try {
      // Log a concise AI config summary to help debug post-restore behavior
      const aiSummary = state.aiConfig
        ? {
            model: state.aiConfig.model || null,
            hasApiKey: Boolean(state.aiConfig.apiKey),
            autoReplyEnabled: state.aiConfig.autoReplyEnabled,
            customReplyCount: Array.isArray(state.aiConfig.customReplies)
              ? state.aiConfig.customReplies.length
              : 0,
          }
        : null;

      logger.info(
        { code, ready: state.ready, aiConfig: aiSummary },
        "WhatsApp session initialized"
      );
    } catch (err) {
      logger.debug({ err, code }, "Failed to log session AI summary");
    }
  } catch (error) {
    sessions.delete(code);
    logger.error({ err: error }, "Failed to initialize WhatsApp client");
    throw new Error("Failed to start WhatsApp session");
  }

  return state;
}

function registerEventHandlers(code, state) {
  state.client.on("qr", async (qr) => {
    const now = Date.now();
    if (now - state.lastQrTimestamp < QR_REFRESH_INTERVAL_MS) return;
    state.lastQrTimestamp = now;
    try {
      const qrcode = getQrCodeLib();
      state.qr = await qrcode.toDataURL(qr);
    } catch (error) {
      logger.error({ err: error }, "Failed to convert QR to data URL");
    }
  });

  state.client.on("ready", () => {
    state.ready = true;
    state.startedAt = Date.now();

    // Store bot information for owner detection
    if (state.client.info && state.client.info.wid) {
      state.botNumber = state.client.info.wid.user;
      logger.info(
        { code, botNumber: state.botNumber },
        "WhatsApp client ready"
      );
    } else {
      logger.info({ code }, "WhatsApp client ready (no info available)");
    }
  });

  state.client.on("disconnected", (reason) => {
    logger.warn({ code, reason }, "WhatsApp client disconnected");
    state.ready = false;

    // If the disconnection is due to logout, destroy the session completely.
    if (reason === "NAVIGATION" || reason?.includes("Logged out")) {
      logger.info(
        { code },
        "Session disconnected by user, destroying session."
      );
      destroySession(code).catch((err) => {
        logger.error(
          { err, code },
          "Error during automatic session destruction on logout."
        );
      });
      return; // Do not attempt to reconnect
    }

    // Attempt to reconnect if not deliberately destroyed
    if (!state.destroyed) {
      const reconnectDelay = 5000;
      logger.info({ code, reconnectDelay }, "Scheduling reconnection attempt");

      setTimeout(() => {
        if (sessions.has(code) && !state.destroyed && !state.ready) {
          logger.info({ code }, "Attempting to reconnect WhatsApp client");
          state.client.initialize().catch((err) => {
            logger.error({ err, code }, "Failed to reconnect WhatsApp client");
          });
        }
      }, reconnectDelay);
    }
  });

  state.client.on("auth_failure", (msg) => {
    logger.error({ code, msg }, "WhatsApp authentication failure");
  });

  state.client.on("message", async (msg) => {
    await messageHandler.processIncomingMessage(code, state, msg, sessions, chatHistoryManager);
  });

  // Listen for outgoing messages (commands) from the bot owner
  state.client.on("message_create", async (msg) => {
    await messageHandler.processOutgoingMessage(code, state, msg, sessions);
  });
}



async function updateAiConfig(code, config) {
  const session = sessions.get(code);
  if (!session) {
    throw new Error("Session not found");
  }
  const baseConfig = session.aiConfig
    ? { ...session.aiConfig }
    : { ...DEFAULT_AI_CONFIG };
  const nextConfig = {
    ...baseConfig,
    ...config,
  };

  nextConfig.contextWindow = clampContextWindow(
    config.contextWindow ?? baseConfig.contextWindow
  );
  nextConfig.customReplies = sanitizeCustomReplies(
    config.customReplies ?? baseConfig.customReplies
  );

  session.aiConfig = nextConfig;

  // Persist the updated config including persona
  try {
    await saveAiConfig(code, nextConfig);
  } catch (error) {
    logger.error({ err: error, code }, "Failed to persist AI config update");
  }

  const limit = nextConfig.contextWindow;
  for (const [chatId, history] of session.chatHistory.entries()) {
    if (history.length > limit) {
      session.chatHistory.set(chatId, history.slice(-limit));
    }
  }

  logger.info(
    {
      code,
      autoReplyEnabled: nextConfig.autoReplyEnabled,
      customReplyCount: nextConfig.customReplies.length,
      contextWindow: nextConfig.contextWindow,
    },
    "AI configuration updated"
  );

  return nextConfig;
}

function getAiConfig(code) {
  const session = sessions.get(code);
  if (!session || !session.aiConfig) {
    return null;
  }
  return serializeAiConfig(session.aiConfig);
}

async function sendBulkMessages(code, payload) {
  const session = sessions.get(code);
  if (!session) {
    throw new Error("Session not found");
  }
  if (!session.ready) {
    throw new Error("Session is not ready yet");
  }

  const numbers = scheduledJobManager.normalizeNumbers(payload.numbers);
  if (!numbers.length) {
    throw new Error("No valid numbers provided");
  }

  const results = await scheduledJobManager.performBulkSend(session, payload.message, numbers);
  const successCount = results.filter((item) => item.success).length;

  return {
    total: numbers.length,
    success: successCount,
    failed: numbers.length - successCount,
    results,
  };
}

async function scheduleMessages(code, payload) {
  const session = sessions.get(code);
  if (!session) {
    throw new Error("Session not found");
  }
  if (!session.ready) {
    throw new Error("Session is not ready yet");
  }

  return await scheduledJobManager.scheduleMessages(session, payload, code);
}

async function getScheduledMessages(code) {
  return await scheduledJobManager.getScheduledMessages(code);
}

async function cancelScheduledMessage(code, jobId) {
  const session = sessions.get(code);
  if (!session) {
    throw new Error("Session not found");
  }
  return await scheduledJobManager.cancelScheduledMessage(session, code, jobId);
}

async function removeScheduledMessage(code, jobId) {
  const session = sessions.get(code);
  if (!session) {
    throw new Error("Session not found");
  }
  return await scheduledJobManager.removeScheduledMessage(session, code, jobId);
}



async function shutdownAll() {
  // Clear intervals
  chatHistoryManager.stopHistoryPruneInterval();

  for (const [code, session] of sessions.entries()) {
    try {
      await flushSessionMessages(code);
    } catch (error) {
      logger.error(
        { err: error, code },
        "Failed to flush messages during shutdown"
      );
    }

    try {
      scheduledJobManager.clearScheduledJobs(session);
      session.destroyed = true;
      await session.client.destroy();
      logger.info({ code }, "Session destroyed");
    } catch (error) {
      logger.error({ err: error, code }, "Failed to destroy session");
    }
  }
  sessions.clear();
}

async function destroySession(code) {
  const session = sessions.get(code);
  if (!session) {
    return false;
  }

  try {
    await flushSessionMessages(code);
  } catch (error) {
    logger.error(
      { err: error, code },
      "Failed to flush messages before logout"
    );
  }

  try {
    scheduledJobManager.clearScheduledJobs(session);
    session.destroyed = true;
    await session.client.destroy();
    logger.info({ code }, "Session destroyed via logout");
  } catch (error) {
    logger.error({ err: error, code }, "Failed to destroy session on logout");
  } finally {
    sessions.delete(code);
  }

  return true;
}

function clampContextWindow(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return getEffectiveContextWindow(DEFAULT_CONTEXT_WINDOW);
  }
  if (numeric < MIN_CONTEXT_WINDOW) {
    return MIN_CONTEXT_WINDOW;
  }
  if (numeric > MAX_CONTEXT_WINDOW) {
    return MAX_CONTEXT_WINDOW;
  }
  return Math.round(getEffectiveContextWindow(numeric));
}

function getEffectiveContextWindow(desired) {
  const isHighMemory = checkMemoryPressure();
  return isHighMemory
    ? Math.max(MIN_CONTEXT_WINDOW, Math.floor(desired / 2))
    : desired;
}


function sanitizeCustomReplies(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .map((entry) => {
      const trigger =
        typeof entry.trigger === "string" ? entry.trigger.trim() : "";
      const response =
        typeof entry.response === "string" ? entry.response.trim() : "";
      const matchType = entry.matchType || "contains";

      if (!trigger || !response) {
        return null;
      }

      const normalized = {
        trigger,
        response,
        matchType,
      };

      if (matchType === "regex") {
        try {
          normalized.regex = new RegExp(trigger, "i");
        } catch (error) {
          logger.warn(
            { trigger, err: error },
            "Invalid custom reply regex; falling back to 'contains'"
          );
          normalized.matchType = "contains";
        }
      }

      return normalized;
    })
    .filter(Boolean);
}




function checkMemoryPressure() {
  const memUsage = process.memoryUsage();
  const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
  return heapUsedMB > 768; // Use hardcoded value since MAX_MEMORY_MB is removed
}




async function hydrateSessionState(code, session) {
  await Promise.all([
    hydrateAiConfig(code, session),
    scheduledJobManager.hydrateScheduledJobs(code, session),
  ]);
}

async function hydrateAiConfig(code, session) {
  try {
    const persisted = await loadSessionConfig(code);
    if (!persisted) {
      logger.debug({ code }, "No persisted session config found in DB");
    } else {
      logger.debug(
        { code, persistedKeys: Object.keys(persisted) },
        "Loaded persisted session config"
      );
    }
    const storedConfig = persisted?.aiConfig || {};
    const storedCredentials = persisted?.credentials?.gemini || {};
    const baseConfig = {
      ...DEFAULT_AI_CONFIG,
      ...(session.aiConfig || {}),
    };

    const apiKeyFromConfig =
      typeof storedConfig.apiKey === "string" && storedConfig.apiKey.trim()
        ? storedConfig.apiKey.trim()
        : "";
    const apiKeyFromCredentials =
      typeof storedCredentials.apiKey === "string" &&
      storedCredentials.apiKey.trim()
        ? storedCredentials.apiKey.trim()
        : "";

    baseConfig.apiKey =
      apiKeyFromConfig || apiKeyFromCredentials || baseConfig.apiKey;
    baseConfig.model =
      typeof storedConfig.model === "string"
        ? storedConfig.model
        : baseConfig.model;
    baseConfig.systemPrompt =
      storedConfig.systemPrompt ?? baseConfig.systemPrompt;
    baseConfig.autoReplyEnabled =
      storedConfig.autoReplyEnabled ?? baseConfig.autoReplyEnabled;
    baseConfig.contextWindow = clampContextWindow(
      storedConfig.contextWindow ??
        baseConfig.contextWindow ??
        DEFAULT_CONTEXT_WINDOW
    );

    const storedReplies = Array.isArray(storedConfig.customReplies)
      ? storedConfig.customReplies
      : Array.isArray(persisted?.customReplies)
      ? persisted.customReplies
      : [];

    baseConfig.customReplies = sanitizeCustomReplies(storedReplies);

    session.aiConfig = baseConfig;
    // Load recent persona messages from database based on contextWindow
    session.persona = await loadPersonaMessages(code, baseConfig.contextWindow);
  } catch (error) {
    logger.error({ err: error, code }, "Failed to hydrate AI configuration");
    if (!session.aiConfig) {
      session.aiConfig = { ...DEFAULT_AI_CONFIG };
    }
  }
}

function serializeAiConfig(config) {
  const apiKey = typeof config.apiKey === "string" ? config.apiKey : "";
  return {
    apiKey,
    hasApiKey: Boolean(apiKey),
    model: config.model,
    systemPrompt: config.systemPrompt,
    autoReplyEnabled: config.autoReplyEnabled,
    contextWindow: clampContextWindow(config.contextWindow),
    customReplies: serializeCustomReplies(config.customReplies),
  };
}

function serializeCustomReplies(customReplies) {
  if (!Array.isArray(customReplies)) {
    return [];
  }

  return customReplies.map((item) => ({
    trigger: item.trigger,
    response: item.response,
    matchType: item.matchType,
  }));
}

module.exports = {
  isAuthorized,
  ensureSession,
  getSession,
  listSessions,
  updateAiConfig,
  getAiConfig,
  sendBulkMessages,
  scheduleMessages,
  getScheduledMessages,
  cancelScheduledMessage,
  removeScheduledMessage,
  shutdownAll,
  destroySession,
  loadAuthCodes,
};
