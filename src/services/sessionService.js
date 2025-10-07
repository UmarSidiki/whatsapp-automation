"use strict";

const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const env = require("../config/env");
const logger = require("../config/logger");
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
const {
  saveScheduledJob,
  updateScheduledJob,
  deleteScheduledJob,
  listScheduledJobs,
} = require("./schedulePersistenceService");

const sessions = new Map();
const SCHEDULE_RETRY_DELAY_MS = 5_000;

const DEFAULT_AI_CONFIG = {
  apiKey: "",
  model: "",
  systemPrompt: undefined,
  autoReplyEnabled: true,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  customReplies: [],
};

function loadAuthCodes() {
  if (env.AUTH_CODES) {
    return env.AUTH_CODES.split(",").map((code) => code.trim()).filter(Boolean);
  }

  const codesPath = env.CODE_FILE_PATH || path.join(__dirname, "../../codes/codes.json");
  try {
    const raw = fs.readFileSync(codesPath, "utf8");
    const data = JSON.parse(raw);
    const list = Array.isArray(data?.secret_code) ? data.secret_code.filter(Boolean) : [];
    if (!list.length) {
      logger.warn({ codesPath }, "codes.json found but contains no codes");
    }
    return list;
  } catch (error) {
    logger.error({ err: error, codesPath }, "Unable to read auth codes from file");
    return [];
  }
}

const AUTH_CODES = loadAuthCodes();
if (!AUTH_CODES.length) {
  logger.warn(
    "No auth codes configured. Set AUTH_CODES env var or populate codes/codes.json to enable logins."
  );
}

function isAuthorized(code) {
  return AUTH_CODES.includes(code);
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

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: code }),
    puppeteer: {
      headless: env.puppeteerHeadless,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
  });

  const state = {
    client,
    qr: null,
    ready: false,
    aiConfig: null,
    stopList: new Map(),
    lastQrTimestamp: 0,
    chatHistory: new Map(),
    scheduledJobs: new Map(),
  };

  registerEventHandlers(code, state);
  sessions.set(code, state);

  try {
    await client.initialize();
    await hydrateSessionState(code, state);
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
      state.qr = await qrcode.toDataURL(qr);
    } catch (error) {
      logger.error({ err: error }, "Failed to convert QR to data URL");
    }
  });

  state.client.on("ready", () => {
    state.ready = true;
    logger.info({ code }, "WhatsApp client ready");
  });

  state.client.on("disconnected", (reason) => {
    logger.warn({ code, reason }, "WhatsApp client disconnected");
    state.ready = false;
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

    if (text.toLowerCase() === "!stopauto") {
      current.stopList.set(chatId, Date.now());
      await safeReply(msg, "🤖 Auto replies disabled for 24 hours.");
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
  appendHistoryEntry(current, chatId, { role: "assistant", text: customReply });
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
  const baseConfig = session.aiConfig ? { ...session.aiConfig } : { ...DEFAULT_AI_CONFIG };
  const nextConfig = {
    ...baseConfig,
    ...config,
  };

  nextConfig.contextWindow = clampContextWindow(config.contextWindow ?? baseConfig.contextWindow);
  nextConfig.customReplies = sanitizeCustomReplies(config.customReplies ?? baseConfig.customReplies);

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

  const results = await performBulkSend(session, payload.message, numbers, code);
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
    logger.error({ err: error, code, jobId }, "Failed to persist scheduled message");
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
      logger.error({ err: error, code, jobId }, "Failed to persist cancellation");
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
    await deleteScheduledJob(code, jobId);
  } catch (error) {
    logger.error({ err: error, code, jobId }, "Failed to delete scheduled message");
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
  const delay = typeof overrideDelay === "number" ? Math.max(overrideDelay, 0) : Math.max(sendTime - Date.now(), 0);

  const run = async () => {
    job.timeoutId = null;
    job.status = "sending";
    job.error = undefined;

    try {
      await updateScheduledJob(code, job.id, { status: "sending", error: null });
    } catch (error) {
      logger.error({ err: error, code, jobId: job.id }, "Failed to mark job as sending");
    }

    if (!session.ready) {
      job.status = "scheduled";
      try {
        await updateScheduledJob(code, job.id, { status: "scheduled" });
      } catch (error) {
        logger.error({ err: error, code, jobId: job.id }, "Failed to reschedule job while client not ready");
      }
      scheduleJobExecution(code, session, job, SCHEDULE_RETRY_DELAY_MS);
      return;
    }

    try {
      const results = await performBulkSend(session, job.message, job.numbers, code);
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
        logger.error({ err: error, code, jobId: job.id }, "Failed to persist sent job state");
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
        logger.error({ err: persistError, code, jobId: job.id }, "Failed to persist failed job state");
      }
      logger.error({ err: error, code, jobId: job.id }, "Scheduled message failed");
    }
  };

  const runner = () => {
    run().catch((error) => {
      logger.error({ err: error, code, jobId: job.id }, "Scheduled message execution error");
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
  for (const [code, session] of sessions.entries()) {
    try {
      await flushSessionMessages(code);
    } catch (error) {
      logger.error({ err: error, code }, "Failed to flush messages during shutdown");
    }

    try {
      clearScheduledJobs(session);
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
    logger.error({ err: error, code }, "Failed to flush messages before logout");
  }

  try {
    clearScheduledJobs(session);
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
      const trigger = typeof entry.trigger === "string" ? entry.trigger.trim() : "";
      const response = typeof entry.response === "string" ? entry.response.trim() : "";
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

  const limit = clampContextWindow(session.aiConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
  if (history.length > limit) {
    history.splice(0, history.length - limit);
  }

  historyStore.set(chatId, history);
  return history;
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
  await Promise.all([hydrateCustomReplies(code, session), hydrateScheduledJobs(code, session)]);
}

async function hydrateCustomReplies(code, session) {
  try {
    const persisted = await loadSessionConfig(code);
    const baseConfig = session.aiConfig ? { ...session.aiConfig } : { ...DEFAULT_AI_CONFIG };
    const storedReplies = Array.isArray(persisted?.customReplies) ? persisted.customReplies : [];
    baseConfig.customReplies = sanitizeCustomReplies(storedReplies);
    session.aiConfig = baseConfig;
  } catch (error) {
    logger.error({ err: error, code }, "Failed to hydrate custom replies");
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
          await updateScheduledJob(code, job.id, { status: "scheduled", error: null });
        } catch (error) {
          logger.error({ err: error, code, jobId: job.id }, "Failed to reset in-flight job");
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
  const limit = clampContextWindow(contextWindow ?? session.aiConfig?.contextWindow);
  return history.slice(-limit);
}

function ensureScheduledJobs(session) {
  if (!session.scheduledJobs) {
    session.scheduledJobs = new Map();
  }
  return session.scheduledJobs;
}

function serializeAiConfig(config) {
  return {
    hasApiKey: Boolean(config.apiKey),
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
  AUTH_CODES,
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
};
