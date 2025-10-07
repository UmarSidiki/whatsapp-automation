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
  return {
    apiKey: aiConfig.apiKey || "",
    model: aiConfig.model || "",
    systemPrompt: aiConfig.systemPrompt,
    autoReplyEnabled: aiConfig.autoReplyEnabled !== false,
    contextWindow: aiConfig.contextWindow,
    customReplies: sanitizeCustomRepliesForStorage(aiConfig.customReplies),
  };
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

  if (aiConfig) {
    setPayload.aiConfig = sanitizeAiConfigForStorage(aiConfig);
  }

  if (customReplies) {
    setPayload.customReplies = sanitizeCustomRepliesForStorage(customReplies);
  }

  await collection.updateOne(
    { sessionCode },
    {
      $set: setPayload,
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true }
  );
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
