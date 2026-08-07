import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { signJobroloHcnRequest } from "./jobrolo-service-auth.js";

const EMAIL = "chance@wavepa.com";
const SUBJECT = "chance-google-subject-fixture";
const OWNER_ID = "chance-jobnimbus-owner-fixture";
const SECOND_OWNER_ID = "second-jobnimbus-owner-fixture";
const THIRD_OWNER_ID = "third-jobnimbus-owner-fixture";
const CLIENT_ID = "jobrolo-http-fixture";
const SHARED_SECRET = "jobrolo-http-fixture-shared-secret-123456789";

test("signed adapter fixes principal scope and requires both approval gates for one synthetic action", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-jobrolo-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const providerCalls = [];
  const providerWrites = [];
  const assignedContact = {
    jnid: "assigned-file-provider-id",
    number: 2739,
    record_type_name: "Insurance",
    owners: [{ id: OWNER_ID }],
    display_name: "Assigned File Fixture",
    status_name: "Ready for Review",
    stage_name: "Carrier Review",
    is_active: true,
    date_updated: 1785261000
  };
  const assignedContactB = {
    jnid: "assigned-file-provider-id-b",
    number: 2740,
    record_type_name: "Insurance",
    owners: [{ id: OWNER_ID }],
    display_name: "Assigned File Fixture B",
    status_name: "Ready for Review",
    stage_name: "Carrier Review",
    is_active: true,
    date_updated: 1785260900
  };
  const provider = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://provider.invalid");
    providerCalls.push(url.pathname);
    if (req.method === "GET" && url.pathname === "/account/users") {
      return json(res, 200, {
        total: 3,
        users: [{
          jnid: OWNER_ID,
          email: EMAIL,
          display_name: "Chance Pearson",
          is_active: true
        }, {
          jnid: SECOND_OWNER_ID,
          email: "second@wavepa.com",
          display_name: "Second Adjuster",
          is_active: true
        }, {
          jnid: THIRD_OWNER_ID,
          email: "third@wavepa.com",
          display_name: "Third Adjuster",
          is_active: true
        }]
      });
    }
    if (req.method === "GET" && url.pathname === "/contacts") {
      return json(res, 200, {
        contacts: [assignedContact, assignedContactB]
      });
    }
    if (
      req.method === "GET"
      && url.pathname === "/contacts/assigned-file-provider-id"
    ) {
      return json(res, 200, assignedContact);
    }
    if (
      req.method === "GET"
      && url.pathname === "/contacts/assigned-file-provider-id-b"
    ) {
      return json(res, 200, assignedContactB);
    }
    if (req.method === "GET" && url.pathname === "/activities") {
      return json(res, 200, { activities: [] });
    }
    if (req.method === "GET" && url.pathname === "/tasks") {
      return json(res, 200, { tasks: [] });
    }
    if (req.method === "GET" && url.pathname === "/files") {
      return json(res, 200, { files: [] });
    }
    if (req.method === "POST" && url.pathname === "/activities") {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        providerWrites.push(raw ? JSON.parse(raw) : {});
        json(res, 200, { jnid: "synthetic-note-provider-id" });
      });
      return;
    }
    return json(res, 404, { error: "not found" });
  });
  await listen(provider);
  t.after(() => closeServer(provider));

  const bridgePort = await reservePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(bridgePort),
      PUBLIC_BASE_URL: `http://127.0.0.1:${bridgePort}`,
      HCN_CONSOLE_ENABLED: "true",
      HCN_CONSOLE_ORIGIN: `http://127.0.0.1:${bridgePort}`,
      HCN_GOOGLE_LOGIN_ALLOWED_DOMAIN: "wavepa.com",
      CHANCE_GOOGLE_EMAIL: EMAIL,
      CHANCE_GOOGLE_SUBJECT: SUBJECT,
      CHANCE_JOBNIMBUS_OWNER_ID: OWNER_ID,
      WAVE_AUTH_USERS_JSON: "[]",
      JOBNIMBUS_API_KEY: "jobnimbus-http-fixture-key",
      JOBNIMBUS_API_BASE_URL:
        `http://127.0.0.1:${provider.address().port}`,
      HCN_TENANT_ID: "tenant_0123456789abcdef",
      HCN_REFERENCE_KEY: Buffer.alloc(32, 0x61).toString("base64url"),
      HCN_OPERATIONS_ROOT: root,
      HCN_JOBROLO_ADAPTER_ENABLED: "true",
      HCN_JOBROLO_CLIENT_ID: CLIENT_ID,
      HCN_JOBROLO_SHARED_SECRET: SHARED_SECRET,
      HCN_JOBROLO_PRINCIPAL_EMAIL: EMAIL,
      HCN_MANAGEMENT_ADJUSTERS_JSON: JSON.stringify([{
        ownerId: OWNER_ID,
        displayName: "Chance Pearson"
      }, {
        ownerId: SECOND_OWNER_ID,
        displayName: "Second Adjuster"
      }, {
        ownerId: THIRD_OWNER_ID,
        displayName: "Third Adjuster"
      }]),
      JOBNIMBUS_BRIDGE_TOKEN: "",
      CODEX_OPERATOR_TOKEN: "",
      CODEX_MAC_OPERATOR_TOKEN: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      HCN_GOOGLE_CLIENT_ID: "",
      HCN_GOOGLE_CLIENT_SECRET: "",
      HCN_GOOGLE_GRANT_KEY: "",
      HCN_QUO_LINK_KEY: "",
      HCN_ASSISTANT_HISTORY_KEY:
        Buffer.alloc(32, 0x62).toString("base64url"),
      HCN_THRESHER_AI_ENABLED: "true",
      HCN_THRESHER_AI_GROQ_API_KEY: "",
      QUO_API_KEY: "",
      TWILIO_AUTH_TOKEN: "",
      RETELL_API_KEY: "",
      OPENAI_API_KEY: "",
      OAUTH_SESSION_SECRET: "",
      GPT_OAUTH_CLIENT_SECRET: "",
      BRIDGE_ALLOW_WRITES: "true",
      HCN_ACTION_EXECUTION_ENABLED: "true",
      HCN_THRESHER_ENABLED: "false",
      HCN_THRESHER_STORE_KEY: "",
      HCN_THRESHER_REFERENCE_KEY: "",
      HCN_THRESHER_SIGNING_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  t.after(() => stopChild(child));
  await waitForBridge(child, bridgePort, () => output);

  const origin = `http://127.0.0.1:${bridgePort}`;
  const sessionRef = "session_0123456789abcdef0123456789abcdef";
  const status = await signedPost(origin, "/integrations/jobrolo/v1/status", {
    requestId: "request_11111111111111111111111111111111",
    sessionRef,
    nonce: "nonce_11111111111111111111111111111111",
    input: {}
  });
  assert.equal(status.response.status, 200, status.text);
  assert.equal(status.body.schema, "hcn.jobrolo.response.v1");
  assert.equal(status.body.result.adapter.status, "connected");
  assert.equal(status.body.result.profile.email, EMAIL);
  assert.equal(status.body.result.jobNimbus.scope, "assigned");

  const workCenter = await signedPost(
    origin,
    "/integrations/jobrolo/v1/work-center",
    {
      requestId: "request_22222222222222222222222222222222",
      sessionRef,
      nonce: "nonce_22222222222222222222222222222222",
      input: { offset: 0, limit: 10 }
    }
  );
  assert.equal(workCenter.response.status, 200, workCenter.text);
  assert.equal(workCenter.body.result.schema, "hcn.console.work-center.v1");
  assert.equal(workCenter.body.result.files.length, 2);
  const workCenterByName = new Map(
    workCenter.body.result.files.map((file) => [file.displayName, file])
  );
  assert.equal(workCenterByName.size, 2);
  assert.match(
    workCenterByName.get("Assigned File Fixture").fileRef,
    /^subject_[a-f0-9]{32}$/
  );
  assert.equal(providerCalls.includes("/account/users"), true);
  assert.equal(providerCalls.includes("/contacts"), true);

  const managementSweep = await signedPost(
    origin,
    "/integrations/jobrolo/v1/management-sweep",
    {
      requestId: "request_99999999999999999999999999999999",
      sessionRef,
      nonce: "nonce_99999999999999999999999999999999",
      input: { limitPerAdjuster: 10 }
    }
  );
  assert.equal(managementSweep.response.status, 200, managementSweep.text);
  assert.equal(
    managementSweep.body.result.schema,
    "hcn.console.management-sweep.v1"
  );
  assert.equal(managementSweep.body.result.adjusters.length, 3);
  assert.equal(
    managementSweep.body.authority.fileScope,
    "configured_management_adjusters"
  );
  assert.equal(managementSweep.body.authority.exactApprovalRequired, false);
  assert.equal(providerWrites.length, 0);

  const concurrentTurns = await Promise.all([
    signedPost(origin, "/integrations/jobrolo/v1/assistant/turn", {
      requestId: "request_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sessionRef,
      nonce: "nonce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      input: {
        kind: "general",
        fileRef: "",
        prompt: "What can you help me with?",
        mode: "auto"
      }
    }),
    signedPost(origin, "/integrations/jobrolo/v1/assistant/turn", {
      requestId: "request_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      sessionRef,
      nonce: "nonce_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      input: {
        kind: "general",
        fileRef: "",
        prompt: "What can you do?",
        mode: "auto"
      }
    })
  ]);
  for (const turn of concurrentTurns) {
    assert.equal(turn.response.status, 200, turn.text);
    assert.equal(
      turn.body.result.schema,
      "hcn.console.assistant-turn.v4"
    );
    assert.doesNotMatch(
      JSON.stringify(turn.body),
      /(?:conversation|message)_[a-f0-9]{32}/
    );
  }
  const encryptedHistory = await readFile(
    path.join(root, "platform", "assistant-conversations.enc.json"),
    "utf8"
  );
  assert.doesNotMatch(
    encryptedHistory,
    /What can you help me with|What can you do/
  );

  const fileRef = workCenterByName.get("Assigned File Fixture").fileRef;
  const fileRefB = workCenterByName.get("Assigned File Fixture B").fileRef;
  const transitionSessionRef =
    "session_fedcba9876543210fedcba9876543210";
  const transitionInputs = [
    {
      kind: "general",
      fileRef: "",
      prompt: "What can you help me with?",
      mode: "auto"
    },
    {
      kind: "file",
      fileRef,
      prompt: "Show the current file status for Job 2739.",
      mode: "auto"
    },
    {
      kind: "file",
      fileRef: fileRefB,
      prompt: "Show the current file status for Job 2740.",
      mode: "auto"
    },
    {
      kind: "file",
      fileRef,
      prompt: "Show the current file status for Job 2739.",
      mode: "auto"
    }
  ];
  for (let index = 0; index < transitionInputs.length; index += 1) {
    const digit = ["c", "d", "e", "f"][index];
    const turn = await signedPost(
      origin,
      "/integrations/jobrolo/v1/assistant/turn",
      {
        requestId: `request_${digit.repeat(32)}`,
        sessionRef: transitionSessionRef,
        nonce: `nonce_${digit.repeat(32)}`,
        input: transitionInputs[index]
      }
    );
    assert.equal(turn.response.status, 200, turn.text);
    assert.equal(
      turn.body.result.schema,
      "hcn.console.assistant-turn.v4"
    );
    assert.doesNotMatch(
      JSON.stringify(turn.body),
      /(?:conversation|message)_[a-f0-9]{32}/
    );
  }
  const prepared = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/prepare",
    {
      requestId: "request_44444444444444444444444444444444",
      sessionRef,
      nonce: "nonce_44444444444444444444444444444444",
      input: {
        fileRef,
        operations: [{
          type: "jobnimbus.create_note",
          input: { note: "Synthetic adapter approval fixture." }
        }]
      }
    }
  );
  assert.equal(prepared.response.status, 200, prepared.text);
  const plan = prepared.body.result.plan;
  assert.match(plan.planId, /^plan_[a-f0-9]{32}$/);
  assert.match(plan.approvalDigest, /^[a-f0-9]{64}$/);
  assert.equal(plan.status, "pending");
  assert.equal(prepared.text.includes("approvalChallenge"), false);
  assert.equal(prepared.text.includes("assigned-file-provider-id"), false);
  assert.equal(providerWrites.length, 0);

  const missingApproval = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/execute",
    {
      requestId: "request_55555555555555555555555555555555",
      sessionRef,
      nonce: "nonce_55555555555555555555555555555555",
      input: { planId: plan.planId }
    }
  );
  assert.equal(missingApproval.response.status, 400);
  assert.equal(providerWrites.length, 0);

  const approval = {
    schema: "jobrolo.approval-attestation.v1",
    approvalRequestId: "approval_0123456789abcdef",
    planDigest: plan.approvalDigest,
    approvedAt: new Date().toISOString(),
    approvedByUserId: "user_0123456789abcdef"
  };
  const wrongApproval = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/execute",
    {
      requestId: "request_66666666666666666666666666666666",
      sessionRef,
      nonce: "nonce_66666666666666666666666666666666",
      input: {
        planId: plan.planId,
        approval: { ...approval, planDigest: "b".repeat(64) }
      }
    }
  );
  assert.equal(wrongApproval.response.status, 409);
  assert.equal(providerWrites.length, 0);

  const executed = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/execute",
    {
      requestId: "request_77777777777777777777777777777777",
      sessionRef,
      nonce: "nonce_77777777777777777777777777777777",
      input: { planId: plan.planId, approval }
    }
  );
  assert.equal(executed.response.status, 200, executed.text);
  assert.equal(providerWrites.length, 1);
  assert.equal(
    providerWrites[0].note,
    "Synthetic adapter approval fixture."
  );
  assert.equal(providerWrites[0].primary.id, "assigned-file-provider-id");
  assert.equal(
    executed.body.result.receipt.status,
    "completed_pending_verification"
  );

  const replayedApproval = await signedPost(
    origin,
    "/integrations/jobrolo/v1/action-plans/execute",
    {
      requestId: "request_88888888888888888888888888888888",
      sessionRef,
      nonce: "nonce_88888888888888888888888888888888",
      input: { planId: plan.planId, approval }
    }
  );
  assert.equal(replayedApproval.response.status, 409);
  assert.equal(providerWrites.length, 1);

  const callerSelectedIdentity = await signedPost(
    origin,
    "/integrations/jobrolo/v1/status",
    {
      requestId: "request_33333333333333333333333333333333",
      sessionRef,
      nonce: "nonce_33333333333333333333333333333333",
      input: {},
      actorExtra: { email: "other@wavepa.com" }
    }
  );
  assert.equal(callerSelectedIdentity.response.status, 400);
  assert.match(callerSelectedIdentity.body.error, /unsupported fields/i);
});

async function signedPost(
  origin,
  pathname,
  { requestId, sessionRef, nonce, input, actorExtra = {} }
) {
  const body = {
    schema: "jobrolo.hcn.request.v1",
    requestId,
    actor: { sessionRef, ...actorExtra },
    input
  };
  const headers = signJobroloHcnRequest({
    clientId: CLIENT_ID,
    secret: SHARED_SECRET,
    pathname,
    timestamp: Date.now(),
    nonce,
    body
  });
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    response,
    text,
    body: text ? JSON.parse(text) : null
  };
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function reservePort() {
  const server = createServer();
  await listen(server);
  const port = server.address().port;
  await closeServer(server);
  return port;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
}

async function waitForBridge(child, port, readOutput) {
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Bridge exited early:\n${readOutput()}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Bridge did not start:\n${readOutput()}`);
}
