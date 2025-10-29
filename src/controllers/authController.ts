import type { Request as ExRequest, Response as ExResponse } from "express";
import {
  isAuthorized,
  ensureSession,
  destroySession,
  getSession,
} from "../services/session";

export async function startSession(req: ExRequest, res: ExResponse) {
  const code = String(req.body?.code || "").trim();
  if (!code) {
    return res.status(400).json({ error: "Code is required" });
  }

  if (!(await isAuthorized(code))) {
    return res.status(401).json({ error: "Invalid code" });
  }

  await ensureSession(code);
  return res.json({ success: true });
}

export async function endSession(req: ExRequest, res: ExResponse) {
  const code = String(req.params?.code || "").trim();
  if (!code) {
    return res.status(400).json({ error: "Code is required" });
  }

  if (!(await isAuthorized(code))) {
    return res.status(401).json({ error: "Invalid code" });
  }

  const removed = await destroySession(code);
  if (!removed) {
    return res.status(404).json({ error: "No active session" });
  }

  return res.json({ success: true });
}

export async function sessionStatus(req: ExRequest, res: ExResponse) {
  const code = String(req.params?.code || "").trim();
  if (!code) {
    return res.status(400).json({ error: "Code is required" });
  }

  if (!(await isAuthorized(code))) {
    return res.status(401).json({ error: "Invalid code" });
  }

  const session = getSession(code);
  if (!session) {
    return res.status(404).json({ error: "No active session" });
  }

  return res.json({ active: true, ready: Boolean(session.ready) });
}

export default {
  startSession,
  endSession,
  sessionStatus,
};
