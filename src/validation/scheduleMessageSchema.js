"use strict";

const { z } = require("zod");
const bulkMessageSchema = require("./bulkMessageSchema");

const scheduleMessageSchema = bulkMessageSchema.base
	.extend({
		sendAt: z
			.union([z.string(), z.number(), z.date()])
			.transform((value) => {
				if (value instanceof Date) return value;
				const date = new Date(value);
				if (Number.isNaN(date.getTime())) {
					throw new Error("Invalid schedule time");
				}
				return date;
			}),
	})
	.transform((data) => ({
		message: data.message.trim(),
		numbers: Array.from(
			new Set(
				data.numbers
					.map((value) => (typeof value === "string" ? value.trim() : ""))
					.filter(Boolean)
			)
		),
		sendAt: data.sendAt,
	}));

module.exports = scheduleMessageSchema;
