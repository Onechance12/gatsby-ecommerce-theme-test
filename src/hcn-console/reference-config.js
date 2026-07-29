/**
 * Fail-closed HCN console opaque-reference configuration.
 *
 * The reference key is accepted only as canonical, unpadded base64url. Secret
 * bytes stay inside the reference factory closure and are never included in
 * readiness projections or errors.
 */

import { createHcnReferenceFactory } from "../hcn-ops/references.js";

const TENANT_ID_PATTERN = /^tenant_[a-f0-9]{16}$/;
const CANONICAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MIN_REFERENCE_KEY_BYTES = 32;
const MAX_REFERENCE_KEY_BYTES = 128;

const READY = Object.freeze({
  ready: true,
  status: "ready"
});

const UNAVAILABLE = Object.freeze({
  ready: false,
  status: "unavailable"
});

/**
 * Load the HCN-only reference configuration without exposing configuration
 * values. Missing or malformed values produce an unavailable configuration;
 * consumers must call requireFactory(), which fails with a safe 503 error.
 */
export function loadHcnConsoleReferenceConfiguration(
  environment = process.env
) {
  let referenceFactory = null;

  try {
    const tenantId = readEnvironmentValue(environment, "HCN_TENANT_ID");
    const encodedKey = readEnvironmentValue(environment, "HCN_REFERENCE_KEY");
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      return unavailableConfiguration();
    }

    const keyBytes = decodeCanonicalReferenceKey(encodedKey);
    if (!keyBytes) return unavailableConfiguration();

    try {
      referenceFactory = createHcnReferenceFactory({
        tenantId,
        hmacKey: keyBytes
      });
    } finally {
      keyBytes.fill(0);
    }
  } catch {
    return unavailableConfiguration();
  }

  return Object.freeze({
    ready: true,
    readiness: READY,
    requireFactory() {
      return referenceFactory;
    }
  });
}

/**
 * Return a privacy-safe descriptor suitable for health/readiness responses.
 */
export function projectHcnReferenceConfigurationReadiness(configuration) {
  return configuration?.ready === true ? READY : UNAVAILABLE;
}

export class HcnConsoleReferenceConfigurationError extends Error {
  constructor() {
    super("HCN reference configuration is unavailable.");
    this.name = "HcnConsoleReferenceConfigurationError";
    this.code = "hcn_reference_configuration_unavailable";
    this.statusCode = 503;
  }
}

function unavailableConfiguration() {
  return Object.freeze({
    ready: false,
    readiness: UNAVAILABLE,
    requireFactory() {
      throw new HcnConsoleReferenceConfigurationError();
    }
  });
}

function readEnvironmentValue(environment, key) {
  if (
    environment === null ||
    (typeof environment !== "object" && typeof environment !== "function")
  ) {
    return "";
  }
  const value = environment[key];
  return typeof value === "string" ? value : "";
}

function decodeCanonicalReferenceKey(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_BASE64URL_PATTERN.test(value)
  ) {
    return null;
  }

  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return null;
  }

  if (
    decoded.byteLength < MIN_REFERENCE_KEY_BYTES ||
    decoded.byteLength > MAX_REFERENCE_KEY_BYTES ||
    decoded.toString("base64url") !== value
  ) {
    decoded.fill(0);
    return null;
  }
  return decoded;
}
