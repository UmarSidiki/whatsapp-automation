import logger from "../../config/logger";
import { loadSessionConfig } from "../persistence/sessionConfigService";
import { sanitizeCustomReplies, serializeCustomReplies } from "./utils";
import { DEFAULT_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW } from "../../constants";

const DEFAULT_AI_CONFIG = {
  apiKey: "",
  model: "",
  systemPrompt: undefined,
  autoReplyEnabled: true,
  voiceReplyEnabled: false,
  speechToTextApiKey: "",
  textToSpeechApiKey: "",
  voiceLanguage: "en-US",
  voiceGender: "NEUTRAL",
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  customReplies: [],
};

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

function updateAiConfig(session, config) {
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
      autoReplyEnabled: nextConfig.autoReplyEnabled,
      customReplyCount: nextConfig.customReplies.length,
      contextWindow: nextConfig.contextWindow,
    },
    "AI configuration updated"
  );

  return nextConfig;
}

function getAiConfig(session) {
  if (!session || !session.aiConfig) {
    return null;
  }
  return serializeAiConfig(session.aiConfig);
}

function serializeAiConfig(config) {
  const apiKey = typeof config.apiKey === "string" ? config.apiKey : "";
  const speechToTextApiKey =
    typeof config.speechToTextApiKey === "string"
      ? config.speechToTextApiKey
      : "";
  const textToSpeechApiKey =
    typeof config.textToSpeechApiKey === "string"
      ? config.textToSpeechApiKey
      : "";

  return {
    apiKey,
    hasApiKey: Boolean(apiKey),
    model: config.model,
    systemPrompt: config.systemPrompt,
    autoReplyEnabled: config.autoReplyEnabled,
    contextWindow: clampContextWindow(config.contextWindow),
    customReplies: serializeCustomReplies(config.customReplies),
    voiceReplyEnabled: config.voiceReplyEnabled ?? false,
    speechToTextApiKey,
    textToSpeechApiKey,
    voiceLanguage: config.voiceLanguage ?? "en-US",
    voiceGender: config.voiceGender ?? "NEUTRAL",
  };
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
      logger.debug(
        { code, persistedKeys: Object.keys(persisted) },
        "Loaded persisted session config"
      );
    }
    const storedConfig = persisted?.aiConfig || {};
    const storedCredentials = persisted?.credentials?.gemini || {};
    const storedGoogleCloudCredentials =
      persisted?.credentials?.googleCloud || {};
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

    // Restore voice configuration
    baseConfig.voiceReplyEnabled =
      storedConfig.voiceReplyEnabled ?? baseConfig.voiceReplyEnabled ?? false;
    baseConfig.voiceLanguage =
      storedConfig.voiceLanguage ?? baseConfig.voiceLanguage ?? "en-US";
    baseConfig.voiceGender =
      storedConfig.voiceGender ?? baseConfig.voiceGender ?? "NEUTRAL";

    // Restore Google Cloud API keys for voice features
    const speechToTextApiKey =
      typeof storedGoogleCloudCredentials.speechToTextApiKey === "string" &&
      storedGoogleCloudCredentials.speechToTextApiKey.trim()
        ? storedGoogleCloudCredentials.speechToTextApiKey.trim()
        : "";
    const textToSpeechApiKey =
      typeof storedGoogleCloudCredentials.textToSpeechApiKey === "string" &&
      storedGoogleCloudCredentials.textToSpeechApiKey.trim()
        ? storedGoogleCloudCredentials.textToSpeechApiKey.trim()
        : "";

    if (speechToTextApiKey) {
      baseConfig.speechToTextApiKey = speechToTextApiKey;
    }
    if (textToSpeechApiKey) {
      baseConfig.textToSpeechApiKey = textToSpeechApiKey;
    }

    const storedReplies = Array.isArray(storedConfig.customReplies)
      ? storedConfig.customReplies
      : Array.isArray(persisted?.customReplies)
      ? persisted.customReplies
      : [];

    baseConfig.customReplies = sanitizeCustomReplies(storedReplies);

    session.aiConfig = baseConfig;

    // Log voice configuration status for debugging
    if (baseConfig.voiceReplyEnabled) {
      logger.info(
        {
          code,
          voiceReplyEnabled: true,
          hasSpeechToTextKey: Boolean(baseConfig.speechToTextApiKey),
          hasTextToSpeechKey: Boolean(baseConfig.textToSpeechApiKey),
          voiceLanguage: baseConfig.voiceLanguage,
        },
        "Voice configuration restored"
      );
    }
  } catch (error) {
    logger.error({ err: error, code }, "Failed to hydrate AI configuration");
    if (!session.aiConfig) {
      session.aiConfig = { ...DEFAULT_AI_CONFIG };
    }
  }
}

async function hydrateScheduledJobs(code, session) {
  const { ensureScheduledJobs } = await import("./scheduler");
  const { listScheduledJobs, updateScheduledJob } = await import("../persistence/schedulePersistenceService");
  const { documentToJob, scheduleJobExecution } = await import("./scheduler");
  
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
        scheduleJobExecution(code, session, job, undefined);
      }
    }
  } catch (error) {
    logger.error({ err: error, code }, "Failed to hydrate scheduled jobs");
  }
}

export {
  updateAiConfig,
  getAiConfig,
  hydrateSessionState,
  hydrateAiConfig,
  hydrateScheduledJobs,
  clampContextWindow,
  DEFAULT_AI_CONFIG,
};