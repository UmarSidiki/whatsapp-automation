"use strict";

const logger = require("../config/logger");
const { MAX_MEMORY_MB } = require("../constants");

let memoryMonitorInterval = null;

/**
 * Check if system is under memory pressure
 */
function checkMemoryPressure() {
  const memUsage = process.memoryUsage();
  const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
  return heapUsedMB > MAX_MEMORY_MB;
}

/**
 * Get system information - optimized for Ubuntu low-resource systems
 */
async function getSystemInfo() {
  try {
    const si = require("systeminformation");

    // For low-resource systems, get data sequentially to reduce memory pressure
    const cpu = await si.cpu();
    const mem = await si.mem();
    const disk = await si.fsSize();

    const cpuUsage = cpu ? Math.round(cpu.currentLoad || 0) : 0;
    const totalMem = mem ? Math.round(mem.total / 1024 / 1024 / 1024 * 10) / 10 : 0; // GB with 1 decimal
    const usedMem = mem ? Math.round(mem.used / 1024 / 1024 / 1024 * 10) / 10 : 0; // GB with 1 decimal
    const memUsagePercent = mem ? Math.round((mem.used / mem.total) * 100) : 0;

    // Get disk usage for primary drive (Ubuntu root filesystem)
    let diskUsagePercent = 0;
    let diskTotalGB = 0;
    let diskUsedGB = 0;
    if (disk && disk.length > 0) {
      const primaryDisk = disk.find(d => d.mount === '/') || disk[0];
      if (primaryDisk) {
        diskUsagePercent = Math.round((primaryDisk.used / primaryDisk.size) * 100);
        diskTotalGB = Math.round(primaryDisk.size / 1024 / 1024 / 1024 * 10) / 10;
        diskUsedGB = Math.round(primaryDisk.used / 1024 / 1024 / 1024 * 10) / 10;
      }
    }

    return {
      cpu: {
        usagePercent: cpuUsage,
        model: cpu?.model || 'Unknown',
        cores: cpu?.cores || 0,
      },
      memory: {
        totalGB: totalMem,
        usedGB: usedMem,
        usagePercent: memUsagePercent,
        // Add swap info for zram systems
        swapTotalGB: mem ? Math.round((mem.swaptotal || 0) / 1024 / 1024 / 1024 * 10) / 10 : 0,
        swapUsedGB: mem ? Math.round((mem.swapused || 0) / 1024 / 1024 / 1024 * 10) / 10 : 0,
      },
      disk: {
        usagePercent: diskUsagePercent,
        totalGB: diskTotalGB,
        usedGB: diskUsedGB,
      },
      system: {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        isLowResource: MAX_MEMORY_MB < 512,
      },
    };
  } catch (error) {
    logger.warn({ err: error }, "Failed to get system information");
    return {
      cpu: { usagePercent: 0, model: 'Unknown', cores: 0 },
      memory: { totalGB: 0, usedGB: 0, usagePercent: 0, swapTotalGB: 0, swapUsedGB: 0 },
      disk: { usagePercent: 0, totalGB: 0, usedGB: 0 },
      system: { platform: process.platform, arch: process.arch, nodeVersion: process.version, isLowResource: true },
    };
  }
}

/**
 * Start memory monitoring interval - optimized for low-resource systems
 */
function startMemoryMonitorInterval(sessions) {
  if (memoryMonitorInterval) {
    return; // Already running
  }

  // For low-resource systems (1GB RAM), check more frequently but with lighter monitoring
  const checkInterval = MAX_MEMORY_MB < 512 ? 30 * 1000 : 60 * 1000; // 30s for low RAM, 60s for higher

  memoryMonitorInterval = setInterval(async () => {
    const memUsage = process.memoryUsage();
    const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
    const rssMB = memUsage.rss / 1024 / 1024;

    // More aggressive thresholds for low-resource systems
    const warningThreshold = MAX_MEMORY_MB < 512 ? 0.7 : 0.8; // 70% for low RAM, 80% for higher
    const criticalThreshold = MAX_MEMORY_MB < 512 ? 0.85 : 0.9; // 85% for low RAM, 90% for higher

    if (heapUsedMB > MAX_MEMORY_MB * criticalThreshold) {
      logger.error(
        {
          heapUsedMB: Math.round(heapUsedMB),
          rssMB: Math.round(rssMB),
          maxMB: MAX_MEMORY_MB,
          sessions: sessions.size,
          systemSpec: "Low-resource (1GB RAM + zram)",
        },
        "CRITICAL memory usage - immediate action required"
      );
    } else if (heapUsedMB > MAX_MEMORY_MB * warningThreshold) {
      logger.warn(
        {
          heapUsedMB: Math.round(heapUsedMB),
          rssMB: Math.round(rssMB),
          maxMB: MAX_MEMORY_MB,
          sessions: sessions.size,
          systemSpec: "Low-resource (1GB RAM + zram)",
        },
        "High memory usage detected on low-resource system"
      );
    }
  }, checkInterval);

  logger.info({ checkIntervalMs: checkInterval, maxMemoryMB: MAX_MEMORY_MB }, "Started memory monitor interval for low-resource system");
}

/**
 * Stop memory monitoring interval
 */
function stopMemoryMonitorInterval() {
  if (memoryMonitorInterval) {
    clearInterval(memoryMonitorInterval);
    memoryMonitorInterval = null;
  }
}

/**
 * Get health status
 */
async function getHealthStatus(sessions) {
  const system = await getSystemInfo();
  const processMemory = process.memoryUsage();
  const heapUsedMB = Math.round(processMemory.heapUsed / 1024 / 1024);
  const uptime = process.uptime();

  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: Math.round(uptime),
    process: {
      memory: {
        heapUsedMB,
        heapTotalMB: Math.round(processMemory.heapTotal / 1024 / 1024),
        externalMB: Math.round(processMemory.external / 1024 / 1024),
        rssMB: Math.round(processMemory.rss / 1024 / 1024),
      },
      sessions: sessions.size,
    },
    system,
  };
}

module.exports = {
  checkMemoryPressure,
  getSystemInfo,
  startMemoryMonitorInterval,
  stopMemoryMonitorInterval,
  getHealthStatus,
};