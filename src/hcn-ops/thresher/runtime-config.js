import { timingSafeEqual } from "node:crypto";
import path from "node:path";

import { createThresherStore } from "./store.js";

const TENANT_REF_PATTERN = /^tenant_[a-f0-9]{16}$/;
const CANONICAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MIN_KEY_BYTES = 32;
const MAX_KEY_BYTES = 128;

const KEY_NAMES = Object.freeze([
  "HCN_THRESHER_STORE_KEY",
  "HCN_THRESHER_REFERENCE_KEY",
  "HCN_THRESHER_SIGNING_KEY"
]);

/**
 * Loads the isolated Thresher foundation without activating persistence.
 *
 * No configured Thresher keys is a supported "not configured" state. Once
 * any dedicated key is supplied, all three keys and the isolated path/tenant
 * boundary must validate or startup fails closed.
 */
export function loadThresherRuntimeConfiguration(
  environment = {},
  { disallowedSecrets = [] } = {}
) {
  const values = readValues(environment);
  const suppliedKeys = KEY_NAMES.filter((name) => values[name]);

  if (suppliedKeys.length === 0) {
    return unavailableConfiguration();
  }
  if (suppliedKeys.length !== KEY_NAMES.length) {
    fail(
      "partial_configuration",
      "All dedicated Thresher keys must be configured together."
    );
  }

  const operationsRoot = requireIsolatedRoot(values.HCN_OPERATIONS_ROOT);
  const storePath = requireIsolatedStorePath(
    values.HCN_THRESHER_STORE_PATH,
    operationsRoot
  );
  if (!TENANT_REF_PATTERN.test(values.HCN_TENANT_ID)) {
    fail(
      "invalid_tenant",
      "HCN_TENANT_ID must be an exact opaque HCN tenant reference."
    );
  }

  const keyBytes = new Map();
  try {
    for (const name of KEY_NAMES) {
      keyBytes.set(name, decodeCanonicalKey(values[name], name));
    }
    assertDedicatedKeysAreDistinct(keyBytes, disallowedSecrets);

    // Construction validates the encrypted-store contract without reading or
    // creating a file. Persistence remains inactive until a reviewed caller
    // explicitly asks this configuration for its private store.
    const storeProbe = createThresherStore({
      filePath: storePath,
      encryptionKey: values.HCN_THRESHER_STORE_KEY,
      tenantRef: values.HCN_TENANT_ID
    });
    storeProbe.close();
  } finally {
    for (const bytes of keyBytes.values()) bytes.fill(0);
  }

  const createStore = () =>
    createThresherStore({
      filePath: storePath,
      encryptionKey: values.HCN_THRESHER_STORE_KEY,
      tenantRef: values.HCN_TENANT_ID
    });

  return Object.freeze({
    ready: true,
    status: "ready_not_active",
    persistenceActive: false,
    requireStore() {
      return createStore();
    }
  });
}

export function projectThresherRuntimeConfiguration(configuration) {
  if (configuration?.ready === true) {
    return Object.freeze({
      ready: true,
      status: "ready_not_active",
      persistenceActive: false
    });
  }
  return Object.freeze({
    ready: false,
    status: "not_configured",
    persistenceActive: false
  });
}

export class ThresherRuntimeConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ThresherRuntimeConfigurationError";
    this.code = `hcn_thresher_${code}`;
    this.statusCode = 503;
  }
}

function unavailableConfiguration() {
  return Object.freeze({
    ready: false,
    status: "not_configured",
    persistenceActive: false,
    requireStore() {
      throw new ThresherRuntimeConfigurationError(
        "not_configured",
        "The isolated Thresher store is not configured."
      );
    }
  });
}

function readValues(environment) {
  if (
    environment === null
    || (typeof environment !== "object" && typeof environment !== "function")
  ) {
    return Object.fromEntries([
      "HCN_OPERATIONS_ROOT",
      "HCN_TENANT_ID",
      "HCN_THRESHER_STORE_PATH",
      ...KEY_NAMES
    ].map((name) => [name, ""]));
  }
  return Object.fromEntries([
    "HCN_OPERATIONS_ROOT",
    "HCN_TENANT_ID",
    "HCN_THRESHER_STORE_PATH",
    ...KEY_NAMES
  ].map((name) => [
    name,
    typeof environment[name] === "string" ? environment[name].trim() : ""
  ]));
}

function requireIsolatedRoot(value) {
  if (!value || !path.isAbsolute(value)) {
    fail(
      "unsafe_root",
      "HCN_OPERATIONS_ROOT must be an absolute HCN-only path."
    );
  }
  const resolved = path.resolve(value);
  if (
    resolved === path.parse(resolved).root
    || resolved === path.resolve("/var/data")
  ) {
    fail(
      "unsafe_root",
      "HCN_OPERATIONS_ROOT must not be a filesystem or shared data root."
    );
  }
  return resolved;
}

function requireIsolatedStorePath(value, operationsRoot) {
  if (!value || !path.isAbsolute(value)) {
    fail(
      "unsafe_store_path",
      "HCN_THRESHER_STORE_PATH must be absolute."
    );
  }
  const resolved = path.resolve(value);
  const thresherRoot = path.join(operationsRoot, "thresher");
  if (!resolved.startsWith(`${thresherRoot}${path.sep}`)) {
    fail(
      "unsafe_store_path",
      "HCN_THRESHER_STORE_PATH must be inside the dedicated Thresher subtree."
    );
  }
  return resolved;
}

function decodeCanonicalKey(value, name) {
  if (!CANONICAL_BASE64URL_PATTERN.test(value)) {
    fail("invalid_key", `${name} must be canonical unpadded base64url.`);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    fail("invalid_key", `${name} must be canonical unpadded base64url.`);
  }
  if (
    bytes.byteLength < MIN_KEY_BYTES
    || bytes.byteLength > MAX_KEY_BYTES
    || bytes.toString("base64url") !== value
  ) {
    bytes.fill(0);
    fail(
      "invalid_key",
      `${name} must encode ${MIN_KEY_BYTES}-${MAX_KEY_BYTES} key bytes.`
    );
  }
  return bytes;
}

function assertDedicatedKeysAreDistinct(keyBytes, disallowedSecrets) {
  const entries = [...keyBytes.entries()];
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < entries.length;
      rightIndex += 1
    ) {
      if (equalBytes(entries[leftIndex][1], entries[rightIndex][1])) {
        fail(
          "reused_key",
          `${entries[leftIndex][0]} must be different from ${entries[rightIndex][0]}.`
        );
      }
    }
  }

  for (const [keyName, bytes] of entries) {
    for (const item of Array.isArray(disallowedSecrets)
      ? disallowedSecrets
      : []) {
      const label = String(item?.name || "another service secret");
      const value = typeof item?.value === "string" ? item.value : "";
      if (!value) continue;
      if (
        equalBytes(bytes, Buffer.from(value, "utf8"))
        || (
          CANONICAL_BASE64URL_PATTERN.test(value)
          && equalBytes(bytes, Buffer.from(value, "base64url"))
        )
      ) {
        fail(
          "reused_key",
          `${keyName} must be different from ${label}.`
        );
      }
    }
  }
}

function equalBytes(left, right) {
  return (
    left.byteLength === right.byteLength
    && timingSafeEqual(left, right)
  );
}

function fail(code, message) {
  throw new ThresherRuntimeConfigurationError(code, message);
}
