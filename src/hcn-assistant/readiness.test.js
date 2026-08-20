import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHcnAssistantConversationStore } from "./conversation-store.js";

const CORRECT_KEY = Buffer.alloc(32, 0x51).toString("base64url");
const WRONG_KEY = Buffer.alloc(32, 0x52).toString("base64url");
const REFERENCE_KEY = Buffer.alloc(32, 0x53).toString("base64url");

test("assistant readiness authenticates existing encrypted history", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-history-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const historyPath = path.join(
    root,
    "platform",
    "assistant-conversations.enc.json"
  );
  const store = createHcnAssistantConversationStore({
    filePath: historyPath,
    encryptionKey: CORRECT_KEY
  });
  await store.create({
    principalRef: `principal_${"1".repeat(32)}`,
    scope: "assigned",
    kind: "general",
    fileRef: "",
    title: "Readiness fixture"
  });
  const original = await readFile(historyPath);

  const correct = await startHealthServer({ root, historyKey: CORRECT_KEY });
  t.after(() => stopChild(correct.child));
  assert.equal(correct.health.hcnAssistant.historyConfigured, true);
  assert.equal(
    correct.health.hcnAssistant.historyReady,
    true,
    JSON.stringify(correct.health.hcnConsole?.referenceConfiguration || {})
  );
  assert.equal(correct.health.hcnAssistant.ready, true);
  await stopChild(correct.child);

  const wrong = await startHealthServer({ root, historyKey: WRONG_KEY });
  t.after(() => stopChild(wrong.child));
  assert.equal(wrong.health.hcnAssistant.historyConfigured, true);
  assert.equal(wrong.health.hcnAssistant.historyReady, false);
  assert.equal(wrong.health.hcnAssistant.ready, false);
  await stopChild(wrong.child);

  const tampered = Buffer.from(original);
  tampered[Math.floor(tampered.length / 2)] ^= 0x01;
  await writeFile(historyPath, tampered);
  const corrupt = await startHealthServer({ root, historyKey: CORRECT_KEY });
  t.after(() => stopChild(corrupt.child));
  assert.equal(corrupt.health.hcnAssistant.historyConfigured, true);
  assert.equal(corrupt.health.hcnAssistant.historyReady, false);
  assert.equal(corrupt.health.hcnAssistant.ready, false);
  await stopChild(corrupt.child);
});

async function startHealthServer({ root, historyKey }) {
  const port = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      PUBLIC_BASE_URL: origin,
      HCN_CONSOLE_ENABLED: "true",
      HCN_CONSOLE_ORIGIN: origin,
      HCN_OPERATIONS_ROOT: root,
      HCN_TENANT_ID: "tenant_0123456789abcdef",
      HCN_REFERENCE_KEY: REFERENCE_KEY,
      HCN_THRESHER_AI_ENABLED: "true",
      HCN_THRESHER_AI_GROQ_API_KEY:
        "gsk_hcn_history_readiness_fixture_1234567890",
      HCN_ASSISTANT_HISTORY_KEY: historyKey,
      HCN_ASSISTANT_HISTORY_STORE_PATH: path.join(
        root,
        "platform",
        "assistant-conversations.enc.json"
      ),
      HCN_THRESHER_STORE_PATH: path.join(root, "thresher", "state.enc.json"),
      HANDOFF_STORE_PATH: path.join(root, "platform", "handoffs.json"),
      HANDOFF_UPLOAD_DIR: path.join(root, "platform", "handoff-uploads"),
      ARTIFACT_STORE_PATH: path.join(root, "platform", "artifacts.json"),
      ARTIFACT_UPLOAD_DIR: path.join(root, "platform", "artifact-uploads"),
      ARTIFACT_FILE_DIR: path.join(root, "platform", "artifacts"),
      CLAIM_CALL_STORE_PATH: path.join(root, "platform", "claim-calls.json"),
      ACTION_BATCH_STORE_PATH: path.join(root, "platform", "action-batches.json"),
      ACTION_APPROVAL_STORE_PATH: path.join(root, "platform", "action-approvals.json"),
      OUTBOUND_SEND_STORE_PATH: path.join(root, "platform", "outbound-sends.json"),
      HCN_GOOGLE_GRANT_STORE_PATH: path.join(root, "platform", "google-grants.enc.json"),
      HCN_ACTION_RECEIPT_STORE_PATH: path.join(root, "platform", "action-receipts.json"),
      HCN_QUO_LINE_STORE_PATH: path.join(root, "platform", "quo-lines.enc.json"),
      HCN_IDENTITY_PIN_STORE_PATH: path.join(root, "platform", "identity-pins.json"),
      HCN_INVITATION_STORE_PATH: path.join(root, "platform", "employee-invitations.enc.json"),
      JOBNIMBUS_API_KEY: "hcn-history-readiness-jobnimbus-key",
      JOBNIMBUS_BRIDGE_TOKEN: "",
      CODEX_OPERATOR_TOKEN: "",
      CODEX_MAC_OPERATOR_TOKEN: "",
      OPENAI_API_KEY: "",
      QUO_API_KEY: "",
      TWILIO_AUTH_TOKEN: "",
      RETELL_API_KEY: "",
      GOOGLE_CLIENT_SECRET: "",
      HCN_GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      GPT_OAUTH_CLIENT_SECRET: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer(child, origin);
  const response = await fetch(`${origin}/health`);
  assert.equal(response.status, 200);
  return { child, health: await response.json() };
}

async function waitForServer(child, origin) {
  let output = "";
  const capture = (chunk) => { output += chunk.toString("utf8"); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before readiness check: ${output}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // The child has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for readiness server: ${output}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "close"),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
