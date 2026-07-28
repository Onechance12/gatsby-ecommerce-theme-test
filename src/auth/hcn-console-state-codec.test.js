import assert from "node:assert/strict";
import test from "node:test";

import {
  HcnConsoleStateError,
  createHcnConsoleStateCodec,
  isHcnConsoleStateEnvelope
} from "./hcn-console-state-codec.js";

const SECRET =
  "4K3MtzN3QYV0-secure-fixture-root-secret-fx0P";

test("HCN state uses a purpose-separated authenticated envelope", () => {
  const codec = createHcnConsoleStateCodec({
    secret: SECRET,
    randomBytes: (length) => Buffer.alloc(length, 7)
  });
  const payload = {
    kind: "hcn_console_authorize_state",
    transactionId: "A".repeat(43),
    exp: 1_800_000_000_000
  };
  const sealed = codec.seal(payload);
  assert.equal(isHcnConsoleStateEnvelope(sealed), true);
  assert.match(sealed, /^hcn1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(codec.open(sealed), payload);
  assert.equal(sealed.includes(payload.transactionId), false);
  assert.equal(sealed.includes(SECRET), false);
});

test("state tampering, alternate roots, and legacy envelopes fail closed", () => {
  const first = createHcnConsoleStateCodec({
    secret: SECRET,
    randomBytes: (length) => Buffer.alloc(length, 9)
  });
  const second = createHcnConsoleStateCodec({
    secret: `${SECRET}-different`,
    randomBytes: (length) => Buffer.alloc(length, 9)
  });
  const sealed = first.seal({ kind: "fixture", exp: 1 });
  const tampered = `${sealed.slice(0, -1)}${
    sealed.endsWith("A") ? "B" : "A"
  }`;
  for (const value of [
    tampered,
    sealed.replace(/^hcn1/, "legacy"),
    "iv.tag.ciphertext",
    "",
    `hcn1.${"A".repeat(9000)}.tag.ciphertext`
  ]) {
    assert.throws(() => first.open(value), HcnConsoleStateError);
  }
  assert.throws(() => second.open(sealed), HcnConsoleStateError);
  assert.equal(isHcnConsoleStateEnvelope("iv.tag.ciphertext"), false);
});

test("invalid state payloads and cryptographic providers fail closed", () => {
  assert.throws(
    () => createHcnConsoleStateCodec({
      secret: "weak",
      randomBytes: (length) => Buffer.alloc(length)
    }),
    /OAUTH_SESSION_SECRET/
  );
  const wrongIv = createHcnConsoleStateCodec({
    secret: SECRET,
    randomBytes: () => Buffer.alloc(11)
  });
  assert.throws(() => wrongIv.seal({ kind: "fixture" }), HcnConsoleStateError);
  const codec = createHcnConsoleStateCodec({ secret: SECRET });
  assert.throws(() => codec.seal("not-an-object"), HcnConsoleStateError);
  assert.throws(
    () => codec.seal({ value: "x".repeat(5000) }),
    HcnConsoleStateError
  );
});
