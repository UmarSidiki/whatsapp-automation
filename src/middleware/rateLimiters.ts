import rateLimit from "express-rate-limit";
import env from "../config/env";

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
});
