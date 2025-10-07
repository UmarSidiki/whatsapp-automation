"use strict";

const logger = require("../config/logger");
const { connectMongo, getCollection } = require("./mongoService");

let initialized = false;

async function ensureIndexes() {
  if (initialized) {
    return;
  }

  await connectMongo();
  const collection = getCollection("sessionConfigs");
  await collection.createIndex({ sessionCode: 1 }, { unique: true });
  initialized = true;
}

async function loadSessionConfig(sessionCode) {
  if (!sessionCode) {
    return null;
  }
  try {
    await ensureIndexes();
    const collection = getCollection("sessionConfigs");
    return await collection.findOne({ sessionCode });
  } catch (error) {
    logger.error({ err: error, sessionCode }, "Failed to load session config");
    return null;
  }
}

function sanitizeCustomRepliesForStorage(customReplies) {
  if (!Array.isArray(customReplies)) {
    return [];
  }
  return customReplies.map((entry) => ({
    trigger: entry.trigger,
    response: entry.response,
    matchType: entry.matchType,
  }));
}

function sanitizeAiConfigForStorage(aiConfig) {
  if (!aiConfig || typeof aiConfig !== "object") {
    return null;
  }
  const apiKey = typeof aiConfig.apiKey === "string" ? aiConfig.apiKey.trim() : "";
  return {
    apiKey,
    model: aiConfig.model || "",
    systemPrompt: aiConfig.systemPrompt,
    autoReplyEnabled: aiConfig.autoReplyEnabled !== false,
    contextWindow: aiConfig.contextWindow,
  };
}

function hasCustomRepliesPayload(value) {
  return Array.isArray(value);
}

async function saveSessionConfig(sessionCode, { aiConfig, customReplies } = {}) {
  if (!sessionCode) {
    throw new Error("sessionCode is required");
  }

  await ensureIndexes();
  const collection = getCollection("sessionConfigs");
  const now = new Date();

  const setPayload = {
    updatedAt: now,
  };
  const unsetPayload = {};

  if (typeof aiConfig !== "undefined") {
    const sanitizedAiConfig = sanitizeAiConfigForStorage(aiConfig);
    if (sanitizedAiConfig) {
      setPayload.aiConfig = sanitizedAiConfig;
      const apiKey = sanitizedAiConfig.apiKey;
      if (apiKey) {
        setPayload["credentials.gemini.apiKey"] = apiKey;
        setPayload["credentials.gemini.updatedAt"] = now;
      } else {
        unsetPayload["credentials.gemini"] = "";
      }
    } else {
      unsetPayload.aiConfig = "";
      unsetPayload["credentials.gemini"] = "";
    }
  }

  if (typeof customReplies !== "undefined") {
    const sanitizedCustomReplies = sanitizeCustomRepliesForStorage(customReplies);
    if (sanitizedCustomReplies.length) {
      setPayload.customReplies = sanitizedCustomReplies;
      unsetPayload["aiConfig.customReplies"] = "";
    } else if (hasCustomRepliesPayload(customReplies)) {
      unsetPayload.customReplies = "";
      unsetPayload["aiConfig.customReplies"] = "";
    }
  }

  const updateDoc = {
    $set: setPayload,
    $setOnInsert: {
      createdAt: now,
    },
  };

  if (Object.keys(unsetPayload).length) {
    updateDoc.$unset = unsetPayload;
  }

  await collection.updateOne({ sessionCode }, updateDoc, { upsert: true });
}

async function saveAiConfig(sessionCode, aiConfig) {
  await saveSessionConfig(sessionCode, { aiConfig, customReplies: aiConfig?.customReplies });
}

async function saveCustomReplies(sessionCode, customReplies) {
  await saveSessionConfig(sessionCode, { customReplies });
}

module.exports = {
  loadSessionConfig,
  saveAiConfig,
  saveCustomReplies,
};
