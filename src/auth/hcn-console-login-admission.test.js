import assert from "node:assert/strict";
import test from "node:test";

import {
  HCN_LOGIN_ADMISSION_DEFAULTS,
  createHcnConsoleLoginAdmission
} from "./hcn-console-login-admission.js";

function fixture(options = {}) {
  let timestamp = options.start ?? 1_800_000_000_000;
  const admission = createHcnConsoleLoginAdmission({
    now: () => timestamp,
    ...options.config
  });
  return {
    admission,
    advance(ms) {
      timestamp += ms;
    },
    setNow(value) {
      timestamp = value;
    }
  };
}

test("defaults leave transaction headroom and bound one source", () => {
  assert.equal(HCN_LOGIN_ADMISSION_DEFAULTS.perSourceLimit, 6);
  assert.equal(HCN_LOGIN_ADMISSION_DEFAULTS.globalLimit, 192);
  assert.equal(
    HCN_LOGIN_ADMISSION_DEFAULTS.globalLimit < 256,
    true
  );

  const { admission } = fixture();
  for (
    let index = 0;
    index < HCN_LOGIN_ADMISSION_DEFAULTS.perSourceLimit;
    index += 1
  ) {
    assert.deepEqual(admission.admit("198.51.100.7"), {
      allowed: true,
      retryAfterSeconds: 0
    });
  }
  assert.deepEqual(admission.admit("198.51.100.7"), {
    allowed: false,
    retryAfterSeconds: 600
  });
  assert.equal(admission.stats().admittedInGlobalWindow, 6);
});

test("sustained per-source flood stays denied without growing memory", () => {
  const clock = fixture({
    config: {
      perSourceLimit: 3,
      perSourceWindowMs: 60_000,
      globalLimit: 20,
      globalWindowMs: 60_000,
      maxUniqueSources: 10
    }
  });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(clock.admission.admit("source-a").allowed, true);
  }
  for (let index = 0; index < 10_000; index += 1) {
    const result = clock.admission.admit("source-a");
    assert.equal(result.allowed, false);
    assert.equal(result.retryAfterSeconds, 60);
  }
  assert.deepEqual(clock.admission.stats(), {
    available: true,
    uniqueSources: 1,
    admittedInGlobalWindow: 3,
    perSourceLimit: 3,
    globalLimit: 20,
    maxUniqueSources: 10
  });
});

test("distributed sources are stopped by the global window limit", () => {
  const clock = fixture({
    config: {
      perSourceLimit: 4,
      perSourceWindowMs: 60_000,
      globalLimit: 8,
      globalWindowMs: 30_000,
      maxUniqueSources: 20
    }
  });
  for (let index = 0; index < 8; index += 1) {
    assert.equal(
      clock.admission.admit(`edge-${index}`).allowed,
      true
    );
  }
  assert.deepEqual(clock.admission.admit("edge-nine"), {
    allowed: false,
    retryAfterSeconds: 30
  });
  assert.equal(clock.admission.stats().uniqueSources, 8);
});

test("limits recover exactly when their rolling windows expire", () => {
  const clock = fixture({
    config: {
      perSourceLimit: 2,
      perSourceWindowMs: 10_000,
      globalLimit: 3,
      globalWindowMs: 10_000,
      maxUniqueSources: 3
    }
  });
  assert.equal(clock.admission.admit("source-a").allowed, true);
  clock.advance(1_000);
  assert.equal(clock.admission.admit("source-a").allowed, true);
  assert.equal(clock.admission.admit("source-b").allowed, true);
  assert.deepEqual(clock.admission.admit("source-c"), {
    allowed: false,
    retryAfterSeconds: 9
  });

  clock.advance(8_999);
  assert.equal(clock.admission.admit("source-a").allowed, false);
  clock.advance(1);
  assert.equal(clock.admission.admit("source-c").allowed, true);
  assert.deepEqual(clock.admission.cleanup(), {
    globalEventsRemoved: 0,
    sourceEventsRemoved: 0,
    sourcesRemoved: 0
  });
});

test("unique-source capacity is bounded and recovers after cleanup", () => {
  const clock = fixture({
    config: {
      perSourceLimit: 2,
      perSourceWindowMs: 5_000,
      globalLimit: 10,
      globalWindowMs: 5_000,
      maxUniqueSources: 3
    }
  });
  assert.equal(clock.admission.admit("source-a").allowed, true);
  assert.equal(clock.admission.admit("source-b").allowed, true);
  assert.equal(clock.admission.admit("source-c").allowed, true);
  for (let index = 0; index < 1_000; index += 1) {
    assert.deepEqual(clock.admission.admit(`distributed-${index}`), {
      allowed: false,
      retryAfterSeconds: 5
    });
  }
  assert.equal(clock.admission.stats().uniqueSources, 3);

  clock.advance(5_000);
  assert.deepEqual(clock.admission.cleanup(), {
    globalEventsRemoved: 3,
    sourceEventsRemoved: 3,
    sourcesRemoved: 3
  });
  assert.equal(clock.admission.admit("source-new").allowed, true);
  assert.equal(clock.admission.stats().uniqueSources, 1);
});

test("invalid source and clock input fail closed with bounded retry", () => {
  const clock = fixture();
  for (const source of [
    null,
    "",
    " source",
    "source ",
    "two sources",
    "line\nbreak",
    "x".repeat(513)
  ]) {
    assert.deepEqual(clock.admission.admit(source), {
      allowed: false,
      retryAfterSeconds: 60
    });
  }
  assert.equal(clock.admission.stats().admittedInGlobalWindow, 0);

  const failedClock = createHcnConsoleLoginAdmission({
    now: () => {
      throw new Error("clock details must not escape");
    },
    failureRetryAfterSeconds: 7
  });
  assert.deepEqual(failedClock.admit("source-a"), {
    allowed: false,
    retryAfterSeconds: 7
  });
  assert.equal(failedClock.stats().available, false);

  clock.setNow(Number.POSITIVE_INFINITY);
  assert.deepEqual(clock.admission.admit("source-a"), {
    allowed: false,
    retryAfterSeconds: 60
  });
});

test("retry output is integer-bounded and clock rollback fails closed", () => {
  const clock = fixture({
    config: {
      perSourceLimit: 1,
      perSourceWindowMs: 24 * 60 * 60 * 1000,
      globalLimit: 2,
      globalWindowMs: 24 * 60 * 60 * 1000,
      maxUniqueSources: 2
    }
  });
  assert.equal(clock.admission.admit("source-a").allowed, true);
  assert.deepEqual(clock.admission.admit("source-a"), {
    allowed: false,
    retryAfterSeconds: 3_600
  });
  clock.advance(-1);
  assert.deepEqual(clock.admission.admit("source-b"), {
    allowed: false,
    retryAfterSeconds: 60
  });
});

test("serialized results expose no raw source, digest, secrets, or PII", () => {
  const { admission } = fixture();
  const rawSource = "chance@example.test";
  const decision = admission.admit(rawSource);
  const serialized = JSON.stringify({
    admission,
    decision,
    stats: admission.stats(),
    cleanup: admission.cleanup()
  });
  assert.equal(serialized.includes(rawSource), false);
  assert.equal(serialized.includes("chance"), false);
  assert.equal(serialized.includes("example.test"), false);
  assert.doesNotMatch(serialized, /[a-f0-9]{64}/);
  assert.doesNotMatch(
    serialized,
    /token|secret|cookie|authorization/i
  );
});

test("configuration rejects unsafe or effectively unbounded policies", () => {
  for (const config of [
    { perSourceLimit: 0 },
    { perSourceWindowMs: 0 },
    { globalLimit: 0 },
    { globalWindowMs: 24 * 60 * 60 * 1000 + 1 },
    { maxUniqueSources: 0 },
    { failureRetryAfterSeconds: 3_601 },
    { perSourceLimit: 10, globalLimit: 9 },
    {
      perSourceLimit: 1_001,
      globalLimit: 2_000,
      maxUniqueSources: 100
    }
  ]) {
    assert.throws(
      () => createHcnConsoleLoginAdmission(config),
      TypeError
    );
  }
});
