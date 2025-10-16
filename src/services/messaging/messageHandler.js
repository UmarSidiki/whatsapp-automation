"use strict";

const logger = require("../config/logger");
const { STOP_TIMEOUT_MS } = require("../constants");
const { transcribeAudio } = require("./speechToTextService");
const { synthesizeSpeech } = require("./textToSpeechService");
const { queueMessageForPersistence } = require("./chatPersistenceService");
const { savePersonaMessage } = require("./personaPersistenceService");
const { splitMessageIntoParts } = require("../ai/aiReplyService");

/**
 * Check if a message is from the bot owner
 * According to whatsapp-web.js, the bot's own number can be detected differently
 */
function isBotOwner(msg, sessionCode, sessions) {
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
async function processCommands(code, state, msg, sessions) {
  if (!msg || typeof msg.body !== "string") return false;

  const text = msg.body.trim();
  if (!text) return false;

  const commandText = text.toLowerCase();
  // Determine chat ID: use msg.to for outgoing owner messages, msg.from for incoming
  const chatId = msg.fromMe ? msg.to : msg.from;
  const isBotOwnerMessage = isBotOwner(msg, code, sessions);

  // Bot owner commands (only work when sent by the bot owner)
  if (isBotOwnerMessage) {
    if (commandText === "!stopall") {
      const wasActive = Boolean(state.globalStop.active);
      if (!wasActive) {
        state.globalStop.active = true;
        state.globalStop.since = Date.now();
      }
      await safeReply(
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
      msg,
      "🤖 Auto replies disabled for this chat for 24 hours.",
      false
    );
    return true;
  } else if (commandText === "!start") {
    if (state.stopList.has(chatId)) {
      state.stopList.delete(chatId);
      await safeReply(msg, "🤖 Auto replies re-enabled for this chat.", false);
    } else {
      await safeReply(msg, "🤖 Auto replies were already enabled here.", false);
    }
    return true;
  }

  return false;
}

async function safeReply(msg, text, sendAsVoice = false, config = null) {
  try {
    if (sendAsVoice && config && config.textToSpeechApiKey) {
      // Generate voice message
      try {
        const audioBuffer = await synthesizeSpeech(
          text,
          config.textToSpeechApiKey,
          {
            languageCode: config.voiceLanguage || "en-US",
            gender: config.voiceGender || "NEUTRAL",
          }
        );

        const { MessageMedia } = require("whatsapp-web.js");
        const media = new MessageMedia(
          "audio/ogg; codecs=opus",
          audioBuffer.toString("base64"),
          "voice.ogg"
        );

        await msg.reply(media, undefined, { sendAudioAsVoice: true });

        logger.debug(
          {
            to: msg.from,
            textLength: text.length,
            audioSize: audioBuffer.length,
          },
          "Sent voice message reply"
        );
      } catch (voiceError) {
        logger.error(
          { err: voiceError, to: msg.from },
          "Failed to send voice reply, falling back to text"
        );
        // Fallback to text if voice fails
        await msg.reply(text);
      }
    } else {
      // Send as regular text message
      await msg.reply(text);
    }
  } catch (error) {
    logger.error({ err: error, to: msg.from }, "Failed to send reply");
  }
}

async function markChatUnread(msg) {
  try {
    if (!msg || typeof msg.getChat !== "function") {
      return;
    }

    const chat = await msg.getChat();
    if (!chat || typeof chat.markUnread !== "function") {
      return;
    }

    await chat.markUnread();
  } catch (error) {
    logger.debug({ err: error, to: msg?.from }, "Failed to mark chat unread");
  }
}

async function processIncomingMessage(code, state, msg, sessions, chatHistoryManager) {
  const current = sessions.get(code);
  if (!current || !current.ready) return;

  // Determine chatId: for outgoing (owner) use msg.to, for incoming use msg.from
  const chatId = msg.fromMe ? msg.to : msg.from;
  // Skip group messages
  if (typeof chatId === "string" && chatId.includes("@g.us")) return;
  const config = current.aiConfig;
  const isVoiceMessage = msg.hasMedia && msg.type === "ptt"; // ptt = push-to-talk (voice note)

  // Check timestamp first to skip old messages
  const messageTimestampMs =
    typeof msg.timestamp === "number" && msg.timestamp > 0
      ? msg.timestamp * 1000
      : typeof msg._data?.t === "number" && msg._data.t > 0
      ? msg._data.t * 1000
      : Date.now();

  if (
    current.startedAt &&
    messageTimestampMs + 30000 < current.startedAt
  ) {
    return;
  }

  // Process commands first (both from bot owner and users)
  if (await processCommands(code, current, msg, sessions)) {
    return; // If it was a command, stop further processing
  }

  // If we get here, it's not a command - proceed with normal message processing
  if (current.globalStop.active && !isBotOwner(msg, code, sessions)) {
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
    try {
      // Processing voice message

      // Download the audio
      const media = await msg.downloadMedia();
      if (!media || !media.data) {
        logger.warn(
          { code, chatId: msg.from },
          "Failed to download voice message media"
        );
        await safeReply(
          msg,
          "❌ Sorry, I couldn't download your voice message. Please try again.",
          false
        );
        await markChatUnread(msg);
        return;
      }

      // Check audio size to prevent memory spikes (limit to 5MB)
      const audioSizeMB = media.data.length / (1024 * 1024);
      if (audioSizeMB > 5) {
        logger.warn(
          { code, chatId: msg.from, sizeMB: audioSizeMB },
          "Voice message too large, rejecting to save memory"
        );
        await safeReply(
          msg,
          "❌ Sorry, your voice message is too large. Please send a shorter message.",
          false
        );
        await markChatUnread(msg);
        return;
      }

      // Convert base64 to buffer
      const audioBuffer = Buffer.from(media.data, "base64");

      // Transcribe the audio
      text = await transcribeAudio(
        audioBuffer,
        config.speechToTextApiKey,
        config.voiceLanguage || "en-US"
      );

      if (!text || !text.trim()) {
        logger.debug(
          { code, chatId: msg.from },
          "Voice message transcription returned empty text"
        );
        await safeReply(
          msg,
          "🎤 Sorry, I couldn't understand your voice message. Please try speaking more clearly or send text.",
          false
        );
        await markChatUnread(msg);
        return;
      }

      // Voice message transcribed successfully
    } catch (error) {
      logger.error(
        { err: error, code, chatId: msg.from },
        "Failed to process voice message"
      );
      await safeReply(
        msg,
        "❌ Sorry, there was an error processing your voice message. Please try sending it as text.",
        false
      );
      await markChatUnread(msg);
      return;
    }
  } else {
    // Regular text message
    if (!msg || typeof msg.body !== "string") return;
    text = msg.body.trim();
    if (!text) return;
  }

  chatHistoryManager.appendHistoryEntry(current, chatId, { role: "user", text });
  queueMessageForPersistence({
    sessionCode: code,
    contactId: chatId,
    direction: "incoming",
    message: text,
    timestamp: new Date(),
  });

  if (!config) return;

  const customReply = findCustomReply(config.customReplies, text);
  if (customReply) {
    try {
      const shouldSendAsVoice =
        isVoiceMessage &&
        config.voiceReplyEnabled &&
        config.textToSpeechApiKey;
      await safeReply(msg, customReply, shouldSendAsVoice, config);
      chatHistoryManager.appendHistoryEntry(current, chatId, {
        role: "assistant",
        text: customReply,
      });
      queueMessageForPersistence({
        sessionCode: code,
        contactId: chatId,
        direction: "outgoing",
        message: customReply,
        timestamp: new Date(),
      });
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
    const contextWindow = clampContextWindow(config.contextWindow);
    // Load chat history from database on-demand
    const history = await chatHistoryManager.getHistoryForChat(current, chatId, contextWindow);

    // Generate AI reply using database-loaded history
    const reply = await require("../ai/aiReplyService").generateAiReply(config, history, current.persona);

    if (reply) {
      // Analyze typing patterns for message splitting
      const typingPatterns = require("../ai/aiReplyService").analyzeTypingPatterns ?
        require("../ai/aiReplyService").analyzeTypingPatterns(current.persona) : {};

      // Split message into parts if user has incremental messaging style
      const messageParts = splitMessageIntoParts(reply, typingPatterns);

      const shouldSendAsVoice =
        isVoiceMessage &&
        config.voiceReplyEnabled &&
        config.textToSpeechApiKey;

      // Send messages sequentially with small delays for incremental style
      for (let i = 0; i < messageParts.length; i++) {
        const part = messageParts[i];

        if (i > 0) {
          // Add delay between messages for incremental style (500ms - 1.5s)
          const delay = 500 + Math.random() * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        await safeReply(msg, part, shouldSendAsVoice && i === 0, config); // Only send voice for first part

        // Add to chat history and persistence
        chatHistoryManager.appendHistoryEntry(current, chatId, { role: "assistant", text: part });
        queueMessageForPersistence({
          sessionCode: code,
          contactId: chatId,
          direction: "outgoing",
          message: part,
          timestamp: new Date(),
        });
      }

      // Save conversation pair for enhanced AI learning
      await savePersonaMessage(code, { incoming: text, outgoing: reply });
      // Update in-memory persona
      current.persona.push({ incoming: text, outgoing: reply, timestamp: Date.now() });
      // Keep in-memory limited
      const maxPersona = checkMemoryPressure() ? 50 : 100;
      if (current.persona.length > maxPersona) {
        current.persona = current.persona.slice(-maxPersona);
      }

      await markChatUnread(msg);
    } else {
      // If no reply (likely due to timeout or safety filter), send a fallback message
      const fallbackMessage = isVoiceMessage
        ? "⏱️ Sorry, the AI took too long to respond to your voice message. Please try again."
        : "⏱️ Sorry, the AI took too long to respond. Please try again.";
      await safeReply(msg, fallbackMessage, false);
      await markChatUnread(msg);
    }
  } catch (error) {
    logger.error({ err: error, chatId }, "AI reply error");
    // Send a user-friendly error message for any failure
    const errorMessage = isVoiceMessage
      ? "❌ Sorry, I couldn't process your voice message. Please try sending it as text."
      : "❌ Sorry, an error occurred while generating a reply. Please try again.";
    try {
      await safeReply(msg, errorMessage, false);
      await markChatUnread(msg);
    } catch (replyError) {
      logger.error(
        { err: replyError, chatId },
        "Failed to send error notification"
      );
    }
  }
}

async function processOutgoingMessage(code, state, msg, sessions) {
  try {
    if (!msg.fromMe) return;
    const stateObj = sessions.get(code);
    if (!stateObj || !stateObj.ready) return;
    // Process commands for outgoing messages
    const handled = await processCommands(code, stateObj, msg, sessions);
    if (handled) {
      // Command processed; no further action
      return;
    }
    // Capture owner outgoing messages to build persona
    if (msg.body && typeof msg.body === "string") {
      const trimmed = msg.body.trim();
      if (trimmed) {
        // Save to database (automatically limits to 700 messages)
        await savePersonaMessage(code, trimmed);
        // Update in-memory persona for immediate use
        stateObj.persona.push(trimmed);
        // Keep in-memory limited for performance
        const maxPersona = checkMemoryPressure() ? 50 : 100;
        if (stateObj.persona.length > maxPersona) {
          stateObj.persona = stateObj.persona.slice(-maxPersona);
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "Error handling outgoing message commands");
  }
}

function findCustomReply(customReplies, text) {
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

function clampContextWindow(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return require("../constants").DEFAULT_CONTEXT_WINDOW;
  }
  if (numeric < require("../constants").MIN_CONTEXT_WINDOW) {
    return require("../constants").MIN_CONTEXT_WINDOW;
  }
  if (numeric > require("../constants").MAX_CONTEXT_WINDOW) {
    return require("../constants").MAX_CONTEXT_WINDOW;
  }
  return Math.round(require("../constants").getEffectiveContextWindow(numeric));
}

function checkMemoryPressure() {
  const memUsage = process.memoryUsage();
  const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
  return heapUsedMB > 768; // MAX_MEMORY_MB
}

module.exports = {
  isBotOwner,
  processCommands,
  safeReply,
  markChatUnread,
  processIncomingMessage,
  processOutgoingMessage,
  findCustomReply,
  clampContextWindow,
};