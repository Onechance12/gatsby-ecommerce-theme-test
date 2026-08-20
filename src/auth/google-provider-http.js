const GOOGLE_PROVIDER_ENDPOINTS = Object.freeze({
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  tokenInfo: "https://www.googleapis.com/oauth2/v2/tokeninfo",
  userInfo: "https://openidconnect.googleapis.com/v1/userinfo"
});

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_JSON_BYTES = 64 * 1024;

export { GOOGLE_PROVIDER_ENDPOINTS };

/**
 * Resolve a credential-bearing Google endpoint without permitting production
 * SSRF or credential exfiltration through environment configuration.
 *
 * Production accepts only the exact reviewed Google URL. Tests may opt into an
 * explicit 127.0.0.1 endpoint; hostnames and private-network addresses remain
 * rejected to avoid DNS rebinding and accidental fixture leakage.
 */
export function resolveGoogleProviderEndpoint(
  kind,
  configuredValue,
  { allowLoopbackForTests = false } = {}
) {
  const reviewed = GOOGLE_PROVIDER_ENDPOINTS[kind];
  if (!reviewed) {
    throw new TypeError(`Unknown Google provider endpoint kind: ${kind}`);
  }
  const candidate = String(configuredValue || reviewed).trim();
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError(`Google ${kind} endpoint must be an absolute URL`);
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.toString() !== candidate
  ) {
    throw new TypeError(`Google ${kind} endpoint must be a canonical URL`);
  }
  if (candidate === reviewed) return reviewed;
  if (
    allowLoopbackForTests === true &&
    parsed.hostname === "127.0.0.1" &&
    (parsed.protocol === "http:" || parsed.protocol === "https:")
  ) {
    return candidate;
  }
  throw new TypeError(
    `Google ${kind} endpoint must use the reviewed Google HTTPS URL`
  );
}

/**
 * Fetch a small JSON provider response with redirects disabled, a deadline,
 * and streaming byte enforcement. Error bodies are never returned or logged.
 */
export async function fetchBoundedProviderJson(
  fetchImpl,
  url,
  options = {},
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_JSON_BYTES
  } = {}
) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError("timeoutMs must be between 100 and 60000");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 1024 * 1024) {
    throw new TypeError("maxBytes must be between 256 and 1048576");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: controller.signal
    });
    if (!response || typeof response.ok !== "boolean") {
      throw new GoogleProviderHttpError("Google provider returned an invalid response");
    }
    const payload = await readBoundedJson(response, maxBytes);
    return Object.freeze({ response, payload });
  } catch (error) {
    if (error instanceof GoogleProviderHttpError) throw error;
    if (controller.signal.aborted) {
      throw new GoogleProviderHttpError("Google provider request timed out");
    }
    throw new GoogleProviderHttpError("Google provider request failed");
  } finally {
    clearTimeout(timer);
  }
}

export class GoogleProviderHttpError extends Error {
  constructor(message) {
    super(message);
    this.name = "GoogleProviderHttpError";
  }
}

async function readBoundedJson(response, maxBytes) {
  const contentType = String(response.headers?.get?.("content-type") || "")
    .toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new GoogleProviderHttpError(
      "Google provider returned an unexpected response format"
    );
  }

  const chunks = [];
  let total = 0;
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    throw new GoogleProviderHttpError("Google provider response body is unavailable");
  }
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new GoogleProviderHttpError(
          "Google provider response exceeded the allowed size"
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new GoogleProviderHttpError("Google provider returned invalid JSON");
  }
}
