"use strict";

const createApp = require("../app");
const env = require("../config/env");
const logger = require("../config/logger");
const { connectMongo } = require("../services/mongoService");
const { restoreSessions } = require("./sessionRestorer");

async function startServer() {
  await connectMongo();
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
