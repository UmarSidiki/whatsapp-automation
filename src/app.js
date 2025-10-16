"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const helmet = require("helmet");
const compression = require("compression");

const env = require("./config/env");
const logger = require("./config/logger");
const requestLogger = require("./middleware/requestLogger");
const errorHandler = require("./middleware/errorHandler");
const notFound = require("./middleware/notFound");
const { globalLimiter } = require("./middleware/rateLimiters");
const registerRoutes = require("./routes");
const { listSessions } = require("./services/sessionService");

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.set("sessionRegistry", listSessions());

  if (env.enableRequestLogger) {
    app.use(requestLogger);
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "script-src": ["'self'", "https://cdn.tailwindcss.com"],
          "style-src": ["'self'", "'unsafe-inline'"],
        },
      },
    })
  );

  if (env.enableCompression) {
    app.use(compression());
  }
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
  app.use(globalLimiter);

  const staticDir = env.staticDir;
  if (fs.existsSync(staticDir)) {
    app.use(
      express.static(staticDir, {
        maxAge: env.isProduction ? "1h" : 0,
        fallthrough: true,
      })
    );
  } else {
    logger.warn({ staticDir }, "Static frontend directory not found");
  }

  registerRoutes(app);

  app.get(/.*/, (req, res, next) => {
    if (req.method !== "GET" || !req.accepts("html")) return next();
    const indexPath = path.join(staticDir, "index.html");
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    return next();
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
