"use strict";

const aiConfigSchema = require("../validation/aiConfigSchema");
const { customRepliesSchema } = require("../validation/customRepliesSchema");
const {
  getSession,
  updateAiConfig,
  getAiConfig: fetchAiConfig,
} = require("../services/sessionService");
const { DEFAULT_CONTEXT_WINDOW } = require("../constants");
const { loadSessionConfig } = require("../services/sessionConfigService");
const { loadPersonaMessages } = require("../services/ai/personaPersistenceService");
const logger = require("../config/logger");

async function configureAi(req, res) {
  const session = getSession(req.params.code);
  if (!session) {
    return res.status(404).json({ error: "No session found" });
  }

  const parseResult = aiConfigSchema.safeParse(req.body || {});
  if (!parseResult.success) {
    return res.status(400).json({
      error: "Invalid AI configuration",
      details: parseResult.error.flatten(),
    });
  }

  const { reuseStoredApiKey, ...sanitizedConfig } = parseResult.data;

  let apiKey = sanitizedConfig.apiKey;
  if (!apiKey && reuseStoredApiKey) {
    apiKey = session.aiConfig?.apiKey || "";
  }

  if (!apiKey) {
    return res.status(400).json({ error: "API key is required" });
  }

  // Handle voice API keys - allow empty if voice is disabled
  let speechToTextApiKey = sanitizedConfig.speechToTextApiKey || "";
  let textToSpeechApiKey = sanitizedConfig.textToSpeechApiKey || "";
  
  // If keys are not provided but voice is enabled, try to reuse stored keys
  if (sanitizedConfig.voiceReplyEnabled) {
    if (!speechToTextApiKey && session.aiConfig?.speechToTextApiKey) {
      speechToTextApiKey = session.aiConfig.speechToTextApiKey;
    }
    if (!textToSpeechApiKey && session.aiConfig?.textToSpeechApiKey) {
      textToSpeechApiKey = session.aiConfig.textToSpeechApiKey;
    }
  }

  try {
    await updateAiConfig(req.params.code, {
      ...sanitizedConfig,
      apiKey,
      speechToTextApiKey,
      textToSpeechApiKey,
    });
  } catch (error) {
    logger.error({ err: error, code: req.params.code }, "Failed to update AI configuration");
    return res.status(500).json({ error: "Failed to update AI configuration" });
  }

  let persisted;
  try {
    persisted = await loadSessionConfig(req.params.code);
  } catch (error) {
    logger.error({ err: error, code: req.params.code }, "Failed to reload persisted AI config");
  }

  const responseConfig = fetchAiConfig(req.params.code);
  return res.json({
    success: true,
    config: responseConfig,
    persisted: {
      updatedAt: persisted?.updatedAt,
      hasApiKey: Boolean(persisted?.credentials?.gemini?.apiKey),
      hasSpeechToTextApiKey: Boolean(persisted?.credentials?.googleCloud?.speechToTextApiKey),
      hasTextToSpeechApiKey: Boolean(persisted?.credentials?.googleCloud?.textToSpeechApiKey),
      model: persisted?.aiConfig?.model,
    },
  });
}

async function getAiConfigHandler(req, res) {
  const session = getSession(req.params.code);
  if (!session) {
    return res.status(404).json({ error: "No session found" });
  }

  const config =
    fetchAiConfig(req.params.code) || {
      apiKey: "",
      hasApiKey: false,
      model: "",
      systemPrompt: undefined,
      autoReplyEnabled: true,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      customReplies: [],
      voiceReplyEnabled: false,
      speechToTextApiKey: "",
      textToSpeechApiKey: "",
      voiceLanguage: "en-US",
      voiceGender: "NEUTRAL",
    };

  // Load persisted data to check if API keys are stored in database
  let persisted;
  try {
    persisted = await loadSessionConfig(req.params.code);
  } catch (error) {
    logger.debug({ err: error, code: req.params.code }, "Failed to load persisted config for status check");
  }

  // Add flags to indicate if API keys are stored in database
  if (persisted) {
    config.hasApiKey = Boolean(persisted.credentials?.gemini?.apiKey);
    config.hasSpeechToTextApiKey = Boolean(persisted.credentials?.googleCloud?.speechToTextApiKey);
    config.hasTextToSpeechApiKey = Boolean(persisted.credentials?.googleCloud?.textToSpeechApiKey);
  }

  return res.json({ config });
}

async function updateCustomReplies(req, res) {
  const session = getSession(req.params.code);
  if (!session) {
    return res.status(404).json({ error: "No session found" });
  }

  const parseResult = customRepliesSchema.safeParse(req.body || {});
  if (!parseResult.success) {
    return res.status(400).json({
      error: "Invalid custom reply payload",
      details: parseResult.error.flatten(),
    });
  }

  try {
    await updateAiConfig(req.params.code, {
      customReplies: parseResult.data.customReplies,
    });
  } catch (error) {
    logger.error({ err: error, code: req.params.code }, "Failed to update custom replies");
    return res.status(500).json({ error: "Failed to update custom replies" });
  }

  const config = fetchAiConfig(req.params.code);
  return res.json({
    success: true,
    customReplies: config?.customReplies || [],
  });
}

async function getPersonaMessages(req, res) {
  const session = getSession(req.params.code);
  if (!session) {
    return res.status(404).json({ error: "No session found" });
  }

  try {
    const messages = await loadPersonaMessages(req.params.code, 100); // Load last 100 messages
    return res.json({ messages });
  } catch (error) {
    logger.error({ err: error, code: req.params.code }, "Failed to load persona messages");
    return res.status(500).json({ error: "Failed to load persona messages" });
  }
}

module.exports = {
  configureAi,
  getAiConfig: getAiConfigHandler,
  updateCustomReplies,
  getPersonaMessages,
};
