import { createHash } from "node:crypto";

/** One authenticated JobNimbus download followed by, at most, its fixed CDN. */
export async function fetchJobNimbusBinary(
  fetchImpl,
  url,
  options = {},
  { consumeRequest, testInitialOrigin, ...limits } = {}
) {
  const errorCode = limits.errorCode || "PROVIDER_BINARY_REQUEST_FAILED";
  if (typeof consumeRequest !== "function") {
    throw new TypeError("JobNimbus downloads require a request budget callback");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  validateJobNimbusInitialUrl(url, testInitialOrigin, errorCode);
  const consume = () => {
    try { consumeRequest(); } catch {
      throw providerFailure(errorCode, 503, "request_budget_exceeded");
    }
  };
  return fetchBoundedBinary(async (initialUrl, initialOptions) => {
    consume();
    const response = await fetchImpl(initialUrl, {
      ...initialOptions,
      credentials: "omit",
      redirect: "manual"
    });
    if (!response || ![302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    let target;
    try {
      const location = response.headers?.get?.("location");
      target = exactHttpsUrl(location, "files.jobnimbus.com", errorCode);
    } finally {
      await response.body?.cancel?.().catch(() => {});
    }
    if (initialOptions.signal.aborted) {
      throw providerFailure(errorCode, 504, "deadline_exceeded");
    }
    consume();
    // Only binary negotiation survives the CDN hop. Never forward bearer,
    // cookie, custom auth, referrer, or other initial request options.
    const downloaded = await fetchImpl(target.href, {
      method: "GET",
      headers: new Headers({
        accept: "application/octet-stream",
        "accept-encoding": "identity"
      }),
      credentials: "omit",
      redirect: "error",
      signal: initialOptions.signal
    });
    if (downloaded?.status >= 300 && downloaded.status < 400) {
      await downloaded.body?.cancel?.().catch(() => {});
      throw providerFailure(errorCode, 502, "redirect_limit");
    }
    return downloaded;
  }, url, options, limits);
}

function exactHttpsUrl(value, host, errorCode) {
  if (
    typeof value !== "string"
    || /[\x00-\x20\x7f\\#]/.test(value)
    || !new RegExp(`^https://${host.replaceAll(".", "\\.")}(?::443)?(?:/|\\?|$)`, "i").test(value)
  ) throw providerFailure(errorCode, 502, "redirect_target_rejected");
  let parsed;
  try { parsed = new URL(value); } catch {
    throw providerFailure(errorCode, 502, "redirect_target_rejected");
  }
  if (parsed.origin !== `https://${host}` || parsed.username || parsed.password || parsed.hash) {
    throw providerFailure(errorCode, 502, "redirect_target_rejected");
  }
  return parsed;
}

function validateJobNimbusInitialUrl(value, testInitialOrigin, errorCode) {
  let parsed;
  try {
    if (testInitialOrigin !== undefined) {
      if (process.env.NODE_ENV !== "test" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(testInitialOrigin)) throw new Error();
      const origin = new URL(testInitialOrigin);
      parsed = new URL(value);
      if (origin.origin !== testInitialOrigin || parsed.origin !== origin.origin
        || /[\x00-\x20\x7f\\#@]/.test(value)) throw new Error();
    } else {
      parsed = exactHttpsUrl(value, "app.jobnimbus.com", errorCode);
    }
    if (parsed.search || parsed.username || parsed.password || parsed.hash
      || !(testInitialOrigin === undefined ? /^\/(?:api1\/)?files\/[^/]+$/ : /^\/download\/[^/]+$/).test(parsed.pathname)) throw new Error();
  } catch {
    throw providerFailure(errorCode, 502, "initial_target_rejected");
  }
}

/**
 * Fetch provider bytes with redirects disabled, a body-inclusive deadline,
 * identity encoding, and both advertised and streaming byte bounds.
 */
export async function fetchBoundedBinary(
  fetchImpl,
  url,
  options = {},
  {
    timeoutMs = 30_000,
    maxBytes = 25 * 1024 * 1024,
    errorCode = "PROVIDER_BINARY_REQUEST_FAILED"
  } = {}
) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 100
    || timeoutMs > 120_000
  ) {
    throw new TypeError("timeoutMs must be between 100 and 120000");
  }
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes < 256
    || maxBytes > 32 * 1024 * 1024
  ) {
    throw new TypeError("maxBytes must be between 256 and 33554432");
  }
  if (
    typeof errorCode !== "string"
    || !/^[A-Z][A-Z0-9_]{2,63}$/.test(errorCode)
  ) {
    throw new TypeError("errorCode must be a safe uppercase code");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestHeaders = new Headers(options.headers || {});
    requestHeaders.set("accept", "application/octet-stream");
    requestHeaders.set("accept-encoding", "identity");
    const response = await fetchImpl(url, {
      ...options,
      method: "GET",
      headers: requestHeaders,
      redirect: "error",
      signal: controller.signal
    });
    if (!response || typeof response.ok !== "boolean") {
      throw providerFailure(errorCode, 502, "invalid_response");
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw providerFailure(errorCode, Number(response.status) || 502, "upstream_http");
    }
    const encoding = String(
      response.headers?.get?.("content-encoding") || "identity"
    ).trim().toLowerCase();
    if (encoding !== "identity") {
      await response.body?.cancel?.().catch(() => {});
      throw providerFailure(errorCode, 502, "encoding_rejected");
    }
    let advertisedLength;
    try {
      advertisedLength = advertisedContentLength(
        response.headers?.get?.("content-length"),
        maxBytes,
        errorCode
      );
    } catch (error) {
      await response.body?.cancel?.().catch(() => {});
      throw error;
    }
    const bytes = await readBoundedBinary(response, maxBytes, errorCode);
    if (
      bytes.byteLength === 0
      || (advertisedLength !== null && bytes.byteLength !== advertisedLength)
    ) {
      throw providerFailure(errorCode, 502, "length_invalid");
    }
    return Object.freeze({
      bytes,
      contentLength: bytes.byteLength,
      contentSha256: createHash("sha256").update(bytes).digest("hex")
    });
  } catch (error) {
    if (error instanceof BoundedBinaryProviderError) throw error;
    if (controller.signal.aborted) {
      throw providerFailure(errorCode, 504, "deadline_exceeded");
    }
    throw providerFailure(errorCode);
  } finally {
    clearTimeout(timer);
  }
}

export class BoundedBinaryProviderError extends Error {
  constructor(code, statusCode = 502, failureReason = "network_failed") {
    super("Provider request failed.");
    this.name = "BoundedBinaryProviderError";
    this.code = code;
    this.statusCode = statusCode;
    this.failureReason = failureReason;
  }
}

function advertisedContentLength(value, maxBytes, errorCode) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw providerFailure(errorCode, 502, "length_invalid");
  const length = Number(text);
  if (
    !Number.isSafeInteger(length)
    || length < 1
    || length > maxBytes
  ) {
    throw providerFailure(errorCode, 502, "length_invalid");
  }
  return length;
}

async function readBoundedBinary(response, maxBytes, errorCode) {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    throw providerFailure(errorCode);
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw providerFailure(errorCode, 502, "byte_limit");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function providerFailure(code, statusCode = 502, failureReason = "network_failed") {
  return new BoundedBinaryProviderError(code, statusCode, failureReason);
}
