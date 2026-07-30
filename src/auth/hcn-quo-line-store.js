import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes as cryptographicRandomBytes,
  timingSafeEqual
} from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import path from "node:path";

const STORE_SCHEMA = "hcn.quo.employee-line-store";
const STORE_VERSION = "1.0.0";
const ENVELOPE_SCHEMA = "hcn.quo.employee-line-store.encrypted";
const ENVELOPE_VERSION = "1.0.0";
const ENVELOPE_ALGORITHM = "A256GCM";
const ENVELOPE_AAD = Buffer.from(JSON.stringify({
  schema: ENVELOPE_SCHEMA,
  schemaVersion: ENVELOPE_VERSION,
  algorithm: ENVELOPE_ALGORITHM,
  purpose: "hcn-employee-quo-line-authorization"
}), "utf8");
const KEY_SALT = Buffer.from("hcn-quo-line-store:hkdf-salt:v1", "utf8");
const ENCRYPTION_KEY_INFO =
  Buffer.from("hcn-quo-line-store:aes-256-gcm:v1", "utf8");
const OTP_KEY_INFO =
  Buffer.from("hcn-quo-line-store:otp-hmac-sha256:v1", "utf8");
const OTP_MAC_CONTEXT = "hcn-quo-line-store:otp:v1";

const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DERIVED_KEY_BYTES = 32;
const MIN_MASTER_KEY_BYTES = 32;
const MAX_MASTER_KEY_BYTES = 128;
const PRIVATE_FILE_MODE = 0o600;
const PRINCIPAL_REF_PATTERN = /^principal_[a-f0-9]{32}$/;
const GOOGLE_SUBJECT_PATTERN = /^[A-Za-z0-9._~-]{1,255}$/;
const CHALLENGE_REF_PATTERN = /^quo_challenge_[a-f0-9]{32}$/;
const PROVIDER_ID_PATTERN = /^[^\s\x00-\x1f\x7f]{1,512}$/;
const PHONE_PATTERN = /^\+1\d{10}$/;
const OTP_PATTERN = /^\d{6}$/;
const MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EMAIL_LOCAL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const DEFAULT_ALLOWED_DOMAIN = "wavepa.com";
const DEFAULT_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CHALLENGE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MINIMUM_CHALLENGE_INTERVAL_MS = 60 * 1000;
const DEFAULT_CHALLENGE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CHALLENGES_PER_WINDOW = 5;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_BINDINGS = 512;
const DEFAULT_MAX_CHALLENGES = 2048;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const HARD_MAX_RECORDS = 4096;
const HARD_MAX_FILE_BYTES = 16 * 1024 * 1024;
const HARD_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const HARD_MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LINE_NAME_CHARACTERS = 80;
const TEMPORARY_NAME_ATTEMPTS = 4;
const RANDOM_ATTEMPTS = 8;
const OTP_SPACE = 1_000_000;
const UINT32_SPACE = 0x1_0000_0000;
const UINT32_ACCEPTANCE_LIMIT =
  UINT32_SPACE - (UINT32_SPACE % OTP_SPACE);
const CHALLENGE_STATES = new Set([
  "pending",
  "consumed",
  "cancelled",
  "superseded",
  "locked",
  "expired"
]);

/**
 * Encrypted authorization state for HCN employee Quo line bindings.
 *
 * HCN_QUO_LINK_KEY is passed as `encryptionKey`; this module never reads the
 * environment. The key must be dedicated canonical base64url material. HKDF
 * derives independent encryption and OTP-MAC keys.
 *
 * Integration API:
 * - createChallenge(identity + exact Quo line) -> private one-time `code`
 * - getPendingChallenge(identity) -> exact line for a fresh provider recheck
 * - verifyChallenge(identity + code) -> consumes OTP and creates the binding
 * - cancelChallenge(identity + challengeRef)
 * - getBinding(identity)
 * - revokeBinding(identity)
 * - status(identity)
 */
export function createHcnQuoLineStore({
  filePath,
  encryptionKey,
  allowedDomain = DEFAULT_ALLOWED_DOMAIN,
  now = Date.now,
  randomBytes = cryptographicRandomBytes,
  challengeTtlMs = DEFAULT_CHALLENGE_TTL_MS,
  challengeWindowMs = DEFAULT_CHALLENGE_WINDOW_MS,
  minimumChallengeIntervalMs =
    DEFAULT_MINIMUM_CHALLENGE_INTERVAL_MS,
  challengeRetentionMs = DEFAULT_CHALLENGE_RETENTION_MS,
  maxChallengesPerWindow =
    DEFAULT_MAX_CHALLENGES_PER_WINDOW,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxBindings = DEFAULT_MAX_BINDINGS,
  maxChallenges = DEFAULT_MAX_CHALLENGES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES
} = {}) {
  const configuredPath = normalizeStorePath(filePath);
  const domain = normalizeDomain(allowedDomain);
  const keys = deriveStoreKeys(encryptionKey);
  assertFunction(now, "now");
  assertFunction(randomBytes, "randomBytes");
  assertInteger(challengeTtlMs, 60_000, HARD_MAX_TTL_MS, "challengeTtlMs");
  assertInteger(
    challengeWindowMs,
    challengeTtlMs,
    HARD_MAX_TTL_MS,
    "challengeWindowMs"
  );
  assertInteger(
    minimumChallengeIntervalMs,
    0,
    challengeWindowMs,
    "minimumChallengeIntervalMs"
  );
  assertInteger(
    challengeRetentionMs,
    challengeWindowMs,
    HARD_MAX_RETENTION_MS,
    "challengeRetentionMs"
  );
  assertInteger(
    maxChallengesPerWindow,
    1,
    100,
    "maxChallengesPerWindow"
  );
  assertInteger(maxAttempts, 1, 10, "maxAttempts");
  assertInteger(maxBindings, 1, HARD_MAX_RECORDS, "maxBindings");
  assertInteger(maxChallenges, 1, HARD_MAX_RECORDS, "maxChallenges");
  assertInteger(
    maxFileBytes,
    1024,
    HARD_MAX_FILE_BYTES,
    "maxFileBytes"
  );

  const limits = Object.freeze({
    challengeTtlMs,
    challengeWindowMs,
    minimumChallengeIntervalMs,
    challengeRetentionMs,
    maxChallengesPerWindow,
    maxAttempts,
    maxBindings,
    maxChallenges,
    maxFileBytes
  });
  let mutationQueue = Promise.resolve();

  async function createChallenge(input) {
    const request = normalizeCreateChallenge(input, domain);
    return enqueueMutation(async () => {
      const timestamp = readNow(now);
      const document = await loadDocument();
      pruneChallenges(document, timestamp, limits);
      assertIdentityCompatible(document, request);
      assertLineAvailable(document, request);

      const recent = document.challenges.filter(
        (challenge) =>
          challenge.principalRef === request.principalRef
          && Date.parse(challenge.createdAt)
            > timestamp - challengeWindowMs
      );
      if (recent.length >= maxChallengesPerWindow) {
        throw storeError(
          "challenge_rate_limited",
          "Too many Quo verification challenges were requested.",
          429,
          retryAfterSeconds(
            Date.parse(recent[0].createdAt) + challengeWindowMs - timestamp
          )
        );
      }
      const latest = [...recent].sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt)
      )[0];
      if (
        latest
        && timestamp - Date.parse(latest.createdAt)
          < minimumChallengeIntervalMs
      ) {
        throw storeError(
          "challenge_rate_limited",
          "Wait before requesting another Quo verification challenge.",
          429,
          retryAfterSeconds(
            Date.parse(latest.createdAt)
              + minimumChallengeIntervalMs
              - timestamp
          )
        );
      }
      if (document.challenges.length >= maxChallenges) {
        throw storeError(
          "capacity_exceeded",
          "The Quo verification challenge store is at capacity.",
          409
        );
      }

      const instant = iso(timestamp);
      for (const challenge of document.challenges) {
        if (
          challenge.principalRef === request.principalRef
          && challenge.state === "pending"
        ) {
          challenge.state = "superseded";
          challenge.closedAt = instant;
        }
      }

      const challengeRef = createUniqueChallengeRef(
        randomBytes,
        document.challenges
      );
      const code = createOtp(randomBytes);
      const expiresAt = iso(timestamp + challengeTtlMs);
      const challenge = {
        challengeRef,
        principalRef: request.principalRef,
        googleSubject: request.googleSubject,
        email: request.email,
        lineId: request.lineId,
        lineNumber: request.lineNumber,
        lineName: request.lineName,
        codeMac: otpMac(keys.otp, {
          ...request,
          challengeRef,
          expiresAt,
          code
        }),
        attempts: 0,
        maxAttempts,
        state: "pending",
        createdAt: instant,
        expiresAt,
        closedAt: ""
      };
      document.challenges.push(challenge);
      sortDocument(document);
      await saveDocument(document);
      return privateChallengeResult(challenge, code);
    });
  }

  async function getPendingChallenge(input) {
    const identity = normalizeIdentityInput(input, domain);
    const timestamp = readNow(now);
    const document = await loadDocument();
    assertIdentityCompatible(document, identity);
    const challenge = findPendingChallenge(
      document,
      identity.principalRef,
      timestamp
    );
    return challenge ? publicChallenge(challenge) : null;
  }

  async function verifyChallenge(input) {
    const request = normalizeVerifyInput(input, domain);
    return enqueueMutation(async () => {
      const timestamp = readNow(now);
      const document = await loadDocument();
      pruneChallenges(document, timestamp, limits);
      assertIdentityCompatible(document, request);
      const challenge = findLatestPendingChallenge(
        document,
        request.principalRef
      );
      if (!challenge) {
        throw storeError(
          "challenge_not_found",
          "No pending Quo verification challenge is available.",
          409
        );
      }
      if (Date.parse(challenge.expiresAt) <= timestamp) {
        challenge.state = "expired";
        challenge.closedAt = iso(timestamp);
        await saveDocument(document);
        throw storeError(
          "challenge_expired",
          "The Quo verification challenge expired.",
          409
        );
      }
      if (challenge.attempts >= challenge.maxAttempts) {
        challenge.state = "locked";
        challenge.closedAt ||= iso(timestamp);
        await saveDocument(document);
        throw storeError(
          "challenge_locked",
          "The Quo verification challenge is locked.",
          409
        );
      }

      challenge.attempts += 1;
      const providedMac = otpMac(keys.otp, {
        ...challenge,
        code: request.code
      });
      if (!constantTimeTextEqual(providedMac, challenge.codeMac)) {
        if (challenge.attempts >= challenge.maxAttempts) {
          challenge.state = "locked";
          challenge.closedAt = iso(timestamp);
        }
        await saveDocument(document);
        throw storeError(
          challenge.state === "locked"
            ? "challenge_locked"
            : "challenge_incorrect",
          challenge.state === "locked"
            ? "The Quo verification challenge is locked."
            : "The Quo verification code is incorrect.",
          400
        );
      }

      assertLineAvailable(document, challenge);
      challenge.state = "consumed";
      challenge.closedAt = iso(timestamp);
      const binding = {
        principalRef: challenge.principalRef,
        googleSubject: challenge.googleSubject,
        email: challenge.email,
        lineId: challenge.lineId,
        lineNumber: challenge.lineNumber,
        lineName: challenge.lineName,
        verifiedAt: iso(timestamp),
        updatedAt: iso(timestamp),
        verificationMethod: "twilio_sms_otp"
      };
      const existingIndex = document.bindings.findIndex(
        (candidate) =>
          candidate.principalRef === binding.principalRef
      );
      if (
        existingIndex === -1
        && document.bindings.length >= maxBindings
      ) {
        throw storeError(
          "capacity_exceeded",
          "The employee Quo line store is at capacity.",
          409
        );
      }
      if (existingIndex === -1) {
        document.bindings.push(binding);
      } else {
        document.bindings[existingIndex] = binding;
      }
      sortDocument(document);
      await saveDocument(document);
      return publicBinding(binding);
    });
  }

  async function cancelChallenge(input) {
    const request = normalizeCancelInput(input, domain);
    return enqueueMutation(async () => {
      const timestamp = readNow(now);
      const document = await loadDocument();
      pruneChallenges(document, timestamp, limits);
      assertIdentityCompatible(document, request);
      const challenge = document.challenges.find(
        (candidate) =>
          candidate.challengeRef === request.challengeRef
          && candidate.principalRef === request.principalRef
      );
      if (!challenge || challenge.state !== "pending") {
        return Object.freeze({
          cancelled: false,
          challengeRef: request.challengeRef
        });
      }
      challenge.state = "cancelled";
      challenge.closedAt = iso(timestamp);
      await saveDocument(document);
      return Object.freeze({
        cancelled: true,
        challengeRef: challenge.challengeRef
      });
    });
  }

  async function getBinding(input) {
    const identity = normalizeIdentityInput(input, domain);
    const document = await loadDocument();
    assertIdentityCompatible(document, identity);
    const binding = document.bindings.find(
      (candidate) =>
        candidate.principalRef === identity.principalRef
    );
    return binding ? publicBinding(binding) : null;
  }

  async function revokeBinding(input) {
    const identity = normalizeIdentityInput(input, domain);
    return enqueueMutation(async () => {
      const timestamp = readNow(now);
      const document = await loadDocument();
      pruneChallenges(document, timestamp, limits);
      assertIdentityCompatible(document, identity);
      const index = document.bindings.findIndex(
        (candidate) =>
          candidate.principalRef === identity.principalRef
      );
      if (index === -1) {
        return Object.freeze({ revoked: false, state: "not_linked" });
      }
      document.bindings.splice(index, 1);
      await saveDocument(document);
      return Object.freeze({ revoked: true, state: "not_linked" });
    });
  }

  async function status(input) {
    const identity = normalizeIdentityInput(input, domain);
    const timestamp = readNow(now);
    const document = await loadDocument();
    assertIdentityCompatible(document, identity);
    const binding = document.bindings.find(
      (candidate) =>
        candidate.principalRef === identity.principalRef
    );
    const challenge = findPendingChallenge(
      document,
      identity.principalRef,
      timestamp
    );
    return Object.freeze({
      schema: "hcn.quo.employee-line-status",
      schemaVersion: STORE_VERSION,
      state: binding ? "linked" : "not_linked",
      binding: binding ? publicBinding(binding) : null,
      pendingChallenge: challenge ? publicChallenge(challenge) : null
    });
  }

  async function loadDocument() {
    return readEncryptedDocument({
      filePath: configuredPath,
      encryptionKey: keys.encryption,
      limits,
      allowedDomain: domain
    });
  }

  async function saveDocument(document) {
    return writeEncryptedDocument({
      filePath: configuredPath,
      encryptionKey: keys.encryption,
      document,
      randomBytes,
      limits,
      allowedDomain: domain
    });
  }

  function enqueueMutation(operation) {
    const run = mutationQueue.then(operation, operation);
    mutationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  return Object.freeze({
    createChallenge,
    getPendingChallenge,
    verifyChallenge,
    cancelChallenge,
    getBinding,
    revokeBinding,
    status
  });
}

export class HcnQuoLineStoreError extends Error {
  constructor(code, message, statusCode, retryAfterSeconds = 0) {
    super(message);
    this.name = "HcnQuoLineStoreError";
    this.code = code;
    this.statusCode = statusCode;
    if (retryAfterSeconds > 0) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

function normalizeCreateChallenge(value, allowedDomain) {
  exactInput(
    value,
    [
      "principalRef",
      "googleSubject",
      "email",
      "lineId",
      "lineNumber",
      "lineName"
    ],
    "challenge creation"
  );
  return Object.freeze({
    ...normalizeIdentityFields(value, allowedDomain),
    lineId: providerId(value.lineId, "lineId"),
    lineNumber: lineNumber(value.lineNumber),
    lineName: lineName(value.lineName)
  });
}

function normalizeIdentityInput(value, allowedDomain) {
  exactInput(
    value,
    ["principalRef", "googleSubject", "email"],
    "employee identity"
  );
  return Object.freeze(normalizeIdentityFields(value, allowedDomain));
}

function normalizeVerifyInput(value, allowedDomain) {
  exactInput(
    value,
    ["principalRef", "googleSubject", "email", "code"],
    "challenge verification"
  );
  const code = String(value.code || "");
  if (!OTP_PATTERN.test(code)) {
    invalidInput("code must be exactly six digits.");
  }
  return Object.freeze({
    ...normalizeIdentityFields(value, allowedDomain),
    code
  });
}

function normalizeCancelInput(value, allowedDomain) {
  exactInput(
    value,
    ["principalRef", "googleSubject", "email", "challengeRef"],
    "challenge cancellation"
  );
  if (
    typeof value.challengeRef !== "string"
    || !CHALLENGE_REF_PATTERN.test(value.challengeRef)
  ) {
    invalidInput("challengeRef is invalid.");
  }
  return Object.freeze({
    ...normalizeIdentityFields(value, allowedDomain),
    challengeRef: value.challengeRef
  });
}

function normalizeIdentityFields(value, allowedDomain) {
  if (
    typeof value.principalRef !== "string"
    || !PRINCIPAL_REF_PATTERN.test(value.principalRef)
  ) {
    invalidInput("principalRef is invalid.");
  }
  if (
    typeof value.googleSubject !== "string"
    || !GOOGLE_SUBJECT_PATTERN.test(value.googleSubject)
  ) {
    invalidInput("googleSubject is invalid.");
  }
  return {
    principalRef: value.principalRef,
    googleSubject: value.googleSubject,
    email: canonicalEmail(value.email, allowedDomain)
  };
}

function providerId(value, label, persisted = false) {
  if (typeof value !== "string" || !PROVIDER_ID_PATTERN.test(value)) {
    if (persisted) corruptStore(`The stored ${label} is invalid.`);
    invalidInput(`${label} is invalid.`);
  }
  return value;
}

function lineNumber(value, persisted = false) {
  if (typeof value !== "string" || !PHONE_PATTERN.test(value)) {
    if (persisted) corruptStore("The stored Quo line number is invalid.");
    invalidInput("lineNumber must be an E.164 US number.");
  }
  return value;
}

function lineName(value, persisted = false) {
  if (typeof value !== "string") {
    if (persisted) corruptStore("The stored Quo line name is invalid.");
    invalidInput("lineName is invalid.");
  }
  const normalized = value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !normalized
    || Array.from(normalized).length > MAX_LINE_NAME_CHARACTERS
    || (persisted && value !== normalized)
  ) {
    if (persisted) corruptStore("The stored Quo line name is invalid.");
    invalidInput("lineName is invalid.");
  }
  return normalized;
}

function canonicalEmail(value, allowedDomain, persisted = false) {
  if (typeof value !== "string") {
    if (persisted) corruptStore("The stored employee email is invalid.");
    invalidInput("email is invalid.");
  }
  const normalized = value.trim().toLowerCase();
  const separator = normalized.lastIndexOf("@");
  const local = separator > 0 ? normalized.slice(0, separator) : "";
  const domain = separator > 0 ? normalized.slice(separator + 1) : "";
  if (
    normalized !== value
    || Buffer.byteLength(normalized, "utf8") > 254
    || !EMAIL_LOCAL_PATTERN.test(local)
    || domain !== allowedDomain
  ) {
    if (persisted) corruptStore("The stored employee email is invalid.");
    invalidInput("email is outside the approved HCN domain.");
  }
  return normalized;
}

function normalizeDomain(value) {
  if (typeof value !== "string") {
    throw new TypeError("allowedDomain is required");
  }
  const normalized = value.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(normalized)) {
    throw new TypeError("allowedDomain is invalid");
  }
  return normalized;
}

function assertIdentityCompatible(document, identity) {
  for (const record of [...document.bindings, ...document.challenges]) {
    const samePrincipal =
      record.principalRef === identity.principalRef;
    const sameSubject =
      record.googleSubject === identity.googleSubject;
    const sameEmail = record.email === identity.email;
    if (
      (samePrincipal && (!sameSubject || !sameEmail))
      || (sameSubject && (!samePrincipal || !sameEmail))
      || (sameEmail && (!samePrincipal || !sameSubject))
    ) {
      throw storeError(
        "identity_conflict",
        "The HCN employee identity binding is not current.",
        409
      );
    }
  }
}

function assertLineAvailable(document, requested) {
  const conflict = document.bindings.find(
    (binding) =>
      binding.principalRef !== requested.principalRef
      && (
        binding.lineId === requested.lineId
        || binding.lineNumber === requested.lineNumber
      )
  );
  if (conflict) {
    throw storeError(
      "line_conflict",
      "That Quo line is linked to another HCN employee.",
      409
    );
  }
}

function findPendingChallenge(document, principalRef, timestamp) {
  return document.challenges.find(
    (challenge) =>
      challenge.principalRef === principalRef
      && challenge.state === "pending"
      && challenge.attempts < challenge.maxAttempts
      && Date.parse(challenge.expiresAt) > timestamp
  ) || null;
}

function findLatestPendingChallenge(document, principalRef) {
  return [...document.challenges]
    .filter(
      (challenge) =>
        challenge.principalRef === principalRef
        && challenge.state === "pending"
    )
    .sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt)
    )[0] || null;
}

function pruneChallenges(document, timestamp, limits) {
  document.challenges = document.challenges.filter(
    (challenge) =>
      Date.parse(challenge.expiresAt) + limits.challengeRetentionMs
        > timestamp
  );
}

function privateChallengeResult(challenge, code) {
  const result = {
    ...publicChallenge(challenge),
    delivery: Object.freeze({
      to: maskPhone(challenge.lineNumber)
    })
  };
  Object.defineProperty(result, "code", {
    value: code,
    enumerable: false,
    configurable: false,
    writable: false
  });
  Object.defineProperty(result, "toJSON", {
    value() {
      return {
        ...publicChallenge(challenge),
        delivery: { to: maskPhone(challenge.lineNumber) }
      };
    },
    enumerable: false,
    configurable: false,
    writable: false
  });
  return Object.freeze(result);
}

function publicChallenge(challenge) {
  return Object.freeze({
    schema: "hcn.quo.employee-line-challenge",
    schemaVersion: STORE_VERSION,
    challengeRef: challenge.challengeRef,
    state: challenge.state,
    lineId: challenge.lineId,
    lineNumber: challenge.lineNumber,
    lineName: challenge.lineName,
    attempts: challenge.attempts,
    maxAttempts: challenge.maxAttempts,
    createdAt: challenge.createdAt,
    expiresAt: challenge.expiresAt
  });
}

function publicBinding(binding) {
  return Object.freeze({
    schema: "hcn.quo.employee-line-binding",
    schemaVersion: STORE_VERSION,
    state: "linked",
    lineId: binding.lineId,
    lineNumber: binding.lineNumber,
    lineName: binding.lineName,
    verifiedAt: binding.verifiedAt,
    updatedAt: binding.updatedAt,
    verificationMethod: binding.verificationMethod
  });
}

function maskPhone(value) {
  return `***-***-${String(value).slice(-4)}`;
}

function createUniqueChallengeRef(randomBytes, challenges) {
  const existing = new Set(
    challenges.map((challenge) => challenge.challengeRef)
  );
  for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt += 1) {
    const candidate =
      `quo_challenge_${secureRandomBytes(randomBytes, 16).toString("hex")}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw storeError(
    "randomness_unavailable",
    "A unique Quo challenge identifier could not be created.",
    503
  );
}

function createOtp(randomBytes) {
  for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt += 1) {
    const value = secureRandomBytes(randomBytes, 4).readUInt32BE(0);
    if (value < UINT32_ACCEPTANCE_LIMIT) {
      return String(value % OTP_SPACE).padStart(6, "0");
    }
  }
  throw storeError(
    "randomness_unavailable",
    "A Quo verification code could not be created.",
    503
  );
}

function otpMac(key, value) {
  const mac = createHmac("sha256", key);
  for (const component of [
    OTP_MAC_CONTEXT,
    value.challengeRef,
    value.principalRef,
    value.googleSubject,
    value.email,
    value.lineId,
    value.lineNumber,
    value.expiresAt,
    value.code
  ]) {
    updateLengthPrefixed(mac, String(component));
  }
  return mac.digest("base64url");
}

function updateLengthPrefixed(hash, value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hash.update(length);
  hash.update(bytes);
}

function constantTimeTextEqual(left, right) {
  const leftBytes = Buffer.from(String(left || ""), "utf8");
  const rightBytes = Buffer.from(String(right || ""), "utf8");
  if (leftBytes.length !== rightBytes.length) {
    timingSafeEqual(
      createHmac("sha256", Buffer.alloc(32)).update(leftBytes).digest(),
      createHmac("sha256", Buffer.alloc(32)).update(rightBytes).digest()
    );
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

async function readEncryptedDocument({
  filePath,
  encryptionKey,
  limits,
  allowedDomain
}) {
  const parent = path.dirname(filePath);
  const parentState = await inspectDirectory(parent, false);
  if (parentState === "missing") return emptyDocument();
  const metadata = await safeLstat(filePath);
  if (!metadata) return emptyDocument();
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    unsafePath("The Quo line store path is not a regular private file.");
  }
  if (metadata.size < 1 || metadata.size > limits.maxFileBytes) {
    corruptStore("The Quo line store has an invalid size.");
  }
  await assertCanonicalPath(filePath);

  let handle;
  try {
    handle = await open(
      filePath,
      Number(filesystemConstants.O_RDONLY)
        | Number(filesystemConstants.O_NOFOLLOW || 0)
    );
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.size < 1
      || opened.size > limits.maxFileBytes
    ) {
      corruptStore("The Quo line store changed to an invalid object.");
    }
    const bytes = await handle.readFile();
    return decryptDocument(
      bytes,
      encryptionKey,
      limits,
      allowedDomain
    );
  } catch (error) {
    if (error instanceof HcnQuoLineStoreError) throw error;
    corruptStore("The Quo line store could not be read.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeEncryptedDocument({
  filePath,
  encryptionKey,
  document,
  randomBytes,
  limits,
  allowedDomain
}) {
  validateDocument(document, limits, allowedDomain);
  const parent = path.dirname(filePath);
  await inspectDirectory(parent, true);
  const existing = await safeLstat(filePath);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    unsafePath("The Quo line store path is not a regular private file.");
  }
  if (existing) await assertCanonicalPath(filePath);

  const output = encryptDocument(document, encryptionKey, randomBytes);
  if (output.length > limits.maxFileBytes) {
    throw storeError(
      "store_oversize",
      "The encrypted Quo line store exceeds its size bound.",
      409
    );
  }
  let temporaryPath = "";
  let handle;
  let renamed = false;
  try {
    temporaryPath = await uniqueTemporaryPath(filePath, randomBytes);
    handle = await open(
      temporaryPath,
      Number(filesystemConstants.O_WRONLY)
        | Number(filesystemConstants.O_CREAT)
        | Number(filesystemConstants.O_EXCL),
      PRIVATE_FILE_MODE
    );
    await handle.writeFile(output);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = null;
    const temporaryMetadata = await lstat(temporaryPath);
    if (
      temporaryMetadata.isSymbolicLink()
      || !temporaryMetadata.isFile()
    ) {
      unsafePath("The temporary Quo line store path is unsafe.");
    }
    await rename(temporaryPath, filePath);
    renamed = true;
    await chmod(filePath, PRIVATE_FILE_MODE);
    const finalMetadata = await lstat(filePath);
    if (
      finalMetadata.isSymbolicLink()
      || !finalMetadata.isFile()
      || finalMetadata.size !== output.length
    ) {
      unsafePath("The Quo line store was not written safely.");
    }
    await syncDirectory(parent);
  } catch (error) {
    if (error instanceof HcnQuoLineStoreError) throw error;
    throw storeError(
      "store_write_failed",
      "The Quo line store could not be written.",
      503
    );
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryPath && !renamed) {
      await unlink(temporaryPath).catch(() => {});
    }
  }
}

function encryptDocument(document, key, randomBytes) {
  const nonce = secureRandomBytes(randomBytes, NONCE_BYTES);
  const plaintext = Buffer.from(JSON.stringify(document), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AUTH_TAG_BYTES
    });
    cipher.setAAD(ENVELOPE_AAD, {
      plaintextLength: plaintext.length
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);
    return Buffer.from(`${JSON.stringify({
      schema: ENVELOPE_SCHEMA,
      schemaVersion: ENVELOPE_VERSION,
      algorithm: ENVELOPE_ALGORITHM,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url")
    })}\n`, "utf8");
  } finally {
    plaintext.fill(0);
  }
}

function decryptDocument(bytes, key, limits, allowedDomain) {
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch {
    corruptStore("The Quo line store envelope is invalid.");
  }
  exactPersisted(
    envelope,
    [
      "schema",
      "schemaVersion",
      "algorithm",
      "nonce",
      "ciphertext",
      "tag"
    ],
    "encrypted envelope"
  );
  if (
    envelope.schema !== ENVELOPE_SCHEMA
    || envelope.schemaVersion !== ENVELOPE_VERSION
    || envelope.algorithm !== ENVELOPE_ALGORITHM
  ) {
    corruptStore("The Quo line store envelope is unsupported.");
  }
  const nonce = decodeBase64url(envelope.nonce, NONCE_BYTES);
  const tag = decodeBase64url(envelope.tag, AUTH_TAG_BYTES);
  const ciphertext = decodeBase64url(envelope.ciphertext);
  if (ciphertext.length < 1) {
    corruptStore("The Quo line store ciphertext is empty.");
  }

  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AUTH_TAG_BYTES
    });
    decipher.setAAD(ENVELOPE_AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    const document = JSON.parse(plaintext.toString("utf8"));
    validateDocument(document, limits, allowedDomain);
    return document;
  } catch (error) {
    if (error instanceof HcnQuoLineStoreError) throw error;
    corruptStore("The Quo line store could not be authenticated.");
  } finally {
    plaintext?.fill(0);
  }
}

function validateDocument(document, limits, allowedDomain) {
  exactPersisted(
    document,
    ["schema", "schemaVersion", "bindings", "challenges"],
    "document"
  );
  if (
    document.schema !== STORE_SCHEMA
    || document.schemaVersion !== STORE_VERSION
    || !Array.isArray(document.bindings)
    || !Array.isArray(document.challenges)
    || document.bindings.length > limits.maxBindings
    || document.challenges.length > limits.maxChallenges
  ) {
    corruptStore("The Quo line store document is invalid.");
  }
  const identities = new Map();
  const subjects = new Map();
  const emails = new Map();
  const lineIds = new Set();
  const lineNumbers = new Set();
  const challengeRefs = new Set();
  const pendingByPrincipal = new Set();

  for (const binding of document.bindings) {
    validateBinding(binding, allowedDomain);
    assertPersistedIdentityUniqueness(
      binding,
      identities,
      subjects,
      emails
    );
    if (
      lineIds.has(binding.lineId)
      || lineNumbers.has(binding.lineNumber)
    ) {
      corruptStore("The Quo line store contains duplicate line bindings.");
    }
    lineIds.add(binding.lineId);
    lineNumbers.add(binding.lineNumber);
  }
  for (const challenge of document.challenges) {
    validateChallenge(challenge, allowedDomain, limits);
    assertPersistedIdentityUniqueness(
      challenge,
      identities,
      subjects,
      emails
    );
    if (challengeRefs.has(challenge.challengeRef)) {
      corruptStore("The Quo line store contains duplicate challenges.");
    }
    challengeRefs.add(challenge.challengeRef);
    if (challenge.state === "pending") {
      if (pendingByPrincipal.has(challenge.principalRef)) {
        corruptStore(
          "The Quo line store contains multiple pending employee challenges."
        );
      }
      pendingByPrincipal.add(challenge.principalRef);
    }
  }
}

function validateBinding(value, allowedDomain) {
  exactPersisted(
    value,
    [
      "principalRef",
      "googleSubject",
      "email",
      "lineId",
      "lineNumber",
      "lineName",
      "verifiedAt",
      "updatedAt",
      "verificationMethod"
    ],
    "binding"
  );
  persistedIdentity(value, allowedDomain);
  providerId(value.lineId, "lineId", true);
  lineNumber(value.lineNumber, true);
  lineName(value.lineName, true);
  instant(value.verifiedAt, "verifiedAt");
  instant(value.updatedAt, "updatedAt");
  if (
    Date.parse(value.updatedAt) < Date.parse(value.verifiedAt)
    || value.verificationMethod !== "twilio_sms_otp"
  ) {
    corruptStore("The stored Quo line binding is invalid.");
  }
}

function validateChallenge(value, allowedDomain, limits) {
  exactPersisted(
    value,
    [
      "challengeRef",
      "principalRef",
      "googleSubject",
      "email",
      "lineId",
      "lineNumber",
      "lineName",
      "codeMac",
      "attempts",
      "maxAttempts",
      "state",
      "createdAt",
      "expiresAt",
      "closedAt"
    ],
    "challenge"
  );
  if (!CHALLENGE_REF_PATTERN.test(value.challengeRef)) {
    corruptStore("The stored challenge reference is invalid.");
  }
  persistedIdentity(value, allowedDomain);
  providerId(value.lineId, "lineId", true);
  lineNumber(value.lineNumber, true);
  lineName(value.lineName, true);
  if (
    typeof value.codeMac !== "string"
    || !MAC_PATTERN.test(value.codeMac)
  ) {
    corruptStore("The stored challenge MAC is invalid.");
  }
  if (
    !Number.isSafeInteger(value.attempts)
    || value.attempts < 0
    || !Number.isSafeInteger(value.maxAttempts)
    || value.maxAttempts < 1
    || value.maxAttempts > limits.maxAttempts
    || value.attempts > value.maxAttempts
    || !CHALLENGE_STATES.has(value.state)
  ) {
    corruptStore("The stored challenge state is invalid.");
  }
  instant(value.createdAt, "createdAt");
  instant(value.expiresAt, "expiresAt");
  const lifetime =
    Date.parse(value.expiresAt) - Date.parse(value.createdAt);
  if (lifetime < 60_000 || lifetime > limits.challengeTtlMs) {
    corruptStore("The stored challenge lifetime is invalid.");
  }
  if (value.state === "pending") {
    if (
      value.closedAt !== ""
      || value.attempts >= value.maxAttempts
    ) {
      corruptStore("The pending challenge state is invalid.");
    }
  } else {
    instant(value.closedAt, "closedAt");
    if (Date.parse(value.closedAt) < Date.parse(value.createdAt)) {
      corruptStore("The closed challenge timestamp is invalid.");
    }
  }
}

function persistedIdentity(value, allowedDomain) {
  if (!PRINCIPAL_REF_PATTERN.test(value.principalRef)) {
    corruptStore("The stored principal reference is invalid.");
  }
  if (!GOOGLE_SUBJECT_PATTERN.test(value.googleSubject)) {
    corruptStore("The stored Google subject is invalid.");
  }
  canonicalEmail(value.email, allowedDomain, true);
}

function assertPersistedIdentityUniqueness(
  value,
  principals,
  subjects,
  emails
) {
  const identity =
    `${value.principalRef}\0${value.googleSubject}\0${value.email}`;
  for (const [map, key] of [
    [principals, value.principalRef],
    [subjects, value.googleSubject],
    [emails, value.email]
  ]) {
    const existing = map.get(key);
    if (existing && existing !== identity) {
      corruptStore("The stored HCN employee identity mapping conflicts.");
    }
    map.set(key, identity);
  }
}

function emptyDocument() {
  return {
    schema: STORE_SCHEMA,
    schemaVersion: STORE_VERSION,
    bindings: [],
    challenges: []
  };
}

function sortDocument(document) {
  document.bindings.sort((left, right) =>
    left.principalRef.localeCompare(right.principalRef)
  );
  document.challenges.sort((left, right) => {
    const created =
      Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return created || left.challengeRef.localeCompare(right.challengeRef);
  });
}

function deriveStoreKeys(value) {
  const master = canonicalMasterKey(value);
  try {
    return Object.freeze({
      encryption: Buffer.from(hkdfSync(
        "sha256",
        master,
        KEY_SALT,
        ENCRYPTION_KEY_INFO,
        DERIVED_KEY_BYTES
      )),
      otp: Buffer.from(hkdfSync(
        "sha256",
        master,
        KEY_SALT,
        OTP_KEY_INFO,
        DERIVED_KEY_BYTES
      ))
    });
  } finally {
    master.fill(0);
  }
}

function canonicalMasterKey(value) {
  if (
    typeof value !== "string"
    || !BASE64URL_PATTERN.test(value)
  ) {
    invalidConfiguration(
      "HCN_QUO_LINK_KEY must be canonical base64url."
    );
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    bytes = Buffer.alloc(0);
  }
  if (
    bytes.length < MIN_MASTER_KEY_BYTES
    || bytes.length > MAX_MASTER_KEY_BYTES
    || bytes.toString("base64url") !== value
  ) {
    bytes.fill(0);
    invalidConfiguration(
      "HCN_QUO_LINK_KEY must encode 32-128 random bytes."
    );
  }
  return bytes;
}

function decodeBase64url(value, expectedLength = null) {
  if (
    typeof value !== "string"
    || !BASE64URL_PATTERN.test(value)
  ) {
    corruptStore("The encrypted Quo line store envelope is invalid.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value
    || (
      expectedLength !== null
      && decoded.length !== expectedLength
    )
  ) {
    corruptStore("The encrypted Quo line store envelope is invalid.");
  }
  return decoded;
}

async function inspectDirectory(directory, create) {
  let metadata = await safeLstat(directory);
  if (!metadata && create) {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch {
      unsafePath("The Quo line store directory could not be created.");
    }
    metadata = await safeLstat(directory);
  }
  if (!metadata) return "missing";
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    unsafePath("The Quo line store directory is unsafe.");
  }
  await assertCanonicalPath(directory);
  return "ready";
}

async function assertCanonicalPath(target) {
  let actual;
  try {
    actual = await realpath(target);
  } catch {
    unsafePath("The Quo line store path could not be resolved safely.");
  }
  if (canonicalPath(actual) !== canonicalPath(path.resolve(target))) {
    unsafePath("Redirected Quo line store paths are not allowed.");
  }
}

function canonicalPath(value) {
  const normalized = path.normalize(String(value || ""));
  return process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

async function safeLstat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    unsafePath("The Quo line store path could not be inspected.");
  }
}

async function uniqueTemporaryPath(filePath, randomBytes) {
  for (
    let attempt = 0;
    attempt < TEMPORARY_NAME_ATTEMPTS;
    attempt += 1
  ) {
    const suffix = secureRandomBytes(randomBytes, 16).toString("hex");
    const candidate = `${filePath}.tmp-${suffix}`;
    if (!(await safeLstat(candidate))) return candidate;
  }
  throw storeError(
    "store_write_failed",
    "A temporary Quo line store path could not be allocated.",
    503
  );
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, Number(filesystemConstants.O_RDONLY));
    await handle.sync();
  } catch (error) {
    if (
      !["EINVAL", "EPERM", "EISDIR", "EBADF", "ENOTSUP"].includes(
        error?.code
      )
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

function normalizeStorePath(value) {
  if (
    typeof value !== "string"
    || !value
    || value.includes("\0")
    || !path.isAbsolute(value)
  ) {
    invalidConfiguration(
      "The Quo line store requires an absolute file path."
    );
  }
  const resolved = path.resolve(value);
  if (path.dirname(resolved) === resolved) {
    invalidConfiguration(
      "The Quo line store path must identify a file."
    );
  }
  return resolved;
}

function secureRandomBytes(randomBytes, size) {
  let value;
  try {
    value = randomBytes(size);
  } catch {
    throw storeError(
      "randomness_unavailable",
      "Cryptographic randomness is unavailable.",
      503
    );
  }
  if (
    (!Buffer.isBuffer(value) && !(value instanceof Uint8Array))
    || value.byteLength !== size
  ) {
    throw storeError(
      "randomness_unavailable",
      "Cryptographic randomness returned an invalid value.",
      503
    );
  }
  return Buffer.from(value);
}

function exactInput(value, fields, label) {
  const keys = plainKeys(value, label, false);
  if (
    keys.length !== fields.length
    || fields.some((field) => !keys.includes(field))
  ) {
    invalidInput(`${label} must contain exactly the reviewed fields.`);
  }
}

function exactPersisted(value, fields, label) {
  const keys = plainKeys(value, label, true);
  if (
    keys.length !== fields.length
    || fields.some((field) => !keys.includes(field))
  ) {
    corruptStore(`The stored ${label} schema is invalid.`);
  }
}

function plainKeys(value, label, persisted) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    if (persisted) corruptStore(`The stored ${label} is invalid.`);
    invalidInput(`${label} must be a plain object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    if (persisted) corruptStore(`The stored ${label} is invalid.`);
    invalidInput(`${label} must contain string fields.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, "value")
    ) {
      if (persisted) corruptStore(`The stored ${label} is invalid.`);
      invalidInput(`${label} must contain plain enumerable fields.`);
    }
  }
  return keys;
}

function instant(value, label) {
  if (
    typeof value !== "string"
    || !ISO_INSTANT_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    corruptStore(`The stored ${label} is invalid.`);
  }
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch {
    throw storeError(
      "clock_unavailable",
      "The Quo line store clock is unavailable.",
      503
    );
  }
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw storeError(
      "clock_unavailable",
      "The Quo line store clock returned an invalid value.",
      503
    );
  }
  return timestamp;
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function retryAfterSeconds(milliseconds) {
  return Math.max(1, Math.min(3600, Math.ceil(milliseconds / 1000)));
}

function assertFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function`);
  }
}

function assertInteger(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new TypeError(
      `${label} must be an integer between ${minimum} and ${maximum}`
    );
  }
}

function invalidInput(message) {
  throw storeError("invalid_input", message, 400);
}

function invalidConfiguration(message) {
  throw storeError("invalid_configuration", message, 500);
}

function corruptStore(message) {
  throw storeError("store_corrupt", message, 503);
}

function unsafePath(message) {
  throw storeError("unsafe_store_path", message, 503);
}

function storeError(
  code,
  message,
  statusCode,
  retryAfter = 0
) {
  return new HcnQuoLineStoreError(
    code,
    message,
    statusCode,
    retryAfter
  );
}
