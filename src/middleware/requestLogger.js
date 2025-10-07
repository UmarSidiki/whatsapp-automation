"use strict";

const logger = require("../config/logger");

module.exports = function requestLogger(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(
      {
        req: { method: req.method, url: req.originalUrl, ip: req.ip },
        res: { statusCode: res.statusCode },
        duration,
      },
      "request completed"
    );
  });
  next();
};
