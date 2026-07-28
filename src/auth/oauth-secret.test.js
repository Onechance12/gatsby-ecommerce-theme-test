import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStrongOAuthSessionSecret,
  deriveOAuthPurposeKey,
  oauthSecretsEqual
} from "./oauth-secret.js";

const STRONG_SECRET =
  "f3PMXx7u4ry-random-test-root-secret-4Vd0q9b2";

test("OAuth root secret enforces a bounded printable minimum", () => {
  assert.equal(
    assertStrongOAuthSessionSecret(STRONG_SECRET),
    STRONG_SECRET
  );
  assert.equal(
    assertStrongOAuthSessionSecret("", { required: false }),
    ""
  );
  for (const value of [
    "",
    "short",
    "x".repeat(31),
    ` ${"x".repeat(40)}`,
    `${"x".repeat(40)} `,
    `${"x".repeat(20)}\n${"x".repeat(20)}`,
    "é".repeat(32),
    "x".repeat(1025)
  ]) {
    assert.throws(
      () => assertStrongOAuthSessionSecret(value),
      /OAUTH_SESSION_SECRET/
    );
  }
});

test("purpose derivation is deterministic and domain separated", () => {
  const hcn = deriveOAuthPurposeKey(
    STRONG_SECRET,
    "hcn-console-state:v1"
  );
  const broker = deriveOAuthPurposeKey(
    STRONG_SECRET,
    "gpt-broker:v1"
  );
  assert.equal(hcn.length, 32);
  assert.equal(broker.length, 32);
  assert.deepEqual(
    hcn,
    deriveOAuthPurposeKey(
      STRONG_SECRET,
      "hcn-console-state:v1"
    )
  );
  assert.notDeepEqual(hcn, broker);
  assert.equal(hcn.includes(Buffer.from(STRONG_SECRET)), false);
});

test("secret equality is constant-width and type safe", () => {
  assert.equal(oauthSecretsEqual(STRONG_SECRET, STRONG_SECRET), true);
  assert.equal(
    oauthSecretsEqual(STRONG_SECRET, `${STRONG_SECRET}x`),
    false
  );
  assert.equal(oauthSecretsEqual(null, STRONG_SECRET), false);
});
