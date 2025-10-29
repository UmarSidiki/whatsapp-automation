import { Application } from "express";
import { Server } from "http";

import logger from "./config/logger";
import { startServer } from "./bootstrap/startServer";
import { createShutdownManager } from "./bootstrap/shutdown";

// Use CommonJS-compatible main module detection so ts-node (CommonJS) works
const isMainModule = typeof require !== "undefined" && require.main === module;

let appInstance: Application | null = null;
let serverInstance: Server | null = null;
let shutdownManager: any = null;

interface StartOptions {
  exitOnShutdown?: boolean;
}

async function start(options: StartOptions = {}): Promise<{ app: Application, server: Server, shutdown: any }> {
  if (serverInstance) {
    return { app: appInstance!, server: serverInstance!, shutdown: shutdownManager };
  }

  const exitOnShutdown =
    typeof options.exitOnShutdown === "boolean" ? options.exitOnShutdown : isMainModule;

  try {
    const { app, server } = await startServer();
    appInstance = app;
    serverInstance = server;
    shutdownManager = createShutdownManager({ server, exitOnComplete: exitOnShutdown });
    shutdownManager.register();

    return { app, server, shutdown: shutdownManager };
  } catch (error) {
    logger.fatal({ err: error }, "Failed to start server");
    throw error;
  }
}

async function stop(reason: string = "manual"): Promise<void> {
  if (!shutdownManager) {
    return;
  }

  await shutdownManager.gracefulShutdown(reason);
}

if (isMainModule) {
  start().catch((error: any) => {
    logger.fatal({ err: error }, "Unhandled error during startup");
    process.exit(1);
  });
}

export {
  start,
  stop,
};

export function getApp(): Application | null {
  return appInstance;
}

export function getServer(): Server | null {
  return serverInstance;
}

export function getShutdownManager(): any {
  return shutdownManager;
}
