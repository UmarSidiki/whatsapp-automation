import logger from "../../config/logger";
import { fetchFn } from "../../utils/http";

const AUTH_CODES_URL =
  "https://cdn.jsdelivr.net/gh/UmarSidiki/Multi-Tool@refs/heads/master/wp-ai-codes.json";
const AUTH_CODES_REFRESH_MS = 5 * 60 * 1000;

let cachedAuthCodes = [];
let authCodesFetchedAt = 0;
let authCodesPromise = null;

async function fetchAuthCodesFromSource() {
  const response = await fetchFn(AUTH_CODES_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const error = new Error(
      `Auth code source responded with ${response.status}`
    );
    (error as Error & { statusCode: number }).statusCode = response.status;
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  const list = Array.isArray(payload?.secret_code) ? payload.secret_code : [];

  const normalized = list
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  cachedAuthCodes = normalized;
  authCodesFetchedAt = Date.now();

  if (!normalized.length) {
    logger.warn(
      { source: AUTH_CODES_URL },
      "Auth code source returned no codes"
    );
  }

  return cachedAuthCodes;
}

async function loadAuthCodes({ force = false } = {}) {
  const isCacheFresh =
    !force &&
    cachedAuthCodes.length &&
    Date.now() - authCodesFetchedAt < AUTH_CODES_REFRESH_MS;

  if (isCacheFresh) {
    return cachedAuthCodes;
  }

  if (!authCodesPromise) {
    authCodesPromise = fetchAuthCodesFromSource()
      .catch((error) => {
        logger.error(
          { err: error, source: AUTH_CODES_URL },
          "Failed to load auth codes from CDN"
        );
        if (!cachedAuthCodes.length) {
          authCodesFetchedAt = 0;
        }
        return cachedAuthCodes;
      })
      .finally(() => {
        authCodesPromise = null;
      });
  }

  return authCodesPromise;
}

loadAuthCodes().catch(() => {
  /* Initialization errors already logged */
});

async function isAuthorized(code) {
  const trimmed = typeof code === "string" ? code.trim() : "";
  if (!trimmed) {
    return false;
  }
  const codes = await loadAuthCodes();
  return codes.includes(trimmed);
}

export {
  isAuthorized,
  loadAuthCodes,
};