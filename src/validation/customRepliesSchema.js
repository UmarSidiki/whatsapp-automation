"use strict";

const { z } = require("zod");

const customReplyEntrySchema = z
  .object({
    trigger: z.string().min(1, "Trigger is required"),
    response: z.string().min(1, "Response is required"),
    matchType: z.enum(["contains", "exact", "startsWith", "regex"]).default("contains"),
  })
  .transform((entry) => ({
    trigger: entry.trigger.trim(),
    response: entry.response.trim(),
    matchType: entry.matchType,
  }));

const customRepliesSchema = z
  .object({
    customReplies: z.array(customReplyEntrySchema).optional(),
  })
  .transform((data) => ({
    customReplies: Array.isArray(data.customReplies) ? data.customReplies : [],
  }));

module.exports = {
  customReplyEntrySchema,
  customRepliesSchema,
};
