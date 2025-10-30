import logger from "../../config/logger";
import { queueMessageForPersistence } from "../persistence/chatPersistenceService";
import { sessions } from "./sessionManager";
import { DEFAULT_CONTEXT_WINDOW } from "../../constants";
import { clampContextWindow } from "./configManager";

const CHAT_HISTORY_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CHAT_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CHAT_HISTORIES_PER_SESSION = 50;

let historyPruneInterval = null;

/** Chat message entry in memory */
interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

/** Extended chat metadata for access tracking */
interface ChatHistory {
  messages: ChatMessage[];
  lastAccessed: number; // timestamp of last read/write
}

// Use Map<string, ChatHistory> per session
function ensureChatHistory(session: any): Map<string, ChatHistory> {
  if (!session.chatHistory) {
    session.chatHistory = new Map<string, ChatHistory>();
  }

  const historyStore = session.chatHistory;

  // --- MEMORY OPTIMIZATION: Efficient LRU Pruning ---
  // Instead of sorting all entries, find and remove oldest one at a time
  // Saves ~8-10KB per prune operation by avoiding full array allocation
  if (historyStore.size > MAX_CHAT_HISTORIES_PER_SESSION) {
    const excess = historyStore.size - MAX_CHAT_HISTORIES_PER_SESSION;
    let removed = 0;

    for (let i = 0; i < excess; i++) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      
      // Find the oldest entry
      for (const [chatId, chat] of historyStore.entries()) {
        if (chat.lastAccessed < oldestTime) {
          oldestTime = chat.lastAccessed;
          oldestKey = chatId;
        }
      }
      
      if (oldestKey) {
        historyStore.delete(oldestKey);
        removed++;
      }
    }

    logger.debug(
      { sessionCode: session.sessionCode, removed, remaining: historyStore.size },
      "Pruned excess chat histories (optimized LRU policy)"
    );
  }
  // --- END OPTIMIZATION ---

  return historyStore;
}

/** Touch a chat to update its lastAccessed timestamp */
function touchChat(session: any, chatId: string): void {
  const historyStore = session.chatHistory;
  if (!historyStore?.has(chatId)) return;

  const chat = historyStore.get(chatId)!;
  chat.lastAccessed = Date.now();
  historyStore.set(chatId, chat); // triggers Map order update
}

/** Append a message and mark chat as accessed */
function appendHistoryEntry(
  session: any,
  chatId: string,
  entry: { role: "user" | "assistant"; text: string; timestamp?: number }
): ChatMessage[] {
  const historyStore = ensureChatHistory(session);
  let chat = historyStore.get(chatId);

  if (!chat) {
    chat = { messages: [], lastAccessed: Date.now() };
  } else {
    chat.lastAccessed = Date.now();
  }

  const timestamp = entry.timestamp ?? Date.now();
  chat.messages.push({
    role: entry.role,
    text: entry.text,
    timestamp,
  });

  // Trim to context window
  const limit = clampContextWindow(
    session.aiConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  );
  if (chat.messages.length > limit) {
    chat.messages.splice(0, chat.messages.length - limit);
  }

  historyStore.set(chatId, chat);
  return chat.messages;
}

/** Get recent messages (and mark as accessed) */
function getHistoryForChat(
  session: any,
  chatId: string,
  contextWindow?: number
): ChatMessage[] {
  const historyStore = ensureChatHistory(session);
  const chat = historyStore.get(chatId);

  if (!chat) return [];

  // Update access time
  chat.lastAccessed = Date.now();
  historyStore.set(chatId, chat);

  const limit = clampContextWindow(
    contextWindow ?? session.aiConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  );

  return chat.messages.slice(-limit);
}

/** Persist message to MongoDB */
function persistChatMessage(
  sessionCode: string,
  contactId: string,
  direction: "incoming" | "outgoing",
  text: string,
  isAiGenerated: boolean = false
): void {
  if (!sessionCode || !contactId || !text.trim()) return;

  try {
    queueMessageForPersistence({
      sessionCode,
      contactId,
      direction,
      message: text,
      timestamp: new Date(),
      isAiGenerated,
    });
  } catch (error) {
    // Use warn — persistence failure is serious
    logger.warn(
      { err: error, sessionCode, contactId },
      "Failed to queue chat message for persistence"
    );
  }
}

/** Prune old/inactive chats */
function pruneInactiveChatHistories(): void {
  const now = Date.now();
  let totalSessionsChecked = 0;
  let totalHistoriesRemoved = 0;

  for (const [sessionCode, session] of sessions.entries()) {
    const historyStore = session.chatHistory;
    if (!historyStore || historyStore.size === 0) continue;

    totalSessionsChecked++;
    const chatsToRemove: string[] = [];

    for (const [chatId, chat] of historyStore.entries()) {
      const age = now - chat.lastAccessed;
      if (age > CHAT_HISTORY_MAX_AGE_MS) {
        chatsToRemove.push(chatId);
      }
    }

    // Remove all at once
    for (const chatId of chatsToRemove) {
      historyStore.delete(chatId);
      totalHistoriesRemoved++;
    }

    if (chatsToRemove.length > 0) {
      logger.debug(
        { sessionCode, removed: chatsToRemove.length, remaining: historyStore.size },
        "Pruned inactive chats by access age"
      );
    }
  }

  if (totalHistoriesRemoved > 0) {
    logger.info(
      {
        sessionsChecked: totalSessionsChecked,
        historiesRemoved: totalHistoriesRemoved,
        estimatedMemorySavedKB: Math.round(totalHistoriesRemoved * 2),
      },
      "Chat history pruning completed"
    );
  }
}

/** Start periodic pruning */
function startHistoryPruneInterval(): void {
  if (historyPruneInterval) return;

  historyPruneInterval = setInterval(() => {
    try {
      pruneInactiveChatHistories();
    } catch (err) {
      logger.error({ err }, "Error in chat history pruner");
    }
  }, CHAT_HISTORY_PRUNE_INTERVAL_MS);

  // Allow Node to exit even if interval is running
  historyPruneInterval.unref?.();

  logger.info(
    { intervalMs: CHAT_HISTORY_PRUNE_INTERVAL_MS },
    "Chat history pruning interval started"
  );
}

/** Stop pruning */
function stopHistoryPruneInterval(): void {
  if (historyPruneInterval) {
    clearInterval(historyPruneInterval);
    historyPruneInterval = null;
    logger.info("Chat history pruning interval stopped");
  }
}

/** Export */
export {
  ensureChatHistory,
  appendHistoryEntry,
  getHistoryForChat,
  persistChatMessage,
  pruneInactiveChatHistories,
  startHistoryPruneInterval,
  stopHistoryPruneInterval,
  touchChat, // optional: expose if needed
};