"use strict";

const env = require("../config/env");
const logger = require("../config/logger");
const { fetchFn, createTimeoutSignal } = require("../utils/http");

const MAX_MESSAGE_LENGTH = 2000;
const MAX_PROMPT_CHARS = 6000;

async function generateReply({ apiKey, model, systemPrompt }, history) {
  const key = String(apiKey || "").trim();
  const modelName = String(model || "").trim();
  if (!key || !modelName) return null;

  const messages = Array.isArray(history) ? history : [];
  if (!messages.length) return null;

  const { value: promptText, truncated: promptTruncated } = sanitizeSystemPrompt(systemPrompt);
  const {
    history: sanitizedHistory,
    truncated: historyTruncated,
    totalChars,
  } = sanitizeHistory(messages);

  const contents = buildContents(promptText, sanitizedHistory);

  if (!contents.length) {
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

  let response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents }),
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
    const error = new Error(`Gemini API responded with ${response.status}`);
    error.statusCode = response.status;
    error.payload = await response.clone().json().catch(() => null);
    throw error;
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof text === "string" && text.trim().length ? text.trim() : null;
}

function isTimeoutError(error) {
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

function sanitizeSystemPrompt(prompt) {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text) {
    return { value: null, truncated: false };
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    return { value: text.slice(0, MAX_MESSAGE_LENGTH), truncated: true };
  }
  return { value: text, truncated: false };
}

function sanitizeHistory(history) {
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

function buildContents(systemPrompt, history) {
  const contents = [];
  if (systemPrompt) {
    contents.push({ role: "system", parts: [{ text: systemPrompt }] });
  }

  for (const entry of history) {
    const role = entry.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text: entry.text }] });
  }

  return contents;
}

module.exports = {
  generateReply,
};
