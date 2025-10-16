"use strict";

const textToSpeech = require("@google-cloud/text-to-speech");
const logger = require("../config/logger");

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
async function synthesizeSpeech(text, apiKey, options = {}) {
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
        ssmlGender: gender,
      },
      audioConfig: {
        audioEncoding: "OGG_OPUS", // WhatsApp compatible format
        speakingRate: 1.0,
        pitch: 0.0,
      },
    };

    logger.debug(
      { textLength: text.length, languageCode, gender },
      "Synthesizing speech with Google Text-to-Speech"
    );

    const [response] = await client.synthesizeSpeech(request);

    if (!response.audioContent) {
      throw new Error("No audio content returned from Text-to-Speech API");
    }

    logger.debug(
      { audioSize: response.audioContent.length },
      "Speech synthesis completed"
    );

    return Buffer.from(response.audioContent);
  } catch (error) {
    logger.error(
      { err: error, message: error.message },
      "Failed to synthesize speech"
    );
    throw new Error(`Text-to-Speech error: ${error.message}`);
  }
}

module.exports = {
  synthesizeSpeech,
};
