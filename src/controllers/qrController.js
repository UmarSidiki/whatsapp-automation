"use strict";

const { getSession } = require("../services/sessionService");

function isValidBase64Image(value) {
  return (
    typeof value === "string" &&
    /^data:image\/(png|jpeg);base64,[a-z0-9+/=]+$/i.test(value)
  );
}

function getQr(req, res) {
  const session = getSession(req.params.code);
  if (!session) {
    return res.status(404).json({ error: "No session" });
  }

  const qr = isValidBase64Image(session.qr) ? session.qr : null;

  return res.json({ qr, ready: session.ready });
}

module.exports = {
  getQr,
};
