"use strict";

const env = require("../config/env");
const { fetchFn, createTimeoutSignal } = require("../utils/http");

async function generateReply({ apiKey, model, systemPrompt }, history) {
  const key = String(apiKey || "").trim();
  const modelName = String(model || "").trim();
  if (!key || !modelName) return null;

  const messages = Array.isArray(history) ? history : [];
  if (!messages.length) return null;

  const contents = [];
  if (systemPrompt) {
    contents.push({ role: "system", parts: [{ text: systemPrompt }] });
  }

  for (const entry of messages) {
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (!text) continue;
    const role = entry.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text }] });
  }

  if (contents.length === 0) {
    return null;
  }

  const url = `${env.GEMINI_BASE_URL}/v1beta/models/${modelName}:generateContent?key=${key}`;

  const response = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents }),
    signal: createTimeoutSignal(env.AI_TIMEOUT_MS),
  });

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

module.exports = {
  generateReply,
};
