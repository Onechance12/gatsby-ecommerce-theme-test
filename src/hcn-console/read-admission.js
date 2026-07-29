import { createHash } from "node:crypto";

const SESSION_BINDING_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_HASH_CONTEXT = "hcn-console:read-admission:session:v1";
const MAX_CONCURRENT_LIMIT = 32;
const MAX_REQUEST_LIMIT = 10_000;
const MAX_WINDOW_MS = 60 * 60 * 1000;
const MAX_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_SESSIONS = 10_000;
const MAX_TOTAL_REQUEST_EVENTS = 100_000;
const MAX_RETRY_AFTER_SECONDS = 60 * 60;
const CONFIGURATION_FIELDS = Object.freeze([
  "now",
  "concurrentLimit",
  "requestLimit",
  "windowMs",
  "maxTrackedSessions",
  "idleTtlMs",
  "failureRetryAfterSeconds"
]);

export const HCN_READ_ADMISSION_DEFAULTS = Object.freeze({
  concurrentLimit: 3,
  requestLimit: 60,
  windowMs: 60_000,
  maxTrackedSessions: 512,
  idleTtlMs: 5 * 60_000,
  failureRetryAfterSeconds: 1
});

/**
 * A privacy-safe signal that a fresh-read request was not admitted.
 *
 * The error deliberately carries no session key, digest, provider detail, or
 * mutable metadata. Callers may use the bounded retry value for Retry-After.
 */
export class HcnReadAdmissionError extends Error {
  constructor(retryAfterSeconds) {
    super("Fresh-read capacity is temporarily unavailable.");
    this.name = "HcnReadAdmissionError";
    Object.defineProperties(this, {
      code: {
        value: "read_admission_limited",
        enumerable: true
      },
      statusCode: {
        value: 429,
        enumerable: true
      },
      retryAfterSeconds: {
        value: clampRetryAfter(retryAfterSeconds),
        enumerable: true
      }
    });
    Object.freeze(this);
  }
}

/**
 * Create a bounded, in-memory admission controller for HCN fresh-read routes.
 *
 * Each successful `enter` consumes one rolling-window request and one
 * concurrency slot. The returned function releases only the concurrency slot;
 * it is safe to call more than once.
 */
export function createHcnReadAdmissionController(options = {}) {
  assertConfigurationObject(options);
  assertKnownFields(options);

  const {
    now = Date.now,
    concurrentLimit = HCN_READ_ADMISSION_DEFAULTS.concurrentLimit,
    requestLimit = HCN_READ_ADMISSION_DEFAULTS.requestLimit,
    windowMs = HCN_READ_ADMISSION_DEFAULTS.windowMs,
    maxTrackedSessions =
      HCN_READ_ADMISSION_DEFAULTS.maxTrackedSessions,
    idleTtlMs = HCN_READ_ADMISSION_DEFAULTS.idleTtlMs,
    failureRetryAfterSeconds =
      HCN_READ_ADMISSION_DEFAULTS.failureRetryAfterSeconds
  } = options;

  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }
  assertIntegerBetween(
    concurrentLimit,
    1,
    MAX_CONCURRENT_LIMIT,
    "concurrentLimit"
  );
  assertIntegerBetween(
    requestLimit,
    1,
    MAX_REQUEST_LIMIT,
    "requestLimit"
  );
  assertIntegerBetween(windowMs, 1, MAX_WINDOW_MS, "windowMs");
  assertIntegerBetween(
    maxTrackedSessions,
    1,
    MAX_TRACKED_SESSIONS,
    "maxTrackedSessions"
  );
  assertIntegerBetween(
    idleTtlMs,
    1,
    MAX_IDLE_TTL_MS,
    "idleTtlMs"
  );
  assertIntegerBetween(
    failureRetryAfterSeconds,
    1,
    MAX_RETRY_AFTER_SECONDS,
    "failureRetryAfterSeconds"
  );
  if (concurrentLimit > requestLimit) {
    throw new TypeError(
      "concurrentLimit must not exceed requestLimit"
    );
  }
  if (idleTtlMs < windowMs) {
    throw new TypeError("idleTtlMs must not be less than windowMs");
  }
  if (
    requestLimit * maxTrackedSessions >
    MAX_TOTAL_REQUEST_EVENTS
  ) {
    throw new TypeError(
      "requestLimit times maxTrackedSessions exceeds the memory bound"
    );
  }

  /**
   * Values contain counters and timestamps only. Keys are domain-separated
   * hashes, so the raw session binding is not retained by this controller.
   *
   * @type {Map<string, {
   *   active: number,
   *   acceptedAt: number[],
   *   lastAcceptedAt: number
   * }>}
   */
  const sessions = new Map();
  let lastTimestamp = -1;

  function enter(sessionBinding) {
    const sessionKey = internalSessionKey(sessionBinding);
    const timestamp = admissionTimestamp(
      now,
      lastTimestamp,
      failureRetryAfterSeconds
    );
    lastTimestamp = timestamp;
    pruneAt(timestamp);

    let record = sessions.get(sessionKey);
    if (!record && sessions.size >= maxTrackedSessions) {
      throw limited(capacityRetryMilliseconds(timestamp));
    }

    const waits = [];
    if (record?.active >= concurrentLimit) {
      waits.push(failureRetryAfterSeconds * 1000);
    }
    if (record?.acceptedAt.length >= requestLimit) {
      waits.push(
        windowMs - (timestamp - record.acceptedAt[0])
      );
    }
    if (waits.length > 0) {
      throw limited(Math.max(...waits));
    }

    if (!record) {
      record = {
        active: 0,
        acceptedAt: [],
        lastAcceptedAt: timestamp
      };
      sessions.set(sessionKey, record);
    }
    record.active += 1;
    record.acceptedAt.push(timestamp);
    record.lastAcceptedAt = timestamp;

    let released = false;
    const release = () => {
      if (released) return false;
      released = true;
      // An active record is never eligible for pruning, so it remains present
      // until this lease releases its slot.
      record.active -= 1;
      return true;
    };
    return Object.freeze(release);
  }

  function pruneAt(timestamp) {
    let requestsPruned = 0;
    let sessionsPruned = 0;
    const cutoff = timestamp - windowMs;

    for (const [key, record] of sessions) {
      requestsPruned += removeExpired(record.acceptedAt, cutoff);
      if (
        record.active === 0 &&
        timestamp - record.lastAcceptedAt >= idleTtlMs
      ) {
        sessions.delete(key);
        sessionsPruned += 1;
      }
    }
    return Object.freeze({
      requestsPruned,
      sessionsPruned
    });
  }

  function capacityRetryMilliseconds(timestamp) {
    let shortestWait = Number.POSITIVE_INFINITY;
    for (const record of sessions.values()) {
      if (record.active !== 0) continue;
      const wait =
        idleTtlMs - (timestamp - record.lastAcceptedAt);
      if (wait > 0 && wait < shortestWait) shortestWait = wait;
    }
    return Number.isFinite(shortestWait)
      ? shortestWait
      : failureRetryAfterSeconds * 1000;
  }

  function cleanup() {
    const timestamp = optionalTimestamp(now, lastTimestamp);
    if (timestamp === null) {
      return Object.freeze({
        available: false,
        requestsPruned: 0,
        sessionsPruned: 0
      });
    }
    lastTimestamp = timestamp;
    return Object.freeze({
      available: true,
      ...pruneAt(timestamp)
    });
  }

  function stats() {
    const cleanupResult = cleanup();
    if (!cleanupResult.available) {
      return Object.freeze({
        available: false,
        trackedSessions: 0,
        activeRequests: 0,
        requestsInWindow: 0,
        concurrentLimit,
        requestLimit,
        maxTrackedSessions
      });
    }

    let activeRequests = 0;
    let requestsInWindow = 0;
    for (const record of sessions.values()) {
      activeRequests += record.active;
      requestsInWindow += record.acceptedAt.length;
    }
    return Object.freeze({
      available: true,
      trackedSessions: sessions.size,
      activeRequests,
      requestsInWindow,
      concurrentLimit,
      requestLimit,
      maxTrackedSessions
    });
  }

  return Object.freeze({
    enter,
    cleanup,
    stats
  });
}

function internalSessionKey(sessionBinding) {
  if (
    typeof sessionBinding !== "string" ||
    !SESSION_BINDING_PATTERN.test(sessionBinding)
  ) {
    throw new TypeError(
      "sessionBinding must be a lowercase SHA-256 hash"
    );
  }
  return createHash("sha256")
    .update(SESSION_HASH_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(sessionBinding, "utf8")
    .digest("hex");
}

function admissionTimestamp(now, previous, failureRetryAfterSeconds) {
  const timestamp = optionalTimestamp(now, previous);
  if (timestamp === null) {
    throw new HcnReadAdmissionError(failureRetryAfterSeconds);
  }
  return timestamp;
}

function optionalTimestamp(now, previous) {
  let value;
  try {
    value = now();
  } catch {
    return null;
  }
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    (previous >= 0 && timestamp < previous)
  ) {
    return null;
  }
  return timestamp;
}

function limited(waitMilliseconds) {
  const retryAfterSeconds =
    Number.isFinite(waitMilliseconds) && waitMilliseconds > 0
      ? Math.ceil(waitMilliseconds / 1000)
      : 1;
  return new HcnReadAdmissionError(retryAfterSeconds);
}

function clampRetryAfter(value) {
  if (!Number.isFinite(value)) return MAX_RETRY_AFTER_SECONDS;
  return Math.max(
    1,
    Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(value))
  );
}

function removeExpired(events, cutoff) {
  let count = 0;
  while (count < events.length && events[count] <= cutoff) {
    count += 1;
  }
  if (count > 0) events.splice(0, count);
  return count;
}

function assertConfigurationObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError("configuration must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("configuration must be a plain object");
  }
}

function assertKnownFields(value) {
  for (const field of Object.keys(value)) {
    if (!CONFIGURATION_FIELDS.includes(field)) {
      throw new TypeError("configuration contains an unknown field");
    }
  }
}

function assertIntegerBetween(value, minimum, maximum, name) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(
      `${name} must be a safe integer between ${minimum} and ${maximum}`
    );
  }
}
