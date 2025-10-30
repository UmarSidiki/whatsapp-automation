import logger from "../../config/logger";

interface CustomReply {
  trigger: string;
  response: string;
  matchType: string;
  regex?: RegExp;
}

async function safeReply(client, msg, text, sendAsVoice = false, config = null) {
  try {
    if (sendAsVoice && config && config.textToSpeechApiKey && text && text.trim()) {
      // Generate voice message
      try {
        const trimmedText = text.trim();

        // Auto-detect language based on text content
        let detectedLanguage = config.voiceLanguage || "en-US";
        if (!config.voiceLanguage) {
          // Check if text contains Hindi/Urdu characters (Devanagari or Urdu script)
          const hasDevanagari = /[\u0900-\u097F]/.test(trimmedText);
          const hasUrdu = /[\u0600-\u06FF]/.test(trimmedText);
          if (hasDevanagari || hasUrdu) {
            detectedLanguage = "hi-IN"; // Hindi (India) supports both Hindi and Urdu
          }
        }

        const { synthesizeSpeech } = await import("../ai/textToSpeechService");
        const audioBuffer = await synthesizeSpeech(
          trimmedText,
          config.textToSpeechApiKey,
          {
            languageCode: detectedLanguage,
            gender: config.voiceGender || "NEUTRAL",
          }
        );

        // Validate audio buffer before sending
        const MIN_AUDIO_SIZE = 100; // Minimum bytes for a valid voice message
        if (!audioBuffer || audioBuffer.length < MIN_AUDIO_SIZE) {
          logger.warn(
            {
              to: msg.from,
              textLength: trimmedText.length,
              audioSize: audioBuffer?.length || 0
            },
            `TTS returned invalid audio buffer (too small: ${audioBuffer?.length || 0} bytes), falling back to text`
          );
          await client.sendText(msg.from, text, { quotedMessageId: msg.id.id });
          return;
        }

        const base64Audio = audioBuffer.toString('base64');
        if (!base64Audio || base64Audio.length === 0) {
          logger.warn(
            {
              to: msg.from,
              textLength: trimmedText.length,
              audioSize: audioBuffer.length
            },
            "Failed to convert audio to base64, falling back to text"
          );
          await client.sendText(msg.from, text, { quotedMessageId: msg.id.id });
          return;
        }

        // Try different send methods for WPPConnect compatibility
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const clientAny: any = client;
        const dataUri = `data:audio/ogg;codecs=opus;base64,${base64Audio}`;

        if (typeof clientAny.sendPttFromBase64 === "function") {
          // sendPttFromBase64(to, base64, filename, caption?, quotedMessageId?, messageId?)
          await clientAny.sendPttFromBase64(
            msg.from,
            base64Audio,
            "voice.ogg",
            undefined, // caption
            msg.id.id // quotedMessageId
          );
        } else if (typeof clientAny.sendPtt === "function") {
          // sendPtt(to, filePath, filename?, caption?, quotedMessageId?, messageId?)
          // This expects a file path, not base64
          logger.warn(
            { to: msg.from },
            "sendPttFromBase64 not available, sendPtt requires file path, falling back to text"
          );
          await client.sendText(msg.from, text, { quotedMessageId: msg.id.id });
          return;
        } else if (typeof clientAny.sendFileFromBase64 === "function") {
          // sendFileFromBase64(base64, chatId, fileName, caption?)
          await clientAny.sendFileFromBase64(
            base64Audio,
            msg.from,
            "voice.ogg",
            "Voice reply"
          );
        } else if (typeof clientAny.sendFile === "function") {
          // sendFile(chatId, filePathOrDataURI, fileName, caption?)
          await clientAny.sendFile(msg.from, dataUri, "voice.ogg");
        } else if (typeof clientAny.sendMessage === "function") {
          // Last resort: send raw data URI as message
          await clientAny.sendMessage(msg.from, dataUri);
        } else {
          logger.warn(
            { to: msg.from },
            "No supported voice send method found, falling back to text"
          );
          await client.sendText(msg.from, text, { quotedMessageId: msg.id.id });
          return;
        }
      } catch (voiceError) {
        logger.error(
          { err: voiceError, to: msg.from, textLength: text.length },
          "Failed to send voice reply, falling back to text"
        );
        // Fallback to text if voice fails
        await client.sendText(msg.from, text, { quotedMessageId: msg.id.id });
      }
    } else {
      // Send as regular text message
      await client.sendText(msg.from, text, { quotedMessageId: msg.id.id });
    }
  } catch (error) {
    logger.error({ err: error, to: msg.from }, "Failed to send reply");
  }
}

async function sendFragmentedReply(
  client,
  msg,
  fullReply,
  sendAsVoice = false,
  config = null
) {
  // If the reply is short, send as a single message
  if (fullReply.length <= 60) {
    // Changed from word count to character count for better control
    await safeReply(client, msg, fullReply, sendAsVoice, config);
    return;
  }

  // Split the reply into sentences first
  const sentences = fullReply.match(/[^.!?]+[.!?]+/g) || [fullReply];

  // If we have only one sentence but it's long, split it at natural break points
  if (sentences.length === 1 && sentences[0].length > 100) {
    // Try to split at commas, colons, or other natural break points
    const clauses = sentences[0].split(/[:;,\n-]+/);
    if (clauses.length > 1) {
      // Send each clause as a separate message
      for (let i = 0; i < clauses.length; i++) {
        const clause = clauses[i].trim();
        if (clause) {
          await safeReply(
            client,
            msg,
            clause,
            sendAsVoice, // Send ALL clauses as voice, not just the last one
            config
          );
          if (i < clauses.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1500)); // 1.5 second delay
          }
        }
      }
      return;
    }

    // If no natural break points, split at word boundaries but try to keep phrases together
    const words = sentences[0].split(/\s+/);
    const fragments = [];
    let currentFragment = "";

    for (const word of words) {
      const testFragment = currentFragment
        ? `${currentFragment} ${word}`
        : word;

      // If adding this word makes the fragment too long, save the current fragment
      if (testFragment.length > 80 && currentFragment) {
        fragments.push(currentFragment);
        currentFragment = word;
      } else {
        currentFragment = testFragment;
      }
    }

    // Add the last fragment
    if (currentFragment) {
      fragments.push(currentFragment);
    }

    // Send each fragment
    for (let i = 0; i < fragments.length; i++) {
      await safeReply(
        client,
        msg,
        fragments[i],
        sendAsVoice, // Send ALL fragments as voice, not just the last one
        config
      );
      if (i < fragments.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500)); // 1.5 second delay
      }
    }
    return;
  }

  // If we have multiple sentences, send each sentence as a separate message
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i].trim();
    if (sentence) {
      await safeReply(
        client,
        msg,
        sentence,
        sendAsVoice, // Send ALL sentences as voice, not just the last one
        config
      );
      if (i < sentences.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500)); // 1.5 second delay
      }
    }
  }
}

async function markChatUnread(msg) {
  try {
    if (!msg || typeof msg.getChat !== "function") {
      return;
    }

    const chat = await msg.getChat();
    if (!chat) {
      return;
    }

    // In WPPConnect, mark unread by setting unread count
    if (typeof chat.markUnread === "function") {
      await chat.markUnread();
    } else {
      // Fallback: try to send seen status to mark as unread
      logger.debug({ to: msg?.from }, "markUnread not available, skipping");
    }
  } catch (error) {
    logger.debug({ err: error, to: msg?.from }, "Failed to mark chat unread");
  }
}

function sanitizeCustomReplies(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .map((entry) => {
      const trigger =
        typeof entry.trigger === "string" ? entry.trigger.trim() : "";
      const response =
        typeof entry.response === "string" ? entry.response.trim() : "";
      const matchType = entry.matchType || "contains";

      if (!trigger || !response) {
        return null;
      }

      const normalized: CustomReply = {
        trigger,
        response,
        matchType,
      };

      if (matchType === "regex") {
        try {
          normalized.regex = new RegExp(trigger, "i");
        } catch (error) {
          logger.warn(
            { trigger, err: error },
            "Invalid custom reply regex; falling back to 'contains'"
          );
          normalized.matchType = "contains";
        }
      }

      return normalized;
    })
    .filter(Boolean);
}

function serializeCustomReplies(customReplies) {
  if (!Array.isArray(customReplies)) {
    return [];
  }

  return customReplies.map((item) => ({
    trigger: item.trigger,
    response: item.response,
    matchType: item.matchType,
  }));
}

function formatPhoneNumber(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return null;
  }
  if (/@(c|g)\.us$/i.test(value)) {
    return value;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length < 8) {
    return null;
  }
  return `${digits}@c.us`;
}

function normalizeNumbers(numbers) {
  if (!Array.isArray(numbers)) {
    return [];
  }

  const seen = new Set();
  const formatted = [];
  for (const raw of numbers) {
    const formattedNumber = formatPhoneNumber(raw);
    if (formattedNumber && !seen.has(formattedNumber)) {
      seen.add(formattedNumber);
      formatted.push(formattedNumber);
    }
  }
  return formatted;
}

async function performBulkSend(session, message, numbers, sessionCode) {
  const { appendHistoryEntry, persistChatMessage } = await import("./chatHistory");
  const results = [];
  for (const number of numbers) {
    try {
      await session.client.sendText(number, message);
      results.push({ number, success: true });
      appendHistoryEntry(session, number, { role: "assistant", text: message });
      persistChatMessage(sessionCode, number, "outgoing", message);
    } catch (error) {
      logger.error({ err: error, number }, "Failed to send message");
      results.push({ number, success: false, error: error.message });
    }
  }
  return results;
}

export {
  safeReply,
  sendFragmentedReply,
  markChatUnread,
  sanitizeCustomReplies,
  serializeCustomReplies,
  formatPhoneNumber,
  normalizeNumbers,
  performBulkSend,
};