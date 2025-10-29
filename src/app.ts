import express, { Application, NextFunction } from "express";
import type { Request as ExRequest, Response as ExResponse } from "express";
import fs from "fs";
import path from "path";
import helmet from "helmet";
import compression from "compression";

import env from "./config/env";
import logger from "./config/logger";
import requestLogger from "./middleware/requestLogger";
import errorHandler from "./middleware/errorHandler";
import notFound from "./middleware/notFound";
import { globalLimiter } from "./middleware/rateLimiters";
import registerRoutes from "./routes";
import { listSessions } from "./services/session";

function createApp(): Application {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.set("sessionRegistry", listSessions());

  if (env.enableRequestLogger) {
    app.use(requestLogger);
  }
  app.use(helmet());
  if (env.enableCompression) {
    app.use(compression());
  }
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
  app.use(globalLimiter);

  const staticDir = env.staticDir;
  const staticDirAbsolute = path.resolve(staticDir);
  logger.info(
    {
      staticDir,
      staticDirAbsolute,
      exists: fs.existsSync(staticDir),
      cwd: process.cwd(),
    },
    "Static directory configuration"
  );

  if (fs.existsSync(staticDir)) {
    app.use(
      express.static(staticDir, {
        maxAge: env.isProduction ? "1h" : 0,
        fallthrough: true,
      })
    );
    logger.info({ staticDir }, "Static frontend directory mounted");
  } else {
    logger.warn(
      { staticDir, staticDirAbsolute, cwd: process.cwd() },
      "Static frontend directory not found"
    );
  }

  registerRoutes(app);

  app.get(/.*/, (req: ExRequest, res: ExResponse, next: NextFunction) => {
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

export default createApp;
