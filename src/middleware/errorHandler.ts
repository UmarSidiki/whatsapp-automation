import type { Request as ExRequest, Response as ExResponse, NextFunction } from "express";
import logger from "../config/logger";

export default function errorHandler(err: unknown, req: ExRequest, res: ExResponse, next: NextFunction) {
  logger.error({ err, url: req.originalUrl }, "Unhandled error");

  if (res.headersSent) {
    return next(err);
  }
  // coerce unknown error into a message for response
  const message = (err && typeof (err as any).message === 'string') ? (err as any).message : 'Internal server error';
  const status = (err && typeof (err as any).statusCode === 'number') ? (err as any).statusCode : 500;
  res.status(status).json({ error: message });
}
