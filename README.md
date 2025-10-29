# WhatsApp Automation

Production-ready WhatsApp auto-responder powered by Google's Gemini API.

## Features

- Modular service architecture under `src/` (config, middleware, controllers, routes, services, utils)
- Secure multi-session management gated by rotating auth codes
- Configurable Gemini model, API key, and optional system prompt per session
- **Personal chat only**: Automatically ignores group messages and status updates
- Toggleable auto replies with per-session context windows (10-100 messages retained)
- Conversation memory for the last N user/assistant messages to improve AI relevance
- **AI Persona Learning**: Automatically learns your typing style from chat history
  - Uses contact-specific persona for chats with 250+ messages
    - Learns from conversation pairs (user message → your reply) to understand context
    - Sees how you respond to different types of messages
  - Falls back to universal persona for new conversations (your replies only)
  - Number of examples used matches your context window setting (10-1000 messages)
  - Intelligently filters out AI-generated messages to learn only from your actual writing
  - Mimics your tone, sentence structure, punctuation, emojis, vocabulary, and contextual adaptation
- **Voice message support with Google Speech-to-Text and Text-to-Speech APIs**
- Custom keyword, prefix, or regex replies that trigger before AI hand-off
- Bulk messaging console with CSV import and delivery reporting
- Scheduled messaging queue with cancel support for time-based campaigns
- Rate limiting, Helmet hardening, compression, and centralized logging
- 24-hour per-chat opt-out via `!stop` command
- 24-hour re-enable via `!start` command
- Graceful shutdown with automatic WhatsApp client teardown
- Health endpoint (`/health`) and structured logs for observability
- Memory management with automatic pruning for 1GB RAM environments

## Requirements

- Node.js 18.17 or newer (for native `fetch` and `AbortSignal.timeout` support)
- Google Gemini API key (for AI text responses)
- **Google Cloud Speech-to-Text API key** (optional, for voice message transcription)
- **Google Cloud Text-to-Speech API key** (optional, for voice message replies)
- Chrome-compatible environment for Puppeteer (required by `whatsapp-web.js`)
- MongoDB instance (for session persistence, AI config, and scheduled jobs)

## Getting Started

1. Install dependencies:
   ```powershell
   npm install
   ```
2. Copy `.env.example` to `.env` and adjust values. At minimum set:
   - `AUTH_CODES` (comma-separated) for login access
   - `NODE_ENV`, `PORT`, `LOG_LEVEL` as needed
   - Optional resource tuning flags:
     - `ENABLE_COMPRESSION` (`true`/`false`, default auto-enables in production)
     - `ENABLE_REQUEST_LOGGER` (`true`/`false`, default off in production)
     - `AUTO_RESTORE_SESSIONS` (`true`/`false`, default `true`)
     - `SESSION_RESTORE_THROTTLE_MS` (delay between session restores, default `1000`)
3. Run lint checks (optional but recommended before commits):
   ```powershell
   npm run lint
   ```
4. Run in development (includes auto-reload and pretty logs):
   ```powershell
   npm run dev
   ```
5. Launch the production server:
   ```powershell
   npm run start
   ```

The frontend is served from `frontend/` and provides a basic control panel for QR login and AI configuration.

### Project layout

```
src/
   bootstrap/         # Startup, shutdown, and session restoration helpers
  app.js              # Express app factory
  index.js            # Process bootstrap & graceful shutdown
  config/             # Environment + logger setup
  controllers/        # Route handlers (auth, AI config, health, QR)
  middleware/         # Logging, errors, rate limiting
  routes/             # Route registration modules
  services/           # WhatsApp session + Gemini integrations
  utils/              # Shared helpers (HTTP fetch wrapper)
  validation/         # Zod schemas
frontend/             # Static control panel
codes/                # Optional codes.json store
```

## Deployment Notes

- Deploy behind HTTPS and supply a persistent data directory so `LocalAuth` can reuse QR sessions.
- Keep `codes/codes.json` out of version control or override with the `AUTH_CODES` environment variable.
- Add process supervision (PM2, systemd, Docker, etc.) for automatic restarts.
- Tune rate limits (`RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`) to match expected traffic.
- Monitor logs and the `/health` endpoint to detect failures early.

## Frontend Usage

1. Enter a valid auth code to request a QR code.
2. Scan the QR using the paired WhatsApp account. Once connected, configure the Gemini API key, model, and optional system prompt—these settings are persisted in MongoDB for the session.
3. Toggle auto replies, adjust the context window, and manage custom replies directly in the console—saved rules persist in MongoDB and carry across restarts.
4. **Navigate to the Utils tab to enable voice message support:**
   - Toggle "Enable voice message replies"
   - Enter your Google Cloud Speech-to-Text API key (for transcribing incoming voice notes)
   - Enter your Google Cloud Text-to-Speech API key (for generating voice responses)
   - Select the desired language and voice gender
   - Click "Save voice configuration"
   - When enabled, the bot will automatically transcribe voice messages and reply with voice messages
5. **Navigate to the Persona Manager tab to inspect and manage AI learning data:**
   - View all contacts with saved persona data
   - Search contacts by phone number
   - View universal persona (used for new chats)
   - View contact-specific personas (used for established chats with 250+ messages)
   - See statistics: total messages, user messages, your replies, AI replies
   - Edit or delete individual messages from any persona
   - Filter to show only "My reply:" messages used for learning
6. Paste or upload recipients to broadcast bulk messages—results show successes and failures.
7. Schedule messages in advance; monitor, cancel, or remove jobs from the schedule table. Scheduled runs survive restarts and resume automatically once the service is back online.
8. Users can send `!stop` in the chat to disable automated replies for 24 hours, or `!start` to re-enable them early.
   - **Note:** `!stop` disables **both text and voice** auto-replies. The bot will not process any messages (including voice transcription) from stopped users to save API costs.
   - Users must send `!start` as a **text message** to re-enable auto-replies.

### API additions

- `GET /ai/:code` – Retrieve the sanitized AI configuration for a session (includes voice settings).
- `POST /ai/:code` – Update API key, model, auto-reply toggle, context window, custom replies, and voice settings.
- `POST /messages/:code/bulk` – Send an immediate broadcast to multiple numbers.
- `GET /messages/:code/schedule` – List upcoming scheduled jobs and historical results.
- `POST /messages/:code/schedule` – Schedule a delayed broadcast.
- `DELETE /messages/:code/schedule/:jobId` – Cancel a pending scheduled job (`?mode=remove` to delete the record entirely).
- `GET /persona/:code/contacts` – List all contacts with persona data.
- `GET /persona/:code/contact/:contactId` – Get persona messages for a specific contact.
- `GET /persona/:code/universal` – Get universal persona messages.
- `PUT /persona/:code/contact/:contactId/message/:messageIndex` – Update a message in contact persona.
- `PUT /persona/:code/universal/message/:messageIndex` – Update a message in universal persona.
- `DELETE /persona/:code/contact/:contactId/message/:messageIndex` – Delete a message from contact persona.
- `DELETE /persona/:code/universal/message/:messageIndex` – Delete a message from universal persona.

## Voice Message Configuration

The bot supports automatic transcription of incoming voice notes and can reply with AI-generated voice messages using Google Cloud APIs.

### Setup Steps

1. **Create Google Cloud Project:**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select an existing one
   - Enable billing for the project

2. **Enable Required APIs:**
   - Enable [Speech-to-Text API](https://console.cloud.google.com/apis/library/speech.googleapis.com)
   - Enable [Text-to-Speech API](https://console.cloud.google.com/apis/library/texttospeech.googleapis.com)

3. **Generate API Keys:**
   - Go to "APIs & Services" → "Credentials"
   - Click "Create Credentials" → "API Key"
   - Create two separate API keys (or use the same key for both):
     - One for Speech-to-Text
     - One for Text-to-Speech
   - Optionally restrict the keys to only the necessary APIs

4. **Configure in Frontend:**
   - Navigate to the "Utils" tab
   - Enable "Voice message replies"
   - Paste your API keys
   - Select language (e.g., en-US, es-ES, fr-FR)
   - Select voice gender (Neutral, Male, or Female)
   - Click "Save voice configuration"

### How It Works

- When a user sends a voice note, the bot:
  1. Downloads the audio file (OGG/OPUS format from WhatsApp)
  2. Transcribes it using Google Speech-to-Text API
  3. Processes the transcribed text through the AI (Gemini)
  4. Converts the AI response to speech using Google Text-to-Speech API
  5. Sends the audio back as a voice message

- Voice settings are persisted in MongoDB and automatically restored on session reconnect
- If voice processing fails, the bot logs the error and skips the message
- Text messages continue to work normally alongside voice message support

### Supported Languages

The voice feature supports 20+ languages including:
- English (US/UK)
- Spanish (Spain/US)
- French, German, Italian
- Portuguese (Brazil/Portugal)
- Japanese, Korean, Chinese (Simplified/Traditional)
- Arabic, Hindi, Russian, Turkish, Polish, Dutch, Swedish

### Cost Considerations

- Google Cloud charges per request:
  - Speech-to-Text: ~$0.006 per 15 seconds of audio
  - Text-to-Speech: ~$4.00 per 1 million characters
- Monitor usage in Google Cloud Console
- Set up billing alerts to avoid unexpected charges
- Consider implementing rate limits for voice messages if needed

## Troubleshooting

- If QR codes stop refreshing, delete the `.wwebjs_auth` folder for the affected code and restart the service.
- Gemini API errors will be logged with HTTP status. Verify API key, model name, and rate limits.
- Use `LOG_LEVEL=debug` for verbose output during incident response.
