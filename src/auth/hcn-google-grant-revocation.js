const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Revoke one HCN employee refresh grant at Google's pinned revocation
 * endpoint. The caller must not tombstone its encrypted local copy unless
 * this function returns a terminal result.
 */
export async function revokeHcnGoogleRefreshGrant({
  fetchImpl,
  endpoint,
  refreshToken,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  const url = canonicalEndpoint(endpoint);
  const token = boundedToken(refreshToken);
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 100
    || timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(
      "timeoutMs must be between 100 and 60000"
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ token }),
      redirect: "error",
      signal: controller.signal
    });
  } catch {
    throw revocationError(
      controller.signal.aborted
        ? "Google grant revocation timed out."
        : "Google grant revocation is unavailable."
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response || typeof response.status !== "number") {
    throw revocationError(
      "Google grant revocation returned an invalid response."
    );
  }
  if (response.ok) {
    await cancelBody(response);
    return Object.freeze({
      provider: "google",
      status: "revoked"
    });
  }
  if (response.status === 400) {
    const error = await readBoundedError(response);
    if (error === "invalid_token") {
      return Object.freeze({
        provider: "google",
        status: "already_invalid"
      });
    }
  }
  await cancelBody(response);
  throw revocationError(
    "Google did not confirm grant revocation."
  );
}

export class HcnGoogleGrantRevocationError extends Error {
  constructor(message) {
    super(message);
    this.name = "HcnGoogleGrantRevocationError";
    this.code = "google_grant_revocation_failed";
    this.statusCode = 503;
  }
}

function canonicalEndpoint(value) {
  if (typeof value !== "string" || !value) {
    throw new TypeError("endpoint is required");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("endpoint must be an absolute URL");
  }
  if (
    url.toString() !== value
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new TypeError("endpoint must be canonical");
  }
  return value;
}

function boundedToken(value) {
  if (
    typeof value !== "string"
    || !TOKEN_PATTERN.test(value)
    || Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES
  ) {
    throw new TypeError("refreshToken is invalid");
  }
  return value;
}

async function readBoundedError(response) {
  const contentType = String(
    response.headers?.get?.("content-type") || ""
  ).toLowerCase();
  if (!contentType.includes("application/json")) {
    await cancelBody(response);
    return "";
  }
  const reader = response.body?.getReader?.();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return "";
      }
      chunks.push(chunk);
    }
  } catch {
    return "";
  } finally {
    reader.releaseLock();
  }
  try {
    const payload = JSON.parse(
      Buffer.concat(chunks, total).toString("utf8")
    );
    return (
      payload
      && typeof payload === "object"
      && !Array.isArray(payload)
      && typeof payload.error === "string"
    )
      ? payload.error
      : "";
  } catch {
    return "";
  }
}

async function cancelBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // Response bodies never carry authority or user-facing detail.
  }
}

function revocationError(message) {
  return new HcnGoogleGrantRevocationError(message);
}
