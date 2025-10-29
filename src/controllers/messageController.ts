import { bulkMessageSchema } from "../validation/bulkMessageSchema";
import { scheduleMessageSchema } from "../validation/scheduleMessageSchema";
import {
  getSession,
  sendBulkMessages,
  scheduleMessages,
  getScheduledMessages,
  cancelScheduledMessage,
  removeScheduledMessage,
} from "../services/session";
// --- CHANGED ---
// Removed MessageMedia and imported Whatsapp, aliasing it as Client
// from: import { MessageMedia, Client } from "whatsapp-web.js";
// to:
import { Whatsapp as Client } from "@wppconnect-team/wppconnect";
// --- END CHANGE ---
import { transcribeAudio } from "../services/ai/speechToTextService";
import { synthesizeSpeech } from "../services/ai/textToSpeechService";

function validateSession(code: string): { client: Client } {
  const session = getSession(code);
  if (!session) {
    const error = new Error("Session not found") as Error & {
      statusCode?: number;
    };
    error.statusCode = 404;
    throw error;
  }
  return session;
}

async function handleBulkSend(req, res): Promise<void> {
  validateSession(req.params.code);
  const parseResult = bulkMessageSchema.safeParse(req.body || {});
  if (!parseResult.success) {
    res.status(400).json({
      error: "Invalid bulk message payload",
      details: parseResult.error.flatten(),
    });
    return;
  }

  try {
    const result = await sendBulkMessages(req.params.code, parseResult.data);
    res.json({ ...result, success: true });
  } catch (error) {
    const status = (error as { statusCode?: number })?.statusCode || 500;
    res.status(status).json({
      error: (error as Error).message || "Failed to send bulk messages",
    });
  }
}

async function listScheduled(req, res): Promise<void> {
  validateSession(req.params.code);
  try {
    const jobs = await getScheduledMessages(req.params.code);
    res.json({ jobs });
  } catch (error) {
    const status = (error as { statusCode?: number })?.statusCode || 500;
    res.status(status).json({
      error: (error as Error).message || "Failed to load scheduled messages",
    });
  }
}

async function createSchedule(req, res): Promise<void> {
  validateSession(req.params.code);
  const parseResult = scheduleMessageSchema.safeParse(req.body || {});
  if (!parseResult.success) {
    res.status(400).json({
      error: "Invalid schedule payload",
      details: parseResult.error.flatten(),
    });
    return;
  }

  try {
    const job = await scheduleMessages(req.params.code, parseResult.data);
    res.status(201).json({ success: true, job });
  } catch (error) {
    const status = (error as { statusCode?: number })?.statusCode || 500;
    res.status(status).json({
      error: (error as Error).message || "Failed to schedule message",
    });
  }
}

async function cancelSchedule(req, res): Promise<void> {
  validateSession(req.params.code);
  try {
    const mode = String(req.query.mode || "").toLowerCase();
    const handler =
      mode === "remove" ? removeScheduledMessage : cancelScheduledMessage;
    const job = await handler(req.params.code, req.params.jobId);
    res.json({ success: true, job, removed: mode === "remove" });
  } catch (error) {
    const status = (error as { statusCode?: number })?.statusCode || 500;
    res
      .status(status)
      .json({ error: (error as Error).message || "Failed to cancel schedule" });
  }
}

/**
 * Handle incoming voice messages, transcribe them, and reply with a voice note.
 */
async function handleVoiceMessage(req, res): Promise<void> {
  const { code } = req.params;
  const session = validateSession(code);

  try {
    const { audioBuffer, apiKey, languageCode, chatId } = req.body; // Added chatId for clarity

    if (!audioBuffer) {
      res.status(400).json({ error: "Audio buffer is required." });
      return;
    }

    // Transcribe the voice note
    const transcription = await transcribeAudio(
      audioBuffer,
      apiKey,
      languageCode
    );

    // Generate a reply (example: echo the transcription)
    const replyText = `You said: ${transcription}`;
    const voiceNote = await synthesizeSpeech(replyText, apiKey, {
      languageCode,
    });

    // --- CHANGED ---
    // Replaced MessageMedia and client.sendMessage with client.sendVoice
    // and formatted the audio buffer as a base64 data URI.

    // 1. Convert buffer to base64 data URI
    const base64Audio = voiceNote.toString("base64");
    const dataUri = `data:audio/ogg; codecs=opus;base64,${base64Audio}`;

    // 2. Send using client API — try sendPttFromBase64 first, then fall back to other send methods
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientAny: any = session.client;
    if (typeof clientAny.sendPttFromBase64 === "function") {
      await clientAny.sendPttFromBase64(
        chatId,
        base64Audio,
        "voice.ogg",
        "Voice message",
        req.body.quotedMessageId
      );
    } else if (typeof clientAny.sendFileFromBase64 === "function") {
      // sendFileFromBase64(base64, chatId, fileName, caption?)
      await clientAny.sendFileFromBase64(
        base64Audio,
        chatId,
        "voice.ogg",
        "Voice message"
      );
    } else if (typeof clientAny.sendFile === "function") {
      // sendFile(chatId, filePathOrDataURI, fileName, caption?)
      await clientAny.sendFile(chatId, dataUri, "voice.ogg");
    } else if (typeof clientAny.sendMessage === "function") {
      // Last resort: send raw data URI as message
      await clientAny.sendMessage(chatId, dataUri);
    } else {
      throw new Error("No supported send method found on session.client");
    }

    // Original whatsapp-web.js code:
    // const media = new MessageMedia(
    //   "audio/ogg; codecs=opus",
    //   voiceNote.toString("base64"),
    //   "voice.ogg"
    // );
    // await session.client.sendMessage(req.body.chatId, media, {
    //   sendAudioAsVoice: true,
    // });
    // --- END CHANGE ---

    res.status(200).json({ success: true, transcription, replyText });
  } catch (error) {
    res
      .status(500)
      .json({ error: error.message || "Failed to process voice message." });
  }
}
export default {
  handleBulkSend,
  createSchedule,
  listScheduled,
  cancelSchedule,
  handleVoiceMessage,
};
