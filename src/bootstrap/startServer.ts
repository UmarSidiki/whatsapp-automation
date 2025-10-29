"use strict";

import fs from "fs/promises";
import path from "path";
import createApp from "../app";
import env from "../config/env";
import logger from "../config/logger";
import { connectMongo } from "../services/database/mongoService";
import { restoreSessions } from "./sessionRestorer";

async function ensureAuthDirectory() {
  // Get the configured auth directory or use default
  const authDir =
    env.remoteAuthDataPath || path.join(process.cwd(), ".wwebjs_auth");

  try {
    // Check if directory exists
    await fs.access(authDir).catch(async () => {
      // Create directory if it doesn't exist
      await fs.mkdir(authDir, { recursive: true });
      logger.info({ dir: authDir }, "Created WhatsApp auth directory");
    });

    // Ensure directory is writable
    await fs.access(authDir, fs.constants.W_OK).catch(() => {
      throw new Error(`WhatsApp auth directory is not writable: ${authDir}`);
    });

    logger.info({ dir: authDir }, "WhatsApp auth directory ready");
    return authDir;
  } catch (error) {
    logger.error(
      { err: error, dir: authDir },
      "Failed to prepare WhatsApp auth directory"
    );
    throw error;
  }
}

async function startServer() {
  await connectMongo();

  // Ensure auth directory exists and is writable before restoring sessions
  await ensureAuthDirectory();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "Server running");
  });

  // --- MEMORY LEAK FIX ---
  // Set connection timeout to prevent hanging connections
  server.timeout = 120000; // 2 minutes
  server.keepAliveTimeout = 65000; // 65 seconds (should be > load balancer timeout)
  server.headersTimeout = 66000; // Slightly more than keepAliveTimeout
  // --- END FIX ---

  // Restore sessions AFTER server is running so UI is accessible
  // This allows users to see QR codes while sessions are being restored
  restoreSessions().catch((err) => {
    logger.error({ err }, "Failed to restore sessions on startup");
  });

  return { app, server };
}

export { startServer };
