import {
  createHash,
  timingSafeEqual
} from "node:crypto";

export const HCN_LOGIN_COOKIE_NAME = "__Host-hcn_login";
export const HCN_SESSION_COOKIE_NAME = "__Host-hcn_session";

const DEFAULT_MAX_COOKIE_HEADER_BYTES = 4096;
const DEFAULT_MAX_COOKIE_VALUE_BYTES = 2048;
const DEFAULT_MAX_COOKIE_COUNT = 50;
const DEFAULT_LOGIN_COOKIE_AGE_SECONDS = 10 * 60;
const DEFAULT_SESSION_COOKIE_AGE_SECONDS = 12 * 60 * 60;
const MAX_RETURN_TO_BYTES = 2048;
const MAX_CSRF_TOKEN_BYTES = 512;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE_PATTERN = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
const OPAQUE_COOKIE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ENCODED_BACKSLASH_OR_CONTROL =
  /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i;
const HCN_CSRF_CONTEXT = "hcn-console:csrf:v1";

/**
 * Parse a Cookie request header without accepting browser-ambiguous input.
 *
 * Duplicate names, invalid octets, quoted values, empty segments, and
 * oversized input are rejected. Returning a null-prototype object avoids
 * prototype-key surprises when callers look up a cookie by exact name.
 */
export function parseHcnCookieHeader(
  header,
  {
    maxHeaderBytes = DEFAULT_MAX_COOKIE_HEADER_BYTES,
    maxValueBytes = DEFAULT_MAX_COOKIE_VALUE_BYTES,
    maxCookies = DEFAULT_MAX_COOKIE_COUNT
  } = {}
) {
  assertPositiveInteger(maxHeaderBytes, "maxHeaderBytes");
  assertPositiveInteger(maxValueBytes, "maxValueBytes");
  assertPositiveInteger(maxCookies, "maxCookies");

  if (header === undefined || header === null || header === "") {
    return Object.freeze(Object.create(null));
  }
  if (typeof header !== "string") {
    throw httpError("Cookie header must be a single string");
  }
  if (Buffer.byteLength(header, "utf8") > maxHeaderBytes) {
    throw httpError("Cookie header exceeds the allowed size");
  }
  if (/[\u0000-\u001f\u007f-\uffff]/u.test(header)) {
    throw httpError("Cookie header contains invalid characters");
  }

  const segments = header.split(";");
  if (segments.length > maxCookies) {
    throw httpError("Cookie header contains too many cookies");
  }

  const cookies = Object.create(null);
  const seen = new Set();
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) {
      throw httpError("Cookie header contains an empty cookie");
    }
    const equalsAt = trimmed.indexOf("=");
    if (equalsAt <= 0) {
      throw httpError("Cookie header contains a malformed cookie");
    }

    const name = trimmed.slice(0, equalsAt);
    const value = trimmed.slice(equalsAt + 1);
    if (!COOKIE_NAME_PATTERN.test(name)) {
      throw httpError("Cookie header contains an invalid cookie name");
    }
    if (
      !COOKIE_VALUE_PATTERN.test(value) ||
      Buffer.byteLength(value, "utf8") > maxValueBytes
    ) {
      throw httpError("Cookie header contains an invalid cookie value");
    }
    if (seen.has(name)) {
      throw httpError("Cookie header contains a duplicate cookie name");
    }
    seen.add(name);
    cookies[name] = value;
  }
  return Object.freeze(cookies);
}

export function readHcnCookie(header, name, options) {
  if (typeof name !== "string" || !COOKIE_NAME_PATTERN.test(name)) {
    return null;
  }
  const cookies = parseHcnCookieHeader(header, options);
  return Object.prototype.hasOwnProperty.call(cookies, name)
    ? cookies[name]
    : null;
}

export function createHcnLoginCookie(
  value,
  { maxAgeSeconds = DEFAULT_LOGIN_COOKIE_AGE_SECONDS } = {}
) {
  return serializeHostCookie(
    HCN_LOGIN_COOKIE_NAME,
    value,
    maxAgeSeconds
  );
}

export function clearHcnLoginCookie() {
  return clearHostCookie(HCN_LOGIN_COOKIE_NAME);
}

export function createHcnSessionCookie(
  value,
  { maxAgeSeconds = DEFAULT_SESSION_COOKIE_AGE_SECONDS } = {}
) {
  return serializeHostCookie(
    HCN_SESSION_COOKIE_NAME,
    value,
    maxAgeSeconds
  );
}

export function clearHcnSessionCookie() {
  return clearHostCookie(HCN_SESSION_COOKIE_NAME);
}

/**
 * Return a validated same-origin console path.
 *
 * Only `/hcn`, descendants of `/hcn/`, and their query/fragment variants are
 * accepted. The exact string is returned so callers can preserve intended
 * in-console navigation without ever accepting a host or scheme.
 */
export function validateHcnReturnTo(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_RETURN_TO_BYTES
  ) {
    throw httpError("returnTo must be a bounded HCN console path");
  }
  if (
    /[\u0000-\u001f\u007f\\]/u.test(value) ||
    ENCODED_BACKSLASH_OR_CONTROL.test(value) ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    throw httpError("returnTo contains an unsafe path");
  }

  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw httpError("returnTo contains invalid percent encoding");
  }
  if (/[\u0000-\u001f\u007f\\]/u.test(decoded)) {
    throw httpError("returnTo contains an unsafe encoded path");
  }

  let parsed;
  try {
    parsed = new URL(value, "https://hcn-console.invalid");
  } catch {
    throw httpError("returnTo is not a valid path");
  }
  if (
    parsed.origin !== "https://hcn-console.invalid" ||
    !(parsed.pathname === "/hcn" || parsed.pathname.startsWith("/hcn/"))
  ) {
    throw httpError("returnTo must remain inside the HCN console");
  }
  return value;
}

/**
 * Validate an Origin header against a configured, canonical origin.
 *
 * This intentionally performs exact string equality. It does not accept
 * missing origins, `null`, trailing slashes, paths, alternate ports, or
 * equivalent-but-differently-serialized origins.
 */
export function validateExactHcnOrigin(originHeader, expectedOrigin) {
  if (
    typeof originHeader !== "string" ||
    typeof expectedOrigin !== "string" ||
    originHeader.length === 0 ||
    expectedOrigin.length === 0
  ) {
    return false;
  }
  if (
    Buffer.byteLength(originHeader, "utf8") > 512 ||
    Buffer.byteLength(expectedOrigin, "utf8") > 512
  ) {
    return false;
  }
  if (
    /[\u0000-\u0020\u007f,\u0080-\uffff]/u.test(originHeader) ||
    /[\u0000-\u0020\u007f,\u0080-\uffff]/u.test(expectedOrigin)
  ) {
    return false;
  }

  try {
    const parsed = new URL(expectedOrigin);
    if (
      parsed.origin !== expectedOrigin ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return originHeader === expectedOrigin;
}

/**
 * Constant-time comparison for the X-HCN-CSRF request header.
 *
 * Inputs are domain-separated and hashed to fixed-width buffers before
 * comparison, so differing token lengths do not bypass timingSafeEqual.
 */
export function validateHcnCsrfToken(providedToken, expectedToken) {
  const providedValid = isBoundedCsrfToken(providedToken);
  const expectedValid = isBoundedCsrfToken(expectedToken);
  const providedDigest = csrfDigest(providedValid ? providedToken : "");
  const expectedDigest = csrfDigest(expectedValid ? expectedToken : "\0");
  const equal = timingSafeEqual(providedDigest, expectedDigest);
  return providedValid && expectedValid && equal;
}

/**
 * Security headers for authenticated HCN console/API responses.
 *
 * `document: true` allows only same-origin console assets and fetches. The
 * default is appropriate for JSON and redirects and permits no active content.
 */
export function hcnNoStoreSecurityHeaders({ document = false } = {}) {
  if (typeof document !== "boolean") {
    throw new TypeError("document must be a boolean");
  }
  return Object.freeze({
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
    expires: "0",
    "content-security-policy": document
      ? "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; manifest-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'"
      : "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "origin-agent-cluster": "?1",
    "permissions-policy":
      "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  });
}

export class HcnConsoleHttpError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "HcnConsoleHttpError";
    this.statusCode = statusCode;
  }
}

function serializeHostCookie(name, value, maxAgeSeconds) {
  assertOpaqueCookieValue(value);
  assertNonNegativeInteger(maxAgeSeconds, "maxAgeSeconds");
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

function clearHostCookie(name) {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`;
}

function assertOpaqueCookieValue(value) {
  if (typeof value !== "string" || !OPAQUE_COOKIE_VALUE_PATTERN.test(value)) {
    throw httpError("Cookie value must be a 256-bit base64url identifier");
  }
}

function isBoundedCsrfToken(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_CSRF_TOKEN_BYTES &&
    !/[\u0000-\u001f\u007f-\uffff]/u.test(value)
  );
}

function csrfDigest(value) {
  return createHash("sha256")
    .update(HCN_CSRF_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest();
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function httpError(message) {
  return new HcnConsoleHttpError(message, 400);
}
