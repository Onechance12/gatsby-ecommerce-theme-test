import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HcnGoogleGrantStoreError,
  createHcnGoogleGrantStore
} from "./hcn-google-grant-store.js";

const KEY = Buffer.alloc(32, 0x41).toString("base64url");
const OTHER_KEY = Buffer.alloc(32, 0x42).toString("base64url");
const PRINCIPAL = "principal_0123456789abcdef0123456789abcdef";
const OTHER_PRINCIPAL =
  "principal_fedcba9876543210fedcba9876543210";
const REFRESH_TOKEN = "refresh-token-secret-value";
const ACCESS_TOKEN = "access-token-secret-value";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.modify"
];
const START = Date.parse("2026-07-29T12:00:00.000Z");
const ACCESS_EXPIRY = "2026-07-29T13:00:00.000Z";

async function fixture(t, options = {}) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "hcn-google-grants-")
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "private", "google-grants.json");
  let timestamp = options.timestamp ?? START;
  const store = createHcnGoogleGrantStore({
    filePath,
    encryptionKey: options.encryptionKey || KEY,
    now: () => timestamp,
    maxRecords: options.maxRecords,
    maxFileBytes: options.maxFileBytes
  });
  return {
    root,
    filePath,
    store,
    setTime(value) {
      timestamp = value;
    }
  };
}

function grantInput(overrides = {}) {
  return {
    principalRef: PRINCIPAL,
    refreshToken: REFRESH_TOKEN,
    scopes: SCOPES,
    accessToken: ACCESS_TOKEN,
    accessExpiresAt: ACCESS_EXPIRY,
    ...overrides
  };
}

function lookup(principalRef = PRINCIPAL) {
  return { principalRef };
}

function assertStoreError(error, code) {
  assert.ok(error instanceof HcnGoogleGrantStoreError);
  assert.equal(error.code, code);
  return true;
}

test("requires a dedicated canonical 32-128 byte base64url key and absolute path", () => {
  const filePath = path.join(
    os.tmpdir(),
    "hcn-google-grant-key-test.json"
  );
  for (const encryptionKey of [
    "",
    "not base64url",
    Buffer.alloc(31).toString("base64url"),
    Buffer.alloc(129).toString("base64url"),
    `${KEY}=`
  ]) {
    assert.throws(
      () => createHcnGoogleGrantStore({
        filePath,
        encryptionKey
      }),
      (error) => assertStoreError(error, "invalid_configuration")
    );
  }
  assert.throws(
    () => createHcnGoogleGrantStore({
      filePath: "relative/grants.json",
      encryptionKey: KEY
    }),
    (error) => assertStoreError(error, "invalid_configuration")
  );

  const valid = createHcnGoogleGrantStore({
    filePath,
    encryptionKey: Buffer.alloc(128, 0x7a).toString("base64url")
  });
  assert.deepEqual(Object.keys(valid), [
    "get",
    "upsert",
    "revoke",
    "status"
  ]);
});

test("missing store reports an exact non-linked status without creating files", async (t) => {
  const { filePath, store } = await fixture(t);
  assert.deepEqual(await store.status(lookup()), {
    schema: "hcn.google.connector.grant-status",
    schemaVersion: "1.0.0",
    provider: "google",
    principalRef: PRINCIPAL,
    state: "not_linked",
    scopes: [],
    hasRefreshGrant: false,
    accessCredential: "not_cached",
    createdAt: "",
    updatedAt: "",
    revokedAt: ""
  });
  assert.equal(await store.get(lookup()), null);
  await assert.rejects(lstat(filePath), { code: "ENOENT" });
});

test("upsert persists only an authenticated encrypted envelope and returns safe status", async (t) => {
  const { filePath, store } = await fixture(t);
  const result = await store.upsert(grantInput());

  assert.deepEqual(result, {
    schema: "hcn.google.connector.grant-status",
    schemaVersion: "1.0.0",
    provider: "google",
    principalRef: PRINCIPAL,
    state: "linked",
    scopes: [...SCOPES].sort(),
    hasRefreshGrant: true,
    accessCredential: "fresh",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    revokedAt: ""
  });

  const raw = await readFile(filePath, "utf8");
  assert.doesNotMatch(raw, /refresh-token|access-token|@|google-subject/i);
  const envelope = JSON.parse(raw);
  assert.deepEqual(Object.keys(envelope).sort(), [
    "algorithm",
    "ciphertext",
    "keyDerivation",
    "nonce",
    "schema",
    "schemaVersion",
    "tag"
  ]);
  assert.equal(envelope.schema, "hcn.google.connector.grants.encrypted");
  assert.equal(envelope.schemaVersion, "1.0.0");
  assert.equal(envelope.algorithm, "A256GCM");
  assert.equal(envelope.keyDerivation, "HKDF-SHA256");
  assert.match(envelope.nonce, /^[A-Za-z0-9_-]+$/);
  assert.match(envelope.ciphertext, /^[A-Za-z0-9_-]+$/);
  assert.match(envelope.tag, /^[A-Za-z0-9_-]+$/);

  if (process.platform !== "win32") {
    const metadata = await lstat(filePath);
    assert.equal(metadata.mode & 0o077, 0);
  }
});

test("get exposes credentials only as non-enumerable private properties and JSON is status-only", async (t) => {
  const { store } = await fixture(t);
  await store.upsert(grantInput());
  const grant = await store.get(lookup());

  assert.ok(grant);
  assert.equal(grant.refreshToken, REFRESH_TOKEN);
  assert.equal(grant.accessToken, ACCESS_TOKEN);
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(
      grant,
      "refreshToken"
    ),
    false
  );
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(
      grant,
      "accessToken"
    ),
    false
  );
  assert.doesNotMatch(
    JSON.stringify(grant),
    /refresh-token|access-token/
  );
  assert.deepEqual(JSON.parse(JSON.stringify(grant)), {
    schema: "hcn.google.connector.grant-status",
    schemaVersion: "1.0.0",
    provider: "google",
    principalRef: PRINCIPAL,
    state: "linked",
    scopes: [...SCOPES].sort(),
    hasRefreshGrant: true,
    accessCredential: "fresh",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    revokedAt: ""
  });
  assert.doesNotMatch(
    JSON.stringify({ ...grant }),
    /refresh-token|access-token/
  );
});

test("status distinguishes fresh, expired, and uncached access credentials", async (t) => {
  const { store, setTime } = await fixture(t);
  await store.upsert(grantInput());
  setTime(Date.parse(ACCESS_EXPIRY));
  assert.equal(
    (await store.status(lookup())).accessCredential,
    "expired"
  );

  setTime(START + 2 * 60 * 60 * 1000);
  await store.upsert({
    principalRef: PRINCIPAL,
    refreshToken: "replacement-refresh-token",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"]
  });
  const status = await store.status(lookup());
  assert.equal(status.accessCredential, "not_cached");
  assert.deepEqual(status.scopes, [
    "https://www.googleapis.com/auth/gmail.modify"
  ]);
  assert.equal(status.createdAt, "2026-07-29T12:00:00.000Z");
  assert.equal(status.updatedAt, "2026-07-29T14:00:00.000Z");
});

test("revoke is idempotent, persists a tombstone, and removes active credentials", async (t) => {
  const { filePath, store, setTime } = await fixture(t);
  await store.upsert(grantInput());
  setTime(START + 60_000);

  const revoked = await store.revoke(lookup());
  assert.equal(revoked.state, "revoked");
  assert.equal(revoked.hasRefreshGrant, false);
  assert.equal(revoked.accessCredential, "not_cached");
  assert.equal(revoked.revokedAt, "2026-07-29T12:01:00.000Z");
  assert.equal(await store.get(lookup()), null);
  assert.deepEqual(await store.revoke(lookup()), revoked);

  const reopened = createHcnGoogleGrantStore({
    filePath,
    encryptionKey: KEY,
    now: () => START + 120_000
  });
  assert.equal((await reopened.status(lookup())).state, "revoked");
  assert.equal(await reopened.get(lookup()), null);
  assert.doesNotMatch(
    await readFile(filePath, "utf8"),
    /refresh-token|access-token/
  );
});

test("unknown revoke remains non-linked and does not allocate a store", async (t) => {
  const { filePath, store } = await fixture(t);
  const result = await store.revoke(lookup());
  assert.equal(result.state, "not_linked");
  await assert.rejects(lstat(filePath), { code: "ENOENT" });
});

test("input schemas, principal references, scopes, credentials, and instants fail closed", async (t) => {
  const { store } = await fixture(t);
  const invalidLookups = [
    {},
    { principalRef: PRINCIPAL, email: "person@example.test" },
    { principalRef: "person@example.test" },
    { principalRef: "principal_ABCDEF0123456789ABCDEF0123456789" }
  ];
  for (const input of invalidLookups) {
    await assert.rejects(
      store.status(input),
      (error) => assertStoreError(error, "invalid_input")
    );
  }

  const invalidUpserts = [
    { ...grantInput(), email: "person@example.test" },
    grantInput({ scopes: [] }),
    grantInput({ scopes: [SCOPES[0], SCOPES[0]] }),
    grantInput({ scopes: ["scope with spaces"] }),
    grantInput({ refreshToken: "short" }),
    (() => {
      const input = grantInput();
      delete input.accessExpiresAt;
      return input;
    })(),
    grantInput({ accessExpiresAt: "2026-07-29T13:00:00Z" })
  ];
  for (const input of invalidUpserts) {
    await assert.rejects(
      store.upsert(input),
      (error) => assertStoreError(error, "invalid_input")
    );
  }
  assert.equal((await store.status(lookup())).state, "not_linked");
});

test("wrong key, ciphertext tampering, envelope drift, and malformed JSON fail closed", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.upsert(grantInput());

  const wrongKeyStore = createHcnGoogleGrantStore({
    filePath,
    encryptionKey: OTHER_KEY
  });
  await assert.rejects(
    wrongKeyStore.status(lookup()),
    (error) => assertStoreError(error, "store_corrupt")
  );

  const original = JSON.parse(await readFile(filePath, "utf8"));
  const tampered = {
    ...original,
    ciphertext:
      (original.ciphertext[0] === "A" ? "B" : "A")
      + original.ciphertext.slice(1)
  };
  await writeFile(filePath, `${JSON.stringify(tampered)}\n`);
  await assert.rejects(
    store.get(lookup()),
    (error) => assertStoreError(error, "store_corrupt")
  );
  await assert.rejects(
    store.upsert(grantInput({
      principalRef: OTHER_PRINCIPAL
    })),
    (error) => assertStoreError(error, "store_corrupt")
  );

  await writeFile(
    filePath,
    `${JSON.stringify({ ...original, unexpected: true })}\n`
  );
  await assert.rejects(
    store.status(lookup()),
    (error) => assertStoreError(error, "store_corrupt")
  );

  await writeFile(filePath, "{not-json");
  await assert.rejects(
    store.status(lookup()),
    (error) => assertStoreError(error, "store_corrupt")
  );
});

test("oversize and non-file store paths fail closed without silent reset", async (t) => {
  const { filePath, store } = await fixture(t, {
    maxFileBytes: 1024
  });
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.alloc(1025, 0x41));
  await assert.rejects(
    store.status(lookup()),
    (error) => assertStoreError(error, "store_corrupt")
  );
  await assert.rejects(
    store.upsert(grantInput()),
    (error) => assertStoreError(error, "store_corrupt")
  );

  await rm(filePath, { force: true });
  await mkdir(filePath);
  await assert.rejects(
    store.status(lookup()),
    (error) => assertStoreError(error, "unsafe_store_path")
  );
});

test("symlinked file and parent paths are rejected", async (t) => {
  const { root } = await fixture(t);
  const realDirectory = path.join(root, "real");
  const realFile = path.join(realDirectory, "grants.json");
  const linkedFile = path.join(root, "linked-grants.json");
  const linkedDirectory = path.join(root, "linked-directory");
  await mkdir(realDirectory);
  await writeFile(realFile, "{}");

  try {
    await symlink(realFile, linkedFile, "file");
    await symlink(realDirectory, linkedDirectory, "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("The current Windows account cannot create test symlinks.");
      return;
    }
    throw error;
  }

  const fileLinkStore = createHcnGoogleGrantStore({
    filePath: linkedFile,
    encryptionKey: KEY
  });
  await assert.rejects(
    fileLinkStore.status(lookup()),
    (error) => assertStoreError(error, "unsafe_store_path")
  );

  const parentLinkStore = createHcnGoogleGrantStore({
    filePath: path.join(linkedDirectory, "new-grants.json"),
    encryptionKey: KEY
  });
  await assert.rejects(
    parentLinkStore.upsert(grantInput()),
    (error) => assertStoreError(error, "unsafe_store_path")
  );
});

test("bounded record capacity is enforced and existing grants remain intact", async (t) => {
  const { store } = await fixture(t, { maxRecords: 1 });
  await store.upsert(grantInput());
  await assert.rejects(
    store.upsert(grantInput({
      principalRef: OTHER_PRINCIPAL,
      refreshToken: "other-refresh-token"
    })),
    (error) => assertStoreError(error, "capacity_exceeded")
  );
  assert.equal(
    (await store.get(lookup())).refreshToken,
    REFRESH_TOKEN
  );
  assert.equal(
    (await store.status(lookup(OTHER_PRINCIPAL))).state,
    "not_linked"
  );
});

test("oversize replacement is rejected before rename and preserves the previous valid store", async (t) => {
  const { filePath, store } = await fixture(t, {
    maxFileBytes: 1400
  });
  await store.upsert({
    principalRef: PRINCIPAL,
    refreshToken: REFRESH_TOKEN,
    scopes: [SCOPES[0]]
  });
  const before = await readFile(filePath);

  await assert.rejects(
    store.upsert({
      principalRef: OTHER_PRINCIPAL,
      refreshToken: "r".repeat(800),
      accessToken: "a".repeat(300),
      accessExpiresAt: ACCESS_EXPIRY,
      scopes: SCOPES
    }),
    (error) => assertStoreError(error, "store_oversize")
  );
  assert.deepEqual(await readFile(filePath), before);
  assert.equal(
    (await store.get(lookup())).refreshToken,
    REFRESH_TOKEN
  );
});

test("concurrent mutations are serialized and leave no temporary files", async (t) => {
  const { filePath, store } = await fixture(t, {
    maxRecords: 32
  });
  const principals = Array.from({ length: 20 }, (_value, index) =>
    `principal_${index.toString(16).padStart(32, "0")}`
  );
  await Promise.all(
    principals.map((principalRef, index) =>
      store.upsert({
        principalRef,
        refreshToken: `refresh-token-${index.toString().padStart(2, "0")}`,
        scopes: [SCOPES[index % SCOPES.length]]
      })
    )
  );
  for (const principalRef of principals) {
    assert.equal(
      (await store.status({ principalRef })).state,
      "linked"
    );
  }
  const names = await readdir(path.dirname(filePath));
  assert.deepEqual(names, [path.basename(filePath)]);
});

test("reopening with the same key preserves exact active grant material", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.upsert(grantInput());
  const reopened = createHcnGoogleGrantStore({
    filePath,
    encryptionKey: KEY,
    now: () => START
  });
  const grant = await reopened.get(lookup());
  assert.equal(grant.refreshToken, REFRESH_TOKEN);
  assert.equal(grant.accessToken, ACCESS_TOKEN);
  assert.deepEqual(grant.scopes, [...SCOPES].sort());
});

test("invalid randomness and clock providers fail closed without credentials in errors", async (t) => {
  const { root } = await fixture(t);
  const filePath = path.join(root, "failure", "grants.json");
  const badRandomStore = createHcnGoogleGrantStore({
    filePath,
    encryptionKey: KEY,
    randomBytes: () => Buffer.alloc(1)
  });
  await assert.rejects(
    badRandomStore.upsert(grantInput()),
    (error) => {
      assertStoreError(error, "randomness_unavailable");
      assert.doesNotMatch(
        error.message,
        /refresh-token|access-token/
      );
      return true;
    }
  );

  const badClockStore = createHcnGoogleGrantStore({
    filePath,
    encryptionKey: KEY,
    now: () => Number.NaN,
    randomBytes
  });
  await assert.rejects(
    badClockStore.status(lookup()),
    (error) => assertStoreError(error, "clock_unavailable")
  );
});
