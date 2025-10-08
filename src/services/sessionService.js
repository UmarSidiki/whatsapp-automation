"use strict";

const env = require("../config/env");
const logger = require("../config/logger");
const { fetchFn } = require("../utils/http");
const {
  STOP_TIMEOUT_MS,
  QR_REFRESH_INTERVAL_MS,
  DEFAULT_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  MAX_CONTEXT_WINDOW,
  MIN_SCHEDULE_DELAY_MS,
  MAX_SCHEDULE_DELAY_MS,
} = require("../constants");
const { generateReply } = require("./geminiService");
const {
  queueMessageForPersistence,
  flushSessionMessages,
} = require("./chatPersistenceService");
const { loadSessionConfig } = require("./sessionConfigService");
const remoteAuthStore = require("./remoteAuthStore");
const {
  saveScheduledJob,
  updateScheduledJob,
  deleteScheduledJob,
  listScheduledJobs,
} = require("./schedulePersistenceService");

const sessions = new Map();
const SCHEDULE_RETRY_DELAY_MS = 5_000;
const MESSAGE_TIMESTAMP_TOLERANCE_MS = 30_000; // 30s for clock skew tolerance
const CHAT_HISTORY_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CHAT_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CHAT_HISTORIES_PER_SESSION = 50; // Limit number of tracked chats

let qrCodeLib = null;
let whatsappDeps = null;
let historyPruneInterval = null;

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
  "--disable-features=Translate",
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
    const error = new Error(`Auth code source responded with ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  const list = Array.isArray(payload?.secret_code)
    ? payload.secret_code
    : [];

  const normalized = list
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  cachedAuthCodes = normalized;
  authCodesFetchedAt = Date.now();

  if (!normalized.length) {
    logger.warn({ source: AUTH_CODES_URL }, "Auth code source returned no codes");
  }

  return cachedAuthCodes;
}

async function loadAuthCodes({ force = false } = {}) {
  const isCacheFresh =
    !force && cachedAuthCodes.length && Date.now() - authCodesFetchedAt < AUTH_CODES_REFRESH_MS;

  if (isCacheFresh) {
    return cachedAuthCodes;
  }

  if (!authCodesPromise) {
    authCodesPromise = fetchAuthCodesFromSource()
      .catch((error) => {
        logger.error({ err: error, source: AUTH_CODES_URL }, "Failed to load auth codes from CDN");
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
    stopList: new Map(),
    lastQrTimestamp: 0,
    chatHistory: new Map(),
    scheduledJobs: new Map(),
  };

  registerEventHandlers(code, state);
  sessions.set(code, state);
  
  // Start the chat history pruning interval when the first session is created
  startHistoryPruneInterval();

  try {
    await client.initialize();
    await hydrateSessionState(code, state);
    // Wait briefly for the client to become ready or fail authentication so callers get a usable session
    try {
      const readyPromise = new Promise((resolve, reject) => {
        const onReady = () => {
          cleanup();
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
        new Promise((res) => setTimeout(() => res(false), env.SESSION_READY_TIMEOUT_MS)),
      ]);
    } catch (err) {
      logger.warn({ err, code }, "Client did not become ready during ensureSession wait");
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

      logger.info({ code, ready: state.ready, aiConfig: aiSummary }, "WhatsApp session initialized");
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
    logger.info({ code }, "WhatsApp client ready");
  });

  state.client.on("disconnected", (reason) => {
    logger.warn({ code, reason }, "WhatsApp client disconnected");
    state.ready = false;
    
    // Attempt to reconnect if not deliberately destroyed
    if (!state.destroyed) {
      const reconnectDelay = 5000;
      logger.info({ code, reconnectDelay }, "Scheduling reconnection attempt");
      
      setTimeout(() => {
        if (sessions.has(code) && !state.destroyed && !state.ready) {
          logger.info({ code }, "Attempting to reconnect WhatsApp client");
          state.client.initialize().catch(err => {
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
    const current = sessions.get(code);
    if (!current || !current.ready) return;
    if (!msg || typeof msg.body !== "string") return;
    if (msg.from.includes("@g.us")) return;

    const text = msg.body.trim();
    if (!text) return;

    const chatId = msg.from;

    const messageTimestampMs =
      typeof msg.timestamp === "number" && msg.timestamp > 0
        ? msg.timestamp * 1000
        : typeof msg._data?.t === "number" && msg._data.t > 0
        ? msg._data.t * 1000
        : Date.now();

    if (
      current.startedAt &&
      messageTimestampMs + MESSAGE_TIMESTAMP_TOLERANCE_MS < current.startedAt
    ) {
      logger.debug(
        {
          code,
          chatId,
          messageTimestampMs,
          sessionStartedAt: current.startedAt,
        },
        "Skipping message received before session started"
      );
      return;
    }

    // Allow the remote contact to opt-out for a period by sending !stopauto.
    // Ignore commands sent by the client itself (fromMe).
    if (!msg.fromMe && text.toLowerCase() === "!stop") {
      current.stopList.set(chatId, Date.now());
      await safeReply(msg, "🤖 Auto replies disabled for 24 hours.");
      return;
    }

    // Allow the remote contact to re-enable auto replies early.
    if (!msg.fromMe && text.toLowerCase() === "!start") {
      if (current.stopList.has(chatId)) {
        current.stopList.delete(chatId);
        await safeReply(msg, "🤖 Auto replies re-enabled. I'll reply as usual.");
      } else {
        await safeReply(msg, "🤖 Auto replies are already enabled.");
      }
      return;
    }

    const stopTime = current.stopList.get(chatId);
    if (stopTime && Date.now() - stopTime < STOP_TIMEOUT_MS) {
      return;
    } else if (stopTime) {
      current.stopList.delete(chatId);
    }

    appendHistoryEntry(current, chatId, { role: "user", text });
    persistChatMessage(code, chatId, "incoming", text);

    const config = current.aiConfig;
    if (!config) return;

    const customReply = findCustomReply(config.customReplies, text);
    if (customReply) {
      try {
        await safeReply(msg, customReply);
        appendHistoryEntry(current, chatId, {
          role: "assistant",
          text: customReply,
        });
        persistChatMessage(code, chatId, "outgoing", customReply);
      } catch (error) {
        logger.error({ err: error, chatId }, "Custom reply send error");
      }
      return;
    }

    if (!config.autoReplyEnabled) {
      return;
    }

    if (!config.apiKey || !config.model) {
      logger.debug({ code }, "Auto reply skipped: AI credentials missing");
      return;
    }

    try {
      const contextWindow = clampContextWindow(config.contextWindow);
      const history = getHistoryForChat(current, chatId, contextWindow);
      const reply = await generateReply(config, history);
      if (reply) {
        await safeReply(msg, reply);
        appendHistoryEntry(current, chatId, { role: "assistant", text: reply });
        persistChatMessage(code, chatId, "outgoing", reply);
      }
    } catch (error) {
      logger.error({ err: error, chatId }, "AI reply error");
    }
  });
}

async function safeReply(msg, text) {
  try {
    await msg.reply(text);
  } catch (error) {
    logger.error({ err: error, to: msg.from }, "Failed to send reply");
  }
}

function updateAiConfig(code, config) {
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

  const numbers = normalizeNumbers(payload.numbers);
  if (!numbers.length) {
    throw new Error("No valid numbers provided");
  }

  const results = await performBulkSend(
    session,
    payload.message,
    numbers,
    code
  );
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
  scheduleJobExecution(code, session, job);

  try {
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
    error.statusCode = 409;
    throw error;
  }

  if (job.timeoutId) {
    clearTimeout(job.timeoutId);
  }

  jobs.delete(jobId);

  try {
    const removed = await deleteScheduledJob(code, jobId);
    if (!removed) {
      logger.warn({ code, jobId }, "Scheduled message not found in persistence while removing");
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

async function shutdownAll() {
  // Clear prune interval if it exists
  if (historyPruneInterval) {
    clearInterval(historyPruneInterval);
    historyPruneInterval = null;
  }

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
      clearScheduledJobs(session);
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
    clearScheduledJobs(session);
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
    return DEFAULT_CONTEXT_WINDOW;
  }
  if (numeric < MIN_CONTEXT_WINDOW) {
    return MIN_CONTEXT_WINDOW;
  }
  if (numeric > MAX_CONTEXT_WINDOW) {
    return MAX_CONTEXT_WINDOW;
  }
  return Math.round(numeric);
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

function findCustomReply(customReplies, text) {
  if (!Array.isArray(customReplies) || !customReplies.length) {
    return null;
  }

  const lowerText = text.toLowerCase();

  for (const rule of customReplies) {
    switch (rule.matchType) {
      case "exact":
        if (lowerText === rule.trigger.toLowerCase()) {
          return rule.response;
        }
        break;
      case "startsWith":
        if (lowerText.startsWith(rule.trigger.toLowerCase())) {
          return rule.response;
        }
        break;
      case "regex":
        if (rule.regex && rule.regex.test(text)) {
          return rule.response;
        }
        break;
      case "contains":
      default:
        if (lowerText.includes(rule.trigger.toLowerCase())) {
          return rule.response;
        }
        break;
    }
  }

  return null;
}

function ensureChatHistory(session) {
  if (!session.chatHistory) {
    session.chatHistory = new Map();
  }
  
  // Limit the number of tracked chats per session for memory management
  if (session.chatHistory.size > MAX_CHAT_HISTORIES_PER_SESSION) {
    const chatsToRemove = session.chatHistory.size - MAX_CHAT_HISTORIES_PER_SESSION;
    const chatIds = Array.from(session.chatHistory.keys());
    
    // Remove oldest chats (first entries)
    for (let i = 0; i < chatsToRemove; i++) {
      session.chatHistory.delete(chatIds[i]);
    }
    
    logger.debug(
      { removed: chatsToRemove, remaining: session.chatHistory.size },
      "Pruned excess chat histories from session"
    );
  }
  
  return session.chatHistory;
}

function appendHistoryEntry(session, chatId, entry) {
  const historyStore = ensureChatHistory(session);
  const history = historyStore.get(chatId) || [];

  history.push({
    role: entry.role,
    text: entry.text,
    timestamp: entry.timestamp || Date.now(),
  });

  const limit = clampContextWindow(
    session.aiConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  );
  if (history.length > limit) {
    history.splice(0, history.length - limit);
  }

  historyStore.set(chatId, history);
  return history;
}

/**
 * Prune inactive chat histories to reduce memory usage.
 * Removes chat histories that haven't been accessed in CHAT_HISTORY_MAX_AGE_MS
 * and ensures total histories per session don't exceed MAX_CHAT_HISTORIES_PER_SESSION.
 */
function pruneInactiveChatHistories() {
  const now = Date.now();
  let totalSessionsChecked = 0;
  let totalHistoriesRemoved = 0;

  for (const [sessionCode, session] of sessions.entries()) {
    if (!session.chatHistory || session.chatHistory.size === 0) {
      continue;
    }

    totalSessionsChecked++;
    const historiesToRemove = [];

    // Find histories older than max age
    for (const [chatId, history] of session.chatHistory.entries()) {
      if (history.length === 0) {
        historiesToRemove.push(chatId);
        continue;
      }

      // Check the last message timestamp
      const lastMessage = history[history.length - 1];
      const age = now - lastMessage.timestamp;

      if (age > CHAT_HISTORY_MAX_AGE_MS) {
        historiesToRemove.push(chatId);
      }
    }

    // Remove old histories
    for (const chatId of historiesToRemove) {
      session.chatHistory.delete(chatId);
      totalHistoriesRemoved++;
    }

    // Enforce max histories per session (already done in ensureChatHistory, but double-check here)
    if (session.chatHistory.size > MAX_CHAT_HISTORIES_PER_SESSION) {
      const excess = session.chatHistory.size - MAX_CHAT_HISTORIES_PER_SESSION;
      const chatIds = Array.from(session.chatHistory.keys());
      
      for (let i = 0; i < excess; i++) {
        session.chatHistory.delete(chatIds[i]);
        totalHistoriesRemoved++;
      }
    }

    if (historiesToRemove.length > 0) {
      logger.debug(
        { 
          sessionCode, 
          removed: historiesToRemove.length, 
          remaining: session.chatHistory.size 
        },
        "Pruned inactive chat histories"
      );
    }
  }

  if (totalHistoriesRemoved > 0) {
    logger.info(
      {
        sessionsChecked: totalSessionsChecked,
        historiesRemoved: totalHistoriesRemoved,
        estimatedMemorySavedKB: Math.round(totalHistoriesRemoved * 2) // Rough estimate: 2KB per history
      },
      "Chat history pruning cycle completed"
    );
  }
}

/**
 * Start the interval for pruning inactive chat histories.
 */
function startHistoryPruneInterval() {
  if (historyPruneInterval) {
    return; // Already running
  }

  historyPruneInterval = setInterval(() => {
    pruneInactiveChatHistories();
  }, CHAT_HISTORY_PRUNE_INTERVAL_MS);

  logger.info(
    { intervalMs: CHAT_HISTORY_PRUNE_INTERVAL_MS },
    "Started chat history pruning interval"
  );
}

function persistChatMessage(sessionCode, contactId, direction, text) {
  if (!sessionCode || !contactId || !text) {
    return;
  }

  try {
    queueMessageForPersistence({
      sessionCode,
      contactId,
      direction,
      message: text,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.debug(
      { err: error, sessionCode, contactId },
      "Chat persistence skipped due to upstream error"
    );
  }
}

async function hydrateSessionState(code, session) {
  await Promise.all([
    hydrateAiConfig(code, session),
    hydrateScheduledJobs(code, session),
  ]);
}

async function hydrateAiConfig(code, session) {
  try {
    const persisted = await loadSessionConfig(code);
    if (!persisted) {
      logger.debug({ code }, "No persisted session config found in DB");
    } else {
      logger.debug({ code, persistedKeys: Object.keys(persisted) }, "Loaded persisted session config");
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
      typeof storedCredentials.apiKey === "string" && storedCredentials.apiKey.trim()
        ? storedCredentials.apiKey.trim()
        : "";

    baseConfig.apiKey = apiKeyFromConfig || apiKeyFromCredentials || baseConfig.apiKey;
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
  } catch (error) {
    logger.error({ err: error, code }, "Failed to hydrate AI configuration");
    if (!session.aiConfig) {
      session.aiConfig = { ...DEFAULT_AI_CONFIG };
    }
  }
}

async function hydrateScheduledJobs(code, session) {
  const jobs = ensureScheduledJobs(session);
  jobs.clear();

  try {
    const documents = await listScheduledJobs(code);
    for (const doc of documents) {
      const job = documentToJob(doc);
      jobs.set(job.id, job);

      if (job.status === "sending") {
        job.status = "scheduled";
        job.error = undefined;
        try {
          await updateScheduledJob(code, job.id, {
            status: "scheduled",
            error: null,
          });
        } catch (error) {
          logger.error(
            { err: error, code, jobId: job.id },
            "Failed to reset in-flight job"
          );
        }
      }

      if (job.status === "scheduled") {
        scheduleJobExecution(code, session, job);
      }
    }
  } catch (error) {
    logger.error({ err: error, code }, "Failed to hydrate scheduled jobs");
  }
}

function getHistoryForChat(session, chatId, contextWindow) {
  const historyStore = ensureChatHistory(session);
  const history = historyStore.get(chatId) || [];
  const limit = clampContextWindow(
    contextWindow ?? session.aiConfig?.contextWindow
  );
  return history.slice(-limit);
}

function ensureScheduledJobs(session) {
  if (!session.scheduledJobs) {
    session.scheduledJobs = new Map();
  }
  return session.scheduledJobs;
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

async function performBulkSend(session, message, numbers, sessionCode) {
  const results = [];
  for (const number of numbers) {
    try {
      await session.client.sendMessage(number, message);
      results.push({ number, success: true });
      appendHistoryEntry(session, number, { role: "assistant", text: message });
      persistChatMessage(sessionCode, number, "outgoing", message);
    } catch (error) {
      logger.error({ err: error, number }, "Failed to send message");
      results.push({ number, success: false, error: error.message });
    }
  }
  return results;
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
