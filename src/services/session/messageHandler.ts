import type { Message, Whatsapp } from "@wppconnect-team/wppconnect";
import logger from "../../config/logger";
import { STOP_TIMEOUT_MS } from "../../constants";
import { generateReply } from "../ai/geminiService";
import type { HistoryEntry } from "../ai/geminiService";
import { transcribeAudio } from "../ai/speechToTextService";
import {
  buildPersonaProfile,
  buildStandaloneExamples,
  extractContactPersonaData,
} from "./personaProfiler";
import { appendHistoryEntry, persistChatMessage } from "./chatHistory";
import { markChatUnread, safeReply, sendFragmentedReply } from "./utils";
import { sessions } from "./sessionManager";

const MESSAGE_TIMESTAMP_TOLERANCE_MS = 30_000; // tolerate clock skew for 30 seconds
const PERSONA_IMPORT_TARGET = 1000;
const MAX_HISTORY_IMPORT = 1000;
const CONTACT_PERSONA_MIN_MESSAGES = 1000;

type CustomReplyMatch = "contains" | "exact" | "startsWith" | "regex";

interface CustomReplyRule {
  trigger: string;
  response: string;
  matchType?: CustomReplyMatch;
  regex?: RegExp;
}

interface BulkMessagePayload {
  numbers: string[];
  message: string;
}

interface BulkSendResult {
  number: string;
  success: boolean;
  error?: string;
}

interface VoiceConfig {
  voiceReplyEnabled?: boolean;
  speechToTextApiKey?: string;
  textToSpeechApiKey?: string;
  voiceLanguage?: string;
  voiceGender?: string;
}

interface AiConfig extends VoiceConfig {
  autoReplyEnabled: boolean;
  apiKey?: string;
  model?: string;
  customReplies?: CustomReplyRule[];
  contextWindow?: number;
}

interface SessionState {
  client: Whatsapp | null;
  ready: boolean;
  startedAt?: number;
  aiConfig: AiConfig | null;
  globalStop: { active: boolean; since: number };
  stopList: Map<string, number>;
  botNumber?: string | null;
}

type ExtendedMessage = Message & {
  session?: string;
  hasMedia?: boolean;
  isMedia?: boolean;
  isPtt?: boolean;
  mimetype?: string;
  _data?: { t?: number };
  id?: { id?: string; _serialized?: string };
  quotedMsg?: (Message & { body?: string }) | null;
};

type AiUtilityMode = "explain" | "qa";

interface AiUtilityCommand {
  mode: AiUtilityMode;
  rawPrompt: string;
  normalizedPrompt: string;
  referencedText?: string;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function importChatHistoryToPersona(
  client: Whatsapp | null,
  sessionCode: string,
  contactId: string,
  currentCount: number
): Promise<number> {
  if (!client || !contactId) {
    return 0;
  }

  const deficit = Math.max(0, PERSONA_IMPORT_TARGET - currentCount);
  const fetchLimit = Math.min(MAX_HISTORY_IMPORT, Math.max(deficit, 0));
  if (!fetchLimit) {
    return 0;
  }

  try {
    const clientAny = client as Whatsapp & { getChatById?: (id: string) => Promise<unknown> };
    const rawChat = (await clientAny.getChatById?.(contactId)) as {
      fetchMessages?: (opts: { limit: number }) => Promise<ExtendedMessage[]>;
    } | null;
    if (!rawChat || typeof rawChat.fetchMessages !== "function") {
      logger.warn({ sessionCode, contactId }, "Chat not found in WhatsApp for persona import");
      return 0;
    }

    const messages: ExtendedMessage[] = await rawChat.fetchMessages({ limit: fetchLimit });
    if (!messages?.length) {
      logger.info({ sessionCode, contactId }, "No messages returned from WhatsApp chat");
      return 0;
    }

    const { queueMessageForPersistence, flushQueuedMessages } = await import(
      "../persistence/chatPersistenceService"
    );

    let importedCount = 0;
    for (const message of messages.slice().reverse()) {
      const text = typeof message.body === "string" ? message.body.trim() : "";
      if (!text || message.hasMedia || message.isMedia) {
        continue;
      }

      const timestampSeconds = typeof message.timestamp === "number" ? message.timestamp : 0;
      const timestamp = timestampSeconds > 0 ? new Date(timestampSeconds * 1000) : new Date();

      try {
        queueMessageForPersistence({
          sessionCode,
          contactId,
          direction: message.fromMe ? "outgoing" : "incoming",
          message: text,
          timestamp,
          isAiGenerated: false,
        });
        importedCount += 1;
      } catch (error) {
        logger.debug(
          { err: error, sessionCode, contactId },
          "Failed to queue imported persona message"
        );
      }
    }

    if (importedCount) {
      await flushQueuedMessages();
    }

    return importedCount;
  } catch (error) {
    logger.error({ err: error, sessionCode, contactId }, "Persona history import failed");
    return 0;
  }
}

function isBotOwner(msg: ExtendedMessage, sessionCode: string): boolean {
  if (msg.fromMe) {
    return true;
  }

  const session = sessions.get(sessionCode) as SessionState | undefined;
  const botNumber = session?.botNumber;
  if (!botNumber || !msg.from) {
    return false;
  }

  const sanitizedFrom = msg.from.replace(/@.*$/, "");
  return botNumber === sanitizedFrom;
}

async function processCommands(
  code: string,
  state: SessionState,
  msg: ExtendedMessage
): Promise<boolean> {
  if (!msg || typeof msg.body !== "string" || !state?.client) {
    return false;
  }

  const text = msg.body.trim();
  if (!text) {
    return false;
  }

  const commandText = text.toLowerCase();
  const chatId = msg.fromMe ? msg.to : msg.from;
  const isOwner = isBotOwner(msg, code);

  if (isOwner) {
    if (commandText === "!stopall") {
      const alreadyStopped = state.globalStop.active;
      if (!alreadyStopped) {
        state.globalStop.active = true;
        state.globalStop.since = Date.now();
      }
      await safeReply(
        state.client,
        msg,
        alreadyStopped
          ? "🛑 Global auto replies are already disabled."
          : "🛑 Global auto replies disabled. I'll stay quiet until you send !startall.",
        false
      );
      return true;
    }

    if (commandText === "!startall") {
      const wasStopped = state.globalStop.active;
      state.globalStop.active = false;
      state.globalStop.since = 0;
      state.stopList.clear();
      await safeReply(
        state.client,
        msg,
        wasStopped
          ? "✅ Global auto replies re-enabled for all chats."
          : "✅ Global auto replies were already enabled.",
        false
      );
      return true;
    }
  }

  if (!chatId) {
    return false;
  }

  if (commandText === "!stop") {
    state.stopList.set(chatId, Date.now());
    await safeReply(state.client, msg, "🤖 Auto replies disabled for this chat for 24 hours.", false);
    return true;
  }

  if (commandText === "!start") {
    if (state.stopList.has(chatId)) {
      state.stopList.delete(chatId);
      await safeReply(state.client, msg, "🤖 Auto replies re-enabled for this chat.", false);
    } else {
      await safeReply(state.client, msg, "🤖 Auto replies were already enabled here.", false);
    }
    return true;
  }

  return false;
}

async function downloadMediaWithRetry(
  client: Whatsapp | null,
  msg: ExtendedMessage,
  maxRetries = 3,
  baseDelayMs = 1000,
  forceForVoice = false
): Promise<string | null> {
  if (!client) {
    return null;
  }

  const sessionCode = msg.session || "unknown";
  const chatId = msg.from || "unknown";
  const isVoice = msg.type === "ptt" || (msg.type === "audio" && msg.isPtt);

  if (!forceForVoice && !msg.isMedia && !msg.hasMedia && !isVoice) {
    logger.debug({ sessionCode, chatId }, "Skipping download: no media present");
    return null;
  }

  const clientAny = client as Whatsapp & { downloadMedia?: (message: ExtendedMessage) => Promise<string> };

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const mediaBase64 = await clientAny.downloadMedia?.(msg);
      if (mediaBase64 && typeof mediaBase64 === "string" && mediaBase64.length > 0) {
        logger.debug({ sessionCode, chatId, attempt }, "Media downloaded successfully");
        return mediaBase64;
      }
    } catch (error) {
      logger.error({ err: error, sessionCode, chatId, attempt }, "Voice media download failed");
    }

    if (attempt < maxRetries) {
      await delay(baseDelayMs * attempt);
    }
  }

  logger.warn({ sessionCode, chatId, maxRetries }, "Exhausted media download retries");
  return null;
}

function registerMessageHandlers(code: string, state: SessionState) {
  state.client?.onAnyMessage?.(async (msg: ExtendedMessage) => {
    const current = sessions.get(code);
    if (!current || !current.ready) return;

    if (!msg.session) {
      msg.session = code;
    }

    const chatId = msg.fromMe ? msg.to : msg.from;
    if (typeof chatId === "string") {
      if (chatId.includes("@g.us")) {
        logger.debug({ code, chatId }, "Skipping group message");
        return;
      }
      if (chatId.includes("@broadcast") || chatId.includes("status@broadcast")) {
        logger.debug({ code, chatId, msgType: msg.type }, "Skipping broadcast/status message");
        return;
      }
      if (chatId.includes("@newsletter")) {
        logger.debug({ code, chatId, msgType: msg.type }, "Skipping newsletter message");
        return;
      }
    }

    const config = current.aiConfig;
    const isVoiceMessage = msg.type === "ptt" || (msg.type === "audio" && msg.isPtt);

    const messageTimestampMs =
      typeof msg.timestamp === "number" && msg.timestamp > 0
        ? msg.timestamp * 1000
        : typeof msg._data?.t === "number" && msg._data.t > 0
        ? msg._data.t * 1000
        : Date.now();

    if (
      current.startedAt &&
      messageTimestampMs + MESSAGE_TIMESTAMP_TOLERANCE_MS < current.startedAt
    ) {
      return;
    }

    if (await processCommands(code, current, msg)) {
      return;
    }

    if (msg.fromMe) {
      const text = typeof msg.body === "string" ? msg.body.trim() : "";
      const hasMedia = msg.hasMedia || msg.isMedia || isVoiceMessage;
      if (text && !hasMedia) {
        appendHistoryEntry(current, chatId, { role: "assistant", text });
        persistChatMessage(code, chatId, "outgoing", text, false);
      }
      return;
    }

    if (current.globalStop.active && !isBotOwner(msg, code)) {
      return;
    }

    const stopTime = current.stopList.get(chatId);
    if (stopTime && Date.now() - stopTime < STOP_TIMEOUT_MS) {
      return;
    } else if (stopTime) {
      current.stopList.delete(chatId);
    }

    let text = "";
    let aiUtilityCommand: AiUtilityCommand | null = null;

    if (isVoiceMessage && config?.voiceReplyEnabled && config?.speechToTextApiKey) {
      const messageAgeMs = Date.now() - messageTimestampMs;
      if (messageAgeMs > 24 * 60 * 60 * 1000) {
        await safeReply(
          state.client,
          msg,
          "⏰ Sorry, I can't process voice messages older than 24 hours. Please send a new one!",
          false
        );
        await markChatUnread(msg);
        return;
      }

      try {
        const mediaBase64 = await downloadMediaWithRetry(state.client, msg, 3, 1000, true);
        if (!mediaBase64) {
          logger.warn(
            { code, chatId: msg.from, messageAgeMs, isMedia: msg.isMedia, msgType: msg.type },
            "Failed to download voice message media after retries"
          );
          await safeReply(
            state.client,
            msg,
            "❌ Sorry, I couldn't download your voice message after a few tries. Please try again in a moment or send as text.",
            false
          );
          await markChatUnread(msg);
          return;
        }

        let cleanBase64 = mediaBase64;
        if (mediaBase64.startsWith("data:")) {
          const commaIndex = mediaBase64.indexOf(",");
          if (commaIndex > 0) {
            cleanBase64 = mediaBase64.substring(commaIndex + 1);
            logger.debug(
              {
                code,
                chatId: msg.from,
                originalLength: mediaBase64.length,
                cleanLength: cleanBase64.length,
              },
              "Stripped data URI prefix from media"
            );
          } else {
            logger.error(
              { code, chatId: msg.from, mediaPreview: mediaBase64.substring(0, 100) },
              "Invalid data URI format in media"
            );
            await safeReply(state.client, msg, "❌ Invalid voice message format. Please try again.", false);
            await markChatUnread(msg);
            return;
          }
        }

        const audioBuffer = Buffer.from(cleanBase64, "base64");
        const MIN_AUDIO_SIZE = 100;
        if (audioBuffer.length < MIN_AUDIO_SIZE) {
          logger.error(
            {
              code,
              chatId: msg.from,
              audioSize: audioBuffer.length,
              base64Preview: cleanBase64.substring(0, 100),
            },
            "Invalid tiny audio buffer from download"
          );
          await safeReply(
            state.client,
            msg,
            `❌ Voice message too short or corrupted (only ${audioBuffer.length} bytes received). Please record a longer one or send text.`,
            false
          );
          await markChatUnread(msg);
          return;
        }

        const mimeType = msg.mimetype || "audio/ogg; codecs=opus";
        logger.debug(
          {
            code,
            chatId: msg.from,
            audioSize: audioBuffer.length,
            mimeType,
            base64Preview: cleanBase64.substring(0, 50),
          },
          "Processing voice message"
        );

        text = await transcribeAudio(
          audioBuffer,
          config.speechToTextApiKey,
          config.voiceLanguage || "en-US"
        );

        if (!text || !text.trim()) {
          logger.warn(
            { code, chatId: msg.from, audioSize: audioBuffer.length, language: config.voiceLanguage },
            "Voice message transcription returned empty text"
          );
          await safeReply(
            state.client,
            msg,
            "🎤 Sorry, I couldn't understand your voice message. Please try speaking more clearly or send text.",
            false
          );
          await markChatUnread(msg);
          return;
        }

        logger.info(
          { code, chatId: msg.from, transcriptionLength: text.length, preview: text.substring(0, 50) },
          "Voice message transcribed successfully"
        );
      } catch (error) {
        const err = error as Error & { code?: string };
        const message = typeof err?.message === "string" ? err.message : "";

        logger.error(
          { err, code, chatId: msg.from, errorMessage: message, errorCode: err?.code },
          "Failed to process voice message"
        );

        let errorMsg = "❌ Sorry, there was an error processing your voice message.";
        if (message.includes("API key")) {
          errorMsg += " The Speech-to-Text API key may be invalid.";
        } else if (message.includes("quota") || message.includes("limit")) {
          errorMsg += " API quota exceeded. Please try again later.";
        } else if (message.includes("permission")) {
          errorMsg += " API permissions issue. Please contact support.";
        } else {
          errorMsg += " Please try sending it as text.";
        }

        await safeReply(state.client, msg, errorMsg, false);
        await markChatUnread(msg);
        return;
      }
    } else {
      if (!msg || typeof msg.body !== "string") return;
      text = msg.body.trim();
      if (!text) return;
    }

    aiUtilityCommand = detectAiUtilityCommand(text, msg);
    if (aiUtilityCommand) {
      logger.debug(
        {
          code,
          chatId,
          mode: aiUtilityCommand.mode,
          referenced: Boolean(aiUtilityCommand.referencedText),
          promptPreview: aiUtilityCommand.rawPrompt.slice(0, 80),
        },
        "Detected !me AI utility command"
      );
    }

    const hasMedia = msg.hasMedia || msg.isMedia;
    const shouldPersist = !hasMedia || isVoiceMessage;
    appendHistoryEntry(current, chatId, { role: "user", text });
    if (shouldPersist) {
      persistChatMessage(code, chatId, "incoming", text, false);
    }

    if (!config) return;

    if (!aiUtilityCommand) {
      const customReply = findCustomReply(config.customReplies, text);
      if (customReply) {
        try {
          const shouldSendAsVoice =
            isVoiceMessage && config.voiceReplyEnabled && config.textToSpeechApiKey;
          await safeReply(state.client, msg, customReply, shouldSendAsVoice, config);
          appendHistoryEntry(current, chatId, { role: "assistant", text: customReply });
          persistChatMessage(code, chatId, "outgoing", customReply, false);
          await markChatUnread(msg);
        } catch (error) {
          logger.error({ err: error, chatId }, "Custom reply send error");
        }
        return;
      }
    }

    if (!config.apiKey || !config.model) {
      if (aiUtilityCommand) {
        await safeReply(
          state.client,
          msg,
          "⚙️ AI configuration is missing (API key or model). Please update the settings before using !me commands.",
          false
        );
        await markChatUnread(msg);
      }
      return;
    }

    if (!config.autoReplyEnabled && !aiUtilityCommand) {
      return;
    }

    try {
      const { clampContextWindow } = await import("./configManager");
      const contextWindow = clampContextWindow(config.contextWindow);

      const { getHistoryForChat } = await import("./chatHistory");
      const rawHistory = getHistoryForChat(current, chatId, contextWindow);
      let history: HistoryEntry[] = rawHistory.map((entry) => ({
        role: entry.role === "assistant" ? "assistant" : "user",
        text: entry.text,
      }));

      if (aiUtilityCommand) {
        history = enhanceHistoryForUtilityCommand(history, aiUtilityCommand);
      }

      const loadPersonaProfile = async () => {
        const { getChatMessages, getUniversalPersona } = await import(
          "../persistence/chatPersistenceService"
        );
        let chatMessages = await getChatMessages(code, chatId);

        if (chatMessages.length < CONTACT_PERSONA_MIN_MESSAGES && current.client) {
          try {
            logger.info(
              { code, chatId, currentCount: chatMessages.length },
              "Attempting to build persona from WhatsApp chat history"
            );

            const importedCount = await importChatHistoryToPersona(
              current.client,
              code,
              chatId,
              chatMessages.length
            );

            if (importedCount > 0) {
              chatMessages = await getChatMessages(code, chatId);
              logger.info(
                { code, chatId, imported: importedCount, total: chatMessages.length },
                "Successfully imported chat history to persona"
              );
            }
          } catch (error) {
            logger.warn(
              { err: error, code, chatId },
              "Failed to import chat history, continuing with existing data"
            );
          }
        }

        const exampleLimit = Math.min(
          8,
          Math.max(3, Math.floor(contextWindow / 5) || 0)
        );

        const contactData = extractContactPersonaData(chatMessages, exampleLimit);

        if (chatMessages.length >= CONTACT_PERSONA_MIN_MESSAGES && contactData.examples.length >= 3) {
          const profile = buildPersonaProfile({
            source: "contact",
            replies: contactData.replies,
            examples: contactData.examples,
            exampleLimit,
          });

          logger.debug(
            {
              code,
              chatId,
              personaSource: profile.source,
              exampleCount: profile.examples.length,
              guidelineCount: profile.guidelines.length,
              contextWindow,
            },
            "Using contact-specific persona profile"
          );

          return profile;
        }

        const universalMessages = await getUniversalPersona(code);
        const cleanedReplies = universalMessages
          .map((msg) => (typeof msg === "string" ? msg.trim() : ""))
          .filter(Boolean);

        if (cleanedReplies.length) {
          const profile = buildPersonaProfile({
            source: "universal",
            replies: cleanedReplies,
            examples: buildStandaloneExamples(cleanedReplies, exampleLimit),
            exampleLimit,
          });

          logger.debug(
            {
              code,
              chatId,
              personaSource: profile.source,
              exampleCount: profile.examples.length,
              guidelineCount: profile.guidelines.length,
            },
            "Using universal persona profile"
          );

          return profile;
        }

        const fallbackProfile = buildPersonaProfile({
          source: "bootstrap",
          replies: [],
          examples: [],
          exampleLimit,
        });

        logger.debug(
          { code, chatId, personaSource: fallbackProfile.source },
          "Using fallback persona profile"
        );

        return fallbackProfile;
      };

      let reply: string | null = null;
      let retryCount = 0;
      const maxRetries = 2;

      while (retryCount <= maxRetries && !reply) {
        try {
          reply = await generateReply(
            {
              ...config,
              loadPersonaProfile,
              contactId: chatId,
            },
            history
          );
        } catch (error) {
          const err = error as { statusCode?: number } & Error;
          if (err.statusCode === 503 && retryCount < maxRetries) {
            retryCount += 1;
            const delayMs = 2000 * retryCount;
            logger.info({ code, chatId, retryCount, delayMs }, "Retrying after API overload");
            await delay(delayMs);
            continue;
          }
          throw err;
        }
      }

      if (reply) {
        const shouldSendAsVoice =
          isVoiceMessage &&
          config.voiceReplyEnabled &&
          config.textToSpeechApiKey;

        await sendFragmentedReply(state.client, msg, reply, shouldSendAsVoice, config);
        appendHistoryEntry(current, chatId, { role: "assistant", text: reply });
        persistChatMessage(code, chatId, "outgoing", reply, true);
        await markChatUnread(msg);
      } else {
        const fallbackMessage = isVoiceMessage
          ? "⏱️ Sorry, the AI took too long to respond to your voice message. Please try again."
          : "⏱️ Sorry, the AI took too long to respond. Please try again.";
        await safeReply(state.client, msg, fallbackMessage, false);
        await markChatUnread(msg);
      }
    } catch (error) {
      const err = error as { statusCode?: number } & Error;
      logger.error({ err, chatId }, "AI reply error");

      let errorMessage =
        "❌ Sorry, an error occurred while generating a reply. Please try again.";

      if (err.statusCode === 503) {
        errorMessage = "⏳ The AI service is currently overloaded. Please try again shortly.";
      } else if (err.statusCode === 429) {
        errorMessage = "⏱️ Rate limit reached. Please wait a moment before trying again.";
      } else if (err.statusCode === 400) {
        errorMessage = "❌ Invalid request. Please check your message and try again.";
      } else if (isVoiceMessage) {
        errorMessage =
          "❌ Sorry, I couldn't process your voice message. Please try sending it as text.";
      }

      try {
        await safeReply(state.client, msg, errorMessage, false);
        await markChatUnread(msg);
      } catch (replyError) {
        logger.error({ err: replyError, chatId }, "Failed to send error notification");
      }
    }
  });
}

function findCustomReply(customReplies: CustomReplyRule[] | undefined, text: string): string | null {
  if (!Array.isArray(customReplies) || !customReplies.length) {
    return null;
  }

  const lowerText = text.toLowerCase();

  for (const rule of customReplies) {
    if (!rule?.trigger || !rule?.response) continue;

    switch (rule.matchType) {
      case "exact":
        if (lowerText === rule.trigger.toLowerCase()) {
          return rule.response;
        }
        break;
      case "startsWith":
        if (lowerText.startsWith(rule.trigger.toLowerCase())) {
          return rule.response;
        }
        break;
      case "regex":
        if (rule.regex && rule.regex.test(text)) {
          return rule.response;
        }
        break;
      case "contains":
      default:
        if (lowerText.includes(rule.trigger.toLowerCase())) {
          return rule.response;
        }
        break;
    }
  }

  return null;
}

function detectAiUtilityCommand(text: string, msg: ExtendedMessage): AiUtilityCommand | null {
  if (!text) {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith("!me")) {
    return null;
  }

  const remainder = trimmed.slice(3).trim();
  const referencedText = extractQuotedText(msg);
  const normalized = remainder.toLowerCase();

  let mode: AiUtilityMode = "qa";
  if (!remainder && referencedText) {
    mode = "explain";
  } else if (/explain/.test(normalized) && (/message/.test(normalized) || Boolean(referencedText))) {
    mode = "explain";
  }

  const rawPrompt = remainder || (mode === "explain" ? "Explain this message" : "Answer this question");

  return {
    mode,
    rawPrompt,
    normalizedPrompt: normalized || rawPrompt.toLowerCase(),
    referencedText,
  };
}

function extractQuotedText(msg: ExtendedMessage): string | undefined {
  const quoted = msg?.quotedMsg;
  if (!quoted) {
    return undefined;
  }

  const body = typeof quoted.body === "string" ? quoted.body.trim() : "";
  return body || undefined;
}

function enhanceHistoryForUtilityCommand(
  history: HistoryEntry[],
  command: AiUtilityCommand
): HistoryEntry[] {
  const directive = buildUtilityDirective(command);
  if (!history.length) {
    return [{ role: "user", text: directive }];
  }

  const updated = history.slice();
  const lastIndex = updated.length - 1;
  if (updated[lastIndex]?.role === "user") {
    updated[lastIndex] = { ...updated[lastIndex], text: directive };
  } else {
    updated.push({ role: "user", text: directive });
  }

  return updated;
}

function buildUtilityDirective(command: AiUtilityCommand): string {
  const sections: string[] = [
    "The WhatsApp owner invoked the !me command for an on-demand AI explanation. Reply as the human owner.",
    `User instruction: ${command.rawPrompt}`,
  ];

  if (command.referencedText) {
    sections.push(
      [
        "Referenced message (do not quote verbatim in the reply unless necessary):",
        "\"\"\"",
        command.referencedText,
        "\"\"\"",
      ].join("\n")
    );
  }

  if (command.mode === "explain") {
    sections.push(
      "Task: Break down the referenced message in simple language, highlighting meaning, intent, and any next steps."
    );
  } else {
    sections.push("Task: Answer the user's question accurately using relevant knowledge and context.");
  }

  sections.push("Keep the response under four sentences, avoid mentioning AI or the !me command, and stay polite.");

  return sections.join("\n\n");
}

async function sendBulkMessages(code: string, payload: BulkMessagePayload) {
  const { getSession } = await import("./sessionManager");
  const { normalizeNumbers, performBulkSend } = await import("./utils");

  const session = getSession(code);
  if (!session) {
    throw new Error("Session not found");
  }
  if (!session.ready) {
    throw new Error("Session is not ready yet");
  }

  if (!Array.isArray(payload.numbers) || !payload.numbers.length) {
    throw new Error("No valid numbers provided");
  }
  if (typeof payload.message !== "string" || !payload.message.trim()) {
    throw new Error("Message body is required");
  }

  const numbers = normalizeNumbers(payload.numbers);
  if (!numbers.length) {
    throw new Error("No valid numbers provided");
  }

  const results = (await performBulkSend(
    session,
    payload.message,
    numbers,
    code
  )) as BulkSendResult[];
  const successCount = results.filter((item) => item.success).length;

  return {
    total: numbers.length,
    success: successCount,
    failed: numbers.length - successCount,
    results,
  };
}

export {
  registerMessageHandlers,
  sendBulkMessages,
  isBotOwner,
  processCommands,
  findCustomReply,
};
