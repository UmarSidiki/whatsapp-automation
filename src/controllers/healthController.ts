import type { Request, Response } from "express";

export function getHealth(req: Request, res: Response) {
  const registry = req.app.get("sessionRegistry");
  const entries = registry ? [...registry.values()] : [];

  res.json({
    status: "ok",
    uptime: process.uptime(),
    sessions: entries.length,
    readySessions: entries.filter((s: any) => s.ready).length,
  });
}

export default { getHealth };
