"use strict";

module.exports = {
  // Default opt-out timeout for remote contacts (24 hours). Can be overridden via env in future.
  STOP_TIMEOUT_MS: 24 * 60 * 60 * 1000,
  QR_REFRESH_INTERVAL_MS: 30 * 1000,
  DEFAULT_CONTEXT_WINDOW: 50,
  MIN_CONTEXT_WINDOW: 10,
  MAX_CONTEXT_WINDOW: 100,
  MIN_SCHEDULE_DELAY_MS: 10 * 1000,
  MAX_SCHEDULE_DELAY_MS: 7 * 24 * 60 * 60 * 1000,
  // Memory limits for low-resource systems (1GB RAM + zram + 2GB swap)
  MAX_MEMORY_MB: 256, // Conservative limit for 1GB RAM systems
  MAX_TOTAL_MEMORY_MB: 512, // Allow up to 512MB total usage
};
