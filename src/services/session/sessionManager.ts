import env from "../../config/env";
import logger from "../../config/logger";
import { hydrateSessionState } from "./configManager";
import { clearScheduledJobs } from "./scheduler";
import { startHistoryPruneInterval } from "./chatHistory";
import { registerMessageHandlers } from "./messageHandler";
// import remoteAuthStore from "../session/remoteAuthStore"; // WPPConnect does not use RemoteAuth
// --- CHANGED ---
// Import 'Whatsapp' client type
import { Whatsapp } from "@wppconnect-team/wppconnect";
// --- END CHANGE ---

const sessions = new Map();

// --- REMOVED ---
// qrcode library is no longer needed; wppconnect provides base64 directly
// let qrCodeLib = null;
// --- END REMOVAL ---
let whatsappDeps = null;

// --- MEMORY LEAK FIX ---
// Session health check to remove stale/failed sessions
const SESSION_HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

function startSessionHealthCheck(): void {
  if (healthCheckInterval) return;

  healthCheckInterval = setInterval(() => {
    try {
      const now = Date.now();
      const staleSessions: string[] = [];

      for (const [code, session] of sessions.entries()) {
        // Remove sessions that are destroyed but still in map
        if (session.destroyed) {
          staleSessions.push(code);
          continue;
        }

        // Remove sessions that have been idle for too long and never authenticated
        if (!session.hasBeenAuthenticated && !session.ready) {
          const idleTime = now - session.startedAt;
          if (idleTime > env.sessionMaxIdleMs) {
            staleSessions.push(code);
            logger.warn(
              { code, idleTimeHours: Math.round(idleTime / 3600000) },
              "Removing stale unauthenticated session"
            );
          }
        }
      }

      // Clean up stale sessions
      for (const code of staleSessions) {
        const session = sessions.get(code);
        if (session) {
          try {
            if (session.reconnectTimeout) {
              clearTimeout(session.reconnectTimeout);
            }
            if (session.client) {
              session.client.close().catch(() => {});
            }
          } catch (error) {
            logger.debug(
              { err: error, code },
              "Error cleaning up stale session"
            );
          }
        }
        sessions.delete(code);
      }

      if (staleSessions.length > 0) {
        logger.info(
          { removed: staleSessions.length, remaining: sessions.size },
          "Session health check completed"
        );
      }
    } catch (error) {
      logger.error({ err: error }, "Error in session health check");
    }
  }, SESSION_HEALTH_CHECK_INTERVAL_MS);

  // Allow Node to exit even if interval is running
  if (typeof healthCheckInterval.unref === "function") {
    healthCheckInterval.unref();
  }

  logger.info(
    { intervalMs: SESSION_HEALTH_CHECK_INTERVAL_MS },
    "Session health check started"
  );
}

function stopSessionHealthCheck(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    logger.info("Session health check stopped");
  }
}
// --- END FIX ---

// --- REMOVED ---
// async function getQrCodeLib() {
//   if (!qrCodeLib) {
//     qrCodeLib = await import("qrcode");
//   }
//   return qrCodeLib;
// }
// --- END REMOVAL ---

async function getWhatsAppDeps() {
  if (!whatsappDeps) {
    // --- CHANGED ---
    whatsappDeps = await import("@wppconnect-team/wppconnect");
    // --- END CHANGE ---
  }
  return whatsappDeps;
}

const PUPPETEER_ARGS = [
  // --- Your existing (and excellent) config ---
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-video-decode",
  "--disable-accelerated-video-encode",
  "--no-first-run",
  "--no-zygote",
  "--single-process",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-speech-api",
  "--disable-features=site-isolation-trials,IsolateOrigins,site-per-process",
  "--ignore-certificate-errors",
  "--ignore-ssl-errors",
  "--ignore-certificate-errors-skip-list",
  "--disable-notifications",
  "--disable-default-apps",
  "--disable-sync",
  "--mute-audio",
  "--disable-web-security",
  "--disable-translate",
  "--disable-features=Audio,WebRtc,ScriptStreaming",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

async function ensureSession(code) {
  if (sessions.has(code)) {
    return sessions.get(code);
  }

  // --- CHANGED ---
  // We use 'create' from wppconnect, not Client/RemoteAuth
  const { create } = await getWhatsAppDeps();
  // --- END CHANGE ---

  const QR_REFRESH_INTERVAL_MS = 30 * 1000; // 30 seconds

  // --- CHANGED ---
  // Client is created later, state object is prepared first
  const state = {
    client: null as Whatsapp | null, // Type is now Whatsapp
    qr: null,
    ready: false,
    startedAt: Date.now(),
    aiConfig: null,
    botNumber: null, // Store bot's phone number for owner detection
    globalStop: { active: false, since: 0 },
    stopList: new Map(),
    lastQrTimestamp: 0,
    chatHistory: new Map(),
    scheduledJobs: new Map(),
    destroyed: false, // Added 'destroyed' flag from original logic
    hasBeenAuthenticated: false, // Track if session was ever authenticated
    handlersRegistered: false, // Track if event handlers are registered (memory leak prevention)
    reconnectTimeout: null as ReturnType<typeof setTimeout> | null, // Track reconnect timeout for cleanup
  };
  // --- END CHANGE ---

  sessions.set(code, state);

  // Start the chat history pruning interval when the first session is created
  startHistoryPruneInterval();

  // --- MEMORY LEAK FIX ---
  // Start session health check when first session is created
  startSessionHealthCheck();
  // --- END FIX ---

  try {
    // --- CHANGED ---
    // wppconnect 'create' function replaces 'new Client' and 'client.initialize'
    // It returns a promise that resolves when the client is ready.
    const client = await create({
      session: code, // This is the session ID
      headless: env.puppeteerHeadless,
      puppeteerOptions: {
        args: PUPPETEER_ARGS,
      },
      browserArgs: PUPPETEER_ARGS, // Also pass here for redundancy
      autoClose: false,
      logQR: false, // We handle QR manually
      // This callback replaces the 'client.on("qr")' event
      catchQR: (base64Qr) => {
        const now = Date.now();
        if (now - state.lastQrTimestamp < QR_REFRESH_INTERVAL_MS) return;
        state.lastQrTimestamp = now;
        state.qr = base64Qr; // wppconnect provides data URL directly
        logger.info({ code }, "QR code updated");
      },
      // This callback provides status updates
      statusFind: (statusSession, session) => {
        logger.info(
          { code, status: statusSession, session },
          "WhatsApp session status"
        );
      },
      // WPPConnect does not support RemoteAuth. It uses a file store by default.
      // The 'remoteAuthStore' logic is no longer applicable.
    });
    // --- END CHANGE ---

    // --- LOGIC MOVED ---
    // This logic was in the 'ready' event, but 'create' resolving means 'ready'
    state.client = client;
    state.ready = true;
    state.startedAt = Date.now();
    state.hasBeenAuthenticated = true; // Mark as authenticated once ready

    // Store bot information for owner detection
    // Property name changed from 'info.wid' to 'getHostDevice()'
    if (state.client) {
      try {
        const hostDevice = await state.client.getHostDevice();
        if (hostDevice && hostDevice.wid) {
          state.botNumber = hostDevice.wid.user;
          logger.info(
            { code, botNumber: state.botNumber },
            "WhatsApp client ready"
          );
        } else {
          logger.info({ code }, "WhatsApp client ready (no info available)");
        }
      } catch (err) {
        logger.warn({ code, err }, "Failed to retrieve host device info");
        logger.info(
          { code },
          "WhatsApp client ready (host device fetch failed)"
        );
      }
    }
    // --- END LOGIC MOVED ---

    // Register handlers *after* client is created
    registerEventHandlers(code, state);
    await hydrateSessionState(code, state);

    // --- REMOVED ---
    // The complex Promise.race logic is no longer needed.
    // 'await create()' failing will throw an error, which is caught below.
    // 'await create()' succeeding means the client is 'ready'.
    // --- END REMOVAL ---

    try {
      // Log a concise AI config summary to help debug post-restore behavior
      const aiSummary = state.aiConfig
        ? {
            model: state.aiConfig.model || null,
            hasApiKey: Boolean(state.aiConfig.apiKey),
            autoReplyEnabled: state.aiConfig.autoReplyEnabled,
            customReplyCount: Array.isArray(state.aiConfig.customReplies)
              ? state.aiConfig.customReplies.length
              : 0,
          }
        : null;

      logger.info(
        { code, ready: state.ready, aiConfig: aiSummary },
        "WhatsApp session initialized"
      );
    } catch (err) {
      logger.debug({ err, code }, "Failed to log session AI summary");
    }
  } catch (error) {
    // --- MEMORY LEAK FIX ---
    // Ensure complete cleanup on initialization failure
    try {
      if (state.reconnectTimeout) {
        clearTimeout(state.reconnectTimeout);
        state.reconnectTimeout = null;
      }
      if (state.client) {
        await state.client.close().catch(() => {});
        state.client = null;
      }
      clearScheduledJobs(state);
    } catch (cleanupError) {
      logger.debug(
        { err: cleanupError, code },
        "Error during initialization cleanup"
      );
    }
    // --- END FIX ---

    sessions.delete(code);
    logger.error({ err: error }, "Failed to initialize WhatsApp client");
    throw new Error("Failed to start WhatsApp session");
  }

  return state;
}

function registerEventHandlers(code, state) {
  if (!state.client) return; // Should not happen, but a good guard

  // --- MEMORY LEAK FIX ---
  // Remove existing event handlers before registering new ones to prevent accumulation
  // WPPConnect doesn't expose removeListener, so we track if handlers are already registered
  if (state.handlersRegistered) {
    logger.debug(
      { code },
      "Event handlers already registered, skipping re-registration"
    );
    return;
  }
  state.handlersRegistered = true;
  // --- END FIX ---

  // --- REMOVED ---
  // 'client.on("qr")' is now handled by 'catchQR' in the 'create' config.
  // --- END REMOVAL ---

  // --- REMOVED ---
  // 'client.on("ready")' logic is now handled in 'ensureSession' after
  // the 'await create()' promise resolves.
  // --- END REMOVAL ---

  // --- CHANGED ---
  // 'disconnected', 'error', and 'auth_failure' are all consolidated
  // into the 'onStateChange' handler in wppconnect.
  state.client.onStateChange(async (newState) => {
    logger.info({ code, newState }, "WhatsApp session state changed");

    if (newState === "CONNECTED") {
      state.ready = true;
      state.hasBeenAuthenticated = true;
      logger.info({ code }, "WhatsApp client reconnected");
    } else if (newState === "UNPAIRED") {
      // Only destroy if session was previously authenticated
      // UNPAIRED during initial setup is normal and shouldn't destroy the session
      if (state.hasBeenAuthenticated) {
        logger.error(
          { code, msg: newState },
          "WhatsApp unpaired (logout) — destroying session"
        );
        state.ready = false;
        try {
          await destroySession(code); // destroySession deletes from map, no reconnect
        } catch (err) {
          logger.error({ err, code }, `Failed during ${newState} handling`);
        }
      } else {
        logger.info(
          { code },
          "Session UNPAIRED during initial setup - waiting for QR scan"
        );
        state.ready = false;
      }
    } else if (newState === "CONFLICT") {
      // Treat as auth failure, destroy and recreate for new QR
      logger.error(
        { code, msg: newState },
        "WhatsApp conflict — forcing session restart"
      );
      state.ready = false;
      try {
        await destroySession(code); // destroySession already deletes from map
        // Recreate session so a fresh QR is emitted for login
        await ensureSession(code);
        logger.info(
          { code },
          `Re-created session after ${newState}; awaiting QR if needed`
        );
      } catch (err) {
        logger.error({ err, code }, `Failed during ${newState} handling`);
      }
    } else if (newState === "DISCONNECTED") {
      // This is the generic 'disconnected' event
      logger.warn(
        { code, reason: "DISCONNECTED" },
        "WhatsApp client disconnected"
      );
      state.ready = false;

      // Attempt to reconnect if not deliberately destroyed
      if (!state.destroyed) {
        const reconnectDelay = 2000;
        logger.info(
          { code, reconnectDelay },
          "Scheduling reconnection attempt"
        );

        // --- MEMORY LEAK FIX ---
        // Clear any existing reconnect timeout before creating a new one
        if (state.reconnectTimeout) {
          clearTimeout(state.reconnectTimeout);
          state.reconnectTimeout = null;
        }
        // --- END FIX ---

        state.reconnectTimeout = setTimeout(async () => {
          state.reconnectTimeout = null; // Clear reference after execution
          if (sessions.has(code) && !state.destroyed && !state.ready) {
            logger.info({ code }, "Attempting to reconnect WhatsApp client");
            try {
              if (state.client) {
                await state.client.close();
                state.client = null;
              }
              const { create } = await getWhatsAppDeps();
              const client = await create({
                session: code,
                headless: env.puppeteerHeadless,
                puppeteerOptions: {
                  args: PUPPETEER_ARGS,
                },
                browserArgs: PUPPETEER_ARGS,
                autoClose: false,
                logQR: false,
                catchQR: (base64Qr) => {
                  const now = Date.now();
                  if (now - state.lastQrTimestamp < 60000) return;
                  state.lastQrTimestamp = now;
                  state.qr = base64Qr;
                  logger.info({ code }, "QR code updated");
                },
                statusFind: (statusSession, session) => {
                  logger.info(
                    { code, status: statusSession, session },
                    "WhatsApp session status"
                  );
                },
              });
              state.client = client;
              state.ready = true;
              state.startedAt = Date.now();
              state.hasBeenAuthenticated = true;
              state.handlersRegistered = false; // Reset flag for new client

              // Re-fetch botNumber
              try {
                const hostDevice = await state.client.getHostDevice();
                if (hostDevice && hostDevice.wid) {
                  state.botNumber = hostDevice.wid.user;
                  logger.info(
                    { code, botNumber: state.botNumber },
                    "WhatsApp client reconnected and ready"
                  );
                } else {
                  logger.info(
                    { code },
                    "WhatsApp client reconnected (no info available)"
                  );
                }
              } catch (err) {
                logger.warn(
                  { code, err },
                  "Failed to retrieve host device info on reconnect"
                );
              }

              // Re-register handlers
              registerEventHandlers(code, state);
              await hydrateSessionState(code, state);
            } catch (err) {
              logger.error(
                { err, code },
                "Failed to reconnect WhatsApp client"
              );
            }
          }
        }, reconnectDelay);
      } else {
        logger.info(
          { code },
          "Session is destroyed, not attempting reconnect."
        );
      }
    }
  });
  // --- END CHANGE ---

  // --- REMOVED ---
  // 'client.on("error")' logic is approximated in onStateChange for CONFLICT/TIMEOUT etc.
  // No direct equivalent, but protocol errors likely trigger state changes.
  // --- END REMOVAL ---

  registerMessageHandlers(code, state);
}

function getSession(code) {
  return sessions.get(code);
}

function listSessions() {
  return sessions;
}

async function shutdownAll() {
  // Clear prune interval if it exists - handled by chatHistory module

  // --- MEMORY LEAK FIX ---
  // Stop session health check
  stopSessionHealthCheck();
  // --- END FIX ---

  for (const [code, session] of sessions.entries()) {
    try {
      const { flushSessionMessages } = await import(
        "../persistence/chatPersistenceService"
      );
      await flushSessionMessages(code);
    } catch (error) {
      logger.error(
        { err: error, code },
        "Failed to flush messages during shutdown"
      );
    }

    try {
      // --- MEMORY LEAK FIX ---
      // Clear any pending reconnect timeouts
      if (session.reconnectTimeout) {
        clearTimeout(session.reconnectTimeout);
        session.reconnectTimeout = null;
      }
      // --- END FIX ---

      clearScheduledJobs(session);
      session.destroyed = true;
      // --- CHANGED ---
      if (session.client) {
        await session.client.close(); // Method is 'close', not 'destroy'
      }
      // --- END CHANGE ---
      logger.info({ code }, "Session destroyed");
    } catch (error) {
      logger.error({ err: error, code }, "Failed to destroy session");
    }
  }
  sessions.clear();
}

async function destroySession(code) {
  const session = sessions.get(code);
  if (!session) {
    return false;
  }

  try {
    const { flushSessionMessages } = await import(
      "../persistence/chatPersistenceService"
    );
    await flushSessionMessages(code);
  } catch (error) {
    logger.error(
      { err: error, code },
      "Failed to flush messages before logout"
    );
  }

  try {
    // --- MEMORY LEAK FIX ---
    // Clear any pending reconnect timeouts
    if (session.reconnectTimeout) {
      clearTimeout(session.reconnectTimeout);
      session.reconnectTimeout = null;
    }
    // --- END FIX ---

    clearScheduledJobs(session);
    session.destroyed = true;
    // --- CHANGED ---
    if (session.client) {
      await session.client.close(); // Method is 'close', not 'destroy'
    }
    // --- END CHANGE ---
    logger.info({ code }, "Session destroyed via logout");
  } catch (error) {
    logger.error({ err: error, code }, "Failed to destroy session on logout");
  } finally {
    sessions.delete(code);
  }

  return true;
}

export {
  ensureSession,
  getSession,
  listSessions,
  shutdownAll,
  destroySession,
  sessions,
  startSessionHealthCheck,
  stopSessionHealthCheck,
};
