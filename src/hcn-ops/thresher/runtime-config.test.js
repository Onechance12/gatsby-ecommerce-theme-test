import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ThresherRuntimeConfigurationError,
  loadThresherRuntimeConfiguration,
  projectThresherRuntimeConfiguration
} from "./runtime-config.js";

const TENANT = "tenant_0123456789abcdef";
const key = (byte) => Buffer.alloc(32, byte).toString("base64url");

test("missing keys are honestly unavailable and never allocate a store", () => {
  const configuration = loadThresherRuntimeConfiguration({});
  assert.deepEqual(
    projectThresherRuntimeConfiguration(configuration),
    {
      ready: false,
      status: "not_configured",
      persistenceActive: false
    }
  );
  assert.throws(
    () => configuration.requireStore(),
    (error) =>
      error instanceof ThresherRuntimeConfigurationError
      && error.code === "hcn_thresher_not_configured"
      && error.statusCode === 503
  );
});

test("valid dedicated configuration is ready but does not activate persistence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-thresher-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = loadThresherRuntimeConfiguration(
    validEnvironment(root)
  );
  assert.deepEqual(
    projectThresherRuntimeConfiguration(configuration),
    {
      ready: true,
      status: "ready_not_active",
      persistenceActive: false
    }
  );

  const store = configuration.requireStore();
  const snapshot = await store.snapshot({
    tenantRef: TENANT,
    fileRef: "file_0123456789abcdef0123456789abcdef"
  });
  assert.deepEqual(snapshot.authoritativeEvidence, []);
  store.close();
});

test("partial, malformed, broad-root, and escaped-path configuration fails closed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-thresher-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const environment of [
    {
      HCN_THRESHER_STORE_KEY: key(1)
    },
    {
      ...validEnvironment(root),
      HCN_TENANT_ID: "wave"
    },
    {
      ...validEnvironment(root),
      HCN_OPERATIONS_ROOT: path.parse(root).root
    },
    {
      ...validEnvironment(root),
      HCN_THRESHER_STORE_PATH: path.join(root, "platform", "state.json")
    },
    {
      ...validEnvironment(root),
      HCN_THRESHER_SIGNING_KEY: "not+base64"
    }
  ]) {
    assert.throws(
      () => loadThresherRuntimeConfiguration(environment),
      ThresherRuntimeConfigurationError
    );
  }
});

test("Thresher keys are pairwise distinct and cannot reuse another service secret", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-thresher-keys-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = validEnvironment(root);

  assert.throws(
    () =>
      loadThresherRuntimeConfiguration({
        ...environment,
        HCN_THRESHER_SIGNING_KEY: environment.HCN_THRESHER_REFERENCE_KEY
      }),
    /must be different/
  );
  assert.throws(
    () =>
      loadThresherRuntimeConfiguration(environment, {
        disallowedSecrets: [{
          name: "HCN_REFERENCE_KEY",
          value: environment.HCN_THRESHER_STORE_KEY
        }]
      }),
    /HCN_THRESHER_STORE_KEY must be different from HCN_REFERENCE_KEY/
  );
});

function validEnvironment(root) {
  return {
    HCN_OPERATIONS_ROOT: root,
    HCN_TENANT_ID: TENANT,
    HCN_THRESHER_STORE_PATH: path.join(root, "thresher", "state.enc.json"),
    HCN_THRESHER_STORE_KEY: key(1),
    HCN_THRESHER_REFERENCE_KEY: key(2),
    HCN_THRESHER_SIGNING_KEY: key(3)
  };
}
