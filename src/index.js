"use strict";

const createApp = require("./app");
const env = require("./config/env");
const logger = require("./config/logger");
const { shutdownAll } = require("./services/sessionService");
const { shutdownPersistence } = require("./services/chatPersistenceService");
const { connectMongo, closeMongo } = require("./services/mongoService");

let server;
let shuttingDown = false;

module.exports = null;

(async () => {
  try {
    await connectMongo();
    const app = createApp();
    module.exports = app; // ensure require() returns the express app once ready

    server = app.listen(env.PORT, () => {
      logger.info({ port: env.PORT }, "Server running");
    });
  } catch (error) {
    logger.fatal({ err: error }, "Failed to start server");
    process.exit(1);
  }
})();

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Received shutdown signal");

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await shutdownAll();
  await shutdownPersistence();
  await closeMongo();
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Uncaught exception");
  gracefulShutdown("uncaughtException");
});
