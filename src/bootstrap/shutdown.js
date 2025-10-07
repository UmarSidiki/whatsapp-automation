"use strict";

const logger = require("../config/logger");
const { shutdownAll } = require("../services/sessionService");
const { shutdownPersistence } = require("../services/chatPersistenceService");
const { closeMongo } = require("../services/mongoService");

function createShutdownManager({ server, exitOnComplete = true } = {}) {
  let shuttingDown = false;

  async function gracefulShutdown(reason) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal: reason }, "Received shutdown signal");

    try {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
        logger.info("HTTP server closed");
      }
    } catch (error) {
      logger.error({ err: error }, "Error while closing HTTP server");
    }

    try {
      await shutdownAll();
      logger.info("All WhatsApp sessions shut down");
    } catch (error) {
      logger.error({ err: error }, "Failed to shut down all sessions");
    }

    try {
      await shutdownPersistence();
      logger.info("Chat persistence shut down");
    } catch (error) {
      logger.error({ err: error }, "Failed to shut down chat persistence");
    }

    try {
      await closeMongo();
      logger.info("MongoDB connection closed");
    } catch (error) {
      logger.error({ err: error }, "Failed to close MongoDB connection");
    }

    if (exitOnComplete) {
      process.exit(0);
    }
  }

  function handleSignal(signal) {
    gracefulShutdown(signal).catch((error) => {
      logger.fatal({ err: error }, "Unhandled error during graceful shutdown");
      if (exitOnComplete) {
        process.exit(1);
      }
    });
  }

  function register() {
    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
    process.on("unhandledRejection", (reason) => {
      logger.error({ err: reason }, "Unhandled promise rejection");
    });
    process.on("uncaughtException", (error) => {
      logger.fatal({ err: error }, "Uncaught exception");
      handleSignal("uncaughtException");
    });
  }

  return {
    register,
    gracefulShutdown,
  };
}

module.exports = {
  createShutdownManager,
};
