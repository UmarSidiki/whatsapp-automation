# WhatsApp Automation

Production-ready WhatsApp auto-responder powered by Google's Gemini API.

## Features

- Modular service architecture under `src/` (config, middleware, controllers, routes, services, utils)
- Secure multi-session management gated by rotating auth codes
- Configurable Gemini model, API key, and optional system prompt per session
- Toggleable auto replies with per-session context windows (10-100 messages retained)
- Conversation memory for the last N user/assistant messages to improve AI relevance
- Custom keyword, prefix, or regex replies that trigger before AI hand-off
- Bulk messaging console with CSV import and delivery reporting
- Scheduled messaging queue with cancel support for time-based campaigns
- Rate limiting, Helmet hardening, compression, and centralized logging
- 24-hour per-chat opt-out via `!stopauto`
- Graceful shutdown with automatic WhatsApp client teardown
- Health endpoint (`/health`) and structured logs for observability

## Requirements

- Node.js 18.17 or newer (for native `fetch` and `AbortSignal.timeout` support)
- Google Gemini API key
- Chrome-compatible environment for Puppeteer (required by `whatsapp-web.js`)

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
4. Paste or upload recipients to broadcast bulk messages—results show successes and failures.
5. Schedule messages in advance; monitor, cancel, or remove jobs from the schedule table. Scheduled runs survive restarts and resume automatically once the service is back online.
6. Users can send `!stopauto` in the chat to disable automated replies for 24 hours.

### API additions

- `GET /ai/:code` – Retrieve the sanitized AI configuration for a session.
- `POST /ai/:code` – Update API key, model, auto-reply toggle, context window, and custom replies.
- `POST /messages/:code/bulk` – Send an immediate broadcast to multiple numbers.
- `GET /messages/:code/schedule` – List upcoming scheduled jobs and historical results.
- `POST /messages/:code/schedule` – Schedule a delayed broadcast.
- `DELETE /messages/:code/schedule/:jobId` – Cancel a pending scheduled job (`?mode=remove` to delete the record entirely).

## Troubleshooting

- If QR codes stop refreshing, delete the `.wwebjs_auth` folder for the affected code and restart the service.
- Gemini API errors will be logged with HTTP status. Verify API key, model name, and rate limits.
- Use `LOG_LEVEL=debug` for verbose output during incident response.
