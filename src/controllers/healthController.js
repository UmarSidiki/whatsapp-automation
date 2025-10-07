"use strict";

function getHealth(req, res) {
  const registry = req.app.get("sessionRegistry");
  const entries = registry ? [...registry.values()] : [];

  res.json({
    status: "ok",
    uptime: process.uptime(),
    sessions: entries.length,
    readySessions: entries.filter((s) => s.ready).length,
  });
}

module.exports = {
  getHealth,
};
