import test from "node:test";
import assert from "node:assert/strict";
import { getBuildInfo } from "./build-info.js";

const FIXED_RUNTIME = Object.freeze({
  nodeVersion: "22.17.1",
  platform: "linux",
  architecture: "x64"
});

test("build info returns deterministic attested metadata from safe inputs", () => {
  const result = getBuildInfo({
    env: {
      RENDER_GIT_COMMIT: "810802542C35625327662E97FD21F7208532B371",
      RENDER_BUILD_ID: "build-20260728.1",
      RENDER_DEPLOY_ID: "dep-codex_42"
    },
    runtime: FIXED_RUNTIME
  });

  assert.deepEqual(result, {
    service: "jobnimbus-chatgpt-bridge",
    apiVersion: "v1",
    schemaVersion: "0.1.0",
    sourceCommit: "810802542c35625327662e97fd21f7208532b371",
    sourceCommitTrust: "provider_attested",
    buildId: "build-20260728.1",
    deployId: "dep-codex_42",
    runtime: {
      name: "node",
      version: "22.17.1",
      platform: "linux",
      architecture: "x64"
    },
    attested: true
  });
});

test("build info supports fixed fallback metadata keys", () => {
  const result = getBuildInfo({
    env: {
      RENDER_GIT_COMMIT: " ",
      GITHUB_SHA: "abcdef0123456789",
      GITHUB_RUN_ID: "1234567",
      DEPLOY_ID: "deploy-safe"
    },
    runtime: {
      versions: { node: "v20.19.0" },
      platform: "WIN32",
      arch: "ARM64"
    }
  });

  assert.equal(result.sourceCommit, "abcdef0123456789");
  assert.equal(result.sourceCommitTrust, "declared");
  assert.equal(result.buildId, "1234567");
  assert.equal(result.deployId, "deploy-safe");
  assert.deepEqual(result.runtime, {
    name: "node",
    version: "20.19.0",
    platform: "win32",
    architecture: "arm64"
  });
  assert.equal(result.attested, false);
});

test("build info fails closed and never emits unsafe or unrelated environment values", () => {
  const secretMarker = "do-not-leak-this-value";
  const result = getBuildInfo({
    env: {
      RENDER_GIT_COMMIT: `8108025;${secretMarker}`,
      GITHUB_SHA: "abcdef0123456789",
      RENDER_BUILD_ID: `build/${secretMarker}`,
      RENDER_DEPLOY_ID: "deploy-safe",
      JOBNIMBUS_API_KEY: secretMarker,
      DATABASE_URL: `postgres://${secretMarker}`
    },
    runtime: {
      nodeVersion: `22.17.1 ${secretMarker}`,
      platform: `linux/${secretMarker}`,
      architecture: "x64"
    }
  });

  assert.equal(result.sourceCommit, null);
  assert.equal(result.sourceCommitTrust, "invalid");
  assert.equal(result.buildId, null);
  assert.equal(result.deployId, "deploy-safe");
  assert.equal(result.runtime.version, "unknown");
  assert.equal(result.runtime.platform, "unknown");
  assert.equal(result.runtime.architecture, "x64");
  assert.equal(result.attested, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secretMarker));
});

test("build info is explicit when no source revision is available", () => {
  const result = getBuildInfo({ env: {}, runtime: FIXED_RUNTIME });

  assert.equal(result.sourceCommit, null);
  assert.equal(result.sourceCommitTrust, "unavailable");
  assert.equal(result.buildId, null);
  assert.equal(result.deployId, null);
  assert.equal(result.attested, false);
});

test("caller-declared short commits are visible but never provider-attested", () => {
  const result = getBuildInfo({
    env: { SOURCE_COMMIT: "deadbee" },
    runtime: FIXED_RUNTIME
  });

  assert.equal(result.sourceCommit, "deadbee");
  assert.equal(result.sourceCommitTrust, "declared");
  assert.equal(result.attested, false);
});
