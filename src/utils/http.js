"use strict";

const env = require("../config/env");
const logger = require("../config/logger");

const fetchFn = global.fetch
  ? global.fetch.bind(global)
  : async (...args) => {
      const { default: fetch } = await import("node-fetch");
      return fetch(...args);
    };

async function safeJson(response) {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

function createTimeoutSignal(ms) {
  const timeout = Number.isFinite(ms) && ms > 0 ? ms : env.AI_TIMEOUT_MS;
  if (
    typeof globalThis.AbortSignal !== "undefined" &&
    typeof globalThis.AbortSignal.timeout === "function"
  ) {
    return globalThis.AbortSignal.timeout(timeout);
  }
  if (typeof globalThis.AbortController === "function") {
    const controller = new globalThis.AbortController();
    setTimeout(() => controller.abort(), timeout).unref?.();
    return controller.signal;
  }
  return undefined;
}

async function fetchJson(url, options = {}) {
  const response = await fetchFn(url, options);
  if (!response.ok) {
    const payload = await safeJson(response);
    logger.error({ status: response.status, body: payload }, "HTTP request failed");
    const error = new Error(`Request failed with status ${response.status}`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return response.json();
}

module.exports = {
  fetchFn,
  fetchJson,
  safeJson,
  createTimeoutSignal,
};
