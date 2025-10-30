"use strict";

import env from "../../config/env";
import logger from "../../config/logger";
import { fetchFn, createTimeoutSignal } from "../../utils/http";

const MAX_MESSAGE_LENGTH = 2000;
const MAX_PROMPT_CHARS = 6000;

// Context caching configuration
const CACHE_TTL_SECONDS = 7200; // 2 hours
// FIX: Set to the correct minimum for modern Flash models
const MIN_TOKENS_FOR_CACHING = 2048;

// ##################################################################
// TYPE DEFINITIONS
// ##################################################################

// FIX: Define types to replace 'any'
interface GenerateReplyParams {
  apiKey: string;
  model: string;
  systemPrompt: string;
  personaExamples: string[];
  contactId: string;
}

interface HistoryEntry {
  role: "user" | "assistant"; // Use 'assistant' for your internal representation
  text: string;
}

interface SanitizedHistoryResult {
  history: { role: "user" | "assistant"; text: string }[];
  truncated: boolean;
  totalChars: number;
}

interface CacheEntry {
  name: string;
  expiresAt: number;
  apiKey: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: [{ text: string }];
}

interface GeminiSystemInstruction {
  parts: [{ text: string }];
}

interface GenerateContentPayload {
  contents: GeminiContent[];
  cachedContent?: string;
  system_instruction?: GeminiSystemInstruction;
}

interface CreateCachePayload {
  model: string;
  systemInstruction: GeminiSystemInstruction;
  contents: GeminiContent[];
  ttl: string;
}

// FIX: Use the specific CacheEntry type
const cacheRegistry = new Map<string, CacheEntry>();

// ##################################################################
// MAIN REPLY FUNCTION
// ##################################################################

async function generateReply(
  // FIX: Use the new interface
  {
    apiKey,
    model,
    systemPrompt,
    personaExamples,
    contactId,
  }: GenerateReplyParams,
  history: HistoryEntry[] // FIX: Use HistoryEntry type
) {
  const key = String(apiKey || "").trim();
  const modelName = String(model || "").trim();
  if (!key || !modelName) return null;

  const messages = Array.isArray(history) ? history : [];
  if (!messages.length) return null;

  // 1. Sanitize the incoming chat history
  const {
    history: sanitizedHistory,
    truncated: historyTruncated,
    totalChars,
  } = sanitizeHistory(messages);

  // 2. Build the persona prompt from examples
  const personaText = buildPersonaPrompt(personaExamples);
  const staticSystemPrompt =
    typeof systemPrompt === "string" ? systemPrompt.trim() : "";

  let payload: GenerateContentPayload; // FIX: Use specific payload type
  let isCached = false;
  let cacheKey: string | null = null; // This declaration fixes the `cacheKey` scope errors

  // 3. Decide whether to use caching
  const estimatedTokens = Math.floor(
    (personaText.length + staticSystemPrompt.length) / 4
  );

  if (
    personaExamples &&
    personaExamples.length > 0 &&
    contactId &&
    estimatedTokens >= MIN_TOKENS_FOR_CACHING
  ) {
    // 4a. Caching Path
    cacheKey = `${contactId}_${hashString(personaText)}`; // Assign to existing var
    const cachedContent = await getOrCreateCache(
      key,
      modelName,
      staticSystemPrompt,
      personaText,
      cacheKey
    );

    if (cachedContent) {
      payload = buildRequestPayload(null, sanitizedHistory, cachedContent.name);
      isCached = true;
    } else {
      const fullPrompt =
        (staticSystemPrompt ? `${staticSystemPrompt}\n\n` : "") + personaText;
      payload = buildRequestPayload(fullPrompt, sanitizedHistory, null);
    }
  } else {
    // 4b. Non-Caching Path
    const fullPrompt =
      (staticSystemPrompt ? `${staticSystemPrompt}\n\n` : "") + personaText;
    payload = buildRequestPayload(fullPrompt, sanitizedHistory, null);
  }

  if (!payload.contents.length) {
    return null;
  }

  if (historyTruncated) {
    logger.debug(
      {
        historyTruncated,
        totalChars,
        maxChars: MAX_PROMPT_CHARS,
        messageCount: sanitizedHistory.length,
        isCached,
      },
      "Gemini prompt history truncated"
    );
  }

  const url = `${env.GEMINI_BASE_URL}/v1beta/models/${modelName}:generateContent?key=${key}`;

  // 5. Make API Call
  let response: Response; // FIX: Use the built-in 'Response' type
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: createTimeoutSignal(env.AI_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      logger.warn({ err: error }, "Gemini request timed out");
      return null;
    }
    throw error;
  }

  // 6. Handle Response
  if (!response.ok) {
    // FIX: Define errorPayload as a potential object
    const errorPayload: { error?: { message?: string } } | null = await response
      .clone()
      .json()
      .catch(() => null);
    const error = new Error(`Gemini API responded with ${response.status}`);
    (error as any).statusCode = response.status; // Keeping 'any' here is acceptable for custom error props
    (error as any).payload = errorPayload;

    if (response.status === 503) {
      logger.warn(
        {
          status: response.status,
          message: errorPayload?.error?.message,
          model: modelName,
        },
        "Gemini API overloaded - model unavailable"
      );
    }

    // This block now works because cacheKey is in scope
    if (errorPayload?.error?.message?.includes("CachedContent not found")) {
      logger.warn(
        { cacheKey },
        "CachedContent not found on server, deleting from local registry."
      );
      if (cacheKey) cacheRegistry.delete(cacheKey);
    }

    throw error;
  }

  // FIX: Define 'data' structure
  const data: {
    candidates?: [{ content?: { parts?: [{ text?: string }] } }];
  } = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof text === "string" && text.trim().length ? text.trim() : null;
}

// ##################################################################
// CACHING FUNCTIONS
// ##################################################################

async function getOrCreateCache(
  apiKey: string,
  model: string,
  systemPrompt: string | null,
  personaText: string,
  cacheKey: string
): Promise<CacheEntry | null> {
  // FIX: Use specific return type
  const existing = cacheRegistry.get(cacheKey);
  if (existing && existing.expiresAt > Date.now()) {
    return existing;
  }

  if (existing) {
    await deleteRemoteCache(existing.apiKey, existing.name);
  }

  try {
    const cachePayload: CreateCachePayload = {
      // FIX: Use specific payload type
      model: `models/${model}`,
      systemInstruction: {
        parts: [{ text: systemPrompt || "" }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: personaText }],
        },
      ],
      ttl: `${CACHE_TTL_SECONDS}s`,
    };

    const url = `${env.GEMINI_BASE_URL}/v1beta/cachedContents?key=${apiKey}`;
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cachePayload),
      signal: createTimeoutSignal(30000),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.warn(
        { status: response.status, error, cacheKey },
        "Failed to create Gemini cache, falling back to non-cached"
      );
      return null;
    }

    const data: { name: string } = await response.json(); // FIX: Define data structure
    const cacheEntry: CacheEntry = {
      // FIX: Use specific type
      name: data.name,
      expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
      apiKey: apiKey,
    };

    cacheRegistry.set(cacheKey, cacheEntry);
    logger.info(
      { cacheName: data.name, ttl: CACHE_TTL_SECONDS, cacheKey },
      "Created new Gemini context cache"
    );

    return cacheEntry;
  } catch (error) {
    logger.warn(
      { err: error, cacheKey },
      "Error creating context cache, proceeding without cache"
    );
    return null;
  }
}

async function deleteRemoteCache(apiKey: string, cacheName: string) {
  if (!apiKey || !cacheName) return;

  logger.debug({ cacheName }, "Deleting expired/invalid cache from remote");
  try {
    const url = `${env.GEMINI_BASE_URL}/v1beta/${cacheName}?key=${apiKey}`;
    await fetchFn(url, {
      method: "DELETE",
      signal: createTimeoutSignal(10000),
    });
  } catch (error) {
    logger.warn({ err: error, cacheName }, "Failed to delete remote cache");
  }
}

async function cleanupExpiredCaches(): Promise<void> {
  const now = Date.now();
  let removed = 0;

  for (const [key, entry] of cacheRegistry.entries()) {
    if (entry.expiresAt <= now) {
      await deleteRemoteCache(entry.apiKey, entry.name);
      cacheRegistry.delete(key);
      removed++;
    }
  }

  if (removed > 0) {
    logger.debug(
      { removed, remaining: cacheRegistry.size },
      "Cleaned up expired cache entries"
    );
  }
}

setInterval(cleanupExpiredCaches, 10 * 60 * 1000);

// ##################################################################
// UTILITY FUNCTIONS
// ##################################################################

function buildRequestPayload(
  fallbackPrompt: string | null,
  history: HistoryEntry[], // FIX: Use specific type
  cacheName: string | null
): GenerateContentPayload {
  // FIX: Use specific return type
  const contents: GeminiContent[] = history.map((entry) => ({
    role: entry.role === "assistant" ? "model" : "user",
    parts: [{ text: entry.text }],
  }));

  const payload: GenerateContentPayload = { contents };

  if (cacheName) {
    payload.cachedContent = cacheName;
  } else if (fallbackPrompt) {
    payload.system_instruction = {
      parts: [{ text: fallbackPrompt }],
    };
  }

  return payload;
}

function buildPersonaPrompt(examples: string[]): string {
  const exampleList = examples
    .filter((msg) => msg && msg.trim())
    .map((msg, index) => `Example ${index + 1}:\n${msg.trim()}`)
    .join("\n\n");

  if (!exampleList) return "";

  // ... (persona prompt text is fine)
  return `IMPORTANT: Learn and mimic my writing style from these examples of how I respond to different messages:

${exampleList}

Analyze and match my:
- Tone (casual/formal/friendly) based on context
- Sentence structure and length
- Use of punctuation and emojis
- Vocabulary and phrases
- Level of detail in responses
- How I adapt my style to different types of messages

Reply naturally as if you were me, maintaining consistency with my communication style and adapting appropriately to the user's message.`;
}

function sanitizeHistory(history: HistoryEntry[]): SanitizedHistoryResult {
  // FIX: Use types
  const sanitized: HistoryEntry[] = []; // FIX: Use type
  let truncated = false;

  for (const entry of history) {
    if (!entry) continue;
    const rawText = typeof entry.text === "string" ? entry.text.trim() : "";
    if (!rawText) continue;
    let text = rawText;
    if (rawText.length > MAX_MESSAGE_LENGTH) {
      text = rawText.slice(-MAX_MESSAGE_LENGTH);
      truncated = true;
    }
    sanitized.push({
      role: entry.role === "assistant" ? "assistant" : "user",
      text,
    });
  }

  if (!sanitized.length) {
    return { history: [], truncated: false, totalChars: 0 };
  }

  const limited: HistoryEntry[] = []; // FIX: Use type
  let total = 0;
  for (let i = sanitized.length - 1; i >= 0; i--) {
    const current = sanitized[i];
    const length = current.text.length;

    if (total && total + length > MAX_PROMPT_CHARS) {
      truncated = true;
      continue;
    }

    if (!total && length > MAX_PROMPT_CHARS) {
      limited.push({ ...current, text: current.text.slice(-MAX_PROMPT_CHARS) });
      total = MAX_PROMPT_CHARS;
      truncated = true;
      break;
    }

    limited.push(current);
    total += length;
  }

  return { history: limited.reverse(), truncated, totalChars: total };
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

function isTimeoutError(error: unknown): boolean {
  // FIX: Use 'unknown' instead of 'any'
  if (!error) return false;
  // Type assertion to check for properties
  const err = error as {
    name?: string;
    type?: string;
    code?: number;
    message?: string;
  };
  const name = err.name || err.type;
  if (name === "AbortError" || name === "TimeoutError") return true;
  if (typeof err.code === "number") return err.code === 20 || err.code === 23;
  if (typeof err.message === "string")
    return /abort|time(?:d)?out/i.test(err.message);
  return false;
}

// FIX: Remove unused export
export { generateReply };
