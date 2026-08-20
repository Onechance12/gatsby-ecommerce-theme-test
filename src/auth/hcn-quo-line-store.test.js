import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HcnQuoLineStoreError,
  createHcnQuoLineStore
} from "./hcn-quo-line-store.js";

const KEY = Buffer.alloc(32, 0x41).toString("base64url");
const OTHER_KEY = Buffer.alloc(32, 0x42).toString("base64url");
const IDENTITY = Object.freeze({
  principalRef: `principal_${"a".repeat(32)}`,
  googleSubject: "google-subject-a",
  email: "employee@wavepa.com"
});
const OTHER_IDENTITY = Object.freeze({
  principalRef: `principal_${"b".repeat(32)}`,
  googleSubject: "google-subject-b",
  email: "other@wavepa.com"
});
const LINE = Object.freeze({
  lineId: "quo-line-a",
  lineNumber: "+12145550101",
  lineName: "Employee work line"
});

test("creates an encrypted challenge without serializing its code or identity", async (t) => {
  const fixture = await createFixture(t);
  const challenge = await fixture.store.createChallenge({
    ...IDENTITY,
    ...LINE
  });

  assert.match(challenge.challengeRef, /^quo_challenge_[a-f0-9]{32}$/);
  assert.match(challenge.code, /^\d{6}$/);
  assert.equal(Object.keys(challenge).includes("code"), false);
  assert.equal(JSON.stringify(challenge).includes(challenge.code), false);
  assert.equal(challenge.delivery.to, "***-***-0101");

  const bytes = await readFile(fixture.filePath, "utf8");
  assert.doesNotMatch(bytes, /employee@wavepa\.com/);
  assert.doesNotMatch(bytes, /google-subject-a/);
  assert.doesNotMatch(bytes, /\+12145550101/);
  assert.equal(bytes.includes(challenge.code), false);

  const pending = await fixture.store.getPendingChallenge(IDENTITY);
  assert.equal(pending.challengeRef, challenge.challengeRef);
  assert.equal(pending.lineId, LINE.lineId);
});

test("a correct one-time code atomically creates one immutable employee binding", async (t) => {
  const fixture = await createFixture(t);
  const challenge = await fixture.store.createChallenge({
    ...IDENTITY,
    ...LINE
  });
  const binding = await fixture.store.verifyChallenge({
    ...IDENTITY,
    code: challenge.code
  });

  assert.equal(binding.state, "linked");
  assert.equal(binding.lineId, LINE.lineId);
  assert.equal(binding.lineNumber, LINE.lineNumber);
  assert.equal(
    (await fixture.store.getBinding(IDENTITY)).lineId,
    LINE.lineId
  );
  assert.equal(
    (await fixture.store.status(IDENTITY)).pendingChallenge,
    null
  );
  await assert.rejects(
    fixture.store.verifyChallenge({
      ...IDENTITY,
      code: challenge.code
    }),
    (error) => assertStoreError(error, "challenge_not_found", 409)
  );
});

test("unrestricted HCN sign-in supports an externally hosted employee email", async (t) => {
  const fixture = await createFixture(t, { allowedDomain: "" });
  const identity = {
    ...IDENTITY,
    email: "richard@titanrecon.com"
  };
  const challenge = await fixture.store.createChallenge({
    ...identity,
    ...LINE
  });
  const binding = await fixture.store.verifyChallenge({
    ...identity,
    code: challenge.code
  });
  assert.equal(binding.state, "linked");
});

test("incorrect attempts persist and the configured limit locks the challenge", async (t) => {
  const fixture = await createFixture(t, { maxAttempts: 2 });
  await fixture.store.createChallenge({ ...IDENTITY, ...LINE });

  await assert.rejects(
    fixture.store.verifyChallenge({ ...IDENTITY, code: "999998" }),
    (error) => assertStoreError(error, "challenge_incorrect", 400)
  );
  const pending = await fixture.store.getPendingChallenge(IDENTITY);
  assert.equal(pending.attempts, 1);

  await assert.rejects(
    fixture.store.verifyChallenge({ ...IDENTITY, code: "999997" }),
    (error) => assertStoreError(error, "challenge_locked", 400)
  );
  assert.equal(
    await fixture.store.getPendingChallenge(IDENTITY),
    null
  );
  assert.equal(await fixture.store.getBinding(IDENTITY), null);
});

test("expired challenges fail closed and cannot create a binding", async (t) => {
  let now = Date.parse("2026-07-29T12:00:00.000Z");
  const fixture = await createFixture(t, {
    now: () => now,
    challengeTtlMs: 60_000,
    challengeWindowMs: 120_000,
    challengeRetentionMs: 120_000,
    minimumChallengeIntervalMs: 0
  });
  const challenge = await fixture.store.createChallenge({
    ...IDENTITY,
    ...LINE
  });
  now += 60_001;

  await assert.rejects(
    fixture.store.verifyChallenge({
      ...IDENTITY,
      code: challenge.code
    }),
    (error) => assertStoreError(error, "challenge_expired", 409)
  );
  assert.equal(await fixture.store.getBinding(IDENTITY), null);
});

test("identity and Quo line ownership cannot cross employee boundaries", async (t) => {
  const fixture = await createFixture(t, {
    minimumChallengeIntervalMs: 0
  });
  const challenge = await fixture.store.createChallenge({
    ...IDENTITY,
    ...LINE
  });
  await assert.rejects(
    fixture.store.getPendingChallenge({
      ...IDENTITY,
      googleSubject: OTHER_IDENTITY.googleSubject
    }),
    (error) => assertStoreError(error, "identity_conflict", 409)
  );
  await fixture.store.verifyChallenge({
    ...IDENTITY,
    code: challenge.code
  });

  await assert.rejects(
    fixture.store.createChallenge({
      ...OTHER_IDENTITY,
      ...LINE
    }),
    (error) => assertStoreError(error, "line_conflict", 409)
  );
});

test("new challenges supersede old codes and enforce issuance bounds", async (t) => {
  let now = Date.parse("2026-07-29T12:00:00.000Z");
  const fixture = await createFixture(t, {
    now: () => now,
    minimumChallengeIntervalMs: 0,
    maxChallengesPerWindow: 2
  });
  const first = await fixture.store.createChallenge({
    ...IDENTITY,
    ...LINE
  });
  now += 1;
  const second = await fixture.store.createChallenge({
    ...IDENTITY,
    ...LINE
  });

  assert.notEqual(first.challengeRef, second.challengeRef);
  assert.equal(
    (await fixture.store.getPendingChallenge(IDENTITY)).challengeRef,
    second.challengeRef
  );
  await fixture.store.verifyChallenge({
    ...IDENTITY,
    code: second.code
  });
  await assert.rejects(
    fixture.store.createChallenge({
      ...IDENTITY,
      lineId: "quo-line-b",
      lineNumber: "+12145550102",
      lineName: "Replacement line"
    }),
    (error) => {
      assertStoreError(error, "challenge_rate_limited", 429);
      assert.equal(error.retryAfterSeconds > 0, true);
      return true;
    }
  );
});

test("cancellation and binding revocation are identity scoped", async (t) => {
  const fixture = await createFixture(t, {
    minimumChallengeIntervalMs: 0
  });
  const challenge = await fixture.store.createChallenge({
    ...IDENTITY,
    ...LINE
  });
  assert.deepEqual(
    await fixture.store.cancelChallenge({
      ...IDENTITY,
      challengeRef: challenge.challengeRef
    }),
    { cancelled: true, challengeRef: challenge.challengeRef }
  );
  assert.equal(await fixture.store.getPendingChallenge(IDENTITY), null);

  const replacement = await fixture.store.createChallenge({
    ...IDENTITY,
    ...LINE
  });
  await fixture.store.verifyChallenge({
    ...IDENTITY,
    code: replacement.code
  });
  assert.deepEqual(
    await fixture.store.revokeBinding(IDENTITY),
    { revoked: true, state: "not_linked" }
  );
  assert.equal(await fixture.store.getBinding(IDENTITY), null);
});

test("corruption and a wrong encryption key fail closed", async (t) => {
  const fixture = await createFixture(t);
  await fixture.store.createChallenge({ ...IDENTITY, ...LINE });

  const wrongKeyStore = createHcnQuoLineStore({
    filePath: fixture.filePath,
    encryptionKey: OTHER_KEY
  });
  await assert.rejects(
    wrongKeyStore.status(IDENTITY),
    (error) => assertStoreError(error, "store_corrupt", 503)
  );

  await writeFile(fixture.filePath, "{\"corrupt\":true}\n", "utf8");
  await assert.rejects(
    fixture.store.status(IDENTITY),
    (error) => assertStoreError(error, "store_corrupt", 503)
  );
});

test("mutations serialize and atomic writes leave no temporary files", async (t) => {
  const fixture = await createFixture(t, {
    minimumChallengeIntervalMs: 0
  });
  await Promise.all([
    fixture.store.createChallenge({ ...IDENTITY, ...LINE }),
    fixture.store.createChallenge({
      ...OTHER_IDENTITY,
      lineId: "quo-line-b",
      lineNumber: "+12145550102",
      lineName: "Other work line"
    })
  ]);
  const files = await readdir(path.dirname(fixture.filePath));
  assert.deepEqual(files, [path.basename(fixture.filePath)]);
  assert.ok(await fixture.store.getPendingChallenge(IDENTITY));
  assert.ok(await fixture.store.getPendingChallenge(OTHER_IDENTITY));
});

test("canonical key, absolute path, exact input, and symlink constraints fail closed", async (t) => {
  assert.throws(
    () => createHcnQuoLineStore({
      filePath: "relative.json",
      encryptionKey: KEY
    }),
    (error) => assertStoreError(error, "invalid_configuration", 500)
  );
  assert.throws(
    () => createHcnQuoLineStore({
      filePath: path.join(os.tmpdir(), "quo-store.json"),
      encryptionKey: "not-canonical=="
    }),
    (error) => assertStoreError(error, "invalid_configuration", 500)
  );

  const fixture = await createFixture(t);
  await assert.rejects(
    fixture.store.createChallenge({
      ...IDENTITY,
      ...LINE,
      unexpected: true
    }),
    (error) => assertStoreError(error, "invalid_input", 400)
  );

  if (process.platform !== "win32") {
    await mkdir(path.dirname(fixture.filePath), { recursive: true });
    const target = path.join(path.dirname(fixture.filePath), "target");
    await writeFile(target, "target", "utf8");
    await symlink(target, fixture.filePath);
    await assert.rejects(
      fixture.store.status(IDENTITY),
      (error) => assertStoreError(error, "unsafe_store_path", 503)
    );
  }
});

async function createFixture(t, overrides = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "hcn-quo-line-store-")
  );
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const filePath = path.join(directory, "private", "quo-lines.enc.json");
  return {
    directory,
    filePath,
    store: createHcnQuoLineStore({
      filePath,
      encryptionKey: KEY,
      ...overrides
    })
  };
}

function assertStoreError(error, code, statusCode) {
  assert.equal(error instanceof HcnQuoLineStoreError, true);
  assert.equal(error.code, code);
  assert.equal(error.statusCode, statusCode);
  return true;
}
