import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_META_SCHEMA_VERSION,
  PLATFORM_SESSION_SCHEMA_VERSION,
  buildPlatformMeta,
  buildPlatformSession
} from "./metadata.js";

const NOW = () => new Date("2026-07-28T18:00:00.000Z");
const NODE_RUNTIME = {
  nodeVersion: "20.19.0",
  platform: "linux",
  architecture: "x64"
};

test("public metadata proves the runtime without exposing environment contents", () => {
  const secret = "never-emit-this-secret";
  const meta = buildPlatformMeta({
    env: {
      RENDER_GIT_COMMIT: "810802542c35625327662e97fd21f7208532b371",
      JOBNIMBUS_API_KEY: secret
    },
    runtime: {
      jobNimbusConfigured: true,
      gmailConfigured: true,
      quoConfigured: true,
      writesAllowed: true,
      gmailSendAllowed: true,
      quoSendAllowed: true,
      releaseGates: {
        ALLOW_CARRIER_FOLLOWUP_CALLS: true,
        ALLOW_CLIENT_COORDINATOR_CALLS: false,
        ALLOW_GMAIL_SEND: true,
        ALLOW_LEGACY_CLIENT_MEMORY_WRITES: false,
        ALLOW_QUO_SEND: true,
        ALLOW_RETELL_CALLS: true,
        ALLOW_VOICE_CALLS: false,
        BRIDGE_ALLOW_WRITES: true
      }
    },
    nodeRuntime: NODE_RUNTIME,
    now: NOW
  });

  assert.equal(meta.schemaVersion, PLATFORM_META_SCHEMA_VERSION);
  assert.equal(meta.build.attested, true);
  assert.equal(meta.build.sourceCommit, "810802542c35625327662e97fd21f7208532b371");
  assert.equal(meta.build.sourceCommitTrust, "provider_attested");
  assert.equal(meta.boundaries.chanceBrain, "legacy_read_only_non_operator_paths");
  assert.equal(meta.boundaries.hcnV2ChanceBrainDataFlow, "disconnected");
  assert.equal(meta.boundaries.jobrolo, "disconnected");
  assert.equal(meta.capabilityCatalog.semantics, "route_authorization_only");
  assert.equal(meta.capabilityCatalog.effectiveAvailability, "combine_with_runtime");
  assert.equal(meta.runtime.configurationDrift.status, "detected");
  assert.deepEqual(
    meta.runtime.configurationDrift.differences.map((item) => item.key),
    ["ALLOW_GMAIL_SEND", "ALLOW_QUO_SEND", "BRIDGE_ALLOW_WRITES"]
  );
  assert.equal(JSON.stringify(meta).includes(secret), false);
});

test("session metadata returns named least-privilege capabilities without identity PII", () => {
  const session = buildPlatformSession({
    identity: {
      type: "codex_operator_token",
      role: "codex_operator",
      subject: "private-subject",
      email: "private@example.test",
      token: "private-token"
    },
    env: {},
    runtime: {},
    nodeRuntime: NODE_RUNTIME,
    now: NOW
  });

  assert.equal(session.schemaVersion, PLATFORM_SESSION_SCHEMA_VERSION);
  assert.equal(session.authenticated, true);
  assert.equal(session.identity.type, "codex_operator");
  assert.equal(session.identity.jobNimbusScope, "assigned");
  assert.equal(session.authorizedCapabilities.includes("platform.session.read"), true);
  assert.match(session.descriptorHash, /^sha256:[a-f0-9]{64}$/);
  const serialized = JSON.stringify(session);
  assert.equal(serialized.includes("private-subject"), false);
  assert.equal(serialized.includes("private@example.test"), false);
  assert.equal(serialized.includes("private-token"), false);
});

test("legacy shared-token sessions fail closed instead of inheriting wildcard authority", () => {
  const session = buildPlatformSession({
    identity: { type: "bridge_token", role: "chance" },
    env: {},
    runtime: {},
    nodeRuntime: NODE_RUNTIME,
    now: NOW
  });

  assert.equal(session.authenticated, false);
  assert.deepEqual(session.authorizedCapabilities, []);
  assert.equal(session.identity.authentication, "unsupported");
});
