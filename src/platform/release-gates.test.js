import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RELEASE_GATE_DEFAULTS,
  RELEASE_GATE_KEYS,
  readReleaseGates
} from "./release-gates.js";

const RENDER_MANIFEST_PATH = fileURLToPath(
  new URL("../../render.yaml", import.meta.url)
);
const PACKAGE_MANIFEST_PATH = fileURLToPath(
  new URL("../../package.json", import.meta.url)
);
const DOCKERIGNORE_PATH = fileURLToPath(
  new URL("../../.dockerignore", import.meta.url)
);
const NPMIGNORE_PATH = fileURLToPath(
  new URL("../../.npmignore", import.meta.url)
);

test("release gate defaults are immutable and expose a stable sorted key list", () => {
  assert.equal(Object.isFrozen(RELEASE_GATE_DEFAULTS), true);
  assert.equal(Object.isFrozen(RELEASE_GATE_KEYS), true);
  assert.deepEqual(RELEASE_GATE_KEYS, [...RELEASE_GATE_KEYS].sort());
  assert.deepEqual(Object.keys(RELEASE_GATE_DEFAULTS).sort(), RELEASE_GATE_KEYS);
});

test("all release-critical render manifest gates match the code defaults", () => {
  const manifestValues = parseRenderEnvValues(
    readFileSync(RENDER_MANIFEST_PATH, "utf8")
  );

  assert.equal(RELEASE_GATE_KEYS.length, 8);
  for (const key of RELEASE_GATE_KEYS) {
    assert.equal(
      manifestValues.has(key),
      true,
      `render.yaml is missing release gate ${key}`
    );
    assert.equal(
      manifestValues.get(key) === "true",
      RELEASE_GATE_DEFAULTS[key],
      `render.yaml release gate ${key} drifted from the code default`
    );
  }

  const manifestEffectGates = [...manifestValues.keys()]
    .filter((key) =>
      key === "BRIDGE_ALLOW_WRITES"
      || key === "HCN_ACTION_EXECUTION_ENABLED"
      || (key.startsWith("ALLOW_") && key !== "ALLOW_GOOGLE_USER_AUTH"))
    .sort();
  assert.deepEqual(
    manifestEffectGates,
    RELEASE_GATE_KEYS,
    "render.yaml contains an effect gate that is not monitored by release-gates.js"
  );
});

test("release gate parsing is exact and fails closed", () => {
  const gates = readReleaseGates({
    BRIDGE_ALLOW_WRITES: "true",
    ALLOW_GMAIL_SEND: "TRUE",
    ALLOW_QUO_SEND: " true ",
    ALLOW_VOICE_CALLS: true,
    ALLOW_RETELL_CALLS: "true",
    ALLOW_CLIENT_COORDINATOR_CALLS: "false",
    ALLOW_CARRIER_FOLLOWUP_CALLS: "1",
    HCN_ACTION_EXECUTION_ENABLED: "true"
  });

  assert.deepEqual(gates, {
    ALLOW_CARRIER_FOLLOWUP_CALLS: false,
    ALLOW_CLIENT_COORDINATOR_CALLS: false,
    ALLOW_GMAIL_SEND: false,
    ALLOW_QUO_SEND: false,
    ALLOW_RETELL_CALLS: true,
    ALLOW_VOICE_CALLS: false,
    BRIDGE_ALLOW_WRITES: true,
    HCN_ACTION_EXECUTION_ENABLED: true
  });
  assert.equal(Object.isFrozen(gates), true);
});

test("missing runtime gate values stay disabled even when the reviewed production profile enables them", () => {
  assert.deepEqual(readReleaseGates({}), {
    ALLOW_CARRIER_FOLLOWUP_CALLS: false,
    ALLOW_CLIENT_COORDINATOR_CALLS: false,
    ALLOW_GMAIL_SEND: false,
    ALLOW_QUO_SEND: false,
    ALLOW_RETELL_CALLS: false,
    ALLOW_VOICE_CALLS: false,
    BRIDGE_ALLOW_WRITES: false,
    HCN_ACTION_EXECUTION_ENABLED: false
  });
});

test("release gate reader ignores arbitrary environment secrets", () => {
  const secretMarker = "must-not-leak";
  const accessedKeys = [];
  const env = new Proxy(
    {
      ALLOW_RETELL_CALLS: "true",
      JOBNIMBUS_API_KEY: secretMarker,
      DATABASE_URL: `postgres://${secretMarker}`,
      CHANCE_BRAIN_OWNER_TOKEN: secretMarker
    },
    {
      get(target, property, receiver) {
        if (typeof property === "string") accessedKeys.push(property);
        return Reflect.get(target, property, receiver);
      }
    }
  );

  const gates = readReleaseGates(env);

  assert.deepEqual(accessedKeys, RELEASE_GATE_KEYS);
  assert.deepEqual(Object.keys(gates), RELEASE_GATE_KEYS);
  assert.equal(gates.ALLOW_RETELL_CALLS, true);
  assert.doesNotMatch(JSON.stringify(gates), new RegExp(secretMarker));
});

test("production packaging excludes quarantined legacy memory", () => {
  const packageManifest = JSON.parse(
    readFileSync(PACKAGE_MANIFEST_PATH, "utf8")
  );
  const scripts = packageManifest.scripts || {};
  const dockerIgnore = readFileSync(DOCKERIGNORE_PATH, "utf8");
  const npmIgnore = readFileSync(NPMIGNORE_PATH, "utf8");

  assert.equal("memory" in scripts, false);
  assert.doesNotMatch(String(scripts.check || ""), /src\/memory\//);
  assert.match(dockerIgnore, /^src\/memory\/$/m);
  assert.match(npmIgnore, /^src\/memory\/$/m);
  assert.match(npmIgnore, /^memory\/$/m);
  assert.match(npmIgnore, /^data\/memory\/$/m);
});

test("Render uses one HCN-only persistent root and no unwired advisory provider", () => {
  const manifest = readFileSync(RENDER_MANIFEST_PATH, "utf8");

  assert.match(manifest, /name:\s+hcn-operations-data/);
  assert.match(manifest, /mountPath:\s+\/var\/data\/hcn-operations/);
  assert.match(
    manifest,
    /key:\s+HCN_OPERATIONS_ROOT\s*\r?\n\s+value:\s+\/var\/data\/hcn-operations/
  );
  assert.match(
    manifest,
    /key:\s+HCN_THRESHER_STORE_PATH\s*\r?\n\s+value:\s+\/var\/data\/hcn-operations\/thresher\/state\.enc\.json/
  );
  for (const key of [
    "HCN_THRESHER_STORE_KEY",
    "HCN_THRESHER_REFERENCE_KEY",
    "HCN_THRESHER_SIGNING_KEY"
  ]) {
    assert.match(
      manifest,
      new RegExp(`key:\\s+${key}\\s*\\r?\\n\\s+sync:\\s+false`)
    );
  }
  assert.doesNotMatch(manifest, /\bMEMORY_ROOT\b/);
  assert.doesNotMatch(
    manifest,
    /\b(?:OPENAI_OPERATIONAL_MODEL|ZAI_API_KEY|ZAI_OPERATIONAL_MODEL|OPERATIONAL_LLM_[A-Z_]+)\b/
  );
  assert.doesNotMatch(manifest, /\/var\/data\/bridge/);
});

function parseRenderEnvValues(source) {
  const values = new Map();
  let currentKey = null;

  for (const line of source.split(/\r?\n/)) {
    const keyMatch = line.match(/^\s*-\s+key:\s+([A-Z0-9_]+)\s*$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      continue;
    }

    if (!currentKey) continue;
    const valueMatch = line.match(
      /^\s+value:\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/
    );
    if (!valueMatch) continue;

    values.set(
      currentKey,
      valueMatch[1] ?? valueMatch[2] ?? valueMatch[3] ?? ""
    );
    currentKey = null;
  }

  return values;
}
