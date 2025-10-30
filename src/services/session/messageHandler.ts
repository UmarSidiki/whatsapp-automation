import logger from "../../config/logger";
import { generateReply } from "../ai/geminiService";
import { transcribeAudio } from "../ai/speechToTextService";
import { appendHistoryEntry, persistChatMessage } from "./chatHistory";
import { markChatUnread, safeReply, sendFragmentedReply } from "./utils";
import { sessions } from "./sessionManager";

const STOP_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const MESSAGE_TIMESTAMP_TOLERANCE_MS = 30_000; // 30s for clock skew tolerance

/**
 * Check if a message is from the bot owner
 * According to WPPConnect, the bot's own number can be detected differently
 */
function isBotOwner(msg: any, sessionCode: string): boolean {
  // Method 1: Check if fromMe is true (messages sent by the bot itself)
  if (msg.fromMe) {
    return true;
  }

  // Method 2: Compare with the session's authenticated number
  try {
    const session = sessions.get(sessionCode);
    if (session && session.botNumber) {
      const messageFrom = msg.from.replace(/@.*$/, ""); // Remove @c.us suffix
      return session.botNumber === messageFrom;
    }
  } catch (error) {
    logger.debug({ err: error }, "Error checking bot owner");
  }

  return false;
}

/**
 * Process commands from both bot owner and users
 * @returns {Promise<boolean>} true if the message was a command and was processed
 */
async function processCommands(
  code: string,
  state: any,
  msg: any
): Promise<boolean> {
  if (!msg || typeof msg.body !== "string") return false;

  const text = msg.body.trim();
  if (!text) return false;

  const commandText = text.toLowerCase();
  // Determine chat ID: use msg.to for outgoing owner messages, msg.from for incoming
  const chatId = msg.fromMe ? msg.to : msg.from;
  const isBotOwnerMessage = isBotOwner(msg, code);

  // Bot owner commands (only work when sent by the bot owner)
  if (isBotOwnerMessage) {
    if (commandText === "!stopall") {
      const wasActive = Boolean(state.globalStop.active);
      if (!wasActive) {
        state.globalStop.active = true;
        state.globalStop.since = Date.now();
      }
      await safeReply(
        state.client,
        msg,
        wasActive
          ? "🛑 Global auto replies are already disabled."
          : "🛑 Global auto replies disabled. I'll stay quiet until you send !startall.",
        false
      );
      return true;
    } else if (commandText === "!startall") {
      const wasActive = Boolean(state.globalStop.active);
      state.globalStop.active = false;
      state.globalStop.since = 0;
      if (state.stopList.size) {
        state.stopList.clear();
      }
      await safeReply(
        state.client,
        msg,
        wasActive
          ? "✅ Global auto replies re-enabled for all chats."
          : "✅ Global auto replies were already enabled.",
        false
      );
      return true;
    }
  }

  // User commands (work for any user)
  if (commandText === "!stop") {
    state.stopList.set(chatId, Date.now());
    await safeReply(
      state.client,
      msg,
      "🤖 Auto replies disabled for this chat for 24 hours.",
      false
    );
    return true;
  } else if (commandText === "!start") {
    if (state.stopList.has(chatId)) {
      state.stopList.delete(chatId);
      await safeReply(
        state.client,
        msg,
        "🤖 Auto replies re-enabled for this chat.",
        false
      );
    } else {
      await safeReply(
        state.client,
        msg,
        "🤖 Auto replies were already enabled here.",
        false
      );
    }
    return true;
  }

  return false;
}

/**
 * Helper function to download media with retries for WPPConnect
 * WPPConnect's downloadMedia returns base64 string directly or throws/returns empty on failure
 * @param forceForVoice - If true, skips the isMedia check for voice messages (PTT) as it may fire early
 */
async function downloadMediaWithRetry(
  client: any,
  msg: any,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
  forceForVoice: boolean = false
): Promise<string | null> {
  const sessionCode = msg.session || "unknown";
  const chatId = msg.from || "unknown";
  const isVoice = msg.type === "ptt" || (msg.type === "audio" && msg.isPtt);

  if (!forceForVoice && !msg.isMedia && !isVoice) {
    logger.warn(
      { code: sessionCode, chatId },
      "Message has no media available"
    );
    return null;
  }

  if (forceForVoice && isVoice && !msg.isMedia) {
    logger.debug(
      { code: sessionCode, chatId, msgType: msg.type },
      "Forcing media download for voice message despite isMedia=false (early event?)"
    );
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mediaBase64 = await client.downloadMedia(msg);
      if (
        mediaBase64 &&
        typeof mediaBase64 === "string" &&
        mediaBase64.length > 0
      ) {
        logger.debug(
          {
            code: sessionCode,
            chatId,
            attempt,
            mediaLength: mediaBase64.length,
            isMedia: msg.isMedia,
          },
          "Media downloaded successfully"
        );
        return mediaBase64;
      } else {
        logger.debug(
          {
            code: sessionCode,
            chatId,
            attempt,
            mediaLength: mediaBase64?.length,
          },
          "Download returned empty/invalid media"
        );
      }
    } catch (downloadError) {
      logger.error(
        {
          err: downloadError,
          code: sessionCode,
          chatId,
          attempt,
          msgType: msg.type,
          isMedia: msg.isMedia,
          isVoice,
        },
        `DownloadMedia attempt ${attempt} failed`
      );
    }

    if (attempt < maxRetries) {
      const delay = baseDelayMs * attempt; // Progressive delay: 1s, 2s, 3s
      logger.debug(
        { code: sessionCode, chatId, attempt, delay },
        "Retrying download after delay"
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  logger.warn(
    {
      code: sessionCode,
      chatId,
      maxRetries,
      msgType: msg.type,
      isMedia: msg.isMedia,
    },
    "All download retries exhausted"
  );
  return null;
}

function registerMessageHandlers(code: string, state: any) {
  state.client.onAnyMessage(async (msg: any) => {
    const current = sessions.get(code);
    if (!current || !current.ready) return;

    // Set session on msg if not present (for logging)
    if (!msg.session) {
      msg.session = code;
    }

    // Determine chatId: for outgoing (owner) use msg.to, for incoming use msg.from
    const chatId = msg.fromMe ? msg.to : msg.from;

    // Skip non-personal chats (groups, status/broadcast, newsletters)
    if (typeof chatId === "string") {
      if (chatId.includes("@g.us")) {
        logger.debug({ code, chatId }, "Skipping group message");
        return;
      }
      if (
        chatId.includes("@broadcast") ||
        chatId.includes("status@broadcast")
      ) {
        logger.debug(
          { code, chatId, msgType: msg.type },
          "Skipping status/broadcast message"
        );
        return;
      }
      if (chatId.includes("@newsletter")) {
        logger.debug(
          { code, chatId, msgType: msg.type },
          "Skipping newsletter message"
        );
        return;
      }
    }
    const config = current.aiConfig;
    const isVoiceMessage =
      msg.type === "ptt" || (msg.type === "audio" && msg.isPtt); // Voice message detection

    // Check timestamp first to skip old messages
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

    // Process commands first (both from bot owner and users)
    if (await processCommands(code, current, msg)) {
      return; // If it was a command, stop further processing
    }

    // If the message is from the bot (outgoing), persist it for persona learning but don't process
    if (msg.fromMe) {
      // Persist your manual messages for persona learning (exclude media)
      const text = msg.body?.trim();
      const hasMedia = msg.hasMedia || msg.isMedia || isVoiceMessage;
      if (text && typeof text === "string" && !hasMedia) {
        appendHistoryEntry(current, chatId, { role: "assistant", text });
        persistChatMessage(code, chatId, "outgoing", text, false); // false = not AI-generated
      }
      return; // Don't process further (no AI reply needed for your own messages)
    }

    // If we get here, it's not a command and not from the bot - proceed with normal incoming message processing
    if (current.globalStop.active && !isBotOwner(msg, code)) {
      return;
    }

    // Check stop list BEFORE processing voice (to save API costs)
    const stopTime = current.stopList.get(chatId);
    if (stopTime && Date.now() - stopTime < STOP_TIMEOUT_MS) {
      return;
    } else if (stopTime) {
      current.stopList.delete(chatId);
    }

    let text = "";

    // Now process voice messages or text messages
    if (
      isVoiceMessage &&
      config?.voiceReplyEnabled &&
      config?.speechToTextApiKey
    ) {
      // Early exit for old messages (adjust threshold as needed)
      const messageAgeMs = Date.now() - messageTimestampMs;
      if (messageAgeMs > 24 * 60 * 60 * 1000) {
        // 24 hours
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
        // Processing voice message with retry (force for voice to bypass early isMedia=false)
        const mediaBase64 = await downloadMediaWithRetry(
          state.client,
          msg,
          3,
          1000,
          true
        );
        if (!mediaBase64) {
          logger.warn(
            {
              code,
              chatId: msg.from,
              messageAgeMs,
              isMedia: msg.isMedia,
              msgType: msg.type,
            },
            "Failed to download voice message media after retries"
          );
          await safeReply(
            state.client,
            msg,
            "❌ Sorry, I couldn't download your voice message after a few tries. This might be due to network issues or the message not being ready. Please try again in a moment or send as text.",
            false
          );
          await markChatUnread(msg);
          return;
        }

        // NEW: Strip data URI prefix if present (WPPConnect returns "data:audio/ogg; codecs=opus;base64,<base64>")
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
              {
                code,
                chatId: msg.from,
                mediaPreview: mediaBase64.substring(0, 100),
              },
              "Invalid data URI format in media"
            );
            await safeReply(
              state.client,
              msg,
              "❌ Invalid voice message format. Please try again.",
              false
            );
            await markChatUnread(msg);
            return;
          }
        }

        // Convert base64 to buffer
        const audioBuffer = Buffer.from(cleanBase64, "base64");

        // Validate buffer size and log preview for debug (fixes tiny buffer issue)
        const MIN_AUDIO_SIZE = 100; // Bytes; adjust based on shortest expected PTT
        if (audioBuffer.length < MIN_AUDIO_SIZE) {
          logger.error(
            {
              code,
              chatId: msg.from,
              audioSize: audioBuffer.length,
              base64Preview: cleanBase64.substring(0, 100), // First 100 chars for inspection
              fullBase64Length: cleanBase64.length,
            },
            "Invalid tiny audio buffer from download - likely corrupt base64"
          );
          await safeReply(
            state.client,
            msg,
            `❌ Voice message too short or corrupted (only ${audioBuffer.length} bytes received). Please record a longer/clearer one or send text.`,
            false
          );
          await markChatUnread(msg);
          return;
        }

        const mimeType = msg.mimetype || "audio/ogg; codecs=opus"; // Fallback for PTT

        logger.debug(
          {
            code,
            chatId: msg.from,
            audioSize: audioBuffer.length,
            mimeType,
            base64Preview: cleanBase64.substring(0, 50), // Safe preview for logging
          },
          "Processing voice message"
        );

        // Transcribe the audio
        text = await transcribeAudio(
          audioBuffer,
          config.speechToTextApiKey,
          config.voiceLanguage || "en-US"
        );

        if (!text || !text.trim()) {
          logger.warn(
            {
              code,
              chatId: msg.from,
              audioSize: audioBuffer.length,
              language: config.voiceLanguage,
            },
            "Voice message transcription returned empty text"
          );
          await safeReply(
            state.client,
            msg,
            "🎤 Sorry, I couldn't understand your voice message. This could be due to:\n• Audio too short or unclear\n• Background noise\n• Unsupported language\n\nPlease try speaking more clearly or send a text message.",
            false
          );
          await markChatUnread(msg);
          return;
        }

        logger.info(
          {
            code,
            chatId: msg.from,
            transcriptionLength: text.length,
            preview: text.substring(0, 50),
          },
          "Voice message transcribed successfully"
        );

        // Voice message transcribed successfully
      } catch (error) {
        logger.error(
          {
            err: error,
            code,
            chatId: msg.from,
            errorMessage: error.message,
            errorCode: error.code,
          },
          "Failed to process voice message"
        );

        // Provide more specific error message based on error type
        let errorMsg =
          "❌ Sorry, there was an error processing your voice message.";
        if (error.message?.includes("API key")) {
          errorMsg += " The Speech-to-Text API key may be invalid.";
        } else if (
          error.message?.includes("quota") ||
          error.message?.includes("limit")
        ) {
          errorMsg += " API quota exceeded. Please try again later.";
        } else if (error.message?.includes("permission")) {
          errorMsg += " API permissions issue. Please contact support.";
        } else {
          errorMsg += " Please try sending it as text.";
        }

        await safeReply(state.client, msg, errorMsg, false);
        await markChatUnread(msg);
        return;
      }
    } else {
      // Regular text message
      if (!msg || typeof msg.body !== "string") return;
      text = msg.body.trim();
      if (!text) return;
    }

    // Persist incoming message (exclude media - voice messages are already transcribed to text)
    const hasMedia = msg.hasMedia || msg.isMedia;
    const shouldPersist = !hasMedia || isVoiceMessage; // Voice messages are OK since we have transcribed text

    appendHistoryEntry(current, chatId, { role: "user", text });
    if (shouldPersist) {
      persistChatMessage(code, chatId, "incoming", text, false); // false = not AI-generated
    }

    if (!config) return;

    const customReply = findCustomReply(config.customReplies, text);
    if (customReply) {
      try {
        const shouldSendAsVoice =
          isVoiceMessage &&
          config.voiceReplyEnabled &&
          config.textToSpeechApiKey;
        await safeReply(
          state.client,
          msg,
          customReply,
          shouldSendAsVoice,
          config
        );
        appendHistoryEntry(current, chatId, {
          role: "assistant",
          text: customReply,
        });
        // Custom replies are text-only, safe to persist
        persistChatMessage(code, chatId, "outgoing", customReply, false); // Custom reply = not AI
        await markChatUnread(msg);
      } catch (error) {
        logger.error({ err: error, chatId }, "Custom reply send error");
      }
      return;
    }

    if (!config.autoReplyEnabled) {
      return;
    }

    if (!config.apiKey || !config.model) {
      return;
    }

    try {
      // Get context window setting (respects user's configuration)
      const { clampContextWindow } = await import("./configManager");
      const contextWindow = clampContextWindow(config.contextWindow);

      // Use recent history for context
      const { getHistoryForChat } = await import("./chatHistory");
      const history = getHistoryForChat(current, chatId, contextWindow);

      // --- MEMORY OPTIMIZATION: Lazy Load Persona Examples ---
      // Only load persona examples if they will actually be used
      // This saves 15-20MB/hour by not loading data that gets cached anyway
      const loadPersonaExamples = async (): Promise<string[]> => {
        const { getChatMessages, getUniversalPersona } = await import(
          "../persistence/chatPersistenceService"
        );
        const chatMessages = await getChatMessages(code, chatId);

        let personaExamples: string[] = [];

        if (chatMessages.length >= 250) {
          // Use contact-specific persona for established chats (250+ messages)
          // Build conversation pairs: show what user said and how I responded
          const conversationPairs: string[] = [];

          for (let i = 0; i < chatMessages.length - 1; i++) {
            const current = chatMessages[i].message;
            const next = chatMessages[i + 1].message;

            // Find pairs where user message is followed by my reply
            if (current.startsWith("User: ") && next.startsWith("My reply: ")) {
              const userMsg = current.replace("User: ", "");
              const myReply = next.replace("My reply: ", "");
              conversationPairs.push(
                `User said: "${userMsg}"\nI replied: "${myReply}"`
              );
            }
          }

          personaExamples = conversationPairs.slice(-contextWindow);

          logger.debug(
            {
              code,
              chatId,
              personaSource: "contact",
              exampleCount: personaExamples.length,
              totalMessages: chatMessages.length,
              contextWindow,
            },
            "Using contact-specific persona with conversation pairs"
          );
        } else {
          // Use universal persona for new/small chats (already just your replies)
          const universalMessages = await getUniversalPersona(code);
          personaExamples = universalMessages.slice(-contextWindow);

          logger.debug(
            {
              code,
              chatId,
              personaSource: "universal",
              exampleCount: personaExamples.length,
              contextWindow,
            },
            "Using universal persona"
          );
        }

        return personaExamples;
      };
      // --- END OPTIMIZATION ---

      let reply = null;
      let retryCount = 0;
      const maxRetries = 2;

      // Retry logic for API overload (503 errors)
      while (retryCount <= maxRetries && !reply) {
        try {
          reply = await generateReply(
            {
              ...config,
              loadPersonaExamples, // Pass lazy loader function instead of data
              contactId: chatId, // Pass contactId for context caching
            },
            history
          );
          break; // Success, exit loop
        } catch (error: any) {
          if (error.statusCode === 503 && retryCount < maxRetries) {
            retryCount++;
            const delayMs = 2000 * retryCount; // 2s, 4s
            logger.info(
              { code, chatId, retryCount, delayMs },
              "Retrying after API overload"
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          } else {
            throw error; // Re-throw if not 503 or max retries reached
          }
        }
      }

      if (reply) {
        const shouldSendAsVoice =
          isVoiceMessage &&
          config.voiceReplyEnabled &&
          config.textToSpeechApiKey;

        // Send the reply (as-is, no JSON parsing)
        await sendFragmentedReply(
          state.client,
          msg,
          reply,
          shouldSendAsVoice,
          config
        );

        appendHistoryEntry(current, chatId, { role: "assistant", text: reply });
        // AI replies are text-only, safe to persist
        persistChatMessage(code, chatId, "outgoing", reply, true); // AI-generated = true
        await markChatUnread(msg);
      } else {
        // If no reply (likely due to timeout or safety filter), send a fallback message
        const fallbackMessage = isVoiceMessage
          ? "⏱️ Sorry, the AI took too long to respond to your voice message. Please try again."
          : "⏱️ Sorry, the AI took too long to respond. Please try again.";
        await safeReply(state.client, msg, fallbackMessage, false);
        await markChatUnread(msg);
      }
    } catch (error: any) {
      logger.error({ err: error, chatId }, "AI reply error");

      // Provide specific error messages based on error type
      let errorMessage =
        "❌ Sorry, an error occurred while generating a reply. Please try again.";

      if (error.statusCode === 503) {
        errorMessage =
          "⏳ The AI service is currently overloaded. Please try again in a few moments.";
      } else if (error.statusCode === 429) {
        errorMessage =
          "⏱️ Rate limit reached. Please wait a moment before trying again.";
      } else if (error.statusCode === 400) {
        errorMessage =
          "❌ Invalid request. Please check your message and try again.";
      } else if (isVoiceMessage) {
        errorMessage =
          "❌ Sorry, I couldn't process your voice message. Please try sending it as text.";
      }

      try {
        await safeReply(state.client, msg, errorMessage, false);
        await markChatUnread(msg);
      } catch (replyError) {
        logger.error(
          { err: replyError, chatId },
          "Failed to send error notification"
        );
      }
    }
  });
}

function findCustomReply(customReplies: any[], text: string): string | null {
  if (!Array.isArray(customReplies) || !customReplies.length) {
    return null;
  }

  const lowerText = text.toLowerCase();

  for (const rule of customReplies) {
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

async function sendBulkMessages(code: string, payload: any) {
  const { getSession } = await import("./sessionManager");
  const { normalizeNumbers, performBulkSend } = await import("./utils");

  const session = getSession(code);
  if (!session) {
    throw new Error("Session not found");
  }
  if (!session.ready) {
    throw new Error("Session is not ready yet");
  }

  const numbers = normalizeNumbers(payload.numbers);
  if (!numbers.length) {
    throw new Error("No valid numbers provided");
  }

  const results = await performBulkSend(
    session,
    payload.message,
    numbers,
    code
  );
  const successCount = results.filter((item: any) => item.success).length;

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
