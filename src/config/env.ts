import path from "path";
import dotenv from "dotenv";
import { z } from "zod";

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
    AI_TIMEOUT_MS: z.coerce.number().default(30000), // Increased to 30s for voice message processing
    PUPPETEER_HEADLESS: z.string().optional(),
    GEMINI_BASE_URL: z
      .string()
      .default("https://generativelanguage.googleapis.com"),
    STATIC_DIR: z.string().optional(),
    REMOTE_AUTH_BACKUP_MS: z.coerce.number().optional(),
    REMOTE_AUTH_DATA_PATH: z.string().optional(),
    ENABLE_COMPRESSION: z.string().optional(),
    ENABLE_REQUEST_LOGGER: z.string().optional(),
    AUTO_RESTORE_SESSIONS: z.string().optional(),
    SESSION_RESTORE_THROTTLE_MS: z.coerce.number().optional(),
    SESSION_READY_TIMEOUT_MS: z.coerce.number().default(30000),
    MONGO_URI: z.string().min(10, "MONGO_URI is required"),
    MONGO_DB_NAME: z.string().min(1, "MONGO_DB_NAME is required"),
  })
  .transform((data) => ({
    ...data,
    isProduction: data.NODE_ENV === "production",
    puppeteerHeadless: data.PUPPETEER_HEADLESS !== "false",
    staticDir: data.STATIC_DIR || path.join(__dirname, "../../frontend"),
    remoteAuthBackupMs: Math.max(
      data.REMOTE_AUTH_BACKUP_MS || 5 * 60 * 1000,
      60 * 1000
    ),
    remoteAuthDataPath:
      data.REMOTE_AUTH_DATA_PATH || path.join(process.cwd(), ".wwebjs_auth"),
    enableCompression:
      typeof data.ENABLE_COMPRESSION === "string"
        ? data.ENABLE_COMPRESSION !== "false"
        : data.NODE_ENV === "production",
    enableRequestLogger:
      typeof data.ENABLE_REQUEST_LOGGER === "string"
        ? data.ENABLE_REQUEST_LOGGER !== "false"
        : data.NODE_ENV !== "production",
    autoRestoreSessions: data.AUTO_RESTORE_SESSIONS !== "false",
    sessionRestoreThrottleMs: Math.max(
      data.SESSION_RESTORE_THROTTLE_MS || 1000,
      0
    ),
  }));

const env = EnvSchema.parse(process.env);

export default env;
