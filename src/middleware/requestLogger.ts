import type { Request as ExRequest, Response as ExResponse, NextFunction } from "express";
import logger from "../config/logger";

export default function requestLogger(req: ExRequest, res: ExResponse, next: NextFunction) {
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
}
