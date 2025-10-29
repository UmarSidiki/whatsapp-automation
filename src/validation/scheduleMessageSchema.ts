"use strict";

import { z } from "zod";
import { bulkMessageBase } from "./bulkMessageSchema";

export const scheduleMessageSchema = bulkMessageBase
  .extend({
    sendAt: z.union([z.string(), z.number(), z.date()]).transform((value: string | number | Date) => {
      if (value instanceof Date) return value;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        throw new Error("Invalid schedule time");
      }
      return date;
    }),
  })
  .transform((data: { message: string; numbers: string[]; sendAt: Date }) => ({
    message: data.message.trim(),
    numbers: Array.from(
      new Set(
        data.numbers
          .map((value: string) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean)
      )
    ),
    sendAt: data.sendAt,
  }));

// No CommonJS export, use named export
