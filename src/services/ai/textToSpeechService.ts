"use strict";

import textToSpeech from "@google-cloud/text-to-speech";
import logger from "../../config/logger";

/**
 * Convert text to speech using Google Text-to-Speech API
 * @param {string} text - Text to convert to speech
 * @param {string} apiKey - Google Cloud API key
 * @param {Object} options - Voice options
 * @param {string} options.languageCode - Language code (e.g., 'en-US', 'es-ES')
 * @param {string} options.voiceName - Voice name (e.g., 'en-US-Standard-A')
 * @param {string} options.gender - Voice gender ('MALE', 'FEMALE', 'NEUTRAL')
 * @returns {Promise<Buffer>} Audio buffer (OGG/OPUS format)
 */
async function synthesizeSpeech(text, apiKey, options: { languageCode?: string; voiceName?: string; gender?: string } = {}) {
  if (!text || !apiKey) {
    throw new Error("Text and API key are required");
  }

  try {
    // Create client with API key
    const client = new textToSpeech.TextToSpeechClient({
      apiKey: apiKey,
    });

    const {
      languageCode = "en-US",
      voiceName = null,
      gender = "NEUTRAL",
    } = options;

    const request = {
      input: { text },
      voice: {
        languageCode,
        ...(voiceName ? { name: voiceName } : {}),
        ssmlGender: gender as any,
      },
      audioConfig: {
        audioEncoding: "OGG_OPUS" as any,
        speakingRate: 1.0,
        pitch: 0.0,
      },
    };

    const [response] = await client.synthesizeSpeech(request);

    if (!response.audioContent) {
      logger.error(
        { text, languageCode, gender },
        "No audio content returned from Text-to-Speech API"
      );
      throw new Error("No audio content returned from Text-to-Speech API");
    }

    const audioBuffer = Buffer.from(response.audioContent);

    if (audioBuffer.length === 0) {
      logger.error(
        { text, languageCode, gender },
        "TTS API returned empty audio buffer"
      );
      throw new Error("Empty audio buffer returned from Text-to-Speech API");
    }

    return audioBuffer;
  } catch (error) {
    logger.error(
      { err: error, message: error.message },
      "Failed to synthesize speech"
    );
    throw new Error(`Text-to-Speech error: ${error.message}`);
  }
}

export { synthesizeSpeech };
