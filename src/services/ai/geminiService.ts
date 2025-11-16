"use strict";

import env from "../../config/env";
import logger from "../../config/logger";
import { fetchFn, createTimeoutSignal } from "../../utils/http";
import type { PersonaProfile } from "../../types/persona";

const MAX_MESSAGE_LENGTH = 10000;
const MAX_PROMPT_CHARS = 250000;

// ##################################################################
// TYPE DEFINITIONS
// ##################################################################

interface GenerateReplyParams {
  apiKey: string;
  model: string;
  systemPrompt: string;
  loadPersonaProfile: () => Promise<PersonaProfile>;
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

interface GeminiContent {
  role: "user" | "model";
  parts: [{ text: string }];
}

interface GenerateContentPayload {
  contents: GeminiContent[];
  // cachedContent is removed
  // system_instruction is removed
}

// ##################################################################
// MAIN REPLY FUNCTION
// ##################################################################

async function generateReply(
  {
    apiKey,
    model,
    systemPrompt,
    loadPersonaProfile,
    contactId, // Used for logging
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

  // --- Caching logic removed ---
  // We now always build the full prompt every time.

  const personaProfile = await loadPersonaProfile();
  const personaText = buildPersonaPrompt(personaProfile);

  // Build the full prompt to be sent as the first user message
  const fullPrompt =
    (staticSystemPrompt ? `${staticSystemPrompt}\n\n` : "") + personaText;
    
  const payload = buildRequestPayload(fullPrompt, sanitizedHistory);

  if (!payload.contents.length) {
    return null;
  }

  if (historyTruncated) {
    logger.debug(
      {
        contactId, // Kept contactId for logging
        historyTruncated,
        totalChars,
        maxChars: MAX_PROMPT_CHARS,
        messageCount: sanitizedHistory.length,
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
      logger.warn({ err: error, contactId }, "Gemini request timed out");
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
          contactId,
        },
        "Gemini API overloaded - model unavailable"
      );
    }
    
    // --- Removed "CachedContent not found" error handler ---

    throw error;
  }

  const data: {
    candidates?: [{ content?: { parts?: [{ text?: string }] } }];
  } = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof text === "string" && text.trim().length ? text.trim() : null;
}

// ##################################################################
// CACHING FUNCTIONS - ALL REMOVED
// ##################################################################

// --- getOrCreateCache removed ---
// --- deleteRemoteCache removed ---
// --- cleanupExpiredCaches removed ---
// --- setInterval removed ---

// ##################################################################
// UTILITY FUNCTIONS
// ##################################################################

/**
 * Builds the request payload.
 * The full prompt is now ALWAYS sent as the first user message.
 */
function buildRequestPayload(
  fullPrompt: string | null,
  history: HistoryEntry[]
): GenerateContentPayload {
  const contents: GeminiContent[] = [];

  // If we have a prompt, add it as the first user message
  if (fullPrompt) {
    contents.push({
      role: "user",
      parts: [{ text: fullPrompt }],
    });
    
    // Add a model acknowledgment to establish the instruction
    contents.push({
      role: "model",
      parts: [{ text: "Understood. I will follow these instructions and reply in the specified style." }],
    });
  }

  // Add conversation history
  for (const entry of history) {
    contents.push({
      role: entry.role === "assistant" ? "model" : "user",
      parts: [{ text: entry.text }],
    });
  }

  // No cacheName or system_instruction is added
  return { contents };
}

/**
 * Builds the "persona" prompt text from examples.
 * CRITICAL: Emphasizes learning STYLE, not copying CONTENT
 */
function buildPersonaPrompt(profile?: PersonaProfile | null): string {
  if (!profile) {
    return `You are replying on behalf of the WhatsApp account owner. Keep responses concise, human, and professional.`;
  }

  const guidelines = (profile.guidelines || []).length
    ? profile.guidelines
        .map((line, index) => `${index + 1}. ${line}`)
        .join("\n")
    : "1. Mirror the owner's tone.\n2. Keep replies concise and accurate.";

  const examples = (profile.examples || []).length
    ? profile.examples
        .map((example, index) => {
          const userLine = example.user
            ? `User: ${example.user}`
            : "User context: (not captured)";
          return `Example ${index + 1}\n${userLine}\nOwner reply style: ${example.reply}`;
        })
        .join("\n\n")
    : "No reference replies captured yet.";

  const sourceLabel =
    profile.source === "contact"
      ? "contact-specific conversation"
      : profile.source === "universal"
      ? "overall account history"
      : "default fallback profile";

  return (
    `You are composing WhatsApp replies as the human account owner.\n` +
    `Persona source: ${sourceLabel}.\n\n` +
    `Style summary:\n${profile.summary}\n\n` +
    `Guidelines (follow all, do not repeat them verbatim):\n${guidelines}\n\n` +
    `Reference exchanges (never reuse the exact wording):\n${examples}\n\n` +
    `Instructions:\n` +
    `- Base your response on the latest chat history provided after this message.\n` +
    `- If information is missing, ask a short clarifying question instead of inventing details.\n` +
    `- Keep replies human, warm, and error-free.`
  ).trim();
}

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

// --- hashString function removed (was only for caching) ---

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