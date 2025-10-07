"use strict";

const pino = require("pino");
const env = require("./env");

let transport;
if (!env.isProduction) {
  try {
    require.resolve("pino-pretty");
    transport = { target: "pino-pretty", options: { colorize: true } };
  } catch {
    // optional pretty logging dependency not installed
  }
}

const logger = pino({
  level: env.LOG_LEVEL,
  transport,
});

module.exports = logger;
