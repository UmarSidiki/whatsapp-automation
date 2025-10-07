"use strict";

const path = require("path");
const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

const EnvSchema = z
  .object({
    NODE_ENV: z.string().default("development"),
    PORT: z.coerce.number().default(3000),
    LOG_LEVEL: z.string().default("info"),
    AUTH_CODES: z.string().optional(),
    CODE_FILE_PATH: z.string().optional(),
    JSON_BODY_LIMIT: z.string().default("1mb"),
    RATE_LIMIT_MAX: z.coerce.number().default(120),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().default(20),
    AI_TIMEOUT_MS: z.coerce.number().default(15000),
    PUPPETEER_HEADLESS: z.string().optional(),
    GEMINI_BASE_URL: z.string().default("https://generativelanguage.googleapis.com"),
    STATIC_DIR: z.string().optional(),
    MONGO_URI: z.string().min(10, "MONGO_URI is required"),
    MONGO_DB_NAME: z.string().min(1, "MONGO_DB_NAME is required"),
  })
  .transform((data) => ({
    ...data,
    isProduction: data.NODE_ENV === "production",
    puppeteerHeadless: data.PUPPETEER_HEADLESS !== "false",
    staticDir: data.STATIC_DIR || path.join(__dirname, "../../frontend"),
  }));

const env = EnvSchema.parse(process.env);

module.exports = env;
