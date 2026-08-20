import { createHash } from "node:crypto";

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
      throw providerFailure(errorCode);
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw providerFailure(errorCode, Number(response.status) || 502);
    }
    const encoding = String(
      response.headers?.get?.("content-encoding") || "identity"
    ).trim().toLowerCase();
    if (encoding !== "identity") {
      await response.body?.cancel?.().catch(() => {});
      throw providerFailure(errorCode);
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
      throw providerFailure(errorCode);
    }
    return Object.freeze({
      bytes,
      contentLength: bytes.byteLength,
      contentSha256: createHash("sha256").update(bytes).digest("hex")
    });
  } catch (error) {
    if (error instanceof BoundedBinaryProviderError) throw error;
    if (controller.signal.aborted) {
      throw providerFailure(errorCode, 504);
    }
    throw providerFailure(errorCode);
  } finally {
    clearTimeout(timer);
  }
}

export class BoundedBinaryProviderError extends Error {
  constructor(code, statusCode = 502) {
    super("Provider request failed.");
    this.name = "BoundedBinaryProviderError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function advertisedContentLength(value, maxBytes, errorCode) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw providerFailure(errorCode);
  const length = Number(text);
  if (
    !Number.isSafeInteger(length)
    || length < 1
    || length > maxBytes
  ) {
    throw providerFailure(errorCode);
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
        throw providerFailure(errorCode);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function providerFailure(code, statusCode = 502) {
  return new BoundedBinaryProviderError(code, statusCode);
}
