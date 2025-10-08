"use strict";

const fs = require('fs').promises;
const path = require('path');
const createApp = require("../app");
const env = require("../config/env");
const logger = require("../config/logger");
const { connectMongo } = require("../services/mongoService");
const { restoreSessions } = require("./sessionRestorer");

async function ensureAuthDirectory() {
  // Get the configured auth directory or use default
  const authDir = env.remoteAuthDataPath || path.join(process.cwd(), ".wwebjs_auth");
  
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
    logger.error({ err: error, dir: authDir }, "Failed to prepare WhatsApp auth directory");
    throw error;
  }
}

async function startServer() {
  await connectMongo();
  
  // Ensure auth directory exists and is writable before restoring sessions
  await ensureAuthDirectory();
  
  await restoreSessions();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "Server running");
  });

  return { app, server };
}

module.exports = {
  startServer,
};
