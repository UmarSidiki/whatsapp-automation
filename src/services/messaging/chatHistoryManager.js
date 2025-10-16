"use strict";

const logger = require("../config/logger");
const { CHAT_HISTORY_PRUNE_INTERVAL_MS } = require("../constants");
const { loadMessages } = require("./chatPersistenceService");

let chatHistoryPruneInterval = null;

/**
 * Append entry to chat history - no longer maintains in-memory storage
 * All history is loaded from database on-demand
 */
function appendHistoryEntry() {
  // No-op: we don't maintain in-memory history anymore
  // All persistence is handled by queueMessageForPersistence
}

/**
 * Get history for specific chat - loads from database
 */
async function getHistoryForChat(session, chatId, contextWindow) {
  try {
    const limit = clampContextWindow(
      contextWindow ?? session.aiConfig?.contextWindow ?? require("../constants").DEFAULT_CONTEXT_WINDOW
    );

    // Load from database
    const messages = await loadMessages(session.code, chatId, { limit });

    // Convert to the format expected by AI service
    return messages.map(msg => ({
      role: msg.role,
      text: msg.text,
      timestamp: msg.timestamp,
    }));
  } catch (error) {
    logger.error({ err: error, sessionCode: session.code, chatId }, "Failed to load chat history from database");
    return [];
  }
}

/**
 * Prune inactive chat histories - no longer needed since we don't maintain in-memory storage
 * This function now does nothing but is kept for API compatibility
 */
function pruneInactiveChatHistories() {
  // No-op: chat histories are no longer stored in memory
  logger.debug("Chat history pruning skipped - using database-only storage");
}

/**
 * Start the interval for pruning inactive chat histories.
 */
function startHistoryPruneInterval(sessions) {
  if (chatHistoryPruneInterval) {
    return; // Already running
  }

  chatHistoryPruneInterval = setInterval(() => {
    pruneInactiveChatHistories(sessions);
  }, CHAT_HISTORY_PRUNE_INTERVAL_MS);

  logger.info(
    { intervalMs: CHAT_HISTORY_PRUNE_INTERVAL_MS },
    "Started chat history pruning interval"
  );
}

/**
 * Stop the history prune interval
 */
function stopHistoryPruneInterval() {
  if (chatHistoryPruneInterval) {
    clearInterval(chatHistoryPruneInterval);
    chatHistoryPruneInterval = null;
  }
}

function clampContextWindow(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return require("../constants").getEffectiveContextWindow(require("../constants").DEFAULT_CONTEXT_WINDOW);
  }
  if (numeric < require("../constants").MIN_CONTEXT_WINDOW) {
    return require("../constants").MIN_CONTEXT_WINDOW;
  }
  if (numeric > require("../constants").MAX_CONTEXT_WINDOW) {
    return require("../constants").MAX_CONTEXT_WINDOW;
  }
  return Math.round(require("../constants").getEffectiveContextWindow(numeric));
}

module.exports = {
  appendHistoryEntry,
  getHistoryForChat,
  pruneInactiveChatHistories,
  startHistoryPruneInterval,
  stopHistoryPruneInterval,
  clampContextWindow,
};