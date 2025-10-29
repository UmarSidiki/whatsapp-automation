"use strict";

import speech from "@google-cloud/speech";
import logger from "../../config/logger";

/**
 * Transcribe audio buffer to text using Google Speech-to-Text API
 * @param {Buffer} audioBuffer - Audio file buffer (OGG/OPUS from WhatsApp)
 * @param {string} apiKey - Google Cloud API key
 * @param {string} languageCode - Language code (e.g., 'en-US', 'es-ES')
 * @returns {Promise<string>} Transcribed text
 */
async function transcribeAudio(audioBuffer: Buffer, apiKey: string, languageCode = "en-US"): Promise<string> {
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

    // WhatsApp OGG/OPUS files typically use 48000Hz sample rate.
    // Try explicit sample rates starting with the most common.
    let response;
    let lastError;

    const sampleRatesToTry = [48000, 24000, 16000, 12000, 8000];
    logger.debug(
      {
        languageCode,
        audioSize: audioBuffer.length,
        sampleRatesToTry,
      },
      "Starting transcription with explicit OGG_OPUS sample rates..."
    );

    for (const rate of sampleRatesToTry) {
      try {
        const request = {
          audio: audio,
          config: {
            encoding: "OGG_OPUS" as const,
            languageCode: languageCode,
            enableAutomaticPunctuation: true,
            audioChannelCount: 1,
            sampleRateHertz: rate, // Explicitly set the rate
          },
        };

        logger.debug(`Attempting transcription at ${rate}Hz...`);
        const result = await client.recognize(request);
        response = result[0];

        // Check if we got a valid result
        if (
          response.results &&
          response.results.length > 0 &&
          response.results[0].alternatives &&
          response.results[0].alternatives.length > 0
        ) {
          logger.debug(`Transcription SUCCEEDED at ${rate}Hz.`);
          lastError = null; // Clear last error
          break; // Success! Exit the loop.
        } else {
          // It worked but gave no text. This rate is wrong.
          logger.warn(
            `Transcription at ${rate}Hz returned no results. Trying next rate.`
          );
          response = null; // Clear response to continue loop
          lastError = new Error(
            `Transcription at ${rate}Hz returned empty results.`
          );
        }
      } catch (error) {
        // This rate failed entirely (e.g., wrong sample rate error)
        logger.warn(
          { err: error, rate },
          `Transcription at ${rate}Hz FAILED. Trying next rate.`
        );
        lastError = error;
      }
    }

    // If still no response after all attempts, return empty
    if (!response) {
      logger.error(
        { err: lastError },
        "All OGG_OPUS explicit sample rate attempts failed. No valid transcription possible."
      );
      // Don't throw; let the caller handle empty transcription
      return "";
    }

    // Process the successful response
    if (!response.results || response.results.length === 0) {
      logger.warn(
        {
          languageCode,
          audioSize: audioBuffer.length,
          hasResults: false,
        },
        "No transcription results returned from Google Speech-to-Text"
      );
      return "";
    }

    // Check if any result has alternatives
    const validResults = response.results.filter(
      (result) => result.alternatives && result.alternatives.length > 0
    );

    if (validResults.length === 0) {
      logger.warn(
        {
          resultsCount: response.results.length,
          hasAlternatives: false,
        },
        "Speech-to-Text returned results but no alternatives"
      );
      return "";
    }

    const transcription = validResults
      .map((result) => result.alternatives[0].transcript)
      .filter((text) => text && text.trim())
      .join("\n");

    if (!transcription || !transcription.trim()) {
      logger.warn(
        {
          resultsCount: validResults.length,
          emptyTranscription: true,
        },
        "Speech-to-Text returned empty transcription"
      );
      return "";
    }

    logger.info(
      {
        transcriptionLength: transcription.length,
        resultsCount: validResults.length,
        preview: transcription.substring(0, 50),
      },
      "Audio transcription completed successfully"
    );

    return transcription.trim();
  } catch (error) {
    logger.error(
      { err: error, languageCode, audioSize: audioBuffer?.length },
      "Unexpected error in transcribeAudio"
    );
    // Re-throw for caller to handle, but wrap for context
    throw new Error(`Speech-to-Text error: ${error.message}`);
  }
}

export { transcribeAudio };