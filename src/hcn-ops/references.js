/**
 * Opaque reference generation for HCN Operations v2.
 *
 * Stable references are derived with an injected, HCN-specific HMAC key.
 * Provider record identifiers never appear in an emitted reference. Ephemeral
 * identifiers use Node's cryptographically secure random source by default.
 *
 * This module deliberately does not inspect the environment or load secrets.
 * Credential retrieval and lifecycle remain the caller's responsibility.
 */

import {
  createHmac,
  randomBytes as cryptographicRandomBytes
} from "node:crypto";

import { HCN_SOURCE_SYSTEMS } from "./contracts.js";

const TENANT_ID_PATTERN = /^tenant_[a-f0-9]{16}$/;
const MIN_HMAC_KEY_BYTES = 32;
const MAX_PROVIDER_RECORD_ID_BYTES = 1024;
const RANDOM_REFERENCE_BYTES = 16;
const RANDOM_TENANT_BYTES = 8;
const REFERENCE_CONTEXT = "hcn-operations:opaque-reference:v2";
const ALLOWED_SOURCE_SYSTEMS = new Set(HCN_SOURCE_SYSTEMS);

const STABLE_REFERENCE_DOMAINS = Object.freeze({
  subjectId: Object.freeze({
    domain: "subject-id",
    prefix: "subject_"
  }),
  sourceRecordRef: Object.freeze({
    domain: "source-record-ref",
    prefix: "ref_"
  })
});

const RANDOM_REFERENCE_PREFIXES = Object.freeze({
  observationId: "obs_",
  workItemId: "work_",
  evaluationId: "eval_",
  requestId: "request_",
  traceId: "trace_"
});

/**
 * Creates a tenant-scoped opaque-reference factory.
 *
 * @param {object} options
 * @param {Buffer|Uint8Array} options.hmacKey HCN-only key material (>=32 bytes)
 * @param {string} options.tenantId Exact opaque HCN tenant identifier
 * @param {(size: number) => Buffer|Uint8Array} [options.randomBytes]
 */
export function createHcnReferenceFactory({
  hmacKey,
  tenantId,
  randomBytes = cryptographicRandomBytes
} = {}) {
  const privateKey = copyAndValidateHmacKey(hmacKey);
  assertTenantId(tenantId);
  assertRandomBytesFunction(randomBytes);

  const stableReference = (kind, sourceSystem, providerRecordId) => {
    assertSourceSystem(sourceSystem);
    assertProviderRecordId(providerRecordId);
    const descriptor = STABLE_REFERENCE_DOMAINS[kind];
    const digest = createHmac("sha256", privateKey);
    [
      REFERENCE_CONTEXT,
      descriptor.domain,
      tenantId,
      sourceSystem,
      providerRecordId
    ].forEach((component) => updateLengthPrefixed(digest, component));
    return `${descriptor.prefix}${digest.digest("hex").slice(0, 32)}`;
  };

  const randomReference = (kind) => {
    const bytes = readExactRandomBytes(randomBytes, RANDOM_REFERENCE_BYTES);
    return `${RANDOM_REFERENCE_PREFIXES[kind]}${bytes.toString("hex")}`;
  };

  return Object.freeze({
    tenantId,
    subjectId(sourceSystem, providerRecordId) {
      return stableReference("subjectId", sourceSystem, providerRecordId);
    },
    sourceRecordRef(sourceSystem, providerRecordId) {
      return stableReference("sourceRecordRef", sourceSystem, providerRecordId);
    },
    observationId() {
      return randomReference("observationId");
    },
    workItemId() {
      return randomReference("workItemId");
    },
    evaluationId() {
      return randomReference("evaluationId");
    },
    requestId() {
      return randomReference("requestId");
    },
    traceId() {
      return randomReference("traceId");
    }
  });
}

/**
 * Generates a new opaque HCN tenant identifier.
 *
 * This is intentionally separate from the tenant-scoped factory so creating a
 * factory can never silently select or change a tenant.
 */
export function createRandomTenantId({
  randomBytes = cryptographicRandomBytes
} = {}) {
  assertRandomBytesFunction(randomBytes);
  return `tenant_${readExactRandomBytes(randomBytes, RANDOM_TENANT_BYTES).toString(
    "hex"
  )}`;
}

export class HcnReferenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "HcnReferenceError";
  }
}

function copyAndValidateHmacKey(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail("hmacKey must be provided as bytes");
  }
  const key = Buffer.from(value);
  if (key.byteLength < MIN_HMAC_KEY_BYTES) {
    fail(`hmacKey must contain at least ${MIN_HMAC_KEY_BYTES} bytes`);
  }
  return key;
}

function assertTenantId(value) {
  if (typeof value !== "string" || !TENANT_ID_PATTERN.test(value)) {
    fail("tenantId must be an exact opaque HCN tenant identifier");
  }
}

function assertSourceSystem(value) {
  if (typeof value !== "string" || !ALLOWED_SOURCE_SYSTEMS.has(value)) {
    fail("sourceSystem is not allowlisted for HCN Operations");
  }
}

function assertProviderRecordId(value) {
  if (typeof value !== "string") {
    fail("providerRecordId must be a string");
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength === 0 || value.trim().length === 0) {
    fail("providerRecordId must not be empty");
  }
  if (byteLength > MAX_PROVIDER_RECORD_ID_BYTES) {
    fail(
      `providerRecordId must not exceed ${MAX_PROVIDER_RECORD_ID_BYTES} UTF-8 bytes`
    );
  }
}

function assertRandomBytesFunction(value) {
  if (typeof value !== "function") {
    fail("randomBytes must be a function");
  }
}

function readExactRandomBytes(randomBytes, size) {
  let value;
  try {
    value = randomBytes(size);
  } catch {
    fail("randomBytes failed to generate an opaque identifier");
  }
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail("randomBytes must return bytes");
  }
  const bytes = Buffer.from(value);
  if (bytes.byteLength !== size) {
    fail(`randomBytes must return exactly ${size} bytes`);
  }
  return bytes;
}

function updateLengthPrefixed(hmac, value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hmac.update(length);
  hmac.update(bytes);
}

function fail(message) {
  throw new HcnReferenceError(message);
}
