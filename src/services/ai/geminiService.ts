"use strict";

import env from "../../config/env";
import logger from "../../config/logger";
import { fetchFn, createTimeoutSignal } from "../../utils/http";

const MAX_MESSAGE_LENGTH = 2000;
const MAX_PROMPT_CHARS = 6000;

// Context caching configuration
const CACHE_TTL_SECONDS = 7200; // 2 hours
const MIN_TOKENS_FOR_CACHING = 2048; // Correct minimum for modern Flash models

// ##################################################################
// TYPE DEFINITIONS
// ##################################################################

interface GenerateReplyParams {
  apiKey: string;
  model: string;
  systemPrompt: string;
  loadPersonaExamples: () => Promise<string[]>; // Lazy loader function
  contactId: string;
}

export interface HistoryEntry {
  // Exported for messageHandler
  role: "user" | "assistant";
  text: string;
}

interface SanitizedHistoryResult {
  history: HistoryEntry[];
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

const cacheRegistry = new Map<string, CacheEntry>();

const contactIdMap = new Map<string, number>();
let nextContactId = 1;

function getNumericContactId(contactId: string): number {
  if (!contactIdMap.has(contactId)) {
    contactIdMap.set(contactId, nextContactId++);
  }
  return contactIdMap.get(contactId)!;
}

// ##################################################################
// MAIN REPLY FUNCTION
// ##################################################################

async function generateReply(
  {
    apiKey,
    model,
    systemPrompt,
    loadPersonaExamples,
    contactId,
  }: GenerateReplyParams,
  history: HistoryEntry[]
) {
  const key = String(apiKey || "").trim();
  const modelName = String(model || "").trim();
  if (!key || !modelName) return null;

  const messages = Array.isArray(history) ? history : [];
  if (!messages.length) return null;

  const {
    history: sanitizedHistory,
    truncated: historyTruncated,
    totalChars,
  } = sanitizeHistory(messages);

  const staticSystemPrompt =
    typeof systemPrompt === "string" ? systemPrompt.trim() : "";

  let payload: GenerateContentPayload;
  let isCached = false;
  let cacheKey: string | null = null;

  const numericId = getNumericContactId(contactId);
  let existingCache: CacheEntry | null = null;
  for (const [key, entry] of cacheRegistry.entries()) {
    if (key.startsWith(`${numericId}_`) && entry.expiresAt > Date.now()) {
      existingCache = entry;
      cacheKey = key;
      break;
    }
  }

  if (existingCache) {
    payload = buildRequestPayload(null, sanitizedHistory, existingCache.name);
    isCached = true;

    logger.debug(
      { contactId, cacheKey, expiresAt: existingCache.expiresAt },
      "Using existing cache, skipping persona load"
    );
  } else {
    const personaExamples = await loadPersonaExamples();
    const personaText = buildPersonaPrompt(personaExamples); // <-- This is the only change in this block

    const estimatedTokens = Math.floor(
      (personaText.length + staticSystemPrompt.length) / 4
    );

    if (
      personaExamples &&
      personaExamples.length > 0 &&
      contactId &&
      estimatedTokens >= MIN_TOKENS_FOR_CACHING
    ) {
      cacheKey = `${getNumericContactId(contactId)}_${hashString(personaText)}`;
      const cachedContent = await getOrCreateCache(
        key,
        modelName,
        staticSystemPrompt,
        personaText,
        cacheKey
      );

      if (cachedContent) {
        payload = buildRequestPayload(
          null,
          sanitizedHistory,
          cachedContent.name
        );
        isCached = true;
      } else {
        const fullPrompt =
          (staticSystemPrompt ? `${staticSystemPrompt}\n\n` : "") + personaText;
        payload = buildRequestPayload(fullPrompt, sanitizedHistory, null);
      }
    } else {
      // Non-caching path: Build the full prompt for system_instruction
      // We STILL use the new personaText format here
      const fullPrompt =
        (staticSystemPrompt ? `${staticSystemPrompt}\n\n` : "") + personaText;
      payload = buildRequestPayload(fullPrompt, sanitizedHistory, null);
    }
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

  let response: Response;
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

  if (!response.ok) {
    const errorPayload: { error?: { message?: string } } | null = await response
      .clone()
      .json()
      .catch(() => null);
    const error = new Error(`Gemini API responded with ${response.status}`);
    (error as any).statusCode = response.status;
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

    if (errorPayload?.error?.message?.includes("CachedContent not found")) {
      logger.warn(
        { cacheKey },
        "CachedContent not found on server, deleting from local registry."
      );
      if (cacheKey) cacheRegistry.delete(cacheKey);
    }

    throw error;
  }

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
  const existing = cacheRegistry.get(cacheKey);
  if (existing && existing.expiresAt > Date.now()) {
    return existing;
  }

  if (existing) {
    await deleteRemoteCache(existing.apiKey, existing.name);
  }

  try {
    // **** THIS PAYLOAD IS NOW CORRECT ****
    // systemInstruction = The Urdu Prompt
    // contents = The raw persona examples
    const cachePayload: CreateCachePayload = {
      model: `models/${model}`,
      systemInstruction: {
        parts: [{ text: systemPrompt || "" }],
      },
      contents: [
        {
          role: "user", // "user" role is fine, it's just a container for the text
          parts: [{ text: personaText }], // Pass the block of examples
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

    const data: { name: string } = await response.json();
    const cacheEntry: CacheEntry = {
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
  history: HistoryEntry[],
  cacheName: string | null
): GenerateContentPayload {
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

// **** ⬇️ CRITICAL FIX IS HERE ⬇️ ****
/**
 * Builds the "persona" prompt text from examples.
 * This new version removes all instructions and formats the examples
 * as a raw block of text for the model to learn from.
 */
function buildPersonaPrompt(examples: string[]): string {
  if (!examples || examples.length === 0) {
    return "";
  }

  // 1. Filter and join all messages with a neutral separator.
  // This stops the model from thinking it's a Q&A list.
  const exampleList = examples
    .filter((msg) => msg && msg.trim())
    .join("\n---\n"); // Using a separator helps distinguish messages

  if (!exampleList) {
    return "";
  }

  // 2. Simply frame the text as data.
  // Your MAIN system prompt (the Urdu one) already tells the model
  // "from example only learn typing and writing style".
  // This new format provides the data for that instruction.
  return `
[START OF UMAR'S STYLE EXAMPLES]
${exampleList}
[END OF UMAR'S STYLE EXAMPLES]
`;
}
// **** ⬆️ CRITICAL FIX IS HERE ⬆️ ****

function sanitizeHistory(history: HistoryEntry[]): SanitizedHistoryResult {
  const sanitized: HistoryEntry[] = [];
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

  const limited: HistoryEntry[] = [];
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
  if (!error) return false;
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

export { generateReply };
