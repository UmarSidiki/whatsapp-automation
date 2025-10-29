/* eslint-disable @typescript-eslint/no-explicit-any */

// Only import types for Node.js compatibility
import type { RequestInfo, RequestInit } from "node-fetch";

type FetchFn = (input: RequestInfo, init?: RequestInit) => Promise<any>;

const fetchFn: FetchFn = (globalThis as any).fetch
  ? (globalThis as any).fetch.bind(globalThis)
  : async (input: RequestInfo, init?: RequestInit) => {
      // dynamic import for node-fetch when running under Node that doesn't have global fetch
      const { default: fetch } = await import("node-fetch");
      return fetch(input, init) as Promise<any>;
    };

export async function safeJson(response: any | undefined | null): Promise<any | null> {
  try {
    if (!response) return null;
    return await response.clone().json();
  } catch {
    return null;
  }
}

export function createTimeoutSignal(ms?: number): any {
  // Use a default timeout if not provided
  const DEFAULT_TIMEOUT = 30000;
  const timeout = Number.isFinite(ms as number) && (ms as number) > 0 ? (ms as number) : DEFAULT_TIMEOUT;
  // Prefer AbortSignal.timeout when available
  if (typeof (globalThis as any).AbortSignal !== "undefined" && typeof (globalThis as any).AbortSignal.timeout === "function") {
    return (globalThis as any).AbortSignal.timeout(timeout);
  }
  if (typeof (globalThis as any).AbortController === "function") {
    const controller = new (globalThis as any).AbortController();
    const t = setTimeout(() => controller.abort(), timeout);
    // unref if available (Node.js)
    if (typeof (t as any).unref === "function") (t as any).unref();
    return controller.signal as AbortSignal;
  }
  return undefined;
}


export async function fetchJson(url: string, options: any = {}): Promise<any> {
  const response: any = await fetchFn(url, options);
  if (!response.ok) {
    const payload = await safeJson(response);
    // Use console.error instead of logger
    console.error({ status: response.status, body: payload }, "HTTP request failed");
    const error: any = new Error(`Request failed with status ${response.status}`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return response.json();
}

export { fetchFn };
