import type { Request as ExRequest, Response as ExResponse, NextFunction } from "express";

export default function notFound(req: ExRequest, res: ExResponse, next: NextFunction) {
  if (req.method === "GET" && req.accepts("html")) {
    return next();
  }
  res.status(404).json({ error: "Not found" });
}
