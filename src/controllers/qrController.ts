import type { Request, Response } from "express";
import { getSession } from "../services/session";

function isValidBase64Image(value: any) {
  return (
    typeof value === "string" &&
    /^data:image\/(png|jpeg);base64,[a-z0-9+/=]+$/i.test(value)
  );
}

export function getQr(req: Request, res: Response) {
  const session = getSession(req.params.code);
  if (!session) {
    return res.status(404).json({ error: "No session" });
  }

  const qr = isValidBase64Image(session.qr) ? session.qr : null;

  return res.json({ qr, ready: session.ready });
}

export default { getQr };
