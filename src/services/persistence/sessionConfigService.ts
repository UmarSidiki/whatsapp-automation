import logger from "../../config/logger";
import { connectMongo, getCollection } from "../database/mongoService";
import type { Document } from "mongodb";

let initialized = false;

async function ensureIndexes(): Promise<void> {
  if (initialized) return;

  await connectMongo();
  const collection = getCollection<Document>("sessionConfigs");
  await collection.createIndex({ sessionCode: 1 }, { unique: true });
  initialized = true;
}

export async function loadSessionConfig(sessionCode: string): Promise<Document | null> {
  if (!sessionCode) {
    return null;
  }
  try {
    await ensureIndexes();
    const collection = getCollection<Document>("sessionConfigs");
    return await collection.findOne({ sessionCode });
  } catch (error: unknown) {
    logger.error({ err: error, sessionCode }, "Failed to load session config");
    return null;
  }
}

function sanitizeCustomRepliesForStorage(customReplies: unknown): unknown[] {
  if (!Array.isArray(customReplies)) {
    return [];
  }
  return (customReplies as { [key: string]: unknown }[]).map((entry) => ({
    trigger: entry.trigger,
    response: entry.response,
    matchType: entry.matchType,
  }));
}

function sanitizeAiConfigForStorage(aiConfig: unknown): { config: unknown; apiKey: string; speechToTextApiKey: string; textToSpeechApiKey: string } {
  if (!aiConfig || typeof aiConfig !== "object") {
    return { config: null, apiKey: "", speechToTextApiKey: "", textToSpeechApiKey: "" };
  }

  const asAny = aiConfig as Record<string, unknown>;
  const apiKey = typeof asAny.apiKey === "string" ? (asAny.apiKey as string).trim() : "";
  const speechToTextApiKey = typeof asAny.speechToTextApiKey === "string" ? (asAny.speechToTextApiKey as string).trim() : "";
  const textToSpeechApiKey = typeof asAny.textToSpeechApiKey === "string" ? (asAny.textToSpeechApiKey as string).trim() : "";

  const sanitizedConfig = {
    model: (asAny.model as string) || "",
    systemPrompt: asAny.systemPrompt,
    autoReplyEnabled: (asAny.autoReplyEnabled as boolean) !== false,
    contextWindow: asAny.contextWindow,
    voiceReplyEnabled: (asAny.voiceReplyEnabled as boolean) || false,
    voiceLanguage: (asAny.voiceLanguage as string) || "en-US",
    voiceGender: (asAny.voiceGender as string) || "NEUTRAL",
  };

  return { config: sanitizedConfig, apiKey, speechToTextApiKey, textToSpeechApiKey };
}

function hasCustomRepliesPayload(value: unknown): boolean {
  return Array.isArray(value);
}

export async function saveSessionConfig(sessionCode: string, { aiConfig, customReplies }: { aiConfig?: unknown; customReplies?: unknown } = {}): Promise<void> {
  if (!sessionCode) {
    throw new Error("sessionCode is required");
  }

  await ensureIndexes();
  const collection = getCollection<Document>("sessionConfigs");
  const now = new Date();

  const setPayload: Record<string, unknown> = {
    updatedAt: now,
  };
  const unsetPayload: Record<string, unknown> = {};

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

  const updateDoc: Record<string, unknown> = {
    $set: setPayload,
    $setOnInsert: {
      createdAt: now,
    },
  };

  if (Object.keys(unsetPayload).length) {
  (updateDoc as Record<string, unknown>).$unset = unsetPayload;
  }

  await collection.updateOne({ sessionCode }, updateDoc as Record<string, unknown>, { upsert: true });
}

export async function saveAiConfig(sessionCode: string, aiConfig: unknown): Promise<void> {
  await saveSessionConfig(sessionCode, { aiConfig, customReplies: (aiConfig as { customReplies?: unknown })?.customReplies });
}

export async function saveCustomReplies(sessionCode: string, customReplies: unknown): Promise<void> {
  await saveSessionConfig(sessionCode, { customReplies });
}

export default {
  loadSessionConfig,
  saveAiConfig,
  saveCustomReplies,
};
