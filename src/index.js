"use strict";

const logger = require("./config/logger");
const { startServer } = require("./bootstrap/startServer");
const { createShutdownManager } = require("./bootstrap/shutdown");

const isMainModule = require.main === module;

let appInstance = null;
let serverInstance = null;
let shutdownManager = null;

async function start(options = {}) {
  if (serverInstance) {
    return { app: appInstance, server: serverInstance, shutdown: shutdownManager };
  }

  const exitOnShutdown =
    typeof options.exitOnShutdown === "boolean" ? options.exitOnShutdown : isMainModule;

  try {
    const { app, server } = await startServer();
    appInstance = app;
    serverInstance = server;
    shutdownManager = createShutdownManager({ server, exitOnComplete: exitOnShutdown });
    shutdownManager.register();

    return { app, server, shutdown: shutdownManager };
  } catch (error) {
    logger.fatal({ err: error }, "Failed to start server");
    throw error;
  }
}

async function stop(reason = "manual") {
  if (!shutdownManager) {
    return;
  }

  await shutdownManager.gracefulShutdown(reason);
}

if (isMainModule) {
  start().catch((error) => {
    logger.fatal({ err: error }, "Unhandled error during startup");
    process.exit(1);
  });
}

module.exports = {
  start,
  stop,
  getApp: () => appInstance,
  getServer: () => serverInstance,
  getShutdownManager: () => shutdownManager,
};
