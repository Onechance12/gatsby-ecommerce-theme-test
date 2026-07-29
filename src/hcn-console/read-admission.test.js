import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HCN_READ_ADMISSION_DEFAULTS,
  HcnReadAdmissionError,
  createHcnReadAdmissionController
} from "./read-admission.js";

const START = Date.parse("2026-07-28T18:00:00.000Z");
const SESSION_A = "a".repeat(64);
const SESSION_B = "b".repeat(64);
const SESSION_C = "c".repeat(64);

function fixture(configuration = {}) {
  let timestamp = configuration.start ?? START;
  const controller = createHcnReadAdmissionController({
    now: () => timestamp,
    concurrentLimit: 2,
    requestLimit: 4,
    windowMs: 1_000,
    maxTrackedSessions: 4,
    idleTtlMs: 2_000,
    ...configuration.options
  });
  return {
    controller,
    advance(milliseconds) {
      timestamp += milliseconds;
    },
    setNow(value) {
      timestamp = value;
    }
  };
}

function expectLimited(execute, retryAfterSeconds) {
  assert.throws(execute, (error) => {
    assert.equal(error instanceof HcnReadAdmissionError, true);
    assert.equal(error.code, "read_admission_limited");
    assert.equal(error.statusCode, 429);
    assert.equal(error.retryAfterSeconds, retryAfterSeconds);
    assert.equal(Object.isFrozen(error), true);
    return true;
  });
}

test("defaults are safely bounded", () => {
  assert.equal(HCN_READ_ADMISSION_DEFAULTS.concurrentLimit, 3);
  assert.equal(HCN_READ_ADMISSION_DEFAULTS.requestLimit, 60);
  assert.equal(
    HCN_READ_ADMISSION_DEFAULTS.concurrentLimit <
      HCN_READ_ADMISSION_DEFAULTS.requestLimit,
    true
  );
  assert.equal(
    HCN_READ_ADMISSION_DEFAULTS.requestLimit *
      HCN_READ_ADMISSION_DEFAULTS.maxTrackedSessions <=
      100_000,
    true
  );
  assert.equal(Object.isFrozen(HCN_READ_ADMISSION_DEFAULTS), true);
});

test("enter atomically enforces the per-session concurrency limit", () => {
  const { controller } = fixture();
  const releaseOne = controller.enter(SESSION_A);
  const releaseTwo = controller.enter(SESSION_A);

  expectLimited(() => controller.enter(SESSION_A), 1);
  assert.deepEqual(controller.stats(), {
    available: true,
    trackedSessions: 1,
    activeRequests: 2,
    requestsInWindow: 2,
    concurrentLimit: 2,
    requestLimit: 4,
    maxTrackedSessions: 4
  });

  releaseOne();
  const releaseThree = controller.enter(SESSION_A);
  assert.equal(controller.stats().activeRequests, 2);
  releaseTwo();
  releaseThree();
});

test("release is frozen and idempotent without refunding window use", () => {
  const { controller } = fixture();
  const release = controller.enter(SESSION_A);

  assert.equal(Object.isFrozen(release), true);
  assert.equal(release(), true);
  assert.equal(release(), false);
  assert.equal(release(), false);
  assert.equal(controller.stats().activeRequests, 0);
  assert.equal(controller.stats().requestsInWindow, 1);
});

test("rolling window denies, reports bounded retry, and refills exactly", () => {
  const clock = fixture({
    options: {
      concurrentLimit: 1,
      requestLimit: 2,
      windowMs: 1_500,
      idleTtlMs: 2_000
    }
  });

  clock.controller.enter(SESSION_A)();
  clock.advance(500);
  clock.controller.enter(SESSION_A)();
  expectLimited(() => clock.controller.enter(SESSION_A), 1);

  clock.advance(999);
  expectLimited(() => clock.controller.enter(SESSION_A), 1);
  clock.advance(1);
  clock.controller.enter(SESSION_A)();
  assert.equal(clock.controller.stats().requestsInWindow, 2);
});

test("sessions have independent concurrency and request windows", () => {
  const { controller } = fixture();
  const releaseAOne = controller.enter(SESSION_A);
  const releaseATwo = controller.enter(SESSION_A);
  expectLimited(() => controller.enter(SESSION_A), 1);

  const releaseBOne = controller.enter(SESSION_B);
  const releaseBTwo = controller.enter(SESSION_B);
  expectLimited(() => controller.enter(SESSION_B), 1);

  assert.equal(controller.stats().trackedSessions, 2);
  assert.equal(controller.stats().activeRequests, 4);
  releaseAOne();
  releaseATwo();
  releaseBOne();
  releaseBTwo();
});

test("tracked-session capacity is bounded and idle sessions are pruned", () => {
  const clock = fixture({
    options: {
      maxTrackedSessions: 2
    }
  });
  clock.controller.enter(SESSION_A)();
  clock.advance(250);
  clock.controller.enter(SESSION_B)();

  expectLimited(() => clock.controller.enter(SESSION_C), 2);
  assert.equal(clock.controller.stats().trackedSessions, 2);

  clock.advance(1_750);
  const releaseC = clock.controller.enter(SESSION_C);
  assert.equal(clock.controller.stats().trackedSessions, 2);
  assert.deepEqual(clock.controller.cleanup(), {
    available: true,
    requestsPruned: 0,
    sessionsPruned: 0
  });
  releaseC();
});

test("active entries are not pruned even after the idle interval", () => {
  const clock = fixture({
    options: {
      maxTrackedSessions: 1
    }
  });
  const release = clock.controller.enter(SESSION_A);
  clock.advance(10_000);

  expectLimited(() => clock.controller.enter(SESSION_B), 1);
  assert.equal(clock.controller.stats().trackedSessions, 1);
  release();
  assert.deepEqual(clock.controller.cleanup(), {
    available: true,
    requestsPruned: 0,
    sessionsPruned: 1
  });
});

test("configuration and bindings reject malformed input without mutation", () => {
  const invalidConfigurations = [
    null,
    [],
    { unknownLimit: 1 },
    { now: 1 },
    { concurrentLimit: 0 },
    { concurrentLimit: 3, requestLimit: 2 },
    { requestLimit: 0 },
    { windowMs: 0 },
    { windowMs: 2_000, idleTtlMs: 1_999 },
    { maxTrackedSessions: 0 },
    { failureRetryAfterSeconds: 3_601 },
    { requestLimit: 101, maxTrackedSessions: 1_000 }
  ];
  for (const configuration of invalidConfigurations) {
    assert.throws(
      () => createHcnReadAdmissionController(configuration),
      TypeError
    );
  }

  const { controller } = fixture();
  for (const binding of [
    null,
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    `${"a".repeat(63)}\n`,
    { value: SESSION_A }
  ]) {
    assert.throws(() => controller.enter(binding), TypeError);
  }
  assert.equal(controller.stats().trackedSessions, 0);
});

test("clock failure and rollback fail closed with a privacy-safe 429", () => {
  const privateClockDetail =
    "private-session@example.test provider-token-secret";
  const failedClock = createHcnReadAdmissionController({
    now: () => {
      throw new Error(privateClockDetail);
    },
    failureRetryAfterSeconds: 7
  });
  expectLimited(() => failedClock.enter(SESSION_A), 7);
  assert.deepEqual(failedClock.stats(), {
    available: false,
    trackedSessions: 0,
    activeRequests: 0,
    requestsInWindow: 0,
    concurrentLimit: 3,
    requestLimit: 60,
    maxTrackedSessions: 512
  });

  const clock = fixture();
  clock.controller.enter(SESSION_A)();
  clock.advance(-1);
  expectLimited(() => clock.controller.enter(SESSION_A), 1);
});

test("errors, stats, cleanup, and controller projections expose no binding", () => {
  const rawBinding = "d".repeat(64);
  const clock = fixture({
    options: {
      concurrentLimit: 1,
      requestLimit: 1,
      failureRetryAfterSeconds: 9
    }
  });
  const release = clock.controller.enter(rawBinding);
  let admissionError;
  try {
    clock.controller.enter(rawBinding);
  } catch (error) {
    admissionError = error;
  }

  const serialized = JSON.stringify({
    controller: clock.controller,
    error: admissionError,
    stats: clock.controller.stats(),
    cleanup: clock.controller.cleanup()
  });
  assert.equal(serialized.includes(rawBinding), false);
  assert.equal(serialized.includes("sessionBinding"), false);
  assert.equal(serialized.includes("provider"), false);
  assert.doesNotMatch(serialized, /token|secret|cookie|authorization/i);
  release();
});

test("configuration mutation cannot alter a constructed controller", () => {
  let timestamp = START;
  const configuration = {
    now: () => timestamp,
    concurrentLimit: 1,
    requestLimit: 2,
    windowMs: 1_000,
    maxTrackedSessions: 2,
    idleTtlMs: 2_000,
    failureRetryAfterSeconds: 4
  };
  const controller = createHcnReadAdmissionController(configuration);
  configuration.concurrentLimit = 20;
  configuration.requestLimit = 20;
  configuration.maxTrackedSessions = 20;
  configuration.now = () => timestamp + 100_000;

  const release = controller.enter(SESSION_A);
  expectLimited(() => controller.enter(SESSION_A), 4);
  assert.equal(controller.stats().concurrentLimit, 1);
  assert.equal(controller.stats().requestLimit, 2);
  assert.equal(controller.stats().maxTrackedSessions, 2);
  release();
  timestamp += 1_000;
  controller.enter(SESSION_A)();
});

test("source import boundary excludes providers and stateful subsystems", async () => {
  const source = await readFile(
    new URL("./read-admission.js", import.meta.url),
    "utf8"
  );
  const imports = [
    ...source.matchAll(
      /(?:import\s+[\s\S]*?\s+from\s+|import\s*)["']([^"']+)["']/g
    )
  ].map((match) => match[1].toLowerCase());

  assert.deepEqual(imports, ["node:crypto"]);
  for (const forbidden of [
    "provider",
    "persistence",
    "memory",
    "brain",
    "jobrolo",
    "server"
  ]) {
    assert.equal(
      imports.some((specifier) => specifier.includes(forbidden)),
      false
    );
  }
});
