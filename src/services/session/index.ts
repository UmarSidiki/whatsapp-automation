import {
  ensureSession,
  getSession,
  listSessions,
  shutdownAll,
  destroySession,
} from "./sessionManager";
import { updateAiConfig, getAiConfig } from "./configManager";
import { sendBulkMessages } from "./messageHandler";
import {
  scheduleMessages,
  getScheduledMessages,
  cancelScheduledMessage,
  removeScheduledMessage,
} from "./scheduler";
import { isAuthorized, loadAuthCodes } from "./authManager";

export {
  isAuthorized,
  ensureSession,
  getSession,
  listSessions,
  updateAiConfig,
  getAiConfig,
  sendBulkMessages,
  scheduleMessages,
  getScheduledMessages,
  cancelScheduledMessage,
  removeScheduledMessage,
  shutdownAll,
  destroySession,
  loadAuthCodes,
};

export default {
  isAuthorized,
  ensureSession,
  getSession,
  listSessions,
  updateAiConfig,
  getAiConfig,
  sendBulkMessages,
  scheduleMessages,
  getScheduledMessages,
  cancelScheduledMessage,
  removeScheduledMessage,
  shutdownAll,
  destroySession,
  loadAuthCodes,
};
