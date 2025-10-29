"use strict";

import { z } from "zod";

export const bulkMessageBase = z.object({
  message: z.string().min(1, "Message is required").max(4096, "Message too long"),
  numbers: z.array(z.string().regex(/^\+?\d+$/, "Invalid phone number")).min(1, "At least one number required").max(1000, "Too many numbers"),
});

export const bulkMessageSchema = bulkMessageBase.transform((data) => ({
  message: data.message.trim(),
  numbers: Array.from(
    new Set(
      data.numbers
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    )
  ),
}));
