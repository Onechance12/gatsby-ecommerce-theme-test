import assert from "node:assert/strict";
import test from "node:test";

import {
  HcnConsoleSessionStoreError,
  createHcnConsoleSessionStore,
  projectPublicHcnSession
} from "./hcn-console-session-store.js";

const PKCE = "v".repeat(43);

function fixture(options = {}) {
  let timestamp = options.start ?? Date.parse("2026-07-28T12:00:00.000Z");
  let sequence = 0;
  const store = createHcnConsoleSessionStore({
    now: () => timestamp,
    randomBytes: (size) => {
      sequence += 1;
      return Buffer.alloc(size, sequence);
    },
    ...options.store
  });
  return {
    store,
    now() {
      return timestamp;
    },
    advance(ms) {
      timestamp += ms;
    }
  };
}

test("login transaction uses opaque credentials and one-shot consumption", () => {
  const { store } = fixture();
  const created = store.createLoginTransaction({
    returnTo: "/hcn/work-center",
    pkceVerifier: PKCE
  });
  assert.match(created.transactionId, /^[A-Za-z0-9_-]{43}$/);
  assert.match(created.bindingId, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(created.transactionId, created.bindingId);
  assert.equal(Object.keys(created).includes("transactionId"), false);
  assert.equal(Object.keys(created).includes("bindingId"), false);
  assert.equal(JSON.stringify(created), '"[REDACTED]"');

  const consumed = store.consumeLoginTransaction({
    transactionId: created.transactionId,
    bindingId: created.bindingId
  });
  assert.equal(consumed.returnTo, "/hcn/work-center");
  assert.equal(consumed.pkceVerifier, PKCE);
  assert.equal(Object.keys(consumed).includes("pkceVerifier"), false);
  assert.equal(JSON.stringify(consumed), '"[REDACTED]"');
  assert.equal(
    store.consumeLoginTransaction({
      transactionId: created.transactionId,
      bindingId: created.bindingId
    }),
    null
  );
});

test("wrong login binding consumes the transaction and prevents replay", () => {
  const { store } = fixture();
  const created = store.createLoginTransaction({
    returnTo: "/hcn",
    pkceVerifier: PKCE
  });
  const other = store.createLoginTransaction({
    returnTo: "/hcn",
    pkceVerifier: PKCE
  });
  assert.equal(
    store.consumeLoginTransaction({
      transactionId: created.transactionId,
      bindingId: other.bindingId
    }),
    null
  );
  assert.equal(
    store.consumeLoginTransaction({
      transactionId: created.transactionId,
      bindingId: created.bindingId
    }),
    null
  );
});

test("login transactions expire after ten minutes and cleanup removes them", () => {
  const clock = fixture();
  const created = clock.store.createLoginTransaction({
    returnTo: "/hcn",
    pkceVerifier: PKCE
  });
  clock.advance(10 * 60 * 1000);
  assert.equal(
    clock.store.consumeLoginTransaction({
      transactionId: created.transactionId,
      bindingId: created.bindingId
    }),
    null
  );

  clock.store.createLoginTransaction({
    returnTo: "/hcn",
    pkceVerifier: PKCE
  });
  clock.advance(10 * 60 * 1000);
  assert.deepEqual(clock.store.cleanup(), {
    loginTransactionsRemoved: 1,
    sessionsRemoved: 0
  });
});

test("transaction creation accepts only exact minimal OAuth state", () => {
  const { store } = fixture();
  for (const input of [
    null,
    {},
    { returnTo: "/hcn", pkceVerifier: "short" },
    {
      returnTo: "/hcn",
      pkceVerifier: PKCE,
      clientData: { claim: "must not be accepted" }
    },
    { returnTo: "https://evil.test/hcn", pkceVerifier: PKCE }
  ]) {
    assert.throws(
      () => store.createLoginTransaction(input),
      Error
    );
  }
});

test("session creation yields 256-bit ids and stores minimal auth state", () => {
  const { store } = fixture();
  const created = store.createSession({
    subject: "google-subject-123",
    googleSubject: "provider-subject-123",
    role: "manager"
  });
  assert.match(created.sessionId, /^[A-Za-z0-9_-]{43}$/);
  assert.match(created.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.subject, "google-subject-123");
  assert.equal(created.googleSubject, "provider-subject-123");
  assert.equal(created.role, "manager");
  assert.equal(created.authenticated, true);
  assert.equal(created.authentication, "hcn_browser_session");
  assert.equal(Object.keys(created).includes("sessionId"), false);
  assert.equal(Object.keys(created).includes("csrfToken"), false);
  assert.equal(Object.keys(created).includes("subject"), false);
  assert.equal(Object.keys(created).includes("googleSubject"), false);
  assert.equal(JSON.stringify(created).includes("google-subject"), false);
  assert.equal(JSON.stringify(created).includes("provider-subject"), false);
  assert.equal(JSON.stringify(created).includes(created.sessionId), false);
  assert.equal(JSON.stringify(created).includes(created.csrfToken), false);

  const resolved = store.resolveSession(created.sessionId);
  assert.equal(resolved.subject, "google-subject-123");
  assert.equal(resolved.googleSubject, "provider-subject-123");
  assert.equal(resolved.role, "manager");
  assert.equal(resolved.csrfToken, created.csrfToken);
  assert.equal(JSON.stringify(resolved).includes("google-subject"), false);
  assert.equal(JSON.stringify(resolved).includes("provider-subject"), false);
  assert.equal(JSON.stringify(resolved).includes(created.csrfToken), false);
});

test("public session projection is exact and contains no bearer or identity secret", () => {
  const { store } = fixture();
  const created = store.createSession({
    subject: "private-subject",
    googleSubject: "private-provider-subject",
    role: "chance"
  });
  const projected = projectPublicHcnSession(created);
  assert.deepEqual(Object.keys(projected), [
    "authenticated",
    "authentication",
    "role",
    "createdAt",
    "lastSeenAt",
    "idleExpiresAt",
    "expiresAt"
  ]);
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /private-subject/);
  assert.doesNotMatch(serialized, /private-provider-subject/);
  assert.doesNotMatch(serialized, new RegExp(created.sessionId));
  assert.doesNotMatch(serialized, new RegExp(created.csrfToken));
  assert.equal(Object.isFrozen(projected), true);
  assert.deepEqual(projectPublicHcnSession(null), {
    authenticated: false,
    authentication: "none"
  });
});

test("session CSRF validation is exact and fails closed", () => {
  const { store } = fixture();
  const first = store.createSession({
    subject: "subject-a",
    googleSubject: "provider-subject-a",
    role: "manager"
  });
  const second = store.createSession({
    subject: "subject-b",
    googleSubject: "provider-subject-b",
    role: "manager"
  });
  assert.equal(
    store.validateSessionCsrf(first.sessionId, first.csrfToken),
    true
  );
  assert.equal(
    store.validateSessionCsrf(first.sessionId, second.csrfToken),
    false
  );
  assert.equal(
    store.validateSessionCsrf(second.sessionId, first.csrfToken),
    false
  );
  assert.equal(store.validateSessionCsrf("bad", first.csrfToken), false);
  assert.equal(store.validateSessionCsrf(first.sessionId, "bad"), false);
});

test("sessions enforce 60-minute idle expiration", () => {
  const clock = fixture();
  const created = clock.store.createSession({
    subject: "subject",
    googleSubject: "provider-subject",
    role: "manager"
  });
  clock.advance(60 * 60 * 1000 - 1);
  assert.ok(clock.store.resolveSession(created.sessionId));
  clock.advance(1);
  assert.equal(clock.store.resolveSession(created.sessionId), null);
});

test("touch extends idle lifetime but never the 12-hour absolute lifetime", () => {
  const clock = fixture();
  const created = clock.store.createSession({
    subject: "subject",
    googleSubject: "provider-subject",
    role: "manager"
  });

  for (let hour = 1; hour <= 12; hour += 1) {
    clock.advance(60 * 60 * 1000 - 1);
    const touched = clock.store.touchSession(created.sessionId);
    assert.ok(touched);
    assert.equal(touched.expiresAt, created.expiresAt);
  }
  clock.advance(
    Date.parse(created.expiresAt) - clock.now()
  );
  assert.equal(clock.store.touchSession(created.sessionId), null);
});

test("revokeSession and revokeSubject invalidate the exact intended sessions", () => {
  const { store } = fixture();
  const a1 = store.createSession({
    subject: "subject-a",
    googleSubject: "provider-subject-a",
    role: "manager"
  });
  const a2 = store.createSession({
    subject: "subject-a",
    googleSubject: "provider-subject-a",
    role: "manager"
  });
  const b = store.createSession({
    subject: "subject-b",
    googleSubject: "provider-subject-b",
    role: "manager"
  });

  assert.equal(store.revokeSession(a1.sessionId), true);
  assert.equal(store.revokeSession(a1.sessionId), false);
  assert.equal(store.resolveSession(a1.sessionId), null);
  assert.equal(store.revokeSubject("subject-a"), 1);
  assert.equal(store.resolveSession(a2.sessionId), null);
  assert.ok(store.resolveSession(b.sessionId));
  assert.equal(store.revokeSubject(" subject-b"), 0);
});

test("cleanup removes expired sessions and reports bounded safe counts", () => {
  const clock = fixture();
  clock.store.createSession({
    subject: "subject",
    googleSubject: "provider-subject",
    role: "manager"
  });
  assert.deepEqual(clock.store.stats(), {
    loginTransactions: 0,
    sessions: 1,
    maxTransactions: 256,
    maxSessions: 1024
  });
  clock.advance(60 * 60 * 1000);
  assert.deepEqual(clock.store.cleanup(), {
    loginTransactionsRemoved: 0,
    sessionsRemoved: 1
  });
  assert.equal(clock.store.stats().sessions, 0);
});

test("bounded stores fail closed instead of evicting live auth state", () => {
  const transactions = fixture({
    store: { maxTransactions: 1 }
  }).store;
  transactions.createLoginTransaction({
    returnTo: "/hcn",
    pkceVerifier: PKCE
  });
  assert.throws(
    () => transactions.createLoginTransaction({
      returnTo: "/hcn",
      pkceVerifier: PKCE
    }),
    /capacity/
  );

  const sessions = fixture({
    store: { maxSessions: 1 }
  }).store;
  sessions.createSession({
    subject: "a",
    googleSubject: "provider-subject-a",
    role: "manager"
  });
  assert.throws(
    () => sessions.createSession({
      subject: "b",
      googleSubject: "provider-subject-b",
      role: "manager"
    }),
    /capacity/
  );
});

test("session creation rejects unknown client/file fields and malformed auth state", () => {
  const { store } = fixture();
  const invalid = [
    null,
    {},
    { subject: "", role: "manager" },
    { subject: "subject\n", role: "manager" },
    { subject: "subject", role: "Manager" },
    {
      subject: "subject",
      googleSubject: "",
      role: "manager"
    },
    {
      subject: "subject",
      googleSubject: "provider subject",
      role: "manager"
    },
    { subject: "subject", role: "manager", claimNumber: "forbidden" },
    { subject: "subject", role: "manager", file: {} }
  ];
  for (const input of invalid) {
    assert.throws(
      () => store.createSession(input),
      HcnConsoleSessionStoreError
    );
  }
});

test("random and clock injection fail closed on invalid providers", () => {
  const shortRandom = createHcnConsoleSessionStore({
    now: () => 1,
    randomBytes: () => Buffer.alloc(31)
  });
  assert.throws(
    () => shortRandom.createSession({
      subject: "subject",
      googleSubject: "provider-subject",
      role: "manager"
    }),
    /exactly 32/
  );

  const badClock = createHcnConsoleSessionStore({
    now: () => Number.NaN
  });
  assert.throws(
    () => badClock.createSession({
      subject: "subject",
      googleSubject: "provider-subject",
      role: "manager"
    }),
    /Clock/
  );
});

test("domain separation means identical raw bytes do not create raw map-key collisions", () => {
  const repeated = Buffer.alloc(32, 0x77);
  const store = createHcnConsoleSessionStore({
    now: () => 1,
    randomBytes: () => repeated
  });
  const transaction = store.createLoginTransaction({
    returnTo: "/hcn",
    pkceVerifier: PKCE
  });
  const session = store.createSession({
    subject: "subject",
    googleSubject: "provider-subject",
    role: "manager"
  });
  assert.equal(transaction.transactionId, session.sessionId);
  assert.ok(store.resolveSession(session.sessionId));
  assert.ok(
    store.consumeLoginTransaction({
      transactionId: transaction.transactionId,
      bindingId: transaction.bindingId
    })
  );
});
