"use strict";

import env from "../../config/env";
import logger from "../../config/logger";
import { fetchFn, createTimeoutSignal } from "../../utils/http";

const MAX_MESSAGE_LENGTH = 2000;
const MAX_PROMPT_CHARS = 6000;

async function generateReply({ apiKey, model, systemPrompt, personaExamples }: any, history: any) {
  const key = String(apiKey || "").trim();
  const modelName = String(model || "").trim();
  if (!key || !modelName) return null;

  const messages = Array.isArray(history) ? history : [];
  if (!messages.length) return null;

  const { value: promptText, truncated: promptTruncated } = sanitizeSystemPrompt(
    systemPrompt,
    personaExamples
  );
  const {
    history: sanitizedHistory,
    truncated: historyTruncated,
    totalChars,
  } = sanitizeHistory(messages);

  const payload = buildRequestPayload(promptText, sanitizedHistory);

  if (!payload.contents.length) {
    return null;
  }

  if (promptTruncated || historyTruncated) {
    logger.debug(
      {
        promptTruncated,
        historyTruncated,
        totalChars,
        maxChars: MAX_PROMPT_CHARS,
        messageCount: sanitizedHistory.length,
      },
      "Gemini prompt truncated due to size"
    );
  }

  const url = `${env.GEMINI_BASE_URL}/v1beta/models/${modelName}:generateContent?key=${key}`;

  let response: any;
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
    const payload = await response.clone().json().catch(() => null);
    const error = new Error(`Gemini API responded with ${response.status}`);
    (error as any).statusCode = response.status;
    (error as any).payload = payload;
    
    // Log more details for 503 errors
    if (response.status === 503) {
      logger.warn(
        { 
          status: response.status, 
          message: payload?.error?.message,
          model: modelName 
        },
        "Gemini API overloaded - model unavailable"
      );
    }
    
    throw error;
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof text === "string" && text.trim().length ? text.trim() : null;
}

function isTimeoutError(error: any) {
  if (!error) {
    return false;
  }
  const name = error.name || error.type;
  if (name === "AbortError" || name === "TimeoutError") {
    return true;
  }
  if (typeof error.code === "number") {
    return error.code === 20 || error.code === 23; // ABORT_ERR / TIMEOUT_ERR
  }
  if (typeof error.message === "string") {
    return /abort|time(?:d)?out/i.test(error.message);
  }
  return false;
}

function sanitizeSystemPrompt(prompt: any, personaExamples: string[] = []) {
  let text = typeof prompt === "string" ? prompt.trim() : "";
  
  // Inject persona examples to teach AI your typing style
  if (personaExamples.length > 0) {
    const personaText = buildPersonaPrompt(personaExamples);
    text = text ? `${text}\n\n${personaText}` : personaText;
  }
  
  if (!text) {
    return { value: null, truncated: false };
  }
  // Allow more space for persona-enhanced prompts
  const maxLength = MAX_MESSAGE_LENGTH * 2;
  if (text.length > maxLength) {
    return { value: text.slice(0, maxLength), truncated: true };
  }
  return { value: text, truncated: false };
}

function buildPersonaPrompt(examples: string[]): string {
  // Filter and format examples (already sliced to context window in messageHandler)
  const exampleList = examples
    .filter((msg) => msg && msg.trim())
    .map((msg, index) => `Example ${index + 1}:\n${msg.trim()}`)
    .join("\n\n");

  if (!exampleList) {
    return ""; // Return empty if no valid examples
  }

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

function sanitizeHistory(history: any) {
  const sanitized = [];
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

  const limited = [];
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

function buildRequestPayload(systemPrompt: string | null, history: any[]) {
  const contents = [];

  for (const entry of history) {
    const role = entry.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text: entry.text }] });
  }

  const payload: any = { contents };

  if (systemPrompt) {
    payload.systemInstruction = {
      role: "user",
      parts: [{ text: systemPrompt }],
    };
  }

  return payload;
}

export { generateReply };
