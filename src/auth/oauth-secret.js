import {
  createHmac,
  timingSafeEqual
} from "node:crypto";

const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 1024;
const PURPOSE_PATTERN = /^[a-z][a-z0-9._:-]{2,127}$/;
const DERIVATION_CONTEXT = "wave-bridge:oauth-key-derivation:v1";

/**
 * Validate the root OAuth secret without printing or serializing it.
 *
 * The value is an encoded secret string. Deployments should generate at least
 * 32 random bytes and store the base64url result in Render. Existing printable
 * encodings remain supported as long as they meet the byte and character
 * bounds.
 */
export function assertStrongOAuthSessionSecret(
  value,
  { required = true } = {}
) {
  if (typeof required !== "boolean") {
    throw new TypeError("required must be a boolean");
  }
  if (value === undefined || value === null || value === "") {
    if (!required) return "";
    throw new Error("OAUTH_SESSION_SECRET is required");
  }
  if (typeof value !== "string") {
    throw new Error("OAUTH_SESSION_SECRET must be a string");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    bytes < MIN_SECRET_BYTES ||
    bytes > MAX_SECRET_BYTES ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f-\uffff]/u.test(value)
  ) {
    throw new Error(
      `OAUTH_SESSION_SECRET must be ${MIN_SECRET_BYTES}-${MAX_SECRET_BYTES} bytes of printable non-space ASCII`
    );
  }
  return value;
}

/**
 * Derive a purpose-separated 256-bit key from the validated root secret.
 */
export function deriveOAuthPurposeKey(secret, purpose) {
  const root = assertStrongOAuthSessionSecret(secret);
  if (
    typeof purpose !== "string" ||
    !PURPOSE_PATTERN.test(purpose)
  ) {
    throw new TypeError("OAuth key purpose is invalid");
  }
  return createHmac("sha256", root)
    .update(DERIVATION_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(purpose, "utf8")
    .digest();
}

export function oauthSecretsEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftDigest = createHmac("sha256", DERIVATION_CONTEXT)
    .update(left, "utf8")
    .digest();
  const rightDigest = createHmac("sha256", DERIVATION_CONTEXT)
    .update(right, "utf8")
    .digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
