import assert from "node:assert/strict";
import test from "node:test";

import {
  HcnConsoleReferenceConfigurationError,
  loadHcnConsoleReferenceConfiguration,
  projectHcnReferenceConfigurationReadiness
} from "./reference-config.js";

const TENANT_ID = "tenant_0123456789abcdef";

test("loads an HCN reference factory from canonical base64url key material", () => {
  const encodedKey = Buffer.alloc(32, 0x19).toString("base64url");
  const configuration = loadHcnConsoleReferenceConfiguration({
    HCN_TENANT_ID: TENANT_ID,
    HCN_REFERENCE_KEY: encodedKey
  });

  assert.equal(configuration.ready, true);
  assert.deepEqual(configuration.readiness, {
    ready: true,
    status: "ready"
  });

  const references = configuration.requireFactory();
  assert.equal(references.tenantId, TENANT_ID);
  assert.match(
    references.subjectId("jobnimbus", "synthetic-provider-record"),
    /^subject_[a-f0-9]{32}$/
  );
});

test("accepts decoded key sizes from 32 through 128 bytes", () => {
  for (const size of [32, 64, 128]) {
    const configuration = loadHcnConsoleReferenceConfiguration({
      HCN_TENANT_ID: TENANT_ID,
      HCN_REFERENCE_KEY: Buffer.alloc(size, size).toString("base64url")
    });
    assert.equal(configuration.ready, true);
    assert.doesNotThrow(() => configuration.requireFactory());
  }
});

test("missing configuration remains unavailable and fails closed with a typed 503 error", () => {
  for (const environment of [
    {},
    { HCN_TENANT_ID: TENANT_ID },
    {
      HCN_REFERENCE_KEY: Buffer.alloc(32, 0x21).toString("base64url")
    }
  ]) {
    const configuration =
      loadHcnConsoleReferenceConfiguration(environment);
    assert.equal(configuration.ready, false);
    assert.deepEqual(configuration.readiness, {
      ready: false,
      status: "unavailable"
    });
    assert.throws(
      () => configuration.requireFactory(),
      (error) =>
        error instanceof HcnConsoleReferenceConfigurationError &&
        error.statusCode === 503 &&
        error.code === "hcn_reference_configuration_unavailable" &&
        error.message === "HCN reference configuration is unavailable."
    );
  }
});

test("tenant identifiers must match the exact lowercase opaque format", () => {
  const key = Buffer.alloc(32, 0x31).toString("base64url");
  for (const tenantId of [
    "tenant_0123456789abcde",
    "tenant_0123456789abcdef0",
    "tenant_0123456789ABCDEf",
    " tenant_0123456789abcdef",
    "tenant_0123456789abcdef ",
    "org_0123456789abcdef"
  ]) {
    const configuration = loadHcnConsoleReferenceConfiguration({
      HCN_TENANT_ID: tenantId,
      HCN_REFERENCE_KEY: key
    });
    assert.equal(configuration.ready, false);
    assert.throws(
      () => configuration.requireFactory(),
      HcnConsoleReferenceConfigurationError
    );
  }
});

test("rejects plain text, padded, noncanonical, weak, and oversized keys", () => {
  const candidates = [
    "this-is-plain-text-key-material-not-base64url",
    `${Buffer.alloc(32, 0x42).toString("base64url")}=`,
    Buffer.alloc(31, 0x43).toString("base64url"),
    Buffer.alloc(129, 0x44).toString("base64url"),
    "A",
    "AA+/",
    ` ${Buffer.alloc(32, 0x45).toString("base64url")}`,
    `${Buffer.alloc(32, 0x46).toString("base64url")}\n`
  ];

  for (const encodedKey of candidates) {
    const configuration = loadHcnConsoleReferenceConfiguration({
      HCN_TENANT_ID: TENANT_ID,
      HCN_REFERENCE_KEY: encodedKey
    });
    assert.equal(configuration.ready, false);
    assert.throws(
      () => configuration.requireFactory(),
      HcnConsoleReferenceConfigurationError
    );
  }
});

test("errors and readiness projections never expose secret or tenant values", () => {
  const secret = Buffer.alloc(32, 0x51).toString("base64url");
  const unavailable = loadHcnConsoleReferenceConfiguration({
    HCN_TENANT_ID: TENANT_ID,
    HCN_REFERENCE_KEY: `${secret}=`
  });
  let captured;
  try {
    unavailable.requireFactory();
  } catch (error) {
    captured = error;
  }

  const projection = projectHcnReferenceConfigurationReadiness(unavailable);
  const serialized = JSON.stringify({
    configuration: unavailable,
    projection,
    error: {
      name: captured.name,
      code: captured.code,
      statusCode: captured.statusCode,
      message: captured.message
    }
  });

  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(TENANT_ID), false);
  assert.deepEqual(projection, {
    ready: false,
    status: "unavailable"
  });
  assert.equal(Object.isFrozen(projection), true);
});

test("readiness projection fails closed for unknown values", () => {
  assert.deepEqual(projectHcnReferenceConfigurationReadiness(), {
    ready: false,
    status: "unavailable"
  });
  assert.deepEqual(
    projectHcnReferenceConfigurationReadiness({ ready: "true" }),
    {
      ready: false,
      status: "unavailable"
    }
  );
});
