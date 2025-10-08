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
    return { config: null, apiKey: "", speechToTextApiKey: "", textToSpeechApiKey: "" };
  }

  const apiKey = typeof aiConfig.apiKey === "string" ? aiConfig.apiKey.trim() : "";
  const speechToTextApiKey = typeof aiConfig.speechToTextApiKey === "string" ? aiConfig.speechToTextApiKey.trim() : "";
  const textToSpeechApiKey = typeof aiConfig.textToSpeechApiKey === "string" ? aiConfig.textToSpeechApiKey.trim() : "";

  const sanitizedConfig = {
    model: aiConfig.model || "",
    systemPrompt: aiConfig.systemPrompt,
    autoReplyEnabled: aiConfig.autoReplyEnabled !== false,
    contextWindow: aiConfig.contextWindow,
    voiceReplyEnabled: aiConfig.voiceReplyEnabled || false,
    voiceLanguage: aiConfig.voiceLanguage || "en-US",
    voiceGender: aiConfig.voiceGender || "NEUTRAL",
  };

  return { config: sanitizedConfig, apiKey, speechToTextApiKey, textToSpeechApiKey };
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
    const { config: sanitizedAiConfig, apiKey, speechToTextApiKey, textToSpeechApiKey } = sanitizeAiConfigForStorage(aiConfig);
    const hasApiKeyField = Object.prototype.hasOwnProperty.call(aiConfig, "apiKey");
    const hasSpeechToTextApiKeyField = Object.prototype.hasOwnProperty.call(aiConfig, "speechToTextApiKey");
    const hasTextToSpeechApiKeyField = Object.prototype.hasOwnProperty.call(aiConfig, "textToSpeechApiKey");

    if (sanitizedAiConfig) {
      setPayload.aiConfig = sanitizedAiConfig;
    } else {
      unsetPayload.aiConfig = "";
    }

    // Handle Gemini API key
    if (apiKey) {
      setPayload["credentials.gemini.apiKey"] = apiKey;
      setPayload["credentials.gemini.updatedAt"] = now;
    } else if (hasApiKeyField) {
      unsetPayload["credentials.gemini"] = "";
    }

    // Handle Speech-to-Text API key
    if (speechToTextApiKey) {
      setPayload["credentials.googleCloud.speechToTextApiKey"] = speechToTextApiKey;
      setPayload["credentials.googleCloud.speechToTextUpdatedAt"] = now;
    } else if (hasSpeechToTextApiKeyField) {
      unsetPayload["credentials.googleCloud.speechToTextApiKey"] = "";
    }

    // Handle Text-to-Speech API key
    if (textToSpeechApiKey) {
      setPayload["credentials.googleCloud.textToSpeechApiKey"] = textToSpeechApiKey;
      setPayload["credentials.googleCloud.textToSpeechUpdatedAt"] = now;
    } else if (hasTextToSpeechApiKeyField) {
      unsetPayload["credentials.googleCloud.textToSpeechApiKey"] = "";
    }
  }

  if (typeof customReplies !== "undefined") {
    const sanitizedCustomReplies = sanitizeCustomRepliesForStorage(customReplies);
    if (sanitizedCustomReplies.length) {
      setPayload.customReplies = sanitizedCustomReplies;
    } else if (hasCustomRepliesPayload(customReplies)) {
      unsetPayload.customReplies = "";
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
