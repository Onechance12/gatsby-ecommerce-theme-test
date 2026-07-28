import { createHash } from "node:crypto";

const SOURCE_HASH_CONTEXT = "hcn-console:login-admission:source:v1";
const MAX_SOURCE_KEY_BYTES = 512;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CONFIGURED_COUNT = 100_000;
const MAX_TOTAL_SOURCE_EVENTS = 100_000;
const MAX_RETRY_AFTER_SECONDS = 60 * 60;

export const HCN_LOGIN_ADMISSION_DEFAULTS = Object.freeze({
  perSourceLimit: 6,
  perSourceWindowMs: 10 * 60 * 1000,
  globalLimit: 192,
  globalWindowMs: 10 * 60 * 1000,
  maxUniqueSources: 128,
  failureRetryAfterSeconds: 60
});

/**
 * Bounded admission control for creation of HCN OAuth login transactions.
 *
 * `sourceKey` must already be normalized by a trusted HTTP boundary. This
 * primitive deliberately does not inspect forwarding headers or derive a
 * client address. It stores only a domain-separated digest of the source key.
 *
 * The default global limit leaves 64 slots of headroom in the console's
 * 256-transaction store. The six-per-source limit permits ordinary retries
 * without allowing one source to occupy that store.
 */
export function createHcnConsoleLoginAdmission({
  now = Date.now,
  perSourceLimit =
    HCN_LOGIN_ADMISSION_DEFAULTS.perSourceLimit,
  perSourceWindowMs =
    HCN_LOGIN_ADMISSION_DEFAULTS.perSourceWindowMs,
  globalLimit = HCN_LOGIN_ADMISSION_DEFAULTS.globalLimit,
  globalWindowMs =
    HCN_LOGIN_ADMISSION_DEFAULTS.globalWindowMs,
  maxUniqueSources =
    HCN_LOGIN_ADMISSION_DEFAULTS.maxUniqueSources,
  failureRetryAfterSeconds =
    HCN_LOGIN_ADMISSION_DEFAULTS.failureRetryAfterSeconds
} = {}) {
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }
  assertCount(perSourceLimit, "perSourceLimit");
  assertWindow(perSourceWindowMs, "perSourceWindowMs");
  assertCount(globalLimit, "globalLimit");
  assertWindow(globalWindowMs, "globalWindowMs");
  assertCount(maxUniqueSources, "maxUniqueSources");
  assertRetryAfter(
    failureRetryAfterSeconds,
    "failureRetryAfterSeconds"
  );
  if (perSourceLimit > globalLimit) {
    throw new TypeError(
      "perSourceLimit must not exceed globalLimit"
    );
  }
  if (
    perSourceLimit * maxUniqueSources >
    MAX_TOTAL_SOURCE_EVENTS
  ) {
    throw new TypeError(
      "perSourceLimit times maxUniqueSources exceeds the memory bound"
    );
  }

  /** @type {Map<string, number[]>} */
  const acceptedBySource = new Map();
  /** @type {number[]} */
  const acceptedGlobally = [];
  let lastTimestamp = -1;

  function admit(sourceKey) {
    if (!isNormalizedSourceKey(sourceKey)) {
      return denied(failureRetryAfterSeconds);
    }

    const timestamp = tryReadNow(now);
    if (
      timestamp === null ||
      (lastTimestamp >= 0 && timestamp < lastTimestamp)
    ) {
      return denied(failureRetryAfterSeconds);
    }
    lastTimestamp = timestamp;
    cleanupAt(timestamp);

    const sourceDigest = digestSource(sourceKey);
    const sourceEvents = acceptedBySource.get(sourceDigest);
    const waits = [];

    if (acceptedGlobally.length >= globalLimit) {
      waits.push(
        waitUntilWindowOpens(
          acceptedGlobally[0],
          globalWindowMs,
          timestamp
        )
      );
    }
    if (sourceEvents?.length >= perSourceLimit) {
      waits.push(
        waitUntilWindowOpens(
          sourceEvents[0],
          perSourceWindowMs,
          timestamp
        )
      );
    }
    if (!sourceEvents && acceptedBySource.size >= maxUniqueSources) {
      waits.push(waitUntilSourceSlotOpens(timestamp));
    }

    if (waits.length > 0) {
      return denied(retryAfterSeconds(Math.max(...waits)));
    }

    const events = sourceEvents ?? [];
    events.push(timestamp);
    if (!sourceEvents) {
      acceptedBySource.set(sourceDigest, events);
    }
    acceptedGlobally.push(timestamp);
    return ADMITTED;
  }

  function cleanup() {
    const timestamp = tryReadNow(now);
    if (
      timestamp === null ||
      (lastTimestamp >= 0 && timestamp < lastTimestamp)
    ) {
      return CLEANUP_FAILED;
    }
    lastTimestamp = timestamp;
    return cleanupAt(timestamp);
  }

  function cleanupAt(timestamp) {
    const globalEventsRemoved = removeExpired(
      acceptedGlobally,
      timestamp - globalWindowMs
    );
    let sourceEventsRemoved = 0;
    let sourcesRemoved = 0;
    for (const [digest, events] of acceptedBySource) {
      sourceEventsRemoved += removeExpired(
        events,
        timestamp - perSourceWindowMs
      );
      if (events.length === 0) {
        acceptedBySource.delete(digest);
        sourcesRemoved += 1;
      }
    }
    return Object.freeze({
      globalEventsRemoved,
      sourceEventsRemoved,
      sourcesRemoved
    });
  }

  function waitUntilSourceSlotOpens(timestamp) {
    let earliest = Number.POSITIVE_INFINITY;
    for (const events of acceptedBySource.values()) {
      if (events.length > 0 && events[0] < earliest) {
        earliest = events[0];
      }
    }
    if (!Number.isSafeInteger(earliest)) {
      return failureRetryAfterSeconds * 1000;
    }
    return waitUntilWindowOpens(
      earliest,
      perSourceWindowMs,
      timestamp
    );
  }

  function stats() {
    const cleanupResult = cleanup();
    if (cleanupResult === CLEANUP_FAILED) {
      return Object.freeze({
        available: false,
        uniqueSources: 0,
        admittedInGlobalWindow: 0,
        perSourceLimit,
        globalLimit,
        maxUniqueSources
      });
    }
    return Object.freeze({
      available: true,
      uniqueSources: acceptedBySource.size,
      admittedInGlobalWindow: acceptedGlobally.length,
      perSourceLimit,
      globalLimit,
      maxUniqueSources
    });
  }

  return Object.freeze({
    admit,
    cleanup,
    stats
  });
}

const ADMITTED = Object.freeze({
  allowed: true,
  retryAfterSeconds: 0
});

const CLEANUP_FAILED = Object.freeze({
  globalEventsRemoved: 0,
  sourceEventsRemoved: 0,
  sourcesRemoved: 0,
  available: false
});

function denied(seconds) {
  return Object.freeze({
    allowed: false,
    retryAfterSeconds: clampRetryAfter(seconds)
  });
}

function retryAfterSeconds(waitMs) {
  if (!Number.isFinite(waitMs) || waitMs <= 0) return 1;
  return Math.ceil(waitMs / 1000);
}

function clampRetryAfter(value) {
  if (!Number.isFinite(value)) return MAX_RETRY_AFTER_SECONDS;
  return Math.max(
    1,
    Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(value))
  );
}

function waitUntilWindowOpens(oldest, windowMs, timestamp) {
  const wait = oldest + windowMs - timestamp;
  return Number.isSafeInteger(wait) && wait > 0 ? wait : 1;
}

function removeExpired(events, cutoff) {
  let count = 0;
  while (count < events.length && events[count] <= cutoff) {
    count += 1;
  }
  if (count > 0) events.splice(0, count);
  return count;
}

function digestSource(sourceKey) {
  return createHash("sha256")
    .update(SOURCE_HASH_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(sourceKey, "utf8")
    .digest("hex");
}

function isNormalizedSourceKey(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= MAX_SOURCE_KEY_BYTES &&
    !/[\u0000-\u0020\u007f-\uffff]/u.test(value)
  );
}

function tryReadNow(now) {
  let value;
  try {
    value = now();
  } catch {
    return null;
  }
  const timestamp = value instanceof Date ? value.getTime() : value;
  return Number.isSafeInteger(timestamp) && timestamp >= 0
    ? timestamp
    : null;
}

function assertWindow(value, name) {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_WINDOW_MS
  ) {
    throw new TypeError(
      `${name} must be a positive safe integer no greater than ${MAX_WINDOW_MS}`
    );
  }
}

function assertCount(value, name) {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_CONFIGURED_COUNT
  ) {
    throw new TypeError(
      `${name} must be a positive safe integer no greater than ${MAX_CONFIGURED_COUNT}`
    );
  }
}

function assertRetryAfter(value, name) {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_RETRY_AFTER_SECONDS
  ) {
    throw new TypeError(
      `${name} must be between 1 and ${MAX_RETRY_AFTER_SECONDS}`
    );
  }
}
