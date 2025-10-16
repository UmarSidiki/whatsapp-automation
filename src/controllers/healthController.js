"use strict";

const os = require("os");
const logger = require("../config/logger");

// Cache for CPU usage calculation
let previousCpuTimes = null;
let lastCpuCheck = 0;

function calculateCpuUsage() {
  const cpus = os.cpus();
  const now = Date.now();

  // Calculate current total and idle times
  const currentTimes = cpus.map(cpu => {
    let idle = 0;
    let total = 0;
    for (const type in cpu.times) {
      total += cpu.times[type];
      if (type === 'idle') idle = cpu.times[type];
    }
    return { idle, total };
  });

  // If we have previous measurements and enough time has passed, calculate delta
  if (previousCpuTimes && (now - lastCpuCheck) > 1000) { // At least 1 second
    let deltaIdle = 0;
    let deltaTotal = 0;

    for (let i = 0; i < cpus.length; i++) {
      deltaIdle += currentTimes[i].idle - previousCpuTimes[i].idle;
      deltaTotal += currentTimes[i].total - previousCpuTimes[i].total;
    }

    if (deltaTotal > 0) {
      const usagePercent = Math.round(100 - (deltaIdle / deltaTotal) * 100);
      // Cache current times for next calculation
      previousCpuTimes = currentTimes;
      lastCpuCheck = now;
      return Math.max(0, Math.min(100, usagePercent)); // Clamp between 0-100
    }
  }

  // Cache current times for next calculation
  previousCpuTimes = currentTimes;
  lastCpuCheck = now;

  // Fallback: return average load if available, otherwise estimate
  const loadAvg = os.loadavg();
  if (loadAvg && loadAvg[0] > 0) {
    return Math.round(Math.min(100, (loadAvg[0] / cpus.length) * 100));
  }

  // Last resort: return 0
  return 0;
}

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

  // System usage
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const systemMemory = {
    total: Math.round(totalMem / 1024 / 1024), // MB
    free: Math.round(freeMem / 1024 / 1024),
    used: Math.round((totalMem - freeMem) / 1024 / 1024),
    usagePercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
  };

  // CPU usage (real-time calculation using delta)
  const cpus = os.cpus();
  const cpuUsagePercent = calculateCpuUsage();

  // Disk usage for Ubuntu systems
  let diskUsage = null;
  try {
    const { execSync } = require("child_process");

    // Use df command for Ubuntu systems to get accurate disk usage
    if (process.platform === 'linux') {
      try {
        const dfOutput = execSync('df -BG / | tail -1', { encoding: 'utf8' });
        const parts = dfOutput.trim().split(/\s+/);
        if (parts.length >= 5) {
          const totalGB = parseInt(parts[1].replace('G', '')) || 0;
          const usedGB = parseInt(parts[2].replace('G', '')) || 0;
          const availableGB = parseInt(parts[3].replace('G', '')) || 0;
          const usagePercent = Math.round((usedGB / totalGB) * 100);

          diskUsage = {
            totalGB,
            usedGB,
            availableGB,
            usagePercent,
          };
        }
      } catch (dfError) {
        logger.debug({ err: dfError }, "Failed to get disk usage via df command");
      }
    }

    // Fallback if df command fails
    if (!diskUsage) {
      diskUsage = {
        totalGB: 100, // Default 100GB for Ubuntu systems
        usedGB: 0,
        availableGB: 0,
        usagePercent: 0,
      };
    }
  } catch (error) {
    logger.debug({ err: error }, "Failed to get disk usage");
    diskUsage = {
      totalGB: 0,
      usedGB: 0,
      availableGB: 0,
      usagePercent: 0,
    };
  }

  res.json({
    status: "ok",
    uptime: process.uptime(),
    sessions: entries.length,
    readySessions: entries.filter((s) => s.ready).length,
    memory,
    system: {
      memory: systemMemory,
      cpu: {
        usagePercent: cpuUsagePercent,
        cores: cpus.length,
      },
      disk: diskUsage,
    },
  });
}

module.exports = {
  getHealth,
};
