"use strict";

const speech = require("@google-cloud/speech");
const logger = require("../config/logger");

/**
 * Transcribe audio buffer to text using Google Speech-to-Text API
 * @param {Buffer} audioBuffer - Audio file buffer (OGG/OPUS from WhatsApp)
 * @param {string} apiKey - Google Cloud API key
 * @param {string} languageCode - Language code (e.g., 'en-US', 'es-ES')
 * @returns {Promise<string>} Transcribed text
 */
async function transcribeAudio(audioBuffer, apiKey, languageCode = "en-US") {
  if (!audioBuffer || !apiKey) {
    throw new Error("Audio buffer and API key are required");
  }

  try {
    // Create client with API key
    const client = new speech.SpeechClient({
      apiKey: apiKey,
    });

    const audio = {
      content: audioBuffer.toString("base64"),
    };

    const config = {
      encoding: "OGG_OPUS", // WhatsApp uses OGG/OPUS format
      sampleRateHertz: 16000,
      languageCode: languageCode,
      enableAutomaticPunctuation: true,
      model: "default", // or 'phone_call' for better voice quality
    };

    const request = {
      audio: audio,
      config: config,
    };

    logger.debug({ languageCode }, "Transcribing audio with Google Speech-to-Text");

    const [response] = await client.recognize(request);
    
    if (!response.results || response.results.length === 0) {
      logger.warn("No transcription results returned from Google Speech-to-Text");
      return "";
    }

    const transcription = response.results
      .map((result) => result.alternatives[0].transcript)
      .join("\n");

    logger.debug(
      { transcriptionLength: transcription.length },
      "Audio transcription completed"
    );

    return transcription.trim();
  } catch (error) {
    logger.error(
      { err: error, message: error.message },
      "Failed to transcribe audio"
    );
    throw new Error(`Speech-to-Text error: ${error.message}`);
  }
}

module.exports = {
  transcribeAudio,
};
