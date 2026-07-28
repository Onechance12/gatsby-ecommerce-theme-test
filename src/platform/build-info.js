const SERVICE = "jobnimbus-chatgpt-bridge";
const API_VERSION = "v1";
const SCHEMA_VERSION = "0.1.0";

// Only these non-secret environment variables are inspected. Do not replace
// this allowlist with enumeration of process.env.
const DECLARED_SOURCE_COMMIT_KEYS = Object.freeze([
  "SOURCE_COMMIT",
  "GIT_COMMIT",
  "COMMIT_SHA",
  "GITHUB_SHA"
]);
const BUILD_ID_KEYS = Object.freeze([
  "RENDER_BUILD_ID",
  "BUILD_ID",
  "GITHUB_RUN_ID"
]);
const DEPLOY_ID_KEYS = Object.freeze([
  "RENDER_DEPLOY_ID",
  "DEPLOY_ID"
]);
const SAFE_PROVIDER_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const SAFE_DECLARED_COMMIT = /^[a-f0-9]{7,64}$/i;
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const SAFE_RUNTIME_TOKEN = /^[a-z0-9][a-z0-9._+-]{0,63}$/i;
const SAFE_NODE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i;

/**
 * Return privacy-safe, deterministic runtime metadata.
 *
 * `attested` means that Render supplied a full valid source commit through its
 * provider-owned RENDER_GIT_COMMIT variable. Caller-controlled fallback values
 * are labeled `declared` and never treated as deployment proof. Build and
 * deploy IDs are supplemental and are never proof of the source revision.
 */
export function getBuildInfo(options = {}) {
  const env = isRecord(options.env) ? options.env : process.env;
  const runtime = isRecord(options.runtime)
    ? options.runtime
    : {
        nodeVersion: process.versions?.node,
        platform: process.platform,
        architecture: process.arch
      };

  const sourceRevision = readSourceRevision(env);
  const buildId = readAllowedValue(env, BUILD_ID_KEYS, normalizeId);
  const deployId = readAllowedValue(env, DEPLOY_ID_KEYS, normalizeId);

  return {
    service: SERVICE,
    apiVersion: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    sourceCommit: sourceRevision.sourceCommit,
    sourceCommitTrust: sourceRevision.sourceCommitTrust,
    buildId,
    deployId,
    runtime: {
      name: "node",
      version: normalizeNodeVersion(runtime.nodeVersion ?? runtime.versions?.node) ?? "unknown",
      platform: normalizeRuntimeToken(runtime.platform) ?? "unknown",
      architecture: normalizeRuntimeToken(runtime.architecture ?? runtime.arch) ?? "unknown"
    },
    attested: sourceRevision.sourceCommitTrust === "provider_attested"
  };
}

function readSourceRevision(env) {
  const renderCommit = readConfiguredValue(env, "RENDER_GIT_COMMIT");
  if (renderCommit.configured) {
    const sourceCommit = normalizeProviderCommit(renderCommit.value);
    return {
      sourceCommit,
      sourceCommitTrust: sourceCommit ? "provider_attested" : "invalid"
    };
  }

  for (const key of DECLARED_SOURCE_COMMIT_KEYS) {
    const candidate = readConfiguredValue(env, key);
    if (!candidate.configured) continue;
    const sourceCommit = normalizeDeclaredCommit(candidate.value);
    return {
      sourceCommit,
      sourceCommitTrust: sourceCommit ? "declared" : "invalid"
    };
  }

  return {
    sourceCommit: null,
    sourceCommitTrust: "unavailable"
  };
}

function readConfiguredValue(env, key) {
  if (!Object.prototype.hasOwnProperty.call(env, key)) {
    return { configured: false, value: "" };
  }
  const value = env[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    return { configured: false, value: "" };
  }
  return { configured: true, value };
}

function readAllowedValue(env, keys, normalize) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) continue;
    const raw = env[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;

    // Fail closed on the first configured candidate. Falling through from an
    // invalid higher-priority value could conceal a bad production setting.
    return normalize(raw);
  }
  return null;
}

function normalizeProviderCommit(value) {
  const normalized = String(value).trim();
  return SAFE_PROVIDER_COMMIT.test(normalized) ? normalized.toLowerCase() : null;
}

function normalizeDeclaredCommit(value) {
  const normalized = String(value).trim();
  return SAFE_DECLARED_COMMIT.test(normalized) ? normalized.toLowerCase() : null;
}

function normalizeId(value) {
  const normalized = String(value).trim();
  return SAFE_ID.test(normalized) ? normalized : null;
}

function normalizeNodeVersion(value) {
  const normalized = String(value ?? "").trim().replace(/^v/i, "");
  return SAFE_NODE_VERSION.test(normalized) ? normalized : null;
}

function normalizeRuntimeToken(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SAFE_RUNTIME_TOKEN.test(normalized) ? normalized : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
