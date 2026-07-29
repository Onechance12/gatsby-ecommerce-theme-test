/**
 * Fetch a provider JSON response with redirects disabled, a deadline, and a
 * streaming byte limit. Provider response bodies never enter error messages.
 */
export async function fetchBoundedJson(
  fetchImpl,
  url,
  options = {},
  {
    timeoutMs = 15_000,
    maxBytes = 2 * 1024 * 1024,
    errorCode = "PROVIDER_REQUEST_FAILED"
  } = {}
) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 100
    || timeoutMs > 60_000
  ) {
    throw new TypeError("timeoutMs must be between 100 and 60000");
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
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
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
    const contentType = String(
      response.headers?.get?.("content-type") || ""
    ).toLowerCase();
    if (!contentType.includes("application/json")) {
      await response.body?.cancel?.().catch(() => {});
      throw providerFailure(errorCode);
    }
    return await readBoundedJson(response, maxBytes, errorCode);
  } catch (error) {
    if (error instanceof BoundedJsonProviderError) throw error;
    if (controller.signal.aborted) {
      throw providerFailure(errorCode, 504);
    }
    throw providerFailure(errorCode);
  } finally {
    clearTimeout(timer);
  }
}

export class BoundedJsonProviderError extends Error {
  constructor(code, statusCode = 502) {
    super("Provider request failed.");
    this.name = "BoundedJsonProviderError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function readBoundedJson(response, maxBytes, errorCode) {
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
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw providerFailure(errorCode, 502);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw providerFailure(errorCode);
  }
  if (
    parsed === null
    || (typeof parsed !== "object" && !Array.isArray(parsed))
  ) {
    throw providerFailure(errorCode);
  }
  return parsed;
}

function providerFailure(code, statusCode = 502) {
  return new BoundedJsonProviderError(code, statusCode);
}
