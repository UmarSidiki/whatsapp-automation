"use strict";

const { getSession } = require("../services/sessionService");

function getQr(req, res) {
  const session = getSession(req.params.code);
  if (!session) {
    return res.status(404).json({ error: "No session" });
  }

  return res.json({ qr: session.qr, ready: session.ready });
}

module.exports = {
  getQr,
};
