"use strict";

const { z } = require("zod");

const bulkMessageBase = z.object({
  message: z.string().min(1, "Message is required"),
  numbers: z.array(z.string().min(3, "Invalid number")).min(1, "At least one number is required"),
});

const bulkMessageSchema = bulkMessageBase
  .transform((data) => ({
    message: data.message.trim(),
    numbers: Array.from(
      new Set(
        data.numbers
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean)
      )
    ),
  }));

module.exports = bulkMessageSchema;
module.exports.base = bulkMessageBase;
