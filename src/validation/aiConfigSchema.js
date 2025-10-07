"use strict";

const { z } = require("zod");
const {
  DEFAULT_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  MAX_CONTEXT_WINDOW,
} = require("../constants");
const { customReplyEntrySchema } = require("./customRepliesSchema");

function coerceBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return fallback;
}

function clampContextWindow(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return DEFAULT_CONTEXT_WINDOW;
  }
  if (numeric < MIN_CONTEXT_WINDOW) return MIN_CONTEXT_WINDOW;
  if (numeric > MAX_CONTEXT_WINDOW) return MAX_CONTEXT_WINDOW;
  return Math.round(numeric);
}

const aiConfigSchema = z
  .object({
    apiKey: z.any().optional(),
    reuseStoredApiKey: z.any().optional(),
    model: z.string().min(1, "Model is required"),
    systemPrompt: z
      .union([z.string(), z.undefined()])
      .transform((value) => {
        if (typeof value !== "string") return undefined;
        const trimmed = value.trim();
        return trimmed.length ? trimmed : undefined;
      })
      .optional(),
    autoReplyEnabled: z.any().optional(),
    contextWindow: z.any().optional(),
    customReplies: z.array(customReplyEntrySchema).optional(),
  })
  .transform((data) => {
    const reuseStoredApiKey = coerceBoolean(data.reuseStoredApiKey, false);
    const apiKey = typeof data.apiKey === "string" ? data.apiKey.trim() : "";

    return {
      apiKey,
      reuseStoredApiKey,
      model: data.model.trim(),
      systemPrompt: data.systemPrompt,
      autoReplyEnabled: coerceBoolean(data.autoReplyEnabled, true),
      contextWindow: clampContextWindow(data.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
      customReplies: Array.isArray(data.customReplies) ? data.customReplies : [],
    };
  })
  .superRefine((data, ctx) => {
    if (!data.apiKey && !data.reuseStoredApiKey) {
      ctx.addIssue({
        path: ["apiKey"],
        code: z.ZodIssueCode.custom,
        message: "API key is required",
      });
    }

    if (data.apiKey && data.apiKey.length < 10) {
      ctx.addIssue({
        path: ["apiKey"],
        code: z.ZodIssueCode.custom,
        message: "API key must be at least 10 characters",
      });
    }
  });

module.exports = aiConfigSchema;
