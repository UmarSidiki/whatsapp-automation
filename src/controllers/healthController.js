"use strict";

function getHealth(req, res) {
  const registry = req.app.get("sessionRegistry");
  const entries = registry ? [...registry.values()] : [];
  const memUsage = process.memoryUsage();

  // Calculate memory stats
  const memory = {
    rss: Math.round(memUsage.rss / 1024 / 1024), // MB
    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
    external: Math.round(memUsage.external / 1024 / 1024),
    heapUsagePercent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100),
  };

  res.json({
    status: "ok",
    uptime: process.uptime(),
    sessions: entries.length,
    readySessions: entries.filter((s) => s.ready).length,
    memory,
  });
}

module.exports = {
  getHealth,
};
