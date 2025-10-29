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
  "--no-sandbox", // Mandatory for Heroku's execution environment
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage", // Critical for Heroku's shared memory limit
  "--disable-accelerated-video-decode",
  "--disable-accelerated-video-encode",
  "--no-first-run",
  "--no-zygote",
  "--single-process", // Use a single process instead of multiple
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
  "--mute-audio", // Saves a small amount of memory
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
  };
  // --- END CHANGE ---

  sessions.set(code, state);

  // Start the chat history pruning interval when the first session is created
  startHistoryPruneInterval();

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
        logger.info({ code }, "WhatsApp client ready (host device fetch failed)");
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
    sessions.delete(code);
    logger.error({ err: error }, "Failed to initialize WhatsApp client");
    throw new Error("Failed to start WhatsApp session");
  }

  return state;
}

function registerEventHandlers(code, state) {
  if (!state.client) return; // Should not happen, but a good guard

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
      logger.info({ code }, "WhatsApp client reconnected");
    } else if (newState === "UNPAIRED") {
      // Treat as logout, destroy without recreate
      logger.error(
        { code, msg: newState },
        "WhatsApp unpaired (logout) — destroying session"
      );
      state.ready = false;
      try {
        await destroySession(code); // destroySession deletes from map, no reconnect
      } catch (err) {
        logger.error(
          { err, code },
          `Failed during ${newState} handling`
        );
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
        logger.error(
          { err, code },
          `Failed during ${newState} handling`
        );
      }
    } else if (newState === "DISCONNECTED") {
      // This is the generic 'disconnected' event
      logger.warn({ code, reason: "DISCONNECTED" }, "WhatsApp client disconnected");
      state.ready = false;

      // Attempt to reconnect if not deliberately destroyed
      if (!state.destroyed) {
        const reconnectDelay = 2000;
        logger.info({ code, reconnectDelay }, "Scheduling reconnection attempt");

        setTimeout(async () => {
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
                  logger.info({ code }, "WhatsApp client reconnected (no info available)");
                }
              } catch (err) {
                logger.warn({ code, err }, "Failed to retrieve host device info on reconnect");
              }

              // Re-register handlers
              registerEventHandlers(code, state);
              await hydrateSessionState(code, state);
            } catch (err) {
              logger.error({ err, code }, "Failed to reconnect WhatsApp client");
            }
          }
        }, reconnectDelay);
      } else {
        logger.info({ code }, "Session is destroyed, not attempting reconnect.");
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
};