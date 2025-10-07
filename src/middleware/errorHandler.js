"use strict";

const logger = require("../config/logger");

function errorHandler(err, req, res, next) {
  logger.error({ err, url: req.originalUrl }, "Unhandled error");

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.statusCode || 500).json({
    error: err.message || "Internal server error",
  });
}

module.exports = errorHandler;
