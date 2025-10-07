"use strict";

const aiConfigSchema = require("../validation/aiConfigSchema");
const { customRepliesSchema } = require("../validation/customRepliesSchema");
const {
  getSession,
  updateAiConfig,
  getAiConfig: fetchAiConfig,
} = require("../services/sessionService");
const { DEFAULT_CONTEXT_WINDOW } = require("../constants");
const { saveAiConfig, loadSessionConfig } = require("../services/sessionConfigService");
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

  const updatedConfig = updateAiConfig(req.params.code, {
    ...sanitizedConfig,
    apiKey,
  });

  try {
    await saveAiConfig(req.params.code, updatedConfig);
  } catch (error) {
    logger.error({ err: error, code: req.params.code }, "Failed to persist AI configuration");
    return res.status(500).json({ error: "Failed to persist AI configuration" });
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
      hasApiKey: Boolean(
        persisted?.aiConfig?.apiKey || persisted?.credentials?.gemini?.apiKey
      ),
      model: persisted?.aiConfig?.model,
    },
  });
}

function getAiConfigHandler(req, res) {
  const session = getSession(req.params.code);
  if (!session) {
    return res.status(404).json({ error: "No session found" });
  }

  const config =
    fetchAiConfig(req.params.code) || {
      hasApiKey: false,
      model: "",
      systemPrompt: undefined,
      autoReplyEnabled: true,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      customReplies: [],
    };

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

  const updatedConfig = updateAiConfig(req.params.code, {
    customReplies: parseResult.data.customReplies,
  });

  try {
    await saveAiConfig(req.params.code, updatedConfig);
  } catch (error) {
    logger.error({ err: error, code: req.params.code }, "Failed to persist AI configuration");
  }

  const config = fetchAiConfig(req.params.code);
  return res.json({
    success: true,
    customReplies: config?.customReplies || [],
  });
}

module.exports = {
  configureAi,
  getAiConfig: getAiConfigHandler,
  updateCustomReplies,
};
