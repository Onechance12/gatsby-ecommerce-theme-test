import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHcnInvitationStore
} from "./auth/hcn-invitation-store.js";
import { createActiveThresherRuntime } from "./hcn-ops/thresher/active-runtime.js";
import { createThresherStore } from "./hcn-ops/thresher/store.js";

const PHASE_ZERO_BUILD_SHA = "810802542c35625327662e97fd21f7208532b371";
const PLATFORM_FIXTURE_SECRET = "platform-fixture-secret-must-not-leak";

async function startOperatorJobNimbusFixture(t, port, options = {}) {
  const chanceOwnerId = "fc95a213f70e4c9daddc5fa366be9941";
  const chance = {
    jnid: "contact-chance",
    number: 2739,
    record_type_name: "Insurance",
    owners: [{ id: chanceOwnerId }],
    display_name: "Fixture Homeowner",
    status_name: "Active",
    email: "client@example.test",
    mobile_phone: "2145551212",
    cf_string_2: options.communicationScope ? "ABC-123" : "ABC123"
  };
  const duplicate = {
    ...chance,
    jnid: "contact-chance-duplicate",
    number: 2740,
    status_name: "Inactive"
  };
  const secondAssigned = {
    ...chance,
    jnid: "contact-chance-second",
    number: 2741,
    display_name: "Second Fixture Homeowner",
    email: options.duplicateEmail ? chance.email : "second@example.test",
    mobile_phone: options.duplicatePhone ? chance.mobile_phone : "2145553434",
    cf_string_2: "XYZ-999"
  };
  const companyOther = {
    ...chance,
    jnid: "contact-company-other",
    number: 3901,
    owners: [{ id: "richard-owner-id" }],
    display_name: "Richard Fixture Homeowner",
    email: "company-client@example.test",
    mobile_phone: "2145559090",
    cf_string_2: "COMP-321"
  };
  let taskUpdateCount = 0;
  let companyNoteCreateCount = 0;
  let taskCompleted = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (options.communicationScope && url.pathname === "/oauth-token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "fixture-google-token", expires_in: 3600 }));
      return;
    }
    if (options.communicationScope && url.pathname === "/gmail/v1/users/me/messages" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        messages: [
          { id: "client-message", threadId: "client-thread" },
          { id: "claim-exact-message", threadId: "claim-exact-thread" },
          { id: "email-prefix-message", threadId: "email-prefix-thread" },
          { id: "claim-prefix-message", threadId: "claim-prefix-thread" },
          { id: "claim-suffix-message", threadId: "claim-suffix-thread" },
          ...(options.companyOther
            ? [{ id: "company-claim-message", threadId: "company-claim-thread" }]
            : []),
          { id: "unrelated-message", threadId: "unrelated-thread" }
        ]
      }));
      return;
    }
    if (options.communicationScope && url.pathname === "/gmail/v1/users/me/messages/claim-exact-message" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "claim-exact-message",
        threadId: "claim-exact-thread",
        snippet: "Claim ABC-123",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "carrier@example.test" },
            { name: "To", value: "someone@example.test" },
            { name: "Subject", value: "Claim ABC-123" }
          ],
          body: { data: Buffer.from("Claim ABC-123").toString("base64url") }
        }
      }));
      return;
    }
    if (options.communicationScope && url.pathname === "/gmail/v1/users/me/messages/company-claim-message" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "company-claim-message",
        threadId: "company-claim-thread",
        snippet: "Claim COMP-321",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "carrier@example.test" },
            { name: "To", value: "company-client@example.test" },
            { name: "Subject", value: "Claim COMP-321" }
          ],
          body: { data: Buffer.from("Claim COMP-321").toString("base64url") }
        }
      }));
      return;
    }
    if (options.communicationScope && url.pathname === "/gmail/v1/users/me/messages/client-message" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "client-message",
        threadId: "client-thread",
        snippet: "Client scope",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "carrier@example.test" },
            { name: "To", value: "client@example.test" },
            { name: "Subject", value: "Client scope" }
          ],
          body: { data: Buffer.from("Client scope").toString("base64url") }
        }
      }));
      return;
    }
    if (options.communicationScope && url.pathname === "/gmail/v1/users/me/messages/unrelated-message" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "unrelated-message",
        threadId: "unrelated-thread",
        snippet: "Unrelated scope",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "other@example.test" },
            { name: "To", value: "someone@example.test" },
            { name: "Subject", value: "Unrelated scope" }
          ],
          body: { data: Buffer.from("Unrelated scope").toString("base64url") }
        }
      }));
      return;
    }
    if (options.communicationScope && url.pathname === "/gmail/v1/users/me/messages/email-prefix-message" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "email-prefix-message",
        threadId: "email-prefix-thread",
        snippet: "Email prefix collision",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "carrier@example.test" },
            { name: "To", value: "notclient@example.test" },
            { name: "Subject", value: "Email prefix collision" }
          ],
          body: { data: Buffer.from("Email prefix collision").toString("base64url") }
        }
      }));
      return;
    }
    if (options.communicationScope && url.pathname === "/gmail/v1/users/me/messages/claim-prefix-message" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "claim-prefix-message",
        threadId: "claim-prefix-thread",
        snippet: "Claim X-ABC-123",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "carrier@example.test" },
            { name: "To", value: "someone@example.test" },
            { name: "Subject", value: "Claim X-ABC-123" }
          ],
          body: { data: Buffer.from("Claim X-ABC-123").toString("base64url") }
        }
      }));
      return;
    }
    if (options.communicationScope && url.pathname === "/gmail/v1/users/me/messages/claim-suffix-message" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "claim-suffix-message",
        threadId: "claim-suffix-thread",
        snippet: "Claim ABC-123-4",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "carrier@example.test" },
            { name: "To", value: "someone@example.test" },
            { name: "Subject", value: "Claim ABC-123-4" }
          ],
          body: { data: Buffer.from("Claim ABC-123-4").toString("base64url") }
        }
      }));
      return;
    }
    if (options.communicationScope && url.pathname === "/gmail/v1/users/me/threads/unrelated-thread" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "unrelated-thread",
        messages: [{
          id: "unrelated-message",
          threadId: "unrelated-thread",
          snippet: "Unrelated scope",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "other@example.test" },
              { name: "To", value: "someone@example.test" },
              { name: "Subject", value: "Unrelated scope" }
            ],
            body: { data: Buffer.from("Unrelated scope").toString("base64url") }
          }
        }]
      }));
      return;
    }
    if (options.communicationScope && url.pathname === "/gmail/v1/users/me/threads/company-claim-thread" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "company-claim-thread",
        messages: [{
          id: "company-claim-message",
          threadId: "company-claim-thread",
          snippet: "Claim COMP-321",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "carrier@example.test" },
              { name: "To", value: "company-client@example.test" },
              { name: "Subject", value: "Claim COMP-321" }
            ],
            body: { data: Buffer.from("Claim COMP-321").toString("base64url") }
          }
        }]
      }));
      return;
    }
    if (options.communicationScope && url.pathname === "/phone-numbers" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "line-1", name: "Chance", number: "+19725550100" }] }));
      return;
    }
    if (options.communicationScope && url.pathname === "/messages" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (options.communicationScope && url.pathname === "/calls" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [{
          id: "client-call",
          phoneNumberId: "line-1",
          createdAt: "2026-07-20T12:00:00Z",
          direction: "incoming",
          status: "completed",
          duration: 60
        }]
      }));
      return;
    }
    if (url.pathname === "/contacts") {
      res.writeHead(200, { "content-type": "application/json" });
      const contacts = [
        chance,
        ...(options.duplicateName ? [duplicate] : []),
        ...(options.secondAssigned ? [secondAssigned] : []),
        ...(options.companyOther ? [companyOther] : [])
      ];
      res.end(JSON.stringify({ contacts }));
      return;
    }
    if (url.pathname === "/contacts/contact-chance") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(chance));
      return;
    }
    if (url.pathname === "/contacts/contact-chance-duplicate") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(duplicate));
      return;
    }
    if (url.pathname === "/contacts/contact-chance-second") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(secondAssigned));
      return;
    }
    if (url.pathname === "/contacts/contact-company-other") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(companyOther));
      return;
    }
    if (
      options.companyOther
      && url.pathname === "/activities"
      && req.method === "POST"
    ) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      assert.equal(body.primary?.id, companyOther.jnid);
      companyNoteCreateCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jnid: "company-note-created",
        record_type_name: "Note",
        primary: { id: companyOther.jnid },
        note: body.note
      }));
      return;
    }
    if (url.pathname === "/activities" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ activities: [] }));
      return;
    }
    if (url.pathname === "/tasks" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tasks: [] }));
      return;
    }
    if (url.pathname === "/files" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ files: [] }));
      return;
    }
    if (url.pathname === "/tasks/fixture-task" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jnid: "fixture-task",
        record_type_name: "Task",
        primary: { id: chance.jnid },
        title: "Fixture task",
        is_completed: taskCompleted
      }));
      return;
    }
    if (url.pathname === "/tasks/fixture-task" && req.method === "PUT") {
      taskUpdateCount += 1;
      taskCompleted = true;
      await new Promise((resolve) => setTimeout(resolve, 75));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jnid: "fixture-task",
        record_type_name: "Task",
        primary: { id: chance.jnid },
        title: "Fixture task",
        is_completed: true
      }));
      return;
    }
    if (url.pathname === "/activities/fixture-note" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jnid: "fixture-note",
        record_type_name: "Note",
        primary: { id: chance.jnid },
        note: "Fixture note"
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => server.close());
  return {
    getTaskUpdateCount: () => taskUpdateCount,
    getCompanyNoteCreateCount: () => companyNoteCreateCount
  };
}

test("server exposes claim actions and protects them when auth is unconfigured", async (t) => {
  const port = 18879;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      JOBNIMBUS_BRIDGE_TOKEN: "",
      JOBNIMBUS_API_KEY: "",
      RETELL_API_KEY: "",
      RETELL_AGENT_ID: "",
      RETELL_FROM_NUMBER: "",
      ALLOW_RETELL_CALLS: "false",
      ALLOW_CLIENT_COORDINATOR_CALLS: "false",
      ALLOW_CARRIER_FOLLOWUP_CALLS: "false",
      ALLOW_VOICE_CALLS: "false",
      ALLOW_GOOGLE_USER_AUTH: "false",
      HCN_CONSOLE_ENABLED: "true",
      ALLOW_GMAIL_SEND: "false",
      ALLOW_QUO_SEND: "false",
      BRIDGE_ALLOW_WRITES: "false",
      HCN_ACTION_EXECUTION_ENABLED: "false",
      HCN_SERVICE_NAME: "hcn-operations-platform",
      RENDER_GIT_COMMIT: PHASE_ZERO_BUILD_SHA,
      PLATFORM_FIXTURE_SECRET
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, port);

  const rootRedirectResponse = await fetch(`http://127.0.0.1:${port}/`, {
    redirect: "manual"
  });
  assert.equal(rootRedirectResponse.status, 302);
  assert.equal(
    rootRedirectResponse.headers.get("location"),
    "/hcn/"
  );
  assert.equal(rootRedirectResponse.headers.get("cache-control"), "no-store, max-age=0");
  assert.match(
    rootRedirectResponse.headers.get("content-security-policy"),
    /default-src 'none'/
  );
  assert.equal(rootRedirectResponse.headers.get("set-cookie"), null);

  const consoleRedirectResponse = await fetch(`http://127.0.0.1:${port}/hcn`, {
    redirect: "manual"
  });
  assert.equal(consoleRedirectResponse.status, 302);
  assert.equal(
    consoleRedirectResponse.headers.get("location"),
    "/hcn/"
  );
  assert.equal(consoleRedirectResponse.headers.get("cache-control"), "no-store, max-age=0");

  const consoleResponse = await fetch(`http://127.0.0.1:${port}/hcn/`, {
    redirect: "manual"
  });
  assert.equal(consoleResponse.status, 200);
  assert.equal(consoleResponse.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(consoleResponse.headers.get("vary"), "Cookie, Authorization");
  const signedOutHtml = await consoleResponse.text();
  assert.match(signedOutHtml, /Sign in to HCN/);
  assert.match(
    signedOutHtml,
    /href="\/hcn\/auth\/login\?returnTo=%2Fhcn%2F"/
  );
  assert.doesNotMatch(
    signedOutHtml,
    /Work My Files|Company Sweep|Approvals|Receipts|System Status/
  );

  const signInStyleResponse = await fetch(
    `http://127.0.0.1:${port}/hcn/sign-in.css?shell=v15`
  );
  assert.equal(signInStyleResponse.status, 200);
  assert.match(signInStyleResponse.headers.get("content-type"), /^text\/css/);

  for (const pathname of [
    "/hcn/app.css?shell=v15",
    "/hcn/app.js?shell=v15",
    "/hcn/manifest.webmanifest?shell=v15",
    "/hcn/sw.js?shell=v15"
  ]) {
    const response = await fetch(
      `http://127.0.0.1:${port}${pathname}`
    );
    assert.equal(response.status, 401);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.equal(
      response.headers.get("cache-control"),
      "no-store, max-age=0"
    );
    assert.equal(response.headers.get("service-worker-allowed"), null);
  }

  const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.claimFiling.engine, "retell");
  assert.equal(health.claimFiling.callbackPacketRestoration, "full_approved_packet");
  assert.equal(health.claimFiling.retryRequiresPriorCallId, true);
  assert.equal(health.claimFiling.callsAllowed, false);
  assert.deepEqual(health.clientCoordinator.supportedModes, [
    "appointment_confirmation",
    "missing_document_request",
    "status_update",
    "client_check_in"
  ]);
  assert.equal(health.clientCoordinator.expandedModesAllowed, false);
  assert.equal(health.clientCoordinator.freshEvidenceRequired, true);
  assert.equal(health.clientCoordinator.automaticTextOrWriteback, false);
  assert.equal(health.carrierFollowUp.freshEvidenceRequired, true);
  assert.equal(health.carrierFollowUp.approvalDigestRequired, true);
  assert.equal(health.carrierFollowUp.extensionsSupported, true);
  assert.equal(health.carrierFollowUp.automaticScheduling, false);
  assert.equal(health.carrierFollowUp.automaticJobNimbusWriteback, false);
  assert.equal(health.userOAuth.available, false);
  assert.equal(
    health.userOAuth.perUserGmail,
    "custom_gpt_broker_and_hcn_connector"
  );
  assert.equal(health.userOAuth.roleEnforcement, true);
  assert.equal(health.codexOperator.gmailReadsRequireExactAssignedFile, true);
  assert.equal(health.codexOperator.quoReadsRequireExactAssignedFile, true);
  assert.equal(health.codexOperator.broadUnmatchedCommunicationsSweep, false);
  assert.equal(health.codexOperator.existingDraftSendRequiresBridgeReceipt, true);
  assert.equal(health.codexOperator.retainedDraftIdIsOneShot, true);
  assert.equal(health.codexOperator.chanceBrainClientMemory, "disabled");
  assert.equal(health.brain, undefined);
  assert.equal(health.hcnOperationsBrain.system, "hcn_operations");
  assert.equal(health.hcnOperationsBrain.productName, "Thresher AI");
  assert.equal(health.hcnOperationsBrain.mode, "isolated_v2_foundation");
  assert.equal(health.hcnOperationsBrain.contractsAvailable, true);
  assert.equal(health.hcnOperationsBrain.thresherRulesAvailable, true);
  assert.equal(health.hcnOperationsBrain.clientMemory, "not_yet_persistent");
  assert.equal(
    health.hcnOperationsBrain.modelRuntimeIdentity,
    "hcn.thresher-ai.v1"
  );
  assert.equal(
    health.hcnOperationsBrain.modelInstructionsVersion,
    "hcn.thresher-ai.instructions.v3"
  );
  assert.equal(health.hcnOperationsBrain.optionalModelAdvisory, false);
  assert.equal(health.hcnOperationsBrain.operationalProviderConfigured, false);
  assert.equal(health.hcnOperationsBrain.operationalProvider, "groq");
  assert.equal(
    health.hcnOperationsBrain.operationalModel,
    "openai/gpt-oss-20b"
  );
  assert.equal(health.hcnOperationsBrain.providerNeutralAdapter, false);
  assert.equal(health.hcnOperationsBrain.exactClientDataMinimized, true);
  assert.equal(health.hcnOperationsBrain.modelHasTools, false);
  assert.equal(
    health.hcnOperationsBrain.modelToolAuthority,
    "read_only"
  );
  assert.equal(
    health.hcnOperationsBrain.modelCanPrepareActionPlans,
    false
  );
  assert.equal(health.hcnOperationsBrain.modelCanExecute, false);
  assert.equal(health.hcnOperationsBrain.doesNotAuthorizeActions, true);
  assert.equal(health.hcnOperationsBrain.autonomousLearning, false);
  assert.equal(health.hcnOperationsBrain.externalActions, false);
  assert.equal(health.hcnOperationsBrain.persistenceConfigured, false);
  assert.deepEqual(health.hcnOperationsBrain.storeFoundation, {
    ready: false,
    status: "not_configured",
    persistenceActive: false
  });
  assert.equal(health.outboundSafety.automaticEmailOrTextSending, false);
  assert.equal(health.outboundSafety.explicitChanceApprovalRequired, true);
  assert.equal(health.outboundSafety.shortLivedSingleUseChallengeRequired, true);
  assert.equal(health.chatgptDocumentReturn.nativeConversationFile, true);
  assert.equal(health.chatgptDocumentReturn.readOnly, true);
  assert.equal(health.dateOfLossResearch.mode, "read_only_candidate_research");
  assert.equal(health.dateOfLossResearch.automaticJobNimbusUpdate, false);
  assert.equal(health.voice.streamPath, "/voice/twilio-stream");
  assert.equal(health.voice.streamUrl, undefined);
  assert.equal(health.platform.build.attested, true);
  assert.equal(health.platform.build.sourceCommit, PHASE_ZERO_BUILD_SHA);
  assert.equal(health.platform.build.sourceCommitTrust, "provider_attested");
  assert.equal(health.platform.boundaries.chanceBrain, "disconnected_no_route");
  assert.equal(health.platform.boundaries.hcnChanceBrainDataFlow, "none");
  assert.equal(health.platform.boundaries.jobrolo, "disconnected");
  assert.equal(
    health.platform.boundaries.hcnOperationsBrain,
    "foundation_persistence_pending"
  );
  assert.equal(
    health.platform.boundaries.legacyClientMemory,
    "quarantined_unreachable"
  );
  assert.equal(health.platform.runtime.configurationDrift.status, "detected");
  assert.deepEqual(
    health.platform.runtime.configurationDrift.differences,
    [
      {
        key: "ALLOW_GMAIL_SEND",
        checkedIn: "enabled",
        runtime: "disabled"
      },
      {
        key: "ALLOW_QUO_SEND",
        checkedIn: "enabled",
        runtime: "disabled"
      },
      {
        key: "BRIDGE_ALLOW_WRITES",
        checkedIn: "enabled",
        runtime: "disabled"
      },
      {
        key: "HCN_ACTION_EXECUTION_ENABLED",
        checkedIn: "enabled",
        runtime: "disabled"
      }
    ]
  );
  assert.equal(JSON.stringify(health.platform).includes(PLATFORM_FIXTURE_SECRET), false);

  const platformMetaResponse = await fetch(`http://127.0.0.1:${port}/api/v1/meta`);
  assert.equal(platformMetaResponse.status, 200);
  const platformMeta = await platformMetaResponse.json();
  assert.equal(platformMeta.build.sourceCommit, PHASE_ZERO_BUILD_SHA);
  assert.equal(platformMeta.build.attested, true);
  assert.equal(platformMeta.boundaries.chanceBrain, "disconnected_no_route");
  assert.equal(platformMeta.boundaries.jobrolo, "disconnected");
  assert.equal(JSON.stringify(platformMeta).includes(PLATFORM_FIXTURE_SECRET), false);

  const unauthenticatedSessionResponse = await fetch(`http://127.0.0.1:${port}/api/v1/session`);
  assert.equal(unauthenticatedSessionResponse.status, 401);

  const schemaResponse = await fetch(`http://127.0.0.1:${port}/openapi.json`);
  assert.equal(schemaResponse.status, 200);
  const schema = await schemaResponse.json();
  assert.equal(schema.info.title, "HCN Operations Platform API");
  assert.equal(
    schema.info.description,
    "Authenticated HCN operations API for fresh JobNimbus, Gmail, Quo, calendar, and document evidence. Isolated Thresher AI operational state never authorizes external actions; consequential work remains approval-gated."
  );
  assert.equal(schema.paths["/api/v1/meta"].get.operationId, "readHcnPlatformMetadata");
  assert.deepEqual(
    schema.paths["/api/v1/meta"].get.security,
    []
  );
  assert.equal(schema.paths["/api/v1/session"].get.operationId, "readHcnPlatformSession");
  assert.equal(
    schema.paths["/api/v1/meta"].get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/PlatformMetadataResponse"
  );
  assert.equal(
    schema.paths["/api/v1/session"].get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/PlatformSessionResponse"
  );
  assert.equal(schema.components.schemas.PlatformMetadataResponse.additionalProperties, false);
  assert.deepEqual(
    schema.components.schemas.PlatformMetadataResponse.properties.boundaries
      .properties.jobrolo.enum,
    ["disconnected", "narrow_signed_thresher_adapter"]
  );
  assert.equal(schema.components.schemas.PlatformSessionResponse.additionalProperties, false);
  assert.equal(schema.components.schemas.PlatformRuntimeStatus.additionalProperties, false);
  assert.equal(
    schema.components.schemas.PlatformRuntimeStatus.properties.assistant
      .properties.directReads.$ref,
    "#/components/schemas/PlatformConfigurationStatus"
  );
  assert.equal(
    schema.components.schemas.PlatformRuntimeStatus.properties.assistant
      .required.includes("directReads"),
    true
  );
  assert.equal(
    schema.components.schemas.PlatformRuntimeStatus.properties.gates
      .properties.hcnActionExecution.$ref,
    "#/components/schemas/PlatformGateStatus"
  );
  assert.equal(
    schema.components.schemas.PlatformRuntimeStatus.properties.gates
      .required.includes("hcnActionExecution"),
    true
  );
  assert.equal(
    schema.components.schemas.PlatformReleaseGateKey.enum
      .includes("HCN_ACTION_EXECUTION_ENABLED"),
    true
  );
  assert.equal(
    schema.components.schemas.PlatformSessionResponse.properties.identity.additionalProperties,
    false
  );
  assert.equal(schema.paths["/claim-filing/prepare"].post.operationId, "prepareClaimFilingCall");
  assert.equal(schema.paths["/claim-filing/call"].post.operationId, "placeApprovedClaimFilingCall");
  assert.equal(schema.paths["/claim-filing/result"].post.operationId, "reviewClaimFilingCallResult");
  assert.equal(schema.paths["/claim-filing/callbacks"].post.operationId, "listPendingClaimCallbacks");
  assert.equal(schema.paths["/claim-filing/writeback"].post.operationId, "processApprovedClaimFilingWriteback");
  assert.equal(schema.paths["/scheduling/availability"].post.operationId, "reviewUnifiedSchedulingAvailability");
  assert.equal(schema.paths["/retell/configure-agent"].post.operationId, "configureApprovedRetellAgent");
  assert.equal(schema.paths["/retell/configure-client-coordinator"].post.operationId, "configureApprovedClientCoordinatorAgent");
  assert.equal(schema.paths["/retell/configure-client-coordinator"].post["x-openai-isConsequential"], true);
  assert.equal(schema.paths["/retell/client-coordinator-call"].post.operationId, "placeApprovedClientCoordinatorCall");
  assert.equal(schema.paths["/retell/client-coordinator-call"].post["x-openai-isConsequential"], true);
  assert.equal(schema.paths["/retell/client-coordinator-call-result"].post.operationId, "reviewClientCoordinatorCall");
  assert.equal(schema.paths["/retell/configure-carrier-follow-up"].post.operationId, "configureApprovedCarrierFollowUpAgent");
  assert.equal(schema.paths["/retell/carrier-follow-up-call"].post.operationId, "placeApprovedCarrierFollowUpCall");
  assert.equal(schema.paths["/retell/carrier-follow-up-call"].post["x-openai-isConsequential"], true);
  assert.equal(schema.paths["/retell/carrier-follow-up-call-result"].post.operationId, "reviewCarrierFollowUpCall");
  assert.equal(schema.paths["/retell/homeowner-call"].post.operationId, "placeApprovedHomeownerAppointmentCall");
  assert.equal(schema.paths["/retell/homeowner-call-result"].post.operationId, "reviewHomeownerAppointmentCall");
  assert.equal(schema.paths["/brain/context"], undefined);
  assert.equal(schema.paths["/memory/file-actions"], undefined);
  assert.equal(schema.paths["/memory/persistence-check"], undefined);
  assert.equal(schema.paths["/ops/review-chance-files"].post.operationId, "reviewChanceFilesForApproval");
  assert.equal(schema.paths["/ops/action-batch"].post.operationId, "processApprovedWaveActionBatch");
  assert.equal(schema.paths["/quo/send"].post.operationId, "sendApprovedQuoText");
  assert.equal(schema.paths["/quo/send"].post["x-openai-isConsequential"], true);
  assert.equal(schema.paths["/gmail/send"].post["x-openai-isConsequential"], true);
  assert.equal(schema.paths["/ops/action-batch"].post["x-openai-isConsequential"], true);
  assert.equal(schema.paths["/gmail/attachment-review"].post.operationId, "reviewGmailAttachment");
  assert.equal(schema.paths["/jobnimbus/document-file"].post.operationId, "attachJobNimbusDocumentToChat");
  assert.equal(schema.paths["/jobnimbus/photo-review"].post.operationId, "reviewJobNimbusPhotos");
  assert.equal(schema.paths["/jobnimbus/upload-file"].post.operationId, "uploadJobNimbusFile");
  assert.equal(schema.paths["/weather/dol-research"].post.operationId, "researchPropertyHailDates");

  const chatgptSchemaResponse = await fetch(`http://127.0.0.1:${port}/openapi-chatgpt.json`);
  assert.equal(chatgptSchemaResponse.status, 200);
  const chatgptSchema = await chatgptSchemaResponse.json();
  assert.equal(chatgptSchema.info.title, "HCN Thresher Operations Assistant");
  assert.match(chatgptSchema.info.description, /HCN Operations Platform/);
  assert.match(chatgptSchema.info.description, /isolated operational state/);
  assert.match(chatgptSchema.info.description, /approval-gated/);
  assert.deepEqual(chatgptSchema.security, [{ googleOAuth: [] }]);
  assert.equal(chatgptSchema.components.securitySchemes.googleOAuth.type, "oauth2");
  assert.equal(
    chatgptSchema.components.securitySchemes.googleOAuth.flows.authorizationCode.authorizationUrl,
    `http://127.0.0.1:${port}/oauth/authorize`
  );
  assert.equal(chatgptSchema.components.securitySchemes.bearerAuth, undefined);
  assert.equal(Object.values(chatgptSchema.paths).flatMap((path) => Object.values(path)).length, 28);
  assert.equal(chatgptSchema.paths["/api/v1/meta"], undefined);
  assert.equal(chatgptSchema.paths["/api/v1/session"], undefined);
  assert.equal(chatgptSchema.paths["/auth/whoami"].get.operationId, "readSignedInWaveIdentity");
  assert.equal(chatgptSchema.paths["/auth/quo-line"].post.operationId, "linkAuthenticatedQuoLine");
  assert.equal(chatgptSchema.paths["/auth/quo-line"].post["x-openai-isConsequential"], true);
  assert.equal(chatgptSchema.paths["/brain/context"], undefined);
  assert.equal(chatgptSchema.paths["/memory/file-actions"], undefined);
  assert.equal(chatgptSchema.paths["/memory/persistence-check"], undefined);
  assert.equal(chatgptSchema.paths["/jobnimbus/photo-review"].post.operationId, "reviewJobNimbusPhotos");
  assert.equal(chatgptSchema.paths["/retell/configure-agent"], undefined);
  assert.equal(chatgptSchema.paths["/ops/review-chance-files"].post.operationId, "reviewChanceFilesForApproval");
  assert.equal(chatgptSchema.paths["/ops/start-session"].post.operationId, "startThresherOperationalSession");
  assert.equal(chatgptSchema.paths["/ops/recover-scheduling-communications"].post.operationId, "recoverSchedulingCommunications");
  assert.deepEqual(
    chatgptSchema.components.schemas.OperationalSessionRequest.properties.focus.enum,
    ["priority", "today_inspections", "communications"]
  );
  assert.match(
    chatgptSchema.components.schemas.OperationalSessionRequest.properties.focus.description,
    /scans inbound Gmail and every Quo team line first/i
  );
  assert.equal(chatgptSchema.paths["/ops/action-batch"].post["x-openai-isConsequential"], true);
  assert.equal(chatgptSchema.paths["/claim-filing/prepare"].post.operationId, "prepareClaimFilingCall");
  assert.equal(chatgptSchema.paths["/jobnimbus/document-file"].post.operationId, "attachJobNimbusDocumentToChat");
  assert.equal(chatgptSchema.paths["/weather/dol-research"].post.operationId, "researchPropertyHailDates");
  assert.equal(chatgptSchema.paths["/retell/carrier-follow-up-call"].post.operationId, "placeApprovedCarrierFollowUpCall");
  assert.equal(chatgptSchema.paths["/retell/carrier-follow-up-call-result"].post.operationId, "reviewCarrierFollowUpCall");
  assert.match(
    chatgptSchema.components.schemas.RetellCarrierFollowUpCallRequest.properties.extension.description,
    /kept separate from the E\.164 destination/i
  );
  assert.deepEqual(
    chatgptSchema.components.schemas.DocumentReviewRequest.properties.documentPurpose.enum,
    ["insurance_policy", "tdi_form", "estimate_scope", "carrier_claim_document", "appraisal_document", "representation_contract"]
  );
  for (const pathItem of Object.values(chatgptSchema.paths)) {
    for (const operation of Object.values(pathItem)) {
      if (operation.description) assert.ok(operation.description.length <= 300, `${operation.operationId} description exceeds 300 characters`);
    }
  }
  assert.equal(chatgptSchema.paths["/quo/numbers"], undefined);
  assert.equal(chatgptSchema.paths["/jobnimbus/process-update"], undefined);
  assert.equal(chatgptSchema.paths["/jobnimbus/create-task"], undefined);
  assert.equal(chatgptSchema.paths["/jobnimbus/create-calendar-event"], undefined);
  assert.equal(chatgptSchema.paths["/gmail/send"], undefined);
  assert.equal(chatgptSchema.paths["/quo/send"], undefined);
  assert.equal(chatgptSchema.paths["/jobnimbus/upload-file"].post["x-openai-isConsequential"], true);
  assert.equal(chatgptSchema.paths["/gmail/attachment-review"].post["x-openai-isConsequential"], true);
  const consolidatedActionTypes = chatgptSchema.components.schemas.ActionOperation.properties.type.enum;
  assert.match(
    chatgptSchema.components.schemas.ActionOperation.properties.payload.description,
    /completed:true/
  );
  assert.match(
    chatgptSchema.components.schemas.ActionOperation.properties.payload.description,
    /draftId:'RETURNED_DRAFT_ID'/
  );
  assert.match(
    chatgptSchema.components.schemas.GmailMessageRequest.properties.draftId.description,
    /sends and removes that exact draft/i
  );
  assert.deepEqual(chatgptSchema.components.schemas.GmailMessageRequest.anyOf, [
    { required: ["draftId"] },
    { required: ["to", "subject", "body"] },
    { required: ["to", "subject", "template", "query"] }
  ]);
  for (const actionType of [
    "jobnimbus.process_update",
    "jobnimbus.create_task",
    "jobnimbus.create_calendar_event",
    "gmail.create_draft",
    "gmail.send",
    "quo.send_text"
  ]) {
    assert.equal(consolidatedActionTypes.includes(actionType), true);
  }
  assert.equal(chatgptSchema.paths["/retell/client-coordinator-call"].post.operationId, "placeApprovedClientCoordinatorCall");
  assert.equal(chatgptSchema.paths["/retell/client-coordinator-call-result"].post.operationId, "reviewClientCoordinatorCall");
  assert.equal(chatgptSchema.paths["/retell/homeowner-call"], undefined);
  assert.equal(chatgptSchema.paths["/voice/outbound-call"], undefined);

  const protectedResponse = await fetch(`http://127.0.0.1:${port}/claim-filing/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "2739" })
  });
  assert.equal(protectedResponse.status, 401);

  const protectedIdentityResponse = await fetch(`http://127.0.0.1:${port}/auth/whoami`);
  assert.equal(protectedIdentityResponse.status, 401);

  const protectedBrainResponse = await fetch(`http://127.0.0.1:${port}/brain/context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(protectedBrainResponse.status, 404);
});

test("Codex operator token is distinct, scoped, and keeps batch approval gates", async (t) => {
  const bridgePort = 18884;
  const fakeApiPort = 18886;
  const memoryRoot = await mkdtemp(path.join(tmpdir(), "codex-operator-auth-"));
  t.after(() => rm(memoryRoot, { recursive: true, force: true }));
  await startOperatorJobNimbusFixture(t, fakeApiPort, { secondAssigned: true, duplicatePhone: true });
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(bridgePort),
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-shared-token",
      CODEX_OPERATOR_TOKEN: "fixture-codex-operator-token-1234567890",
      CODEX_MAC_OPERATOR_TOKEN: "fixture-codex-mac-operator-token-1234567890",
      JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      JOBNIMBUS_API_KEY: "fixture-key",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      ALLOW_GOOGLE_USER_AUTH: "false",
      QUO_API_KEY: "fixture-quo-key",
      QUO_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      QUO_DEFAULT_FROM_NUMBER: "",
      HCN_OPERATIONS_ROOT: memoryRoot,
      ALLOW_GMAIL_SEND: "false",
      ALLOW_QUO_SEND: "false",
      BRIDGE_ALLOW_WRITES: "false",
      RENDER_GIT_COMMIT: PHASE_ZERO_BUILD_SHA,
      PLATFORM_FIXTURE_SECRET
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, bridgePort);

  const operatorHeaders = {
    authorization: "Bearer fixture-codex-operator-token-1234567890",
    "content-type": "application/json"
  };
  const sharedHeaders = {
    authorization: "Bearer fixture-shared-token",
    "content-type": "application/json"
  };

  const identityResponse = await fetch(`http://127.0.0.1:${bridgePort}/auth/whoami`, {
    headers: operatorHeaders
  });
  assert.equal(identityResponse.status, 200);
  const identity = await identityResponse.json();
  assert.equal(identity.identity.type, "codex_operator_token");
  assert.equal(identity.identity.role, "codex_operator");
  assert.equal(identity.identity.subject, "codex-hp-operator");
  assert.equal(identity.identity.email, "");
  assert.deepEqual(identity.identity.scopes, [
    "client_evidence:read",
    "management_sweep:read",
    "approval_batches:prepare_execute"
  ]);
  assert.equal(identity.operatorAccess.companyWideIndexOrSweep, false);
  assert.equal(identity.operatorAccess.fixedManagementSweepRead, true);
  assert.match(identity.instruction, /dedicated least-privilege Codex operator/i);

  const macIdentityResponse = await fetch(`http://127.0.0.1:${bridgePort}/auth/whoami`, {
    headers: {
      authorization: "Bearer fixture-codex-mac-operator-token-1234567890",
      "content-type": "application/json"
    }
  });
  assert.equal(macIdentityResponse.status, 200);
  const macIdentity = await macIdentityResponse.json();
  assert.equal(macIdentity.identity.type, "codex_operator_token");
  assert.equal(macIdentity.identity.role, "codex_operator");
  assert.equal(macIdentity.identity.subject, "codex-mac-operator");
  assert.equal(macIdentity.identity.name, "Codex Mac Operator");
  assert.deepEqual(macIdentity.identity.scopes, [
    "client_evidence:read",
    "company_exact_file:read",
    "approval_batches:prepare_execute"
  ]);
  assert.equal(macIdentity.operatorAccess.defaultScope, "chance_assigned");
  assert.equal(macIdentity.operatorAccess.companyExactFileScope, true);
  assert.equal(macIdentity.operatorAccess.companyWideIndexOrSweep, false);
  assert.equal(macIdentity.operatorAccess.fixedManagementSweepRead, false);
  assert.match(macIdentity.instruction, /dedicated least-privilege Codex Mac Operator/i);

  const platformSessionResponse = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/session`, {
    headers: operatorHeaders
  });
  assert.equal(platformSessionResponse.status, 200);
  const platformSession = await platformSessionResponse.json();
  assert.equal(platformSession.authenticated, true);
  assert.equal(platformSession.identity.type, "codex_operator");
  assert.equal(platformSession.identity.jobNimbusScope, "assigned");
  assert.equal(platformSession.build.attested, true);
  assert.equal(platformSession.build.sourceCommit, PHASE_ZERO_BUILD_SHA);
  assert.equal(platformSession.build.sourceCommitTrust, "provider_attested");
  assert.equal(platformSession.authorizedCapabilities.includes("platform.session.read"), true);
  assert.equal(
    platformSession.authorizedCapabilities.includes(
      "hcn.management_sweep.read"
    ),
    true
  );
  assert.equal(platformSession.authorizedCapabilities.some((capability) => capability.includes(".send")), false);
  assert.equal(platformSession.authorizedCapabilities.some((capability) => capability.includes(".upload")), false);
  assert.equal(platformSession.authorizedCapabilities.some((capability) => capability.startsWith("brain.")), false);
  const serializedPlatformSession = JSON.stringify(platformSession);
  assert.equal(serializedPlatformSession.includes(PLATFORM_FIXTURE_SECRET), false);
  assert.equal(serializedPlatformSession.includes('"subject"'), false);
  assert.equal(serializedPlatformSession.includes('"email"'), false);
  assert.equal(serializedPlatformSession.includes('"token"'), false);

  const sharedTokenSessionResponse = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/session`, {
    headers: sharedHeaders
  });
  assert.equal(sharedTokenSessionResponse.status, 403);

  const brainResponse = await fetch(`http://127.0.0.1:${bridgePort}/brain/context`, {
    method: "POST",
    headers: operatorHeaders,
    body: "{}"
  });
  assert.equal(brainResponse.status, 404);

  const advisoryResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/start-session`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ includeBrainAdvisory: true })
  });
  assert.equal(advisoryResponse.status, 400);
  assert.match((await advisoryResponse.json()).error, /not supported.*isolated Thresher/i);

  const unselectedDocumentResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/document-text`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ query: "2739" })
  });
  assert.equal(unselectedDocumentResponse.status, 400);
  assert.match((await unselectedDocumentResponse.json()).error, /requires an exact documentQuery/i);

  const broadSearchResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/search`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ query: "a" })
  });
  assert.equal(broadSearchResponse.status, 400);
  assert.match((await broadSearchResponse.json()).error, /search query is too broad/i);

  const resolverSearchResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/search`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ query: "2739" })
  });
  assert.equal(resolverSearchResponse.status, 200);
  const resolverSearch = await resolverSearchResponse.json();
  assert.deepEqual(
    Object.keys(resolverSearch.matches[0]).sort(),
    ["id", "name", "number", "status"].sort()
  );

  const injectedEmailResponse = await fetch(`http://127.0.0.1:${bridgePort}/gmail/send`, {
    method: "POST",
    headers: sharedHeaders,
    body: JSON.stringify({
      to: "client@example.test\r\nBcc: hidden@example.test",
      subject: "Fixture",
      body: "Fixture body",
      execute: false
    })
  });
  assert.equal(injectedEmailResponse.status, 400);
  assert.match((await injectedEmailResponse.json()).error, /email-header control character/i);

  const ambiguousGroupResponse = await fetch(`http://127.0.0.1:${bridgePort}/gmail/send`, {
    method: "POST",
    headers: sharedHeaders,
    body: JSON.stringify({
      to: "Group: attacker@example.test; <cover@example.test>",
      subject: "Fixture",
      body: "Fixture body",
      execute: false
    })
  });
  assert.equal(ambiguousGroupResponse.status, 400);
  assert.match((await ambiguousGroupResponse.json()).error, /invalid email address/i);

  const displayNameResponse = await fetch(`http://127.0.0.1:${bridgePort}/gmail/send`, {
    method: "POST",
    headers: sharedHeaders,
    body: JSON.stringify({
      to: "Client Name <client@example.test>",
      subject: "Fixture",
      body: "Fixture body",
      execute: false
    })
  });
  assert.equal(displayNameResponse.status, 200);
  assert.equal((await displayNameResponse.json()).plan.to, "Client Name <client@example.test>");

  for (const operation of [
    {
      type: "gmail.send",
      payload: { query: "2739", to: "client@example.test", subject: "Fixture", body: "Fixture body" }
    },
    {
      type: "jobnimbus.update_contact",
      payload: { query: "2739", fields: { owners: [{ id: "someone-else" }] } }
    },
    {
      type: "jobnimbus.process_update",
      payload: { query: "2739", fields: { status_name: "Unvalidated status" } }
    },
    {
      type: "jobnimbus.update_task",
      payload: {
        query: "2739",
        taskId: "fixture-task",
        fields: { related: [{ id: "contact-other" }] }
      }
    },
    {
      type: "jobnimbus.create_task",
      payload: { query: "2739", title: "Not really a task", recordTypeName: "Note" }
    },
    {
      type: "jobnimbus.update_calendar_event",
      payload: { query: "2739", eventId: "fixture-note", fields: { title: "Reparented note" } }
    },
    {
      type: "quo.send_text",
      payload: { query: "2739", to: "+12145550199", content: "Out-of-scope recipient" }
    }
  ]) {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({ operations: [operation], execute: false })
    });
    assert.equal(response.status, 400, operation.type);
  }

  for (const [pathname, body] of [
    ["/gmail/search", { query: "newer_than:1d" }],
    ["/gmail/thread", { threadId: "thread-any" }],
    ["/gmail/attachment-review", { messageId: "message-any", attachmentId: "attachment-any", filename: "scope.pdf" }],
    ["/quo/history", { phone: "+12145550100" }],
    ["/quo/transcript", { callId: "call-any" }]
  ]) {
    const response = await fetch(`http://127.0.0.1:${bridgePort}${pathname}`, {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 400, pathname);
    assert.match((await response.json()).error, /exact Chance-assigned file/i);
  }

  const broadCommunicationsResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/start-session`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ focus: "communications" })
  });
  assert.equal(broadCommunicationsResponse.status, 403);
  assert.match((await broadCommunicationsResponse.json()).error, /broad unmatched communications sweep/i);

  const sharedPhoneHistoryResponse = await fetch(`http://127.0.0.1:${bridgePort}/quo/history`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ query: "2739" })
  });
  assert.equal(sharedPhoneHistoryResponse.status, 400);
  assert.match((await sharedPhoneHistoryResponse.json()).error, /phone is shared.*Quo history.*ambiguous/i);

  const sharedPhonePacketResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/review-chance-files`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({
      query: "2739",
      includeGmail: false,
      includeQuo: true
    })
  });
  assert.equal(sharedPhonePacketResponse.status, 200);
  const sharedPhonePacket = await sharedPhonePacketResponse.json();
  assert.equal(sharedPhonePacket.packets[0].quo.status, "error");
  assert.match(sharedPhonePacket.packets[0].quo.error, /phone is shared.*Quo evidence review.*ambiguous/i);
  assert.deepEqual(sharedPhonePacket.packets[0].quo.timeline, []);

  const broadFileSweepResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/review-chance-files`, {
    method: "POST",
    headers: operatorHeaders,
    body: "{}"
  });
  assert.equal(broadFileSweepResponse.status, 400);
  assert.match((await broadFileSweepResponse.json()).error, /exact-file query unless indexOnly:true/i);

  const broadIndexCommsResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/review-chance-files`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ indexOnly: true, includeGmail: true })
  });
  assert.equal(broadIndexCommsResponse.status, 400);
  assert.match((await broadIndexCommsResponse.json()).error, /cannot include Gmail, Quo, or transcripts/i);

  const minimizedIndexResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/review-chance-files`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ indexOnly: true })
  });
  assert.equal(minimizedIndexResponse.status, 200);
  const minimizedIndex = await minimizedIndexResponse.json();
  assert.deepEqual(
    Object.keys(minimizedIndex.files[0]).sort(),
    ["dateUpdated", "id", "missing", "name", "number", "status"].sort()
  );
  assert.equal(minimizedIndex.brain.status, "isolated_foundation");

  const privacyReviewResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/review-file`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ query: "2739" })
  });
  assert.equal(privacyReviewResponse.status, 200);
  const privacyReview = await privacyReviewResponse.json();
  assert.equal(privacyReview.clientMemory.persisted, false);
  assert.equal(privacyReview.clientMemory.existingClientMemoryRead, false);
  assert.deepEqual(privacyReview.actionReceipts, []);
  assert.equal(privacyReview.brain.status, "isolated_foundation");
  await assert.rejects(
    stat(path.join(memoryRoot, "data", "memory", "files")),
    { code: "ENOENT" }
  );

  const legacyReadOnlyReviewResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/review-file`, {
    method: "POST",
    headers: sharedHeaders,
    body: JSON.stringify({ query: "2739" })
  });
  assert.equal(legacyReadOnlyReviewResponse.status, 200);
  const legacyReadOnlyReview = await legacyReadOnlyReviewResponse.json();
  assert.equal(
    legacyReadOnlyReview.clientMemory.snapshot.file.id,
    "contact-chance"
  );
  assert.equal(legacyReadOnlyReview.clientMemory.persisted, false);
  assert.equal(legacyReadOnlyReview.operational.status, "isolated_foundation");
  await assert.rejects(
    stat(path.join(memoryRoot, "data", "memory", "files")),
    { code: "ENOENT" }
  );

  const legacyAdvisoryResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/review-chance-files`, {
    method: "POST",
    headers: sharedHeaders,
    body: JSON.stringify({
      query: "2739",
      includeBrainAdvisory: true,
      includeGmail: false,
      includeQuo: false
    })
  });
  assert.equal(legacyAdvisoryResponse.status, 400);
  assert.match(
    (await legacyAdvisoryResponse.json()).error,
    /not supported.*isolated Thresher/i
  );
  await assert.rejects(
    stat(path.join(memoryRoot, "data", "memory", "operational-advisories.jsonl")),
    { code: "ENOENT" }
  );

  const unreceiptedDraftResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({
      operations: [{
        type: "gmail.send",
        payload: { query: "2739", draftId: "arbitrary-draft" }
      }],
      execute: false
    })
  });
  assert.equal(unreceiptedDraftResponse.status, 403);
  assert.match((await unreceiptedDraftResponse.json()).error, /draft created by this bridge/i);

  const crossFileAttachmentResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({
      operations: [{
        type: "gmail.create_draft",
        payload: {
          query: "2739",
          to: "carrier@example.test",
          subject: "Fixture",
          body: "Fixture body",
          attachments: [{ source: "generated_lor", query: "2741" }]
        }
      }],
      execute: false
    })
  });
  assert.equal(crossFileAttachmentResponse.status, 403);
  assert.match((await crossFileAttachmentResponse.json()).error, /different Chance file/i);

  const base64AttachmentResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({
      operations: [{
        type: "gmail.create_draft",
        payload: {
          query: "2739",
          to: "carrier@example.test",
          subject: "Fixture",
          body: "Fixture body",
          attachments: [{
            source: "base64",
            filename: "unreviewed.txt",
            contentBase64: Buffer.from("unreviewed").toString("base64")
          }]
        }
      }],
      execute: false
    })
  });
  assert.equal(base64AttachmentResponse.status, 400);
  assert.match((await base64AttachmentResponse.json()).error, /cannot attach arbitrary base64/i);

  const scopedDraftResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({
      operations: [{
        type: "gmail.create_draft",
        payload: {
          query: "2739",
          to: "carrier@example.test",
          subject: "Fixture",
          body: "Fixture body"
        }
      }],
      execute: false
    })
  });
  assert.equal(scopedDraftResponse.status, 200);
  const scopedDraft = await scopedDraftResponse.json();
  assert.equal(scopedDraft.operations[0].plan.plan.fileScope.id, "contact-chance");
  assert.equal(scopedDraft.operations[0].plan.plan.fileScope.number, 2739);

  const mixedClientBatchResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({
      operations: [
        {
          type: "jobnimbus.create_note",
          payload: { query: "2739", note: "First exact file." }
        },
        {
          type: "jobnimbus.create_note",
          payload: { query: "2741", note: "Second exact file." }
        }
      ],
      execute: false
    })
  });
  assert.equal(mixedClientBatchResponse.status, 400);
  assert.match((await mixedClientBatchResponse.json()).error, /only one exact Chance-assigned file/i);

  const batchPayload = {
    operations: [{
      type: "jobnimbus.update_task",
      payload: { query: "2739", taskId: "fixture-task", completed: true }
    }],
    execute: false
  };
  const batchResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify(batchPayload)
  });
  assert.equal(batchResponse.status, 200);
  const batch = await batchResponse.json();
  assert.equal(batch.mode, "dry_run");
  assert.match(batch.approvalDigest, /^[a-f0-9]{64}$/);
  assert.match(batch.approvalChallenge, /^[A-Za-z0-9_-]{40,100}$/);
  assert.equal(Date.parse(batch.approvalExpiresAt) > Date.now(), true);
  assert.match(batch.instruction, /After approval/i);

  const globallyDisabledExecution = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({
      ...batchPayload,
      execute: true,
      approvalDigest: batch.approvalDigest
    })
  });
  assert.equal(globallyDisabledExecution.status, 400);
  assert.match((await globallyDisabledExecution.json()).error, /Writes are disabled/i);

  for (const pathname of [
    "/jobnimbus/upload-file",
    "/jobnimbus/update-contact",
    "/claim-filing/call",
    "/retell/carrier-follow-up-call",
    "/voice/outbound-call",
    "/gmail/draft",
    "/gmail/send",
    "/quo/send",
    "/auth/quo-line"
  ]) {
    const response = await fetch(`http://127.0.0.1:${bridgePort}${pathname}`, {
      method: "POST",
      headers: operatorHeaders,
      body: "{}"
    });
    assert.equal(response.status, 403, pathname);
  }
  const removedPersistenceRoute = await fetch(
    `http://127.0.0.1:${bridgePort}/memory/persistence-check`,
    {
      method: "POST",
      headers: operatorHeaders,
      body: "{}"
    }
  );
  assert.equal(removedPersistenceRoute.status, 404);

  const attachmentUploadResponse = await fetch(`http://127.0.0.1:${bridgePort}/gmail/attachment-review`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ uploadToJobNimbus: true })
  });
  assert.equal(attachmentUploadResponse.status, 403);
  assert.match((await attachmentUploadResponse.json()).error, /cannot upload.*directly to JobNimbus/i);

  const sharedDirectRouteResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/update-contact`, {
    method: "POST",
    headers: sharedHeaders,
    body: "{}"
  });
  assert.equal(sharedDirectRouteResponse.status, 400);
  assert.match((await sharedDirectRouteResponse.json()).error, /query is required/i);

  const unknownTokenResponse = await fetch(`http://127.0.0.1:${bridgePort}/brain/context`, {
    method: "POST",
    headers: { authorization: "Bearer unknown-token", "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(unknownTokenResponse.status, 404);
});

test("Mac operator supports one explicit company file while HP and broad company access stay blocked", async (t) => {
  const bridgePort = 18934;
  const fakeApiPort = 18935;
  const memoryRoot = await mkdtemp(path.join(tmpdir(), "codex-mac-company-scope-"));
  t.after(() => rm(memoryRoot, { recursive: true, force: true }));
  const fixtureApi = await startOperatorJobNimbusFixture(t, fakeApiPort, {
    companyOther: true,
    communicationScope: true
  });
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(bridgePort),
      JOBNIMBUS_BRIDGE_TOKEN: "",
      CODEX_OPERATOR_TOKEN: "fixture-codex-operator-token-1234567890",
      CODEX_MAC_OPERATOR_TOKEN: "fixture-codex-mac-operator-token-1234567890",
      JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      JOBNIMBUS_API_KEY: "fixture-key",
      GOOGLE_CLIENT_ID: "fixture-client",
      GOOGLE_CLIENT_SECRET: "fixture-secret",
      GOOGLE_REFRESH_TOKEN: "fixture-refresh",
      NODE_ENV: "test",
      GOOGLE_TOKEN_URL: `http://127.0.0.1:${fakeApiPort}/oauth-token`,
      GMAIL_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      ALLOW_GOOGLE_USER_AUTH: "false",
      QUO_API_KEY: "fixture-quo-key",
      QUO_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      QUO_DEFAULT_FROM_NUMBER: "+19725550100",
      HCN_OPERATIONS_ROOT: memoryRoot,
      ALLOW_GMAIL_SEND: "false",
      ALLOW_QUO_SEND: "false",
      BRIDGE_ALLOW_WRITES: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, bridgePort);

  const hpHeaders = {
    authorization: "Bearer fixture-codex-operator-token-1234567890",
    "content-type": "application/json"
  };
  const macHeaders = {
    authorization: "Bearer fixture-codex-mac-operator-token-1234567890",
    "content-type": "application/json"
  };

  const hpCompanyResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/review-file`, {
    method: "POST",
    headers: hpHeaders,
    body: JSON.stringify({ query: "3901", operatorScope: "company" })
  });
  assert.equal(hpCompanyResponse.status, 403);
  assert.match((await hpCompanyResponse.json()).error, /dedicated Mac operator/i);

  const macDefaultResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/review-file`, {
    method: "POST",
    headers: macHeaders,
    body: JSON.stringify({ query: "3901" })
  });
  assert.equal(macDefaultResponse.status, 400);
  assert.match((await macDefaultResponse.json()).error, /No Chance Pearson/i);

  const companySearchResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/search`, {
    method: "POST",
    headers: macHeaders,
    body: JSON.stringify({ query: "3901", operatorScope: "company" })
  });
  assert.equal(companySearchResponse.status, 200);
  const companySearch = await companySearchResponse.json();
  assert.equal(companySearch.scope, "explicit_company_file");
  assert.deepEqual(companySearch.matches, [{
    id: "contact-company-other",
    number: 3901,
    name: "Richard Fixture Homeowner",
    status: "Active"
  }]);

  const broadCompanyResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/review-chance-files`, {
    method: "POST",
    headers: macHeaders,
    body: JSON.stringify({ operatorScope: "company", indexOnly: true })
  });
  assert.equal(broadCompanyResponse.status, 400);
  assert.match((await broadCompanyResponse.json()).error, /requires an exact JobNimbus/i);

  const companyReviewResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/review-chance-files`, {
    method: "POST",
    headers: macHeaders,
    body: JSON.stringify({
      query: "3901",
      operatorScope: "company",
      includeGmail: true,
      includeQuo: true,
      limit: 1
    })
  });
  assert.equal(companyReviewResponse.status, 200);
  const companyReview = await companyReviewResponse.json();
  assert.equal(companyReview.scope, "explicit_company_file");
  assert.equal(companyReview.owner.name, "Explicit company file");
  assert.equal(companyReview.packets[0].file.id, "contact-company-other");
  assert.deepEqual(
    companyReview.packets[0].gmail.messages.map((row) => row.id),
    ["company-claim-message"]
  );
  assert.deepEqual(
    companyReview.packets[0].quo.timeline.map((row) => row.id),
    ["client-call"]
  );

  const companyTaskBatchResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: macHeaders,
    body: JSON.stringify({
      operations: [{
        type: "jobnimbus.create_task",
        payload: {
          query: "3901",
          title: "Company exact-file fixture task plan.",
          dueDate: "2026-07-30T14:30:00-05:00",
          operatorScope: "company"
        }
      }],
      execute: false
    })
  });
  assert.equal(companyTaskBatchResponse.status, 200);
  const companyTaskBatch = await companyTaskBatchResponse.json();
  assert.equal(companyTaskBatch.mode, "dry_run");
  assert.deepEqual(
    companyTaskBatch.operations[0].plan.plan.body.owners,
    [{ id: "richard-owner-id" }]
  );

  const companyBatchResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: macHeaders,
    body: JSON.stringify({
      operations: [{
        type: "jobnimbus.create_note",
        payload: {
          query: "3901",
          note: "Company exact-file fixture dry run.",
          operatorScope: "company"
        }
      }],
      execute: false
    })
  });
  assert.equal(companyBatchResponse.status, 200);
  const companyBatch = await companyBatchResponse.json();
  assert.equal(companyBatch.mode, "dry_run");
  assert.equal(companyBatch.operations[0].plan.file.id, "contact-company-other");
  assert.ok(companyBatch.approvalDigest);
  assert.ok(companyBatch.approvalChallenge);

  const companyBatchExecuteResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: macHeaders,
    body: JSON.stringify({
      operations: [{
        type: "jobnimbus.create_note",
        payload: {
          query: "3901",
          note: "Company exact-file fixture dry run.",
          operatorScope: "company"
        }
      }],
      execute: true,
      approvalDigest: companyBatch.approvalDigest,
      approvalChallenge: companyBatch.approvalChallenge
    })
  });
  assert.equal(companyBatchExecuteResponse.status, 200);
  const companyBatchExecute = await companyBatchExecuteResponse.json();
  assert.equal(companyBatchExecute.mode, "executed");
  assert.equal(fixtureApi.getCompanyNoteCreateCount(), 1);

  const mixedScopeResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: macHeaders,
    body: JSON.stringify({
      operations: [
        {
          type: "jobnimbus.create_note",
          payload: {
            query: "3901",
            note: "Company scope.",
            operatorScope: "company"
          }
        },
        {
          type: "jobnimbus.create_note",
          payload: {
            query: "2739",
            note: "Assigned scope.",
            operatorScope: "assigned"
          }
        }
      ],
      execute: false
    })
  });
  assert.equal(mixedScopeResponse.status, 400);
  assert.match((await mixedScopeResponse.json()).error, /cannot mix assigned and company/i);
});

test("Codex operator action batches require the unchanged approval digest", async (t) => {
  const bridgePort = 18885;
  const fakeApiPort = 18887;
  const memoryRoot = await mkdtemp(path.join(tmpdir(), "codex-operator-digest-"));
  t.after(() => rm(memoryRoot, { recursive: true, force: true }));
  const fixtureApi = await startOperatorJobNimbusFixture(t, fakeApiPort);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(bridgePort),
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-shared-token",
      CODEX_OPERATOR_TOKEN: "fixture-codex-operator-token-1234567890",
      JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      JOBNIMBUS_API_KEY: "fixture-key",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      ALLOW_GOOGLE_USER_AUTH: "false",
      QUO_API_KEY: "",
      QUO_DEFAULT_FROM_NUMBER: "",
      HCN_OPERATIONS_ROOT: memoryRoot,
      BRIDGE_ALLOW_WRITES: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, bridgePort);

  const headers = {
    authorization: "Bearer fixture-codex-operator-token-1234567890",
    "content-type": "application/json"
  };
  const operations = [{
    type: "jobnimbus.update_task",
    payload: { query: "2739", taskId: "fixture-task", completed: true }
  }];
  const dryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operations, execute: false })
  });
  assert.equal(dryRunResponse.status, 200);
  const dryRun = await dryRunResponse.json();
  assert.match(dryRun.approvalChallenge, /^[A-Za-z0-9_-]{40,100}$/);

  const missingDigestResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operations, execute: true })
  });
  assert.equal(missingDigestResponse.status, 400);
  assert.match((await missingDigestResponse.json()).error, /approvalDigest from its exact dry run/i);

  const missingChallengeResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operations, execute: true, approvalDigest: dryRun.approvalDigest })
  });
  assert.equal(missingChallengeResponse.status, 400);
  assert.match((await missingChallengeResponse.json()).error, /approvalChallenge from its exact dry run/i);

  const changedPlanResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      operations: [{
        type: "jobnimbus.update_task",
        payload: { query: "2739", taskId: "fixture-task", completed: false }
      }],
      execute: true,
      approvalDigest: dryRun.approvalDigest
    })
  });
  assert.equal(changedPlanResponse.status, 409);
  assert.match((await changedPlanResponse.json()).error, /no longer matches the current plan/i);

  const refreshedPlanResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operations, execute: false })
  });
  assert.equal(refreshedPlanResponse.status, 200);
  const refreshedPlan = await refreshedPlanResponse.json();
  assert.equal(refreshedPlan.approvalDigest, dryRun.approvalDigest);
  assert.notEqual(refreshedPlan.approvalChallenge, dryRun.approvalChallenge);

  const supersededChallengeResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      operations,
      execute: true,
      approvalDigest: dryRun.approvalDigest,
      approvalChallenge: dryRun.approvalChallenge
    })
  });
  assert.equal(supersededChallengeResponse.status, 409);
  assert.match((await supersededChallengeResponse.json()).error, /challenge is superseded/i);

  const executeBody = JSON.stringify({
    operations,
    execute: true,
    approvalDigest: refreshedPlan.approvalDigest,
    approvalChallenge: refreshedPlan.approvalChallenge
  });
  const concurrent = await Promise.all([
    fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
      method: "POST",
      headers,
      body: executeBody
    }),
    fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
      method: "POST",
      headers,
      body: executeBody
    })
  ]);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);
  const concurrentPayloads = await Promise.all(concurrent.map((response) => response.json()));
  assert.equal(concurrentPayloads.some((payload) => payload.mode === "executed"), true);
  assert.equal(concurrentPayloads.some((payload) => /consumed/i.test(payload.error || "")), true);
  const executedBatch = concurrentPayloads.find((payload) => payload.mode === "executed");
  assert.equal(executedBatch.batch.completed[0].receipt.fileId, "contact-chance");
  assert.equal(executedBatch.batch.completed[0].receipt.fileNumber, 2739);
  assert.equal(fixtureApi.getTaskUpdateCount(), 1);
});

test("Codex operator approval challenges expire before execution", async (t) => {
  const bridgePort = 18920;
  const fakeApiPort = 18921;
  const memoryRoot = await mkdtemp(path.join(tmpdir(), "codex-operator-expiry-"));
  t.after(() => rm(memoryRoot, { recursive: true, force: true }));
  const fixtureApi = await startOperatorJobNimbusFixture(t, fakeApiPort);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(bridgePort),
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-shared-token",
      CODEX_OPERATOR_TOKEN: "fixture-codex-operator-token-1234567890",
      JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      JOBNIMBUS_API_KEY: "fixture-key",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      ALLOW_GOOGLE_USER_AUTH: "false",
      QUO_API_KEY: "",
      HCN_OPERATIONS_ROOT: memoryRoot,
      BRIDGE_ALLOW_WRITES: "true",
      ACTION_APPROVAL_TTL_SECONDS: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, bridgePort);

  const headers = {
    authorization: "Bearer fixture-codex-operator-token-1234567890",
    "content-type": "application/json"
  };
  const operations = [{
    type: "jobnimbus.update_task",
    payload: { query: "2739", taskId: "fixture-task", completed: true }
  }];
  const planResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operations, execute: false })
  });
  assert.equal(planResponse.status, 200);
  const plan = await planResponse.json();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const executeResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      operations,
      execute: true,
      approvalDigest: plan.approvalDigest,
      approvalChallenge: plan.approvalChallenge
    })
  });
  assert.equal(executeResponse.status, 409);
  assert.match((await executeResponse.json()).error, /challenge is expired/i);
  assert.equal(fixtureApi.getTaskUpdateCount(), 0);
});

test("Codex operator security ledgers fail closed on corrupted JSON", async (t) => {
  const bridgePort = 18922;
  const fakeApiPort = 18923;
  const memoryRoot = await mkdtemp(path.join(tmpdir(), "codex-operator-ledger-"));
  const bridgeData = path.join(memoryRoot, "platform");
  await mkdir(bridgeData, { recursive: true });
  await writeFile(path.join(bridgeData, "action-approvals.json"), "{corrupt", "utf8");
  t.after(() => rm(memoryRoot, { recursive: true, force: true }));
  const fixtureApi = await startOperatorJobNimbusFixture(t, fakeApiPort);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(bridgePort),
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-shared-token",
      CODEX_OPERATOR_TOKEN: "fixture-codex-operator-token-1234567890",
      JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      JOBNIMBUS_API_KEY: "fixture-key",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      ALLOW_GOOGLE_USER_AUTH: "false",
      QUO_API_KEY: "",
      HCN_OPERATIONS_ROOT: memoryRoot,
      BRIDGE_ALLOW_WRITES: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, bridgePort);

  const headers = {
    authorization: "Bearer fixture-codex-operator-token-1234567890",
    "content-type": "application/json"
  };
  const operations = [{
    type: "jobnimbus.update_task",
    payload: { query: "2739", taskId: "fixture-task", completed: true }
  }];
  const blockedPlanResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operations, execute: false })
  });
  assert.equal(blockedPlanResponse.status, 503);
  assert.match((await blockedPlanResponse.json()).error, /Action approval ledger is corrupted/i);

  await writeFile(path.join(bridgeData, "action-approvals.json"), "[]\n", "utf8");
  const planResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operations, execute: false })
  });
  assert.equal(planResponse.status, 200);
  const plan = await planResponse.json();
  await writeFile(path.join(bridgeData, "action-batches.json"), "{corrupt", "utf8");
  const executeResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      operations,
      execute: true,
      approvalDigest: plan.approvalDigest,
      approvalChallenge: plan.approvalChallenge
    })
  });
  assert.equal(executeResponse.status, 503);
  assert.match((await executeResponse.json()).error, /Action batch ledger is corrupted/i);
  assert.equal(fixtureApi.getTaskUpdateCount(), 0);
});

test("Codex operator token fails closed when weak or malformed", async () => {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "18888",
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-shared-token",
      CODEX_OPERATOR_TOKEN: "too-short",
      JOBNIMBUS_API_KEY: "",
      ALLOW_GOOGLE_USER_AUTH: "false"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise((resolve) => child.on("exit", resolve));
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /32 to 512 printable non-space ASCII/i);
});

test("Codex operator device tokens must be distinct", async () => {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "18889",
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-shared-token",
      CODEX_OPERATOR_TOKEN: "fixture-duplicate-operator-token-1234567890",
      CODEX_MAC_OPERATOR_TOKEN: "fixture-duplicate-operator-token-1234567890",
      JOBNIMBUS_API_KEY: "",
      ALLOW_GOOGLE_USER_AUTH: "false"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise((resolve) => child.on("exit", resolve));
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /CODEX_MAC_OPERATOR_TOKEN must be different from CODEX_OPERATOR_TOKEN/i);
});

test("Chance file resolution fails closed on tied exact names", async (t) => {
  const bridgePort = 18891;
  const fakeApiPort = 18892;
  await startOperatorJobNimbusFixture(t, fakeApiPort, { duplicateName: true });
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(bridgePort),
      JOBNIMBUS_BRIDGE_TOKEN: "",
      CODEX_OPERATOR_TOKEN: "fixture-codex-operator-token-1234567890",
      JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      JOBNIMBUS_API_KEY: "fixture-key",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      ALLOW_GOOGLE_USER_AUTH: "false",
      QUO_API_KEY: "",
      BRIDGE_ALLOW_WRITES: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, bridgePort);

  const response = await fetch(`http://127.0.0.1:${bridgePort}/ops/review-chance-files`, {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-codex-operator-token-1234567890",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      query: "Fixture Homeowner",
      includeGmail: false,
      includeQuo: false
    })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /ambiguous Chance file query/i);
});

test("Codex operator communication reads stay bound to one exact Chance file", async (t) => {
  const bridgePort = 18893;
  const fakeApiPort = 18894;
  await startOperatorJobNimbusFixture(t, fakeApiPort, {
    communicationScope: true,
    secondAssigned: true,
    duplicateEmail: true
  });
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(bridgePort),
      JOBNIMBUS_BRIDGE_TOKEN: "",
      CODEX_OPERATOR_TOKEN: "fixture-codex-operator-token-1234567890",
      JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      JOBNIMBUS_API_KEY: "fixture-key",
      GOOGLE_CLIENT_ID: "fixture-client",
      GOOGLE_CLIENT_SECRET: "fixture-secret",
      GOOGLE_REFRESH_TOKEN: "fixture-refresh",
      NODE_ENV: "test",
      GOOGLE_TOKEN_URL: `http://127.0.0.1:${fakeApiPort}/oauth-token`,
      GMAIL_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      ALLOW_GOOGLE_USER_AUTH: "false",
      QUO_API_KEY: "fixture-quo-key",
      QUO_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      QUO_DEFAULT_FROM_NUMBER: "+19725550100",
      BRIDGE_ALLOW_WRITES: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, bridgePort);
  const headers = {
    authorization: "Bearer fixture-codex-operator-token-1234567890",
    "content-type": "application/json"
  };

  const vagueFileResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/review-chance-files`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: "Active",
      includeGmail: false,
      includeQuo: false
    })
  });
  assert.equal(vagueFileResponse.status, 400);
  assert.match((await vagueFileResponse.json()).error, /No Chance Pearson JobNimbus insurance file found/i);

  const gmailSearchResponse = await fetch(`http://127.0.0.1:${bridgePort}/gmail/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fileQuery: "2739", limit: 10 })
  });
  assert.equal(gmailSearchResponse.status, 200);
  const gmailSearch = await gmailSearchResponse.json();
  assert.equal(gmailSearch.scope, "chance_assigned_file");
  assert.deepEqual(gmailSearch.messages.map((row) => row.id), ["claim-exact-message"]);

  const unrelatedThreadResponse = await fetch(`http://127.0.0.1:${bridgePort}/gmail/thread`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fileQuery: "2739", threadId: "unrelated-thread" })
  });
  assert.equal(unrelatedThreadResponse.status, 403);
  assert.match((await unrelatedThreadResponse.json()).error, /not strongly correlated/i);

  const quoHistoryResponse = await fetch(`http://127.0.0.1:${bridgePort}/quo/history`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "2739" })
  });
  assert.equal(quoHistoryResponse.status, 200);
  const quoHistory = await quoHistoryResponse.json();
  assert.equal(quoHistory.file.id, "contact-chance");
  assert.deepEqual(quoHistory.timeline.map((row) => row.id), ["client-call"]);

  const unrelatedTranscriptResponse = await fetch(`http://127.0.0.1:${bridgePort}/quo/transcript`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "2739", callId: "unrelated-call" })
  });
  assert.equal(unrelatedTranscriptResponse.status, 403);
  assert.match((await unrelatedTranscriptResponse.json()).error, /not present in the current history/i);
});

test("invited employee Google OAuth keeps Gmail identity isolated and enforces the employee role", async (t) => {
  const bridgePort = 18890;
  const fakeGooglePort = 18891;
  const gmailTokens = [];
  const authMemoryRoot = await mkdtemp(path.join(tmpdir(), "wave-auth-"));
  t.after(() => rm(authMemoryRoot, { recursive: true, force: true }));
  const hcnReferenceKey =
    Buffer.alloc(32, 0x31).toString("base64url");
  await seedAcceptedEmployeeInvitation({
    root: authMemoryRoot,
    key: hcnReferenceKey,
    email: "andrea@wavepa.com",
    displayName: "Andrea Ramirez",
    role: "employee",
    jobNimbusOwnerId: "andrea-owner-id",
    googleSubject: "google-andrea-1"
  });
  let verificationSmsBody = "";
  const fakeGoogle = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${fakeGooglePort}`);
    let response;
    if (url.pathname === "/tokeninfo") {
      assert.equal(url.searchParams.get("access_token"), "andrea-access-token");
      response = {
        audience: "fixture-google-client",
        expires_in: 3600,
        scope: "openid email https://www.googleapis.com/auth/gmail.readonly"
      };
    } else if (url.pathname === "/userinfo") {
      assert.equal(req.headers.authorization, "Bearer andrea-access-token");
      response = {
        sub: "google-andrea-1",
        email: "andrea@wavepa.com",
        email_verified: true,
        hd: "wavepa.com",
        name: "Andrea Ramirez"
      };
    } else if (url.pathname === "/token") {
      response = {
        access_token: "andrea-access-token",
        refresh_token: "andrea-refresh-token",
        expires_in: 3600,
        token_type: "Bearer"
      };
    } else if (url.pathname === "/gmail/v1/users/me/messages") {
      gmailTokens.push(req.headers.authorization);
      response = { messages: [], resultSizeEstimate: 0 };
    } else if (url.pathname === "/account/users") {
      assert.equal(req.headers.authorization, "Bearer fixture-jobnimbus-key");
      response = {
        total: 1,
        users: [{ jnid: "andrea-owner-id", email: "andrea@wavepa.com", display_name: "Andrea Ramirez", is_active: true }]
      };
    } else if (url.pathname === "/v1/phone-numbers") {
      assert.equal(req.headers.authorization, "fixture-quo-key");
      response = { data: [{ id: "PN-andrea", name: "Andrea Ramirez", number: "+19725550200" }] };
    } else if (url.pathname.endsWith("/Messages.json")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      assert.equal(form.get("To"), "+19725550200");
      assert.equal(form.get("From"), "+19725550999");
      verificationSmsBody = form.get("Body") || "";
      response = { sid: "SM-verification" };
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve) => fakeGoogle.listen(fakeGooglePort, "127.0.0.1", resolve));
  t.after(() => fakeGoogle.close());

  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(bridgePort),
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-shared-token",
      GOOGLE_CLIENT_ID: "fixture-google-client",
      GOOGLE_CLIENT_SECRET: "fixture-google-secret",
      GOOGLE_REFRESH_TOKEN: "",
      GOOGLE_TOKENINFO_URL: `http://127.0.0.1:${fakeGooglePort}/tokeninfo`,
      GOOGLE_USERINFO_URL: `http://127.0.0.1:${fakeGooglePort}/userinfo`,
      GOOGLE_TOKEN_URL: `http://127.0.0.1:${fakeGooglePort}/token`,
      GMAIL_API_BASE_URL: `http://127.0.0.1:${fakeGooglePort}`,
      PUBLIC_BASE_URL: `http://127.0.0.1:${bridgePort}`,
      ALLOW_GOOGLE_USER_AUTH: "true",
      GOOGLE_OAUTH_ALLOWED_DOMAIN: "wavepa.com",
      GPT_OAUTH_CLIENT_ID: "fixture-gpt-client",
      GPT_OAUTH_CLIENT_SECRET: "fixture-gpt-secret",
      OAUTH_SESSION_SECRET: "fixture-session-encryption-secret",
      HCN_OPERATIONS_ROOT: authMemoryRoot,
      HCN_TENANT_ID: "tenant_a1b2c3d4e5f60718",
      HCN_REFERENCE_KEY: hcnReferenceKey,
      HCN_QUO_LINK_KEY:
        Buffer.alloc(32, 0x32).toString("base64url"),
      WAVE_AUTH_USERS_JSON: "{}",
      AUTO_ENROLL_WAVE_USERS: "false",
      HCN_IDENTITY_PIN_STORE_PATH: path.join(authMemoryRoot, "identity-pins.json"),
      QUO_API_KEY: "fixture-quo-key",
      QUO_API_BASE_URL: `http://127.0.0.1:${fakeGooglePort}/v1`,
      TWILIO_ACCOUNT_SID: "AC-fixture",
      TWILIO_AUTH_TOKEN: "fixture-twilio-token",
      TWILIO_API_BASE_URL: `http://127.0.0.1:${fakeGooglePort}`,
      TWILIO_FROM_NUMBER: "+19725550999",
      QUO_VERIFICATION_FROM_NUMBER: "+19725550999",
      JOBNIMBUS_API_KEY: "fixture-jobnimbus-key",
      JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${fakeGooglePort}`,
      RETELL_API_KEY: "",
      BRIDGE_ALLOW_WRITES: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, bridgePort);
  const headers = { authorization: "Bearer andrea-access-token" };

  const identityResponse = await fetch(`http://127.0.0.1:${bridgePort}/auth/whoami`, { headers });
  assert.equal(identityResponse.status, 200);
  const identity = await identityResponse.json();
  assert.equal(identity.identity.email, "andrea@wavepa.com");
  assert.equal(identity.identity.role, "employee");
  assert.equal(identity.identity.jobNimbusOwnerId, "andrea-owner-id");
  assert.equal(identity.identity.quoLineConfigured, false);
  assert.equal(identity.gmailMode, "signed_in_employee_mailbox");

  const startQuoLinkResponse = await fetch(`http://127.0.0.1:${bridgePort}/auth/quo-line`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ mode: "start", phone: "+19725550200" })
  });
  assert.equal(startQuoLinkResponse.status, 200);
  const startQuoLink = await startQuoLinkResponse.json();
  assert.equal(startQuoLink.verification.sent, true);
  assert.equal(startQuoLink.verification.from, "***-***-0999");
  const verificationCode = verificationSmsBody.match(/\b(\d{6})\b/)?.[1];
  assert.match(verificationCode || "", /^\d{6}$/);

  const verifyQuoLinkResponse = await fetch(`http://127.0.0.1:${bridgePort}/auth/quo-line`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ mode: "verify", code: verificationCode })
  });
  assert.equal(verifyQuoLinkResponse.status, 200);
  const verifiedQuoLink = await verifyQuoLinkResponse.json();
  assert.equal(verifiedQuoLink.linked, true);
  assert.equal(verifiedQuoLink.line.number, "+19725550200");
  const encryptedQuoStore = await readFile(
    path.join(
      authMemoryRoot,
      "platform",
      "quo-line-store.enc.json"
    ),
    "utf8"
  );
  assert.doesNotMatch(
    encryptedQuoStore,
    /andrea@wavepa\.com|\+19725550200|PN-andrea/
  );

  const linkedIdentityResponse = await fetch(`http://127.0.0.1:${bridgePort}/auth/whoami`, { headers });
  assert.equal(linkedIdentityResponse.status, 200);
  const linkedIdentity = await linkedIdentityResponse.json();
  assert.equal(linkedIdentity.identity.role, "employee");
  assert.equal(linkedIdentity.identity.quoLineConfigured, true);
  assert.equal(linkedIdentity.identity.quoLine.number, "+19725550200");
  assert.equal(linkedIdentity.identity.quoLine.source, "verified_sms_link");

  const gmailResponse = await fetch(`http://127.0.0.1:${bridgePort}/gmail/search`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ query: "newer_than:1d", limit: 1 })
  });
  assert.equal(gmailResponse.status, 403);
  assert.deepEqual(gmailTokens, []);

  const fullAccessResponse = await fetch(`http://127.0.0.1:${bridgePort}/claim-filing/call`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(fullAccessResponse.status, 403);

  const callbackUri = "https://chatgpt.com/aip/g-fixture/oauth/callback";
  const authorizeResponse = await fetch(
    `http://127.0.0.1:${bridgePort}/oauth/authorize?${new URLSearchParams({
      client_id: "fixture-gpt-client",
      redirect_uri: callbackUri,
      response_type: "code",
      state: "chatgpt-state"
    })}`,
    { redirect: "manual" }
  );
  assert.equal(authorizeResponse.status, 302);
  const googleAuthorize = new URL(authorizeResponse.headers.get("location"));
  assert.equal(googleAuthorize.hostname, "accounts.google.com");
  assert.equal(googleAuthorize.searchParams.get("client_id"), "fixture-google-client");

  const callbackResponse = await fetch(
    `http://127.0.0.1:${bridgePort}/oauth/google/callback?${new URLSearchParams({
      code: "fixture-google-code",
      state: googleAuthorize.searchParams.get("state")
    })}`,
    { redirect: "manual" }
  );
  assert.equal(callbackResponse.status, 302);
  const chatGptCallback = new URL(callbackResponse.headers.get("location"));
  assert.equal(chatGptCallback.origin + chatGptCallback.pathname, callbackUri);
  assert.equal(chatGptCallback.searchParams.get("state"), "chatgpt-state");

  const tokenResponse = await fetch(`http://127.0.0.1:${bridgePort}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "fixture-gpt-client",
      client_secret: "fixture-gpt-secret",
      redirect_uri: callbackUri,
      code: chatGptCallback.searchParams.get("code")
    })
  });
  assert.equal(tokenResponse.status, 200);
  const brokerTokens = await tokenResponse.json();
  assert.equal(brokerTokens.token_type, "Bearer");
  assert.ok(brokerTokens.access_token);
  assert.ok(brokerTokens.refresh_token);

  const brokerIdentityResponse = await fetch(`http://127.0.0.1:${bridgePort}/auth/whoami`, {
    headers: { authorization: `Bearer ${brokerTokens.access_token}` }
  });
  assert.equal(brokerIdentityResponse.status, 200);
  const brokerIdentity = await brokerIdentityResponse.json();
  assert.equal(brokerIdentity.identity.email, "andrea@wavepa.com");
});

test("HCN console uses a cookie-bound Google session for isolated fresh read-only operations", async (t) => {
  const bridgePort = 18930;
  const fakeGooglePort = 18931;
  const origin = `http://127.0.0.1:${bridgePort}`;
  const providerRequests = [];
  const revokedGoogleGrants = [];
  const hcnProviderRequests = [];
  const hcnManagementActivityFilters = [];
  const jobNimbusMutationRequests = [];
  const chanceOwnerId = "fixture-chance-owner";
  const otherOwnerId = "fixture-other-owner";
  const thirdOwnerId = "fixture-third-owner";
  const exactFileId = "jn-fixture-active";
  const activeContact = {
    jnid: exactFileId,
    number: "HCN-1001",
    record_type_name: "Insurance",
    owners: [{ id: chanceOwnerId }],
    display_name: "Fixture Active Homeowner",
    status_name: "Claim Filed",
    stage_name: "Carrier Review",
    is_active: true,
    date_created: "2026-07-20T15:00:00.000Z",
    date_updated: "2026-07-27T15:00:00.000Z",
    next_appointment_at: "2026-07-29T14:00:00.000Z",
    email: "active.homeowner@example.test",
    mobile_phone: "2145551212",
    address_line1: "100 Fixture Way",
    city: "Dallas",
    state_text: "TX",
    zip: "75001",
    "Insurance Company": "Fixture Mutual",
    "Claim #": "HCN-CLAIM-1001",
    "Policy #": "HCN-POLICY-1001",
    "Date of Loss": "2026-05-18",
    "Carrier DA": "Fixture Adjuster"
  };
  const inactiveChanceContact = {
    ...activeContact,
    jnid: "jn-fixture-inactive",
    number: "HCN-1002",
    display_name: "Fixture Inactive Homeowner",
    is_active: false,
    email: "inactive.homeowner@example.test",
    mobile_phone: "2145551213",
    "Claim #": "HCN-CLAIM-1002",
    "Policy #": "HCN-POLICY-1002"
  };
  const otherOwnerContact = {
    ...activeContact,
    jnid: "jn-fixture-other-owner",
    number: "HCN-1003",
    display_name: "Fixture Other Owner",
    owners: [{ id: otherOwnerId }],
    email: "other.owner@example.test",
    mobile_phone: "2145551214",
    "Claim #": "HCN-CLAIM-1003",
    "Policy #": "HCN-POLICY-1003"
  };
  const thirdOwnerContact = {
    ...activeContact,
    jnid: "jn-fixture-third-owner",
    number: "HCN-1005",
    display_name: "Fixture Third Owner",
    owners: [{ id: thirdOwnerId }],
    email: "third.owner@example.test",
    mobile_phone: "2145551216",
    "Claim #": "HCN-CLAIM-1005",
    "Policy #": "HCN-POLICY-1005"
  };
  const nonInsuranceContact = {
    ...activeContact,
    jnid: "jn-fixture-non-insurance",
    number: "HCN-1004",
    display_name: "Fixture Retail Contact",
    record_type_name: "Retail",
    email: "retail.contact@example.test",
    mobile_phone: "2145551215",
    "Claim #": "HCN-CLAIM-1004",
    "Policy #": "HCN-POLICY-1004"
  };
  const unconfiguredOwnerContact = {
    ...activeContact,
    jnid: "jn-fixture-unconfigured-owner",
    number: "HCN-1007",
    display_name: "Fixture Unconfigured Owner",
    owners: [{ id: "fixture-unconfigured-owner" }],
    email: "unconfigured.owner@example.test",
    mobile_phone: "2145551218",
    "Claim #": "HCN-CLAIM-1007",
    "Policy #": "HCN-POLICY-1007"
  };
  const allContacts = [
    activeContact,
    inactiveChanceContact,
    otherOwnerContact,
    thirdOwnerContact,
    nonInsuranceContact,
    unconfiguredOwnerContact
  ];
  let serveUnknownContactsWrapper = false;
  let ambiguousManagementReferenceId = "";
  let managementActivityOverride = null;
  let serveWrongManagementReferenceField = false;
  let hcnBoundedHistoryMode = false;
  let hcnDisjointActivityOverflowMode = false;
  const memoryRoot = await mkdtemp(path.join(tmpdir(), "hcn-console-memory-canary-"));
  t.after(() => rm(memoryRoot, { recursive: true, force: true }));
  const legacyCanaryPath = path.join(
    memoryRoot,
    "data",
    "memory",
    "files",
    `${createHash("sha256").update(exactFileId).digest("hex")}.json`
  );
  const legacyCanaryBytes = Buffer.from(
    `${JSON.stringify({
      version: 1,
      subjectKey: exactFileId,
      canary: "legacy-v1-must-remain-byte-identical"
    })}\n`
  );
  await mkdir(path.dirname(legacyCanaryPath), { recursive: true });
  await writeFile(legacyCanaryPath, legacyCanaryBytes);
  const legacyCanaryBefore = await stat(legacyCanaryPath);
  const hcnReferenceKey = Buffer.alloc(32, 0x5a).toString("base64url");
  const hcnGoogleGrantKey =
    Buffer.alloc(32, 0x4c).toString("base64url");
  const hcnQuoLinkKey =
    Buffer.alloc(32, 0x6d).toString("base64url");
  await seedAcceptedEmployeeInvitation({
    root: memoryRoot,
    key: hcnReferenceKey,
    email: "adjuster@wavepa.com",
    displayName: "Employee Fixture",
    role: "employee",
    jobNimbusOwnerId: otherOwnerId,
    googleSubject: "hcn-employee-google-subject"
  });
  const hcnGoogleGrantStorePath = path.join(
    memoryRoot,
    "bridge",
    "hcn-google-grants.enc.json"
  );
  const hcnConnectorScopes = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.readonly"
  ];
  const hcnConnectorScopeText = hcnConnectorScopes.join(" ");

  const fakeGoogle = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${fakeGooglePort}`);
    if (url.pathname === "/revoke" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(
        Buffer.concat(chunks).toString("utf8")
      );
      revokedGoogleGrants.push(form.get("token"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      if (form.get("grant_type") === "refresh_token") {
        assert.equal(form.get("client_id"), "hcn-employee-connector-client");
        assert.equal(form.get("client_secret"), "hcn-employee-connector-secret");
        const refreshToken = form.get("refresh_token");
        const employeeRefresh =
          refreshToken === "hcn-employee-connector-refresh-token";
        assert.equal(
          refreshToken === "hcn-google-connector-refresh-token"
            || employeeRefresh,
          true
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          access_token: employeeRefresh
            ? "hcn-employee-connector-refreshed-access-token"
            : "hcn-google-connector-refreshed-access-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: hcnConnectorScopeText
        }));
        return;
      }
      const code = form.get("code");
      const connectorCode =
        code === "hcn-google-connector-code"
        || code === "hcn-employee-connector-code";
      const employeeCode =
        code === "hcn-employee-google-code"
        || code === "hcn-employee-connector-code";
      assert.equal(
        form.get("client_id"),
        "hcn-employee-connector-client"
      );
      assert.equal(
        form.get("client_secret"),
        "hcn-employee-connector-secret"
      );
      assert.equal(
        [
          "hcn-google-code",
          "hcn-google-code-second-session",
          "hcn-google-connector-code",
          "hcn-employee-google-code",
          "hcn-employee-connector-code"
        ].includes(code),
        true
      );
      providerRequests.push({
        code,
        grantType: form.get("grant_type"),
        verifier: form.get("code_verifier"),
        redirectUri: form.get("redirect_uri")
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: employeeCode
          ? (
              connectorCode
                ? "hcn-employee-connector-access-token"
                : "hcn-employee-login-access-token"
            )
          : (
              connectorCode
                ? "hcn-google-connector-access-token"
                : "hcn-google-access-token"
            ),
        ...(connectorCode
          ? {
              refresh_token: employeeCode
                ? "hcn-employee-connector-refresh-token"
                : "hcn-google-connector-refresh-token",
              scope: hcnConnectorScopeText
            }
          : {}),
        expires_in: 3600,
        token_type: "Bearer"
      }));
      return;
    }
    if (url.pathname === "/tokeninfo") {
      const accessToken = url.searchParams.get("access_token");
      const acceptedTokens = [
        "legacy-google-access-token",
        "hcn-google-access-token",
        "hcn-google-connector-access-token",
        "hcn-google-connector-refreshed-access-token",
        "hcn-employee-login-access-token",
        "hcn-employee-connector-access-token",
        "hcn-employee-connector-refreshed-access-token"
      ];
      assert.equal(acceptedTokens.includes(accessToken), true);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        audience: accessToken === "legacy-google-access-token"
          ? "hcn-google-client"
          : "hcn-employee-connector-client",
        expires_in: 3600,
        verified_email: true,
        scope: accessToken.includes("connector")
          ? hcnConnectorScopeText
          : "openid email profile"
      }));
      return;
    }
    if (url.pathname === "/userinfo") {
      const accessToken = String(
        req.headers.authorization || ""
      ).replace(/^Bearer\s+/, "");
      const employeeIdentity =
        accessToken.startsWith("hcn-employee-");
      assert.equal(
        [
          "legacy-google-access-token",
          "hcn-google-access-token",
          "hcn-google-connector-access-token",
          "hcn-google-connector-refreshed-access-token",
          "hcn-employee-login-access-token",
          "hcn-employee-connector-access-token",
          "hcn-employee-connector-refreshed-access-token"
        ].includes(accessToken),
        true
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        sub: employeeIdentity
          ? "hcn-employee-google-subject"
          : "hcn-google-subject",
        email: employeeIdentity
          ? "adjuster@wavepa.com"
          : "chance@wavepa.com",
        email_verified: true,
        hd: "wavepa.com",
        name: employeeIdentity
          ? "Employee Fixture"
          : "Chance Fixture"
      }));
      return;
    }
    if (
      url.pathname === "/account/users"
      && req.method === "GET"
    ) {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-jobnimbus-api-key"
      );
      assert.equal(url.search, "");
      res.writeHead(200, {
        "content-type": "application/json"
      });
      res.end(JSON.stringify({
        users: [
          {
            jnid: chanceOwnerId,
            email: "chance@wavepa.com",
            display_name: "Chance Fixture",
            is_active: true
          },
          {
            jnid: otherOwnerId,
            email: "adjuster@wavepa.com",
            display_name: "Employee Fixture",
            is_active: true
          }
        ]
      }));
      return;
    }
    if (url.pathname === "/contacts" && req.method === "GET") {
      assert.equal(req.headers.authorization, "Bearer hcn-jobnimbus-api-key");
      hcnProviderRequests.push(`jobnimbus:${url.pathname}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(
        serveUnknownContactsWrapper
          ? { unknownWrapper: allContacts }
          : { contacts: allContacts }
      ));
      return;
    }
    if (
      url.pathname === `/contacts/${encodeURIComponent(exactFileId)}`
      && req.method === "GET"
    ) {
      assert.equal(req.headers.authorization, "Bearer hcn-jobnimbus-api-key");
      hcnProviderRequests.push(`jobnimbus:${url.pathname}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(activeContact));
      return;
    }
    if (
      url.pathname ===
        `/contacts/${encodeURIComponent(otherOwnerContact.jnid)}`
      && req.method === "GET"
    ) {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-jobnimbus-api-key"
      );
      hcnProviderRequests.push(`jobnimbus:${url.pathname}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(otherOwnerContact));
      return;
    }
    if (url.pathname === "/activities" && req.method === "POST") {
      jobNimbusMutationRequests.push({
        method: req.method,
        pathname: url.pathname
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jnid: "jn-created-note-must-not-run" }));
      return;
    }
    if (url.pathname === "/activities" && req.method === "GET") {
      assert.equal(req.headers.authorization, "Bearer hcn-jobnimbus-api-key");
      hcnProviderRequests.push(`jobnimbus:${url.pathname}`);
      const filter = JSON.parse(url.searchParams.get("filter") || "{}");
      const term = filter?.must?.[0]?.term || {};
      const referenceField = Object.keys(term)[0] || "related.id";
      const referencedFileId = String(
        term[referenceField] || exactFileId
      );
      hcnManagementActivityFilters.push({
        referenceField,
        referencedFileId
      });
      if (
        hcnDisjointActivityOverflowMode
        && referencedFileId === exactFileId
      ) {
        const size = Number(url.searchParams.get("size") || 50);
        const offset = Number(url.searchParams.get("offset") || 0);
        const relatedOnly = referenceField === "related.id";
        const activities = Array.from({ length: 51 }, (_, index) => ({
          jnid: `jn-disjoint-${relatedOnly ? "related" : "primary"}-${
            index + 1
          }`,
          primary: {
            id: relatedOnly ? "non-contact-primary-ref" : exactFileId
          },
          related: {
            id: relatedOnly ? exactFileId : "non-contact-related-ref"
          },
          record_type_name: "Note",
          status_name: "Recorded",
          date_created: new Date(
            Date.parse(
              relatedOnly
                ? "2026-07-27T15:00:00.000Z"
                : "2026-07-20T15:00:00.000Z"
            ) - index * 60_000
          ).toISOString(),
          actor_role: "adjuster",
          note: `${relatedOnly ? "Newer related-only" : "Older primary-only"} activity ${
            index + 1
          }`
        }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          activities: activities.slice(offset, offset + size)
        }));
        return;
      }
      if (hcnBoundedHistoryMode && referencedFileId === exactFileId) {
        const size = Number(url.searchParams.get("size") || 50);
        const offset = Number(url.searchParams.get("offset") || 0);
        const activities = Array.from({ length: 51 }, (_, index) => ({
          jnid: `jn-bounded-activity-${index + 1}`,
          primary: { id: exactFileId },
          related: { id: exactFileId },
          record_type_name: "Note",
          status_name: "Recorded",
          date_created: new Date(
            Date.parse("2026-07-27T14:00:00.000Z") - index * 60_000
          ).toISOString(),
          actor_role: "adjuster",
          note: `Bounded synthetic activity ${index + 1}`
        }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          activities: activities.slice(offset, offset + size)
        }));
        return;
      }
      const activityNumber = new Map([
        [exactFileId, "1"],
        [otherOwnerContact.jnid, "2"],
        [thirdOwnerContact.jnid, "3"]
      ]).get(referencedFileId) || "unknown";
      res.writeHead(200, { "content-type": "application/json" });
      const activityOverride =
        referencedFileId === exactFileId && managementActivityOverride
          ? managementActivityOverride
          : {};
      res.end(JSON.stringify({
        activities: [{
          jnid: `jn-activity-${activityNumber}`,
          primary: {
            id:
              serveWrongManagementReferenceField
              && referenceField === "primary.id"
              && referencedFileId === exactFileId
                ? nonInsuranceContact.jnid
                : referencedFileId
          },
          related:
            ambiguousManagementReferenceId
            && referencedFileId === exactFileId
              ? [
                  { id: referencedFileId },
                  { id: ambiguousManagementReferenceId }
                ]
              : { id: referencedFileId },
          record_type_name:
            activityOverride.record_type_name || "Note",
          status_name:
            activityOverride.status_name || "Recorded",
          date_created:
            activityOverride.date_created
            || (
              activityNumber === "1"
                ? "2026-07-27T14:00:00.000Z"
                : activityNumber === "2"
                  ? "2026-07-26T14:00:00.000Z"
                  : "2026-07-25T14:00:00.000Z"
            ),
          actor_role: "adjuster",
          note: "Fresh synthetic carrier activity"
        }]
      }));
      return;
    }
    if (url.pathname === "/tasks" && req.method === "GET") {
      assert.equal(req.headers.authorization, "Bearer hcn-jobnimbus-api-key");
      hcnProviderRequests.push(`jobnimbus:${url.pathname}`);
      if (hcnBoundedHistoryMode) {
        const size = Number(url.searchParams.get("size") || 50);
        const offset = Number(url.searchParams.get("offset") || 0);
        const tasks = Array.from({ length: 51 }, (_, index) => ({
          jnid: `jn-bounded-task-${index + 1}`,
          related: { id: exactFileId },
          record_type_name: "Follow Up",
          status_name: "Open",
          priority_name: "High",
          date_start: new Date(
            Date.parse("2026-07-27T16:00:00.000Z") - index * 60_000
          ).toISOString(),
          assigned_role: "coordinator",
          title: `Bounded synthetic task ${index + 1}`
        }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          tasks: tasks.slice(offset, offset + size)
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        tasks: [{
          jnid: "jn-task-1",
          related: { id: exactFileId },
          record_type_name: "Follow Up",
          status_name: "Open",
          priority_name: "High",
          date_start: "2020-01-02T15:00:00.000Z",
          assigned_role: "coordinator",
          title: "Fresh synthetic overdue task"
        }]
      }));
      return;
    }
    if (url.pathname === "/files" && req.method === "GET") {
      assert.equal(req.headers.authorization, "Bearer hcn-jobnimbus-api-key");
      hcnProviderRequests.push(`jobnimbus:${url.pathname}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        files: [{
          jnid: "jn-document-1",
          related: { id: exactFileId },
          name: "Settlement Estimate.pdf",
          record_type_name: "Carrier Document",
          content_type: "application/pdf",
          status_name: "New",
          date_created: "2026-07-27T13:00:00.000Z"
        }]
      }));
      return;
    }
    if (
      url.pathname === "/gmail/v1/users/me/messages"
      && req.method === "GET"
    ) {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-google-connector-access-token"
      );
      assert.match(url.searchParams.get("q"), /HCN-CLAIM-1001/);
      hcnProviderRequests.push(`gmail:${url.pathname}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        messages: [
          { id: "gmail-message-1", threadId: "gmail-thread-1" },
          { id: "gmail-message-2", threadId: "gmail-carrier-thread-1" }
        ]
      }));
      return;
    }
    if (
      url.pathname === "/gmail/v1/users/me/messages/gmail-message-1"
      && req.method === "GET"
    ) {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-google-connector-access-token"
      );
      assert.equal(url.searchParams.get("format"), "full");
      hcnProviderRequests.push(`gmail:${url.pathname}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "gmail-message-1",
        threadId: "gmail-thread-1",
        internalDate: String(Date.parse("2026-07-27T16:00:00.000Z")),
        snippet: "Fresh synthetic homeowner reply",
        payload: {
          mimeType: "text/plain",
          headers: [
            {
              name: "From",
              value: "Fixture Active Homeowner <active.homeowner@example.test>"
            },
            { name: "To", value: "claims@wavepa.com" },
            { name: "Subject", value: "Re: HCN-CLAIM-1001" },
            { name: "Date", value: "Mon, 27 Jul 2026 11:00:00 -0500" }
          ],
          body: {
            data: Buffer.from("Fresh synthetic homeowner reply")
              .toString("base64url")
          }
        }
      }));
      return;
    }
    if (
      url.pathname === "/gmail/v1/users/me/messages/gmail-message-2"
      && req.method === "GET"
    ) {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-google-connector-access-token"
      );
      assert.equal(url.searchParams.get("format"), "full");
      hcnProviderRequests.push(`gmail:${url.pathname}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "gmail-message-2",
        threadId: "gmail-carrier-thread-1",
        internalDate: String(Date.parse("2026-07-27T17:30:00.000Z")),
        labelIds: ["SENT"],
        snippet: "Fresh synthetic carrier follow-up",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "claims@wavepa.com" },
            { name: "To", value: "carrier@example.test" },
            {
              name: "Subject",
              value: "HCN-CLAIM-1001 carrier follow-up"
            },
            { name: "Date", value: "Mon, 27 Jul 2026 12:30:00 -0500" }
          ],
          body: {
            data: Buffer.from(
              "Fresh synthetic sent carrier follow-up"
            ).toString("base64url")
          }
        }
      }));
      return;
    }
    if (url.pathname === "/quo/phone-numbers" && req.method === "GET") {
      assert.equal(req.headers.authorization, "hcn-quo-api-key");
      hcnProviderRequests.push(`quo:${url.pathname}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [
          {
            id: "quo-line-1",
            name: "Fixture HCN line",
            number: "+12145559999"
          },
          {
            id: "quo-line-other-employee",
            name: "Other employee line",
            number: "+12145559888"
          }
        ]
      }));
      return;
    }
    if (url.pathname === "/quo/messages" && req.method === "GET") {
      assert.equal(req.headers.authorization, "hcn-quo-api-key");
      assert.equal(url.searchParams.get("phoneNumberId"), "quo-line-1");
      assert.equal(url.searchParams.get("participants[]"), "+12145551212");
      hcnProviderRequests.push(`quo:${url.pathname}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [
          {
            id: "quo-message-1",
            phoneNumberId: "quo-line-1",
            from: "+12145551212",
            to: ["+12145559999"],
            createdAt: "2026-07-27T17:00:00.000Z",
            direction: "incoming",
            status: "delivered",
            content: "Fresh synthetic text reply"
          },
          {
            id: "quo-message-2",
            phoneNumberId: "quo-line-1",
            from: "+12145559999",
            to: ["+12145551212"],
            createdAt: "2026-07-27T18:30:00.000Z",
            direction: "outgoing",
            status: "delivered",
            content: "Fresh synthetic follow-up"
          }
        ]
      }));
      return;
    }
    if (url.pathname === "/quo/calls" && req.method === "GET") {
      assert.equal(req.headers.authorization, "hcn-quo-api-key");
      assert.equal(url.searchParams.get("phoneNumberId"), "quo-line-1");
      assert.equal(url.searchParams.get("participants[]"), "+12145551212");
      hcnProviderRequests.push(`quo:${url.pathname}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [{
          id: "quo-call-1",
          phoneNumberId: "quo-line-1",
          participants: ["+12145551212"],
          createdAt: "2026-07-27T18:00:00.000Z",
          direction: "outgoing",
          status: "completed",
          duration: 45
        }]
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => fakeGoogle.listen(fakeGooglePort, "127.0.0.1", resolve));
  t.after(() => fakeGoogle.close());

  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(bridgePort),
      PUBLIC_BASE_URL: origin,
      HCN_CONSOLE_ENABLED: "true",
      HCN_CONSOLE_ORIGIN: origin,
      HCN_THRESHER_AI_ENABLED: "false",
      HCN_THRESHER_AI_GROQ_API_KEY: "",
      HCN_ASSISTANT_HISTORY_KEY:
        Buffer.alloc(32, 0x55).toString("base64url"),
      HCN_TENANT_ID: "tenant_0123456789abcdef",
      HCN_REFERENCE_KEY: hcnReferenceKey,
      HCN_GOOGLE_GRANT_KEY: hcnGoogleGrantKey,
      HCN_QUO_LINK_KEY: hcnQuoLinkKey,
      HCN_GOOGLE_GRANT_STORE_PATH: hcnGoogleGrantStorePath,
      ALLOW_GOOGLE_USER_AUTH: "true",
      GOOGLE_CLIENT_ID: "hcn-google-client",
      GOOGLE_CLIENT_SECRET: "hcn-google-secret",
      HCN_GOOGLE_CLIENT_ID: "hcn-employee-connector-client",
      HCN_GOOGLE_CLIENT_SECRET: "hcn-employee-connector-secret",
      GOOGLE_REFRESH_TOKEN: "",
      GOOGLE_TOKEN_URL: `http://127.0.0.1:${fakeGooglePort}/token`,
      GOOGLE_REVOKE_URL: `http://127.0.0.1:${fakeGooglePort}/revoke`,
      GOOGLE_TOKENINFO_URL: `http://127.0.0.1:${fakeGooglePort}/tokeninfo`,
      GOOGLE_USERINFO_URL: `http://127.0.0.1:${fakeGooglePort}/userinfo`,
      GMAIL_API_BASE_URL: `http://127.0.0.1:${fakeGooglePort}`,
      GMAIL_USER: "me",
      GOOGLE_OAUTH_ALLOWED_DOMAIN: "wavepa.com",
      CHANCE_GOOGLE_EMAIL: "chance@wavepa.com",
      CHANCE_GOOGLE_SUBJECT: "hcn-google-subject",
      CHANCE_JOBNIMBUS_OWNER_ID: chanceOwnerId,
      HCN_MANAGEMENT_ADJUSTERS_JSON: JSON.stringify([
        {
          ownerId: chanceOwnerId,
          displayName: "Chance Fixture"
        },
        {
          ownerId: otherOwnerId,
          displayName: "Second Fixture Adjuster"
        },
        {
          ownerId: thirdOwnerId,
          displayName: "Third Fixture Adjuster"
        }
      ]),
      HCN_MANAGEMENT_PROVIDER_REQUEST_BUDGET: "7",
      OAUTH_SESSION_SECRET: "hcn-session-sealing-secret-for-tests",
      GPT_OAUTH_CLIENT_SECRET: "",
      WAVE_AUTH_USERS_JSON: JSON.stringify([
        {
          email: "chance@wavepa.com",
          name: "Chance Fixture",
          role: "chance",
          enabled: true,
          googleSubject: "hcn-google-subject",
          jobNimbusOwnerId: chanceOwnerId,
          jobNimbusScope: "assigned",
          quoLineId: "quo-line-1"
        },
        {
          email: "adjuster@wavepa.com",
          name: "Employee Fixture",
          role: "employee",
          enabled: true,
          googleSubject: "hcn-employee-google-subject",
          jobNimbusOwnerId: otherOwnerId,
          jobNimbusScope: "assigned"
        }
      ]),
      AUTO_ENROLL_WAVE_USERS: "false",
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-shared-bridge-token-for-ambiguity",
      CODEX_OPERATOR_TOKEN:
        "fixture-hcn-hp-operator-token-1234567890",
      CODEX_MAC_OPERATOR_TOKEN:
        "fixture-hcn-mac-operator-token-1234567890",
      JOBNIMBUS_API_KEY: "hcn-jobnimbus-api-key",
      JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${fakeGooglePort}`,
      RETELL_API_KEY: "",
      QUO_API_KEY: "hcn-quo-api-key",
      QUO_API_BASE_URL: `http://127.0.0.1:${fakeGooglePort}/quo`,
      QUO_DEFAULT_FROM_NUMBER: "",
      HCN_OPERATIONS_ROOT: memoryRoot,
      BRIDGE_ALLOW_WRITES: "false",
      ALLOW_GMAIL_SEND: "false",
      ALLOW_QUO_SEND: "false",
      ALLOW_VOICE_CALLS: "false",
      ALLOW_RETELL_CALLS: "false",
      ALLOW_CLIENT_COORDINATOR_CALLS: "false",
      ALLOW_CARRIER_FOLLOWUP_CALLS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, bridgePort);

  const managementHealthResponse = await fetch(`${origin}/health`);
  assert.equal(managementHealthResponse.status, 200);
  const managementHealth = await managementHealthResponse.json();
  assert.deepEqual(managementHealth.hcnConsole.managementSweep, {
    configured: true,
    ready: true,
    configuredAdjusterCount: 3,
    rankingMode: "jobnimbus_activity_only",
    companyCommunicationCoverage: "not_evaluated"
  });
  assert.equal(
    managementHealth.hcnConsole.authorizedSurface,
    "employee_assigned_work_and_authorized_management_read"
  );
  assert.equal(
    managementHealth.userOAuth.perUserGmail,
    "custom_gpt_broker_and_hcn_connector"
  );
  assert.deepEqual(
    managementHealth.codexOperator.fixedManagementSweepRead,
    {
      hpOperatorConfigured: true,
      hpOperatorReady: true,
      macOperatorAuthorized: false,
      readOnly: true
    }
  );
  assert.equal(
    managementHealth.codexOperator.companyWideIndexOrSweep,
    false
  );
  assert.equal(managementHealth.gmailConfigured, true);
  assert.deepEqual(managementHealth.hcnAssistant, {
    identity: "hcn.thresher-ai.v1",
    instructionsVersion: "hcn.thresher-ai.instructions.v3",
    enabled: false,
    configured: false,
    ready: false,
    deterministicReady: false,
    provider: "groq_responses_api",
    model: "openai/gpt-oss-20b",
    reasoningEffort: "routed_medium_or_high",
    routing: {
      deterministic: {
        profileId: "hcn.deterministic.v1",
        providerCall: false
      },
      standard: {
        profileId: "hcn.thresher.groq.gpt-oss-20b.medium.v1",
        model: "openai/gpt-oss-20b",
        reasoningEffort: "medium"
      },
      deep: {
        profileId: "hcn.thresher.groq.gpt-oss-20b.high.v1",
        model: "openai/gpt-oss-20b",
        reasoningEffort: "high"
      },
      codexEscalation: {
        profileId: "hcn.codex-operator-escalation.v1",
        providerCall: false
      }
    },
    historyConfigured: true,
    historyReady: true,
    responsesApiStore: null,
    providerState: "no_provider_conversation_ids_bounded_hcn_replay_only",
    providerRetention: "groq_project_data_controls_apply",
    builtInProviderTools: false,
    remoteTools: false,
    sessionHistory:
      "encrypted_principal_scoped_durable_transcript",
    assignedFileScopeOnly: true,
    modelHasReadTools: false,
    modelTools: [
      "read_work_center",
      "review_file",
      "read_file_document_catalog",
      "read_file_document",
      "read_file_photo_catalog",
      "research_file_hail_dates",
      "read_calendar_day",
      "run_management_sweep",
      "read_closed_file_benchmark"
    ],
    modelSkills: [
      "work_center_triage",
      "exact_file_sweep",
      "activity_gap_management",
      "claim_filing_readiness",
      "representation_readiness",
      "inspection_coordination",
      "communication_recovery",
      "carrier_follow_up",
      "document_review",
      "photo_inventory",
      "date_of_loss_research",
      "settlement_and_payment_review",
      "closed_file_benchmarking",
      "natural_hcn_drafting",
      "evidence_and_safety"
    ],
    modelCanPrepareActionPlans: false,
    modelCanExecute: false,
    exactHumanApprovalRequired: true
  });
  assert.deepEqual(
    managementHealth.hcnConsole.employeeConnections,
    {
      googleGrantVaultConfigured: true,
      googleCredentialStorage:
        "encrypted_per_employee_persistent_grant",
      googleSharedMailboxFallback: false,
      employeeIdentityPins:
        "authenticated_persistent_immutable",
      quoIdentityBinding:
        "immutable_google_subject_plus_sms_otp",
      quoAuthorizationStoreConfigured: true,
      providerTokensExposedToBrowser: false
    }
  );
  assert.doesNotMatch(
    JSON.stringify(managementHealth),
    /fixture-(?:chance|other|third)-owner/
  );

  const loginResponse = await fetch(
    `${origin}/hcn/auth/login?returnTo=${encodeURIComponent("/hcn")}`,
    { redirect: "manual" }
  );
  assert.equal(loginResponse.status, 302);
  assert.equal(loginResponse.headers.get("cache-control"), "no-store, max-age=0");
  const loginCookies = loginResponse.headers.getSetCookie();
  assert.equal(loginCookies.length, 1);
  assert.match(loginCookies[0], /^__Host-hcn_login=[A-Za-z0-9_-]{43};/);
  assert.match(loginCookies[0], /Secure; HttpOnly; SameSite=Lax/);
  const loginCookie = loginCookies[0].split(";", 1)[0];
  const googleAuthorize = new URL(loginResponse.headers.get("location"));
  assert.equal(googleAuthorize.hostname, "accounts.google.com");
  assert.equal(
    googleAuthorize.searchParams.get("client_id"),
    "hcn-employee-connector-client"
  );
  assert.equal(googleAuthorize.searchParams.get("redirect_uri"), `${origin}/oauth/google/callback`);
  assert.equal(googleAuthorize.searchParams.get("scope"), "openid email profile");
  assert.equal(googleAuthorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(googleAuthorize.searchParams.get("access_type"), "online");
  assert.equal(googleAuthorize.searchParams.get("prompt"), "select_account");
  assert.match(
    googleAuthorize.searchParams.get("state"),
    /^hcn1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
  );

  const callbackUrl = `${origin}/oauth/google/callback?${new URLSearchParams({
    code: "hcn-google-code",
    state: googleAuthorize.searchParams.get("state")
  })}`;
  const callbackResponse = await fetch(callbackUrl, {
    redirect: "manual",
    headers: { cookie: loginCookie }
  });
  assert.equal(callbackResponse.status, 302);
  assert.equal(callbackResponse.headers.get("location"), "/hcn");
  const callbackCookies = callbackResponse.headers.getSetCookie();
  assert.equal(callbackCookies.length, 3);
  assert.match(callbackCookies[0], /^__Host-hcn_login=;/);
  assert.ok(
    callbackCookies.some((value) =>
      value.startsWith("hcn_invitation=;")
    )
  );
  const sessionSetCookie = callbackCookies.find((value) =>
    value.startsWith("__Host-hcn_session=")
  );
  assert.ok(sessionSetCookie);
  assert.match(sessionSetCookie, /Secure; HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(callbackCookies.join("\n"), /hcn-google-access-token|hcn-google-code/);
  const sessionCookie = sessionSetCookie.split(";", 1)[0];

  const authenticatedRootResponse = await fetch(`${origin}/`, {
    redirect: "manual",
    headers: { cookie: sessionCookie }
  });
  assert.equal(authenticatedRootResponse.status, 302);
  assert.equal(
    authenticatedRootResponse.headers.get("location"),
    "/hcn/?shell=v15"
  );

  const authenticatedConsoleRedirectResponse = await fetch(`${origin}/hcn`, {
    redirect: "manual",
    headers: { cookie: sessionCookie }
  });
  assert.equal(authenticatedConsoleRedirectResponse.status, 302);
  assert.equal(
    authenticatedConsoleRedirectResponse.headers.get("location"),
    "/hcn/?shell=v15"
  );

  const authenticatedConsoleResponse = await fetch(
    `${origin}/hcn/?shell=v15`,
    { headers: { cookie: sessionCookie } }
  );
  assert.equal(authenticatedConsoleResponse.status, 200);
  assert.match(
    authenticatedConsoleResponse.headers.get("content-type"),
    /^text\/html/
  );
  assert.match(
    authenticatedConsoleResponse.headers.get("content-security-policy"),
    /default-src 'self'/
  );
  assert.equal(
    authenticatedConsoleResponse.headers.get("vary"),
    "Cookie, Authorization"
  );
  const authenticatedConsoleHtml = await authenticatedConsoleResponse.text();
  assert.match(authenticatedConsoleHtml, /HCN Work Center/);
  assert.doesNotMatch(authenticatedConsoleHtml, /type=["']password["']/i);

  for (const [pathname, contentType] of [
    ["/hcn/app.css?shell=v15", "text/css"],
    ["/hcn/app.js?shell=v15", "text/javascript"],
    [
      "/hcn/manifest.webmanifest?shell=v15",
      "application/manifest+json"
    ],
    ["/hcn/sw.js?shell=v15", "text/javascript"]
  ]) {
    const response = await fetch(`${origin}${pathname}`, {
      headers: { cookie: sessionCookie }
    });
    assert.equal(response.status, 200, pathname);
    assert.match(
      response.headers.get("content-type"),
      new RegExp(`^${contentType.replace("+", "\\+")}`)
    );
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(response.headers.get("vary"), "Cookie, Authorization");
  }

  const authenticatedMetaResponse = await fetch(`${origin}/api/v1/meta`, {
    headers: { cookie: sessionCookie }
  });
  assert.equal(authenticatedMetaResponse.status, 200);
  const authenticatedMeta = await authenticatedMetaResponse.json();
  assert.equal(typeof authenticatedMeta.build.attested, "boolean");
  assert.equal(authenticatedMeta.boundaries.chanceBrain, "disconnected_no_route");
  assert.equal(authenticatedMeta.boundaries.jobrolo, "disconnected");
  assert.equal(JSON.stringify(authenticatedMeta).includes(PLATFORM_FIXTURE_SECRET), false);

  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].code, "hcn-google-code");
  assert.equal(
    providerRequests[0].grantType,
    "authorization_code"
  );
  assert.equal(providerRequests[0].redirectUri, `${origin}/oauth/google/callback`);
  assert.match(providerRequests[0].verifier, /^[A-Za-z0-9_-]{86}$/);
  assert.equal(
    createHash("sha256").update(providerRequests[0].verifier).digest("base64url"),
    googleAuthorize.searchParams.get("code_challenge")
  );

  const replayResponse = await fetch(callbackUrl, {
    redirect: "manual",
    headers: { cookie: loginCookie }
  });
  assert.equal(replayResponse.status, 302);
  assert.equal(
    replayResponse.headers.get("location"),
    "/hcn/?auth=invalid_request"
  );
  assert.equal(providerRequests.length, 1);
  const replayLandingResponse = await fetch(
    `${origin}${replayResponse.headers.get("location")}`,
    { redirect: "manual" }
  );
  assert.equal(replayLandingResponse.status, 200);
  assert.equal(replayLandingResponse.headers.get("set-cookie"), null);
  const replayLandingHtml = await replayLandingResponse.text();
  assert.match(
    replayLandingHtml,
    /sign-in attempt expired or could not be verified/i
  );
  assert.match(replayLandingHtml, /Continue with Google/);
  assert.doesNotMatch(replayLandingHtml, /Work My Files|Company Sweep/);
  assert.equal(providerRequests.length, 1);

  const platformSessionResponse = await fetch(`${origin}/api/v1/session`, {
    headers: { cookie: sessionCookie }
  });
  assert.equal(platformSessionResponse.status, 200);
  assert.equal(platformSessionResponse.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(platformSessionResponse.headers.get("vary"), "Cookie, Authorization");
  const platformSession = await platformSessionResponse.json();
  assert.equal(platformSession.authenticated, true);
  assert.equal(platformSession.identity.type, "hcn_browser_session");
  assert.equal(platformSession.identity.role, "chance");
  assert.equal(platformSession.identity.jobNimbusScope, "assigned");
  assert.equal(
    platformSession.runtime.connectors.managementSweep,
    "configured"
  );
  assert.deepEqual(platformSession.authorizedCapabilities, [
    "hcn.action_plans.execute",
    "hcn.action_plans.invalidate",
    "hcn.action_plans.prepare",
    "hcn.action_plans.read",
    "hcn.action_receipts.read",
    "hcn.assistant.conversations.manage",
    "hcn.assistant.conversations.read",
    "hcn.assistant.turn",
    "hcn.closed_file_benchmark.read",
    "hcn.connectors.google.disconnect",
    "hcn.connectors.google.link",
    "hcn.connectors.quo_line.link",
    "hcn.connectors.read",
    "hcn.file.review",
    "hcn.management_sweep.read",
    "hcn.work_center.read",
    "platform.session.read"
  ]);

  const browserSessionResponse = await fetch(`${origin}/hcn/auth/session`, {
    headers: { cookie: sessionCookie }
  });
  assert.equal(browserSessionResponse.status, 200);
  const browserSession = await browserSessionResponse.json();
  assert.match(browserSession.browserSession.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(browserSession.browserSession.expiresAt, /Z$/);
  assert.equal(
    browserSessionResponse.headers.get(
      "x-hcn-session-idle-expires-at"
    ),
    browserSession.browserSession.idleExpiresAt
  );
  assert.equal(
    browserSessionResponse.headers.get("x-hcn-session-expires-at"),
    browserSession.browserSession.expiresAt
  );
  const serializedBrowserSession = JSON.stringify(browserSession);
  assert.equal(browserSession.profile.email, "chance@wavepa.com");
  assert.doesNotMatch(
    serializedBrowserSession,
    /hcn-google-subject|hcn-google-access-token/
  );
  const hcnReadHeaders = {
    cookie: sessionCookie,
    origin,
    "x-hcn-csrf": browserSession.browserSession.csrfToken,
    "content-type": "application/json"
  };

  const disconnectedStatusResponse = await fetch(
    `${origin}/hcn/api/v1/connectors/status`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: "{}"
    }
  );
  assert.equal(disconnectedStatusResponse.status, 200);
  const disconnectedStatus =
    await disconnectedStatusResponse.json();
  assert.equal(
    disconnectedStatus.schema,
    "hcn.console.connectors.v1"
  );
  assert.deepEqual(disconnectedStatus.google, {
    status: "not_connected",
    gmail: "not_connected",
    calendar: "not_connected",
    connectUrl: "/hcn/connect/google/start"
  });
  assert.deepEqual(disconnectedStatus.jobNimbus, {
    status: "connected",
    scope: "assigned"
  });

  const connectorStartResponse = await fetch(
    `${origin}/hcn/connect/google/start`,
    {
      redirect: "manual",
      headers: { cookie: sessionCookie }
    }
  );
  assert.equal(connectorStartResponse.status, 302);
  assert.equal(
    connectorStartResponse.headers.get("cache-control"),
    "no-store, max-age=0"
  );
  const connectorAuthorize = new URL(
    connectorStartResponse.headers.get("location")
  );
  assert.equal(connectorAuthorize.hostname, "accounts.google.com");
  assert.equal(
    connectorAuthorize.searchParams.get("redirect_uri"),
    `${origin}/oauth/google/callback`
  );
  assert.equal(
    connectorAuthorize.searchParams.get("scope"),
    hcnConnectorScopeText
  );
  assert.equal(
    connectorAuthorize.searchParams.get("code_challenge_method"),
    "S256"
  );
  assert.equal(
    connectorAuthorize.searchParams.get("access_type"),
    "offline"
  );
  assert.equal(
    connectorAuthorize.searchParams.get("prompt"),
    "consent"
  );
  assert.equal(
    connectorAuthorize.searchParams.get("hd"),
    null
  );
  assert.notEqual(
    connectorAuthorize.searchParams.get("state"),
    googleAuthorize.searchParams.get("state")
  );
  assert.match(
    connectorAuthorize.searchParams.get("state"),
    /^hcn1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
  );

  const connectorProviderRequestCountBefore =
    providerRequests.length;
  const connectorCallbackUrl =
    `${origin}/oauth/google/callback?${new URLSearchParams({
      code: "hcn-google-connector-code",
      state: connectorAuthorize.searchParams.get("state")
    })}`;
  const connectorCallbackResponse = await fetch(
    connectorCallbackUrl,
    {
      redirect: "manual",
      headers: { cookie: sessionCookie }
    }
  );
  assert.equal(connectorCallbackResponse.status, 302);
  assert.equal(
    connectorCallbackResponse.headers.get("location"),
    "/hcn/?google=connected"
  );
  assert.deepEqual(
    connectorCallbackResponse.headers.getSetCookie(),
    []
  );
  assert.equal(
    providerRequests.length,
    connectorProviderRequestCountBefore + 1
  );
  const connectorProviderRequest =
    providerRequests.at(-1);
  assert.deepEqual(
    {
      code: connectorProviderRequest.code,
      grantType: connectorProviderRequest.grantType,
      redirectUri: connectorProviderRequest.redirectUri
    },
    {
      code: "hcn-google-connector-code",
      grantType: "authorization_code",
      redirectUri: `${origin}/oauth/google/callback`
    }
  );
  assert.match(
    connectorProviderRequest.verifier,
    /^[A-Za-z0-9_-]{86}$/
  );
  assert.equal(
    createHash("sha256")
      .update(connectorProviderRequest.verifier)
      .digest("base64url"),
    connectorAuthorize.searchParams.get("code_challenge")
  );

  const connectorReplayResponse = await fetch(
    connectorCallbackUrl,
    {
      redirect: "manual",
      headers: { cookie: sessionCookie }
    }
  );
  assert.equal(connectorReplayResponse.status, 302);
  assert.equal(
    connectorReplayResponse.headers.get("location"),
    "/hcn/?google=invalid_request"
  );
  assert.equal(
    providerRequests.length,
    connectorProviderRequestCountBefore + 1
  );

  const connectedStatusResponse = await fetch(
    `${origin}/hcn/api/v1/connectors/status`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: "{}"
    }
  );
  assert.equal(connectedStatusResponse.status, 200);
  const connectedStatus = await connectedStatusResponse.json();
  assert.deepEqual(connectedStatus.google, {
    status: "connected",
    gmail: "connected",
    calendar: "connected",
    connectUrl: "/hcn/connect/google/start"
  });
  const serializedConnectedStatus =
    JSON.stringify(connectedStatus);
  assert.deepEqual(connectedStatus.profile, {
    displayName: "Chance Fixture",
    email: "chance@wavepa.com",
    role: "chance"
  });
  for (const forbidden of [
    "hcn-google-subject",
    chanceOwnerId,
    "hcn-google-connector-access-token",
    "hcn-google-connector-refresh-token",
    "hcn-google-secret",
    "+12145559999"
  ]) {
    assert.equal(
      serializedConnectedStatus.includes(forbidden),
      false,
      `HCN connector status leaked ${forbidden}`
    );
  }

  const fullOpenApiResponse = await fetch(`${origin}/openapi.json`);
  assert.equal(fullOpenApiResponse.status, 200);
  const fullOpenApi = await fullOpenApiResponse.json();
  assert.equal(
    fullOpenApi.paths["/hcn/api/v1/work-center"].post.operationId,
    "readHcnWorkCenter"
  );
  assert.equal(
    fullOpenApi.paths["/hcn/api/v1/file-review"].post.operationId,
    "readHcnExactFile"
  );
  assert.equal(
    fullOpenApi.paths["/hcn/api/v1/management-sweep"].post.operationId,
    "readHcnManagementSweep"
  );
  assert.equal(
    fullOpenApi.paths["/hcn/api/v1/assistant/turns"].post.operationId,
    "askHcnThresher"
  );
  assert.equal(
    fullOpenApi.paths[
      "/hcn/api/v1/assistant/conversations/list"
    ].post.operationId,
    "listHcnAssistantConversations"
  );
  assert.equal(
    fullOpenApi.paths["/hcn/connect/google/start"].get.operationId,
    "startHcnGoogleConnector"
  );
  assert.equal(
    fullOpenApi.paths["/hcn/api/v1/connectors/status"].post
      .operationId,
    "readHcnEmployeeConnections"
  );
  assert.equal(
    fullOpenApi.paths[
      "/hcn/api/v1/connectors/google/disconnect"
    ].post.operationId,
    "disconnectHcnGoogleConnector"
  );
  assert.equal(
    fullOpenApi.paths["/hcn/api/v1/connectors/quo-line"].post
      .operationId,
    "linkHcnEmployeeQuoLine"
  );
  assert.equal(
    fullOpenApi.paths[
      "/hcn/api/v1/connectors/google/disconnect"
    ].post["x-openai-isConsequential"],
    true
  );
  assert.equal(
    fullOpenApi.paths["/hcn/api/v1/connectors/quo-line"].post[
      "x-openai-isConsequential"
    ],
    true
  );
  const hcnConnectorOpenApiPaths = [
    "/hcn/connect/google/start",
    "/hcn/api/v1/connectors/status",
    "/hcn/api/v1/connectors/google/disconnect",
    "/hcn/api/v1/connectors/quo-line"
  ];
  const hcnActionOpenApiPaths = [
    "/hcn/api/v1/action-plans/prepare",
    "/hcn/api/v1/action-plans/list",
    "/hcn/api/v1/action-plans/detail",
    "/hcn/api/v1/action-plans/execute",
    "/hcn/api/v1/action-plans/invalidate",
    "/hcn/api/v1/action-receipts/list",
    "/hcn/api/v1/action-receipts/detail"
  ];
  for (const actionPath of hcnActionOpenApiPaths) {
    assert.ok(fullOpenApi.paths[actionPath]?.post);
  }
  assert.equal(
    fullOpenApi.paths["/hcn/api/v1/action-plans/execute"].post[
      "x-openai-isConsequential"
    ],
    true
  );
  const chatGptOpenApiResponse = await fetch(`${origin}/openapi-chatgpt.json`);
  assert.equal(chatGptOpenApiResponse.status, 200);
  const chatGptOpenApi = await chatGptOpenApiResponse.json();
  assert.equal(chatGptOpenApi.paths["/hcn/api/v1/work-center"], undefined);
  assert.equal(chatGptOpenApi.paths["/hcn/api/v1/file-review"], undefined);
  assert.equal(chatGptOpenApi.paths["/hcn/api/v1/management-sweep"], undefined);
  assert.equal(chatGptOpenApi.paths["/hcn/api/v1/assistant/turns"], undefined);
  for (const conversationPath of [
    "/hcn/api/v1/assistant/conversations/list",
    "/hcn/api/v1/assistant/conversations/create",
    "/hcn/api/v1/assistant/conversations/detail",
    "/hcn/api/v1/assistant/conversations/rename",
    "/hcn/api/v1/assistant/conversations/archive",
    "/hcn/api/v1/assistant/conversations/restore"
  ]) {
    assert.equal(chatGptOpenApi.paths[conversationPath], undefined);
  }
  for (const connectorPath of hcnConnectorOpenApiPaths) {
    assert.equal(chatGptOpenApi.paths[connectorPath], undefined);
  }
  for (const actionPath of hcnActionOpenApiPaths) {
    assert.equal(chatGptOpenApi.paths[actionPath], undefined);
  }

  const directRouteResponse = await fetch(`${origin}/jobnimbus/search`, {
    method: "POST",
    headers: hcnReadHeaders,
    body: JSON.stringify({ query: "fixture" })
  });
  assert.equal(directRouteResponse.status, 403);

  const sharedBearerHcnResponse = await fetch(
    `${origin}/hcn/api/v1/work-center`,
    {
      method: "POST",
      headers: {
        authorization:
          "Bearer fixture-shared-bridge-token-for-ambiguity",
        "content-type": "application/json"
      },
      body: JSON.stringify({ offset: 0, limit: 10 })
    }
  );
  assert.equal(sharedBearerHcnResponse.status, 403);

  const sharedBearerAssistantResponse = await fetch(
    `${origin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        authorization:
          "Bearer fixture-shared-bridge-token-for-ambiguity",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef: `conversation_${"a".repeat(32)}`,
        expectedRevision: 0,
        prompt: "Work my files.",
        mode: "auto"
      })
    }
  );
  assert.equal(sharedBearerAssistantResponse.status, 403);

  const directGoogleBearerHcnResponse = await fetch(
    `${origin}/hcn/api/v1/work-center`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer legacy-google-access-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ offset: 0, limit: 10 })
    }
  );
  assert.equal(directGoogleBearerHcnResponse.status, 403);

  const missingAssistantOriginResponse = await fetch(
    `${origin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "x-hcn-csrf": browserSession.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({ prompt: "Work my files." })
    }
  );
  assert.equal(missingAssistantOriginResponse.status, 403);

  const missingAssistantCsrfResponse = await fetch(
    `${origin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin,
        "content-type": "application/json"
      },
      body: JSON.stringify({ prompt: "Work my files." })
    }
  );
  assert.equal(missingAssistantCsrfResponse.status, 403);

  const malformedAssistantResponse = await fetch(
    `${origin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({
        prompt: "Work my files.",
        model: "attacker-selected-model"
      })
    }
  );
  assert.equal(malformedAssistantResponse.status, 400);

  const oversizedAssistantResponse = await fetch(
    `${origin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ prompt: "x".repeat(17 * 1024) })
    }
  );
  assert.equal(oversizedAssistantResponse.status, 413);

  const unavailableAssistantResponse = await fetch(
    `${origin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({
        conversationRef: `conversation_${"a".repeat(32)}`,
        expectedRevision: 0,
        prompt: "Work my files.",
        mode: "auto"
      })
    }
  );
  assert.equal(unavailableAssistantResponse.status, 503);
  const unavailableAssistant = await unavailableAssistantResponse.json();
  assert.equal(
    unavailableAssistant.error,
    "Ask Thresher is not configured for this HCN environment."
  );

  const workCenterResponse = await fetch(
    `${origin}/hcn/api/v1/work-center`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ offset: 0, limit: 10 })
    }
  );
  assert.equal(workCenterResponse.status, 200);
  assert.equal(workCenterResponse.headers.get("cache-control"), "no-store, max-age=0");
  assert.match(
    workCenterResponse.headers.get("x-hcn-session-idle-expires-at"),
    /Z$/
  );
  assert.match(
    workCenterResponse.headers.get("x-hcn-session-expires-at"),
    /Z$/
  );
  const workCenter = await workCenterResponse.json();
  assert.equal(workCenter.schema, "hcn.console.work-center.v1");
  assert.equal(workCenter.ephemeral, true);
  assert.equal(workCenter.cachePolicy, "no_store");
  assert.deepEqual(workCenter.authority, {
    mode: "read_only",
    canWrite: false,
    canSend: false,
    canCall: false,
    canApprove: false
  });
  assert.equal(workCenter.source.source, "jobnimbus");
  assert.equal(workCenter.source.status, "fresh");
  assert.equal(workCenter.source.completeness, "complete");
  assert.equal(workCenter.page.total, 1);
  assert.equal(workCenter.files.length, 1);
  assert.equal(workCenter.files[0].jobNumber, "HCN-1001");
  assert.equal(workCenter.files[0].displayName, "Fixture Active Homeowner");
  assert.match(workCenter.files[0].fileRef, /^subject_[a-f0-9]{32}$/);
  const fileRef = workCenter.files[0].fileRef;
  const serializedWorkCenter = JSON.stringify(workCenter);
  for (const forbidden of [
    exactFileId,
    "jn-fixture-inactive",
    "jn-fixture-other-owner",
    "jn-fixture-non-insurance",
    chanceOwnerId,
    "Fixture Inactive Homeowner",
    "Fixture Other Owner",
    "Fixture Retail Contact"
  ]) {
    assert.equal(serializedWorkCenter.includes(forbidden), false);
  }

  const exactFileResponse = await fetch(
    `${origin}/hcn/api/v1/file-review`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ fileRef, recentLimit: 10 })
    }
  );
  assert.equal(exactFileResponse.status, 200);
  assert.equal(exactFileResponse.headers.get("cache-control"), "no-store, max-age=0");
  const exactFile = await exactFileResponse.json();
  assert.equal(exactFile.schema, "hcn.console.file.v1");
  assert.equal(exactFile.ephemeral, true);
  assert.equal(exactFile.cachePolicy, "no_store");
  assert.equal(
    exactFile.evidenceStatus,
    "complete",
    JSON.stringify({
      sources: exactFile.sources,
      providerRequests: hcnProviderRequests
    })
  );
  assert.equal(exactFile.file.fileRef, fileRef);
  assert.equal(exactFile.file.jobNumber, "HCN-1001");
  assert.equal(exactFile.file.displayName, "Fixture Active Homeowner");
  assert.equal(
    exactFile.intelligence.schemaVersion,
    "hcn.ops.file-intelligence.v1"
  );
  assert.equal(exactFile.intelligence.fileRef, fileRef);
  assert.deepEqual(
    Object.keys(exactFile.intelligence.workflows).sort(),
    [
      "claim_filing",
      "communications",
      "follow_up",
      "inspection_scheduling",
      "neglected_files"
    ]
  );
  for (const [workflowId, workflow] of Object.entries(
    exactFile.intelligence.workflows
  )) {
    assert.equal(
      workflow.schemaVersion,
      "hcn.ops.workflow-evaluation.v1"
    );
    assert.equal(workflow.workflowId, workflowId);
    assert.equal(workflow.fileRef, fileRef);
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(exactFile.sources)
        .map(([source, value]) => [
          source,
          [value.status, value.completeness]
        ])
    ),
    {
      jobnimbus: ["fresh", "complete"],
      gmail: ["fresh", "complete"],
      quo: ["fresh", "complete"]
    }
  );
  assert.equal(exactFile.recent.activities.length, 1);
  assert.equal(exactFile.recent.tasks.length, 1);
  assert.equal(exactFile.recent.documents.length, 1);
  assert.equal(exactFile.recent.gmail.length, 2);
  assert.equal(exactFile.recent.quo.length, 3);
  assert.equal(
    exactFile.recent.gmail.some((item) => item.direction === "inbound"),
    true
  );
  assert.equal(
    exactFile.recent.gmail.some(
      (item) =>
        item.direction === "outbound"
        && item.deliveryState === "sent_verified"
    ),
    true
  );
  assert.equal(exactFile.recent.quo.some((item) => item.direction === "inbound"), true);
  assert.equal(exactFile.recent.quo.some((item) => item.direction === "outbound"), true);
  assert.equal(
    exactFile.lanes.priority.some(
      (item) => item.reasonCode === "overdue_task"
    ),
    true
  );
  assert.equal(
    exactFile.lanes.priority.some(
      (item) => item.reasonCode === "document_review_required"
    ),
    true
  );
  assert.equal(
    exactFile.lanes.priority.some(
      (item) => item.reasonCode === "reply_required"
    ),
    true
  );
  assert.equal(
    exactFile.lanes.waiting.some(
      (item) => item.reasonCode === "awaiting_response"
    ),
    true
  );
  const serializedExactFile = JSON.stringify(exactFile);
  for (const forbidden of [
    exactFileId,
    "jn-activity-1",
    "jn-task-1",
    "jn-document-1",
    "gmail-message-1",
    "gmail-message-2",
    "gmail-thread-1",
    "gmail-carrier-thread-1",
    "quo-message-1",
    "quo-message-2",
    "quo-call-1",
    "quo-line-1",
    chanceOwnerId
  ]) {
    assert.equal(serializedExactFile.includes(forbidden), false);
  }
  assert.equal(
    hcnProviderRequests.some((request) => request.startsWith("jobnimbus:")),
    true
  );
  assert.equal(
    hcnProviderRequests.some((request) => request.startsWith("gmail:")),
    true
  );
  assert.equal(
    hcnProviderRequests.some((request) => request.startsWith("quo:")),
    true
  );
  assert.equal(
    hcnProviderRequests.filter(
      (request) => request === "jobnimbus:/contacts"
    ).length,
    2
  );
  assert.equal(
    hcnProviderRequests.filter(
      (request) =>
        request === `jobnimbus:/contacts/${exactFileId}`
    ).length,
    1
  );

  hcnBoundedHistoryMode = true;
  const boundedHistoryResponse = await fetch(
    `${origin}/hcn/api/v1/file-review`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ fileRef, recentLimit: 10 })
    }
  );
  hcnBoundedHistoryMode = false;
  assert.equal(boundedHistoryResponse.status, 200);
  const boundedHistory = await boundedHistoryResponse.json();
  assert.equal(boundedHistory.file.jobNumber, "HCN-1001");
  assert.equal(
    boundedHistory.file.displayName,
    "Fixture Active Homeowner"
  );
  assert.equal(boundedHistory.evidenceStatus, "complete");
  assert.equal(
    boundedHistory.sources.jobnimbus.failureCode,
    null
  );
  assert.equal(
    boundedHistory.sources.jobnimbus.completeness,
    "complete"
  );
  assert.deepEqual(
    boundedHistory.sources.jobnimbus.collections,
    {
      activities: {
        completeness: "partial",
        returnedItems: 50,
        duplicateItemsRemoved: 0,
        readLimit: 50,
        limitationCode: "bounded_history_window"
      },
      tasks: {
        completeness: "partial",
        returnedItems: 50,
        duplicateItemsRemoved: 0,
        readLimit: 50,
        limitationCode: "bounded_history_window"
      },
      documents: {
        completeness: "complete",
        returnedItems: 1,
        duplicateItemsRemoved: 0,
        readLimit: 500,
        limitationCode: null
      }
    }
  );
  assert.equal(boundedHistory.recent.activities.length, 10);
  assert.equal(boundedHistory.recent.tasks.length, 10);
  assert.deepEqual(boundedHistory.intelligence.historyCoverage, {
    currentFacts: "complete",
    documents: "complete",
    activityHistory: "partial",
    taskHistory: "partial"
  });
  assert.equal(
    boundedHistory.intelligence.workflows.neglected_files.metrics
      .activityGapDays,
    null
  );
  assert.equal(
    boundedHistory.intelligence.workflows.neglected_files.nextActions.some(
      ({ actionCode }) => actionCode === "review_neglected_file"
    ),
    false
  );
  assert.equal(
    boundedHistory.intelligence.workflows.follow_up.metrics
      .verifiedActivityGapDays,
    null
  );
  assert.equal(
    boundedHistory.intelligence.workflows.follow_up.nextActions.some(
      ({ actionCode }) => actionCode === "review_activity_gap"
    ),
    false
  );
  assert.equal(
    new Set(
      boundedHistory.recent.activities.map((activity) => activity.reference)
    ).size,
    boundedHistory.recent.activities.length
  );

  hcnDisjointActivityOverflowMode = true;
  const disjointActivityResponse = await fetch(
    `${origin}/hcn/api/v1/file-review`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ fileRef, recentLimit: 10 })
    }
  );
  hcnDisjointActivityOverflowMode = false;
  assert.equal(disjointActivityResponse.status, 200);
  const disjointActivityReview = await disjointActivityResponse.json();
  assert.equal(disjointActivityReview.recent.activities.length, 10);
  assert.equal(
    disjointActivityReview.recent.activities.every(({ label }) =>
      label.startsWith("Newer related-only activity")
    ),
    true
  );
  assert.equal(
    disjointActivityReview.sources.jobnimbus.collections.activities
      .completeness,
    "partial"
  );

  const hpManagementRequestsBefore = hcnProviderRequests.length;
  const hpMutationRequestsBefore = jobNimbusMutationRequests.length;
  const hpManagementSweepResponse = await fetch(
    `${origin}/hcn/api/v1/management-sweep`,
    {
      method: "POST",
      headers: {
        authorization:
          "Bearer fixture-hcn-hp-operator-token-1234567890",
        "content-type": "application/json"
      },
      body: JSON.stringify({ limitPerAdjuster: 10 })
    }
  );
  assert.equal(hpManagementSweepResponse.status, 200);
  assert.equal(
    hpManagementSweepResponse.headers.get("cache-control"),
    "no-store, max-age=0"
  );
  const hpManagementSweep = await hpManagementSweepResponse.json();
  assert.equal(
    hpManagementSweep.schema,
    "hcn.console.management-sweep.v1"
  );
  assert.equal(hpManagementSweep.ephemeral, true);
  assert.equal(hpManagementSweep.adjusters.length, 3);
  assert.equal(
    jobNimbusMutationRequests.length,
    hpMutationRequestsBefore
  );
  assert.equal(
    hcnProviderRequests
      .slice(hpManagementRequestsBefore)
      .every((request) => request.startsWith("jobnimbus:")),
    true
  );
  const serializedHpManagementSweep =
    JSON.stringify(hpManagementSweep);
  for (const forbidden of [
    exactFileId,
    otherOwnerContact.jnid,
    thirdOwnerContact.jnid,
    unconfiguredOwnerContact.jnid,
    chanceOwnerId,
    otherOwnerId,
    thirdOwnerId,
    "active.homeowner@example.test",
    "2145551212",
    "HCN-POLICY-1001",
    "Fresh synthetic carrier activity"
  ]) {
    assert.equal(
      serializedHpManagementSweep.includes(forbidden),
      false,
      `HP management sweep leaked ${forbidden}`
    );
  }

  const deniedManagementRequestsBefore =
    hcnProviderRequests.length;
  for (const authorization of [
    "Bearer fixture-hcn-mac-operator-token-1234567890",
    "Bearer fixture-shared-bridge-token-for-ambiguity"
  ]) {
    const deniedManagementSweepResponse = await fetch(
      `${origin}/hcn/api/v1/management-sweep`,
      {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json"
        },
        body: JSON.stringify({ limitPerAdjuster: 10 })
      }
    );
    assert.equal(deniedManagementSweepResponse.status, 403);
  }
  assert.equal(
    hcnProviderRequests.length,
    deniedManagementRequestsBefore
  );
  assert.equal(
    jobNimbusMutationRequests.length,
    hpMutationRequestsBefore
  );

  const managementRequestsBefore = hcnProviderRequests.length;
  hcnManagementActivityFilters.length = 0;
  const managementSweepResponse = await fetch(
    `${origin}/hcn/api/v1/management-sweep`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ limitPerAdjuster: 10 })
    }
  );
  assert.equal(managementSweepResponse.status, 200);
  assert.equal(
    managementSweepResponse.headers.get("cache-control"),
    "no-store, max-age=0"
  );
  const managementSweep = await managementSweepResponse.json();
  assert.equal(
    managementSweep.schema,
    "hcn.console.management-sweep.v1"
  );
  assert.equal(managementSweep.ephemeral, true);
  assert.equal(managementSweep.cachePolicy, "no_store");
  assert.equal(
    Date.parse(managementSweep.asOf)
      <= Date.parse(managementSweep.checkedAt),
    true
  );
  assert.equal(
    Date.parse(managementSweep.checkedAt)
      < Date.parse(managementSweep.validUntil),
    true
  );
  assert.equal(managementSweep.criteria.rankingMode, "activity_only");
  assert.equal(managementSweep.adjusters.length, 3);
  assert.deepEqual(
    managementSweep.adjusters.map((adjuster) => adjuster.name),
    [
      "Chance Fixture",
      "Second Fixture Adjuster",
      "Third Fixture Adjuster"
    ]
  );
  assert.deepEqual(
    managementSweep.adjusters.map((adjuster) => adjuster.eligibleCount),
    [1, 1, 1]
  );
  assert.deepEqual(
    managementSweep.adjusters.map((adjuster) => adjuster.items.length),
    [1, 1, 1]
  );
  assert.equal(managementSweep.companyWorst.length, 3);
  assert.deepEqual(
    managementSweep.adjusters.flatMap(
      (adjuster) => adjuster.items.map((item) => item.eventSummary)
    ),
    Array.from({ length: 3 }, () => ({
      fetchedEventCount: 1,
      acceptedEventCount: 1,
      ambiguousReferenceEventCount: 0,
      communicationActivityCount: 0,
      operationalActivityCount: 1,
      noiseCount: 0,
      unsupportedEventCount: 0,
      ignoredUnfreshEventCount: 0
    }))
  );
  assert.equal(
    managementSweep.summary.unsupportedActivityRecordCount,
    0
  );
  assert.equal(
    managementSweep.summary.ambiguousActivityReferenceCount,
    0
  );
  assert.equal(managementSweep.completeness.status, "complete");
  assert.deepEqual(
    managementSweep.sourceHealth.map((source) => [
      source.key,
      source.status
    ]),
    [
      ["jobnimbus", "complete"],
      ["gmail", "not_evaluated"],
      ["quo", "not_evaluated"],
      ["google_calendar", "not_evaluated"]
    ]
  );
  assert.equal(
    managementSweep.adjusters.every(
      (adjuster) =>
        /^adjuster_[a-f0-9]{32}$/.test(adjuster.adjusterRef)
        && adjuster.items.every(
          (item) => /^subject_[a-f0-9]{32}$/.test(item.fileRef)
        )
    ),
    true
  );
  const serializedManagementSweep = JSON.stringify(managementSweep);
  for (const forbidden of [
    exactFileId,
    otherOwnerContact.jnid,
    thirdOwnerContact.jnid,
    unconfiguredOwnerContact.jnid,
    chanceOwnerId,
    otherOwnerId,
    thirdOwnerId,
    "jn-activity-1",
    "jn-activity-2",
    "jn-activity-3",
    "active.homeowner@example.test",
    "2145551212",
    "Fresh synthetic carrier activity"
  ]) {
    assert.equal(
      serializedManagementSweep.includes(forbidden),
      false,
      `HCN management sweep leaked ${forbidden}`
    );
  }
  assert.deepEqual(
    hcnManagementActivityFilters
      .map(({ referenceField }) => referenceField)
      .sort(),
    [
      "primary.id",
      "primary.id",
      "primary.id",
      "related.id",
      "related.id",
      "related.id"
    ]
  );
  assert.equal(
    new Set(
      hcnManagementActivityFilters.map(
        ({ referencedFileId }) => referencedFileId
      )
    ).size,
    3
  );
  const managementProviderRequests = hcnProviderRequests.slice(
    managementRequestsBefore
  );
  assert.equal(
    managementProviderRequests.every(
      (request) => request.startsWith("jobnimbus:")
    ),
    true
  );
  assert.equal(jobNimbusMutationRequests.length, 0);

  const invalidManagementSweepResponse = await fetch(
    `${origin}/hcn/api/v1/management-sweep`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({
        limitPerAdjuster: 10,
        unexpected: true
      })
    }
  );
  assert.equal(invalidManagementSweepResponse.status, 400);

  serveWrongManagementReferenceField = true;
  const wrongReferenceFieldResponse = await fetch(
    `${origin}/hcn/api/v1/management-sweep`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ limitPerAdjuster: 10 })
    }
  );
  serveWrongManagementReferenceField = false;
  assert.equal(wrongReferenceFieldResponse.status, 503);
  assert.equal(
    (await wrongReferenceFieldResponse.json()).error,
    "One or more JobNimbus activity histories are unavailable."
  );
  assert.equal(jobNimbusMutationRequests.length, 0);

  for (const secondFileId of [
    inactiveChanceContact.jnid,
    unconfiguredOwnerContact.jnid,
    nonInsuranceContact.jnid
  ]) {
    ambiguousManagementReferenceId = secondFileId;
    const outOfScopeReferenceResponse = await fetch(
      `${origin}/hcn/api/v1/management-sweep`,
      {
        method: "POST",
        headers: hcnReadHeaders,
        body: JSON.stringify({ limitPerAdjuster: 10 })
      }
    );
    ambiguousManagementReferenceId = "";
    assert.equal(outOfScopeReferenceResponse.status, 200);
    const outOfScopeReferenceSweep =
      await outOfScopeReferenceResponse.json();
    assert.equal(
      outOfScopeReferenceSweep.completeness.status,
      "complete"
    );
    assert.equal(
      outOfScopeReferenceSweep.sourceHealth[0].status,
      "complete"
    );
    assert.equal(
      outOfScopeReferenceSweep.summary.ambiguousActivityReferenceCount,
      0
    );
    const outOfScopeReferenceChanceItem =
      outOfScopeReferenceSweep.adjusters[0].items[0];
    assert.equal(
      outOfScopeReferenceChanceItem.eventSummary.acceptedEventCount,
      1
    );
    assert.equal(
      outOfScopeReferenceChanceItem.eventSummary
        .ambiguousReferenceEventCount,
      0
    );
    assert.equal(
      outOfScopeReferenceChanceItem.gaps.operationalActivity.lastAt,
      "2026-07-27T14:00:00.000Z"
    );
    assert.doesNotMatch(
      JSON.stringify(outOfScopeReferenceSweep),
      /jn-fixture|fixture-(?:chance|other|third|unconfigured)-owner/
    );
    assert.equal(jobNimbusMutationRequests.length, 0);
  }

  ambiguousManagementReferenceId = otherOwnerContact.jnid;
  const crossFileManagementSweepResponse = await fetch(
    `${origin}/hcn/api/v1/management-sweep`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ limitPerAdjuster: 10 })
    }
  );
  ambiguousManagementReferenceId = "";
  assert.equal(crossFileManagementSweepResponse.status, 200);
  const crossFileManagementSweep =
    await crossFileManagementSweepResponse.json();
  assert.equal(crossFileManagementSweep.completeness.status, "partial");
  assert.equal(crossFileManagementSweep.sourceHealth[0].status, "partial");
  assert.equal(
    crossFileManagementSweep.summary.ambiguousActivityReferenceCount,
    1
  );
  assert.match(
    crossFileManagementSweep.completeness.summary,
    /multiple eligible files and were conservatively excluded/
  );
  const crossFileChanceItem =
    crossFileManagementSweep.adjusters[0].items[0];
  assert.equal(crossFileChanceItem.eventSummary.fetchedEventCount, 1);
  assert.equal(crossFileChanceItem.eventSummary.acceptedEventCount, 0);
  assert.equal(
    crossFileChanceItem.eventSummary.operationalActivityCount,
    0
  );
  assert.equal(crossFileChanceItem.eventSummary.unsupportedEventCount, 0);
  assert.equal(
    crossFileChanceItem.eventSummary.ambiguousReferenceEventCount,
    1
  );
  assert.equal(crossFileChanceItem.evidenceHealth.status, "partial");
  assert.match(
    crossFileChanceItem.evidenceHealth.summary,
    /cross-file activity reference was conservatively excluded/
  );
  assert.equal(
    crossFileChanceItem.gaps.operationalActivity.lastAt,
    null
  );
  assert.equal(
    crossFileChanceItem.gaps.operationalActivity.basis,
    "active_since"
  );
  assert.equal(
    crossFileChanceItem.lastTouch.summary,
    "No verified JobNimbus activity was found"
  );
  const crossFileCompanyItem = crossFileManagementSweep.companyWorst.find(
    (item) => item.fileRef === crossFileChanceItem.fileRef
  );
  assert.equal(crossFileCompanyItem.evidenceHealth.status, "partial");
  assert.doesNotMatch(
    JSON.stringify(crossFileManagementSweep),
    /jn-fixture|fixture-(?:chance|other|third|unconfigured)-owner|Fresh synthetic carrier activity|active\.homeowner@example\.test|2145551212/
  );
  assert.equal(jobNimbusMutationRequests.length, 0);

  managementActivityOverride = {
    record_type_name: "Email",
    status_name: "Draft",
    date_created: "2026-07-29T10:00:00.000Z"
  };
  const unsupportedManagementSweepResponse = await fetch(
    `${origin}/hcn/api/v1/management-sweep`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ limitPerAdjuster: 10 })
    }
  );
  managementActivityOverride = null;
  assert.equal(unsupportedManagementSweepResponse.status, 200);
  const unsupportedManagementSweep =
    await unsupportedManagementSweepResponse.json();
  assert.equal(unsupportedManagementSweep.completeness.status, "partial");
  assert.equal(
    unsupportedManagementSweep.sourceHealth[0].status,
    "partial"
  );
  assert.equal(
    unsupportedManagementSweep.summary.unsupportedActivityRecordCount,
    1
  );
  assert.equal(
    unsupportedManagementSweep.summary.ambiguousActivityReferenceCount,
    0
  );
  const chanceManagementItem =
    unsupportedManagementSweep.adjusters[0].items[0];
  assert.equal(chanceManagementItem.eventSummary.fetchedEventCount, 1);
  assert.equal(chanceManagementItem.eventSummary.acceptedEventCount, 0);
  assert.equal(chanceManagementItem.eventSummary.unsupportedEventCount, 1);
  assert.equal(chanceManagementItem.evidenceHealth.status, "partial");
  assert.match(
    chanceManagementItem.evidenceHealth.summary,
    /unsupported record/
  );
  assert.equal(chanceManagementItem.gaps.operationalActivity.lastAt, null);
  assert.equal(
    chanceManagementItem.lastTouch.summary,
    "No verified JobNimbus activity was found"
  );
  assert.equal(jobNimbusMutationRequests.length, 0);

  allContacts.push({
    ...activeContact,
    jnid: "jn-fixture-budget-extra",
    number: "HCN-1006",
    display_name: "Fixture Budget Extra",
    email: "budget.extra@example.test",
    mobile_phone: "2145551217",
    "Claim #": "HCN-CLAIM-1006",
    "Policy #": "HCN-POLICY-1006"
  });
  const budgetExceededResponse = await fetch(
    `${origin}/hcn/api/v1/management-sweep`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ limitPerAdjuster: 10 })
    }
  );
  allContacts.pop();
  assert.equal(budgetExceededResponse.status, 503);
  assert.equal(
    (await budgetExceededResponse.json()).error,
    "The JobNimbus management provider-read budget was exceeded."
  );
  assert.equal(jobNimbusMutationRequests.length, 0);

  const exactNote =
    "Andrea needs to reach out for the declaration page or policy.";
  const actionPrepareBody = {
    fileRef,
    operations: [{
      type: "jobnimbus.create_note",
      input: { note: exactNote }
    }]
  };
  const invalidActionShapeResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/prepare`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({
        ...actionPrepareBody,
        query: exactFileId
      })
    }
  );
  assert.equal(invalidActionShapeResponse.status, 400);
  assert.doesNotMatch(
    JSON.stringify(await invalidActionShapeResponse.json()),
    new RegExp(exactFileId)
  );

  const oversizedActionPrepareResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/prepare`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({
        ...actionPrepareBody,
        padding: "x".repeat(66 * 1024)
      })
    }
  );
  assert.equal(oversizedActionPrepareResponse.status, 413);

  const actionPrepareResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/prepare`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify(actionPrepareBody)
    }
  );
  assert.equal(actionPrepareResponse.status, 200);
  assert.equal(
    actionPrepareResponse.headers.get("cache-control"),
    "no-store, max-age=0"
  );
  const preparedActionEnvelope = await actionPrepareResponse.json();
  assert.equal(preparedActionEnvelope.schema, "hcn.console.actions.v1");
  assert.equal(preparedActionEnvelope.ephemeral, true);
  assert.equal(preparedActionEnvelope.cachePolicy, "no_store");
  assert.deepEqual(preparedActionEnvelope.authority, {
    mode: "explicit_signed_in_employee_approval",
    fileScope: "assigned_only",
    automaticExecution: false,
    automaticRetry: false,
    providerIdentifiersExposed: false
  });
  const preparedActionPlan = preparedActionEnvelope.plan;
  assert.match(preparedActionPlan.planId, /^plan_[a-f0-9]{32}$/);
  assert.equal(preparedActionPlan.fileRef, fileRef);
  assert.match(preparedActionPlan.approvalDigest, /^[a-f0-9]{64}$/);
  assert.match(preparedActionPlan.approvalExpiresAt, /Z$/);
  assert.equal(preparedActionPlan.status, "pending");
  assert.equal(preparedActionPlan.operationCount, 1);
  assert.deepEqual(preparedActionPlan.operations, [{
    index: 0,
    type: "jobnimbus.create_note",
    action: "Create JobNimbus note",
    material: { note: exactNote }
  }]);

  const serializedActionPlan = JSON.stringify(preparedActionEnvelope);
  for (const forbidden of [
    exactFileId,
    chanceOwnerId,
    "/activities",
    "/contacts/",
    "approvalChallenge",
    "providerJobId",
    "hcn-jobnimbus-api-key",
    "fixture-shared-bridge-token-for-ambiguity"
  ]) {
    assert.equal(
      serializedActionPlan.includes(forbidden),
      false,
      `HCN browser action plan leaked ${forbidden}`
    );
  }

  const actionListResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/list`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: "{}"
    }
  );
  assert.equal(actionListResponse.status, 200);
  const actionList = await actionListResponse.json();
  assert.equal(actionList.plans.length, 1);
  assert.equal(actionList.plans[0].planId, preparedActionPlan.planId);
  assert.equal(Object.hasOwn(actionList.plans[0], "operations"), false);
  assert.equal(JSON.stringify(actionList).includes(exactNote), false);

  const invalidActionListResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/list`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ unexpected: true })
    }
  );
  assert.equal(invalidActionListResponse.status, 400);

  const actionDetailResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/detail`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ planId: preparedActionPlan.planId })
    }
  );
  assert.equal(actionDetailResponse.status, 200);
  const actionDetail = await actionDetailResponse.json();
  assert.deepEqual(actionDetail.plan, preparedActionPlan);
  assert.equal(JSON.stringify(actionDetail).includes(exactFileId), false);

  const secondLoginResponse = await fetch(`${origin}/hcn/auth/login`, {
    redirect: "manual"
  });
  assert.equal(secondLoginResponse.status, 302);
  const secondLoginCookie = secondLoginResponse.headers
    .getSetCookie()[0]
    .split(";", 1)[0];
  const secondGoogleAuthorize = new URL(
    secondLoginResponse.headers.get("location")
  );
  const secondCallbackResponse = await fetch(
    `${origin}/oauth/google/callback?${new URLSearchParams({
      code: "hcn-google-code-second-session",
      state: secondGoogleAuthorize.searchParams.get("state")
    })}`,
    {
      redirect: "manual",
      headers: { cookie: secondLoginCookie }
    }
  );
  assert.equal(secondCallbackResponse.status, 302);
  const secondSessionCookie = secondCallbackResponse.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-hcn_session="))
    .split(";", 1)[0];
  const secondBrowserSessionResponse = await fetch(
    `${origin}/hcn/auth/session`,
    { headers: { cookie: secondSessionCookie } }
  );
  assert.equal(secondBrowserSessionResponse.status, 200);
  const secondBrowserSession = await secondBrowserSessionResponse.json();
  const secondHcnHeaders = {
    cookie: secondSessionCookie,
    origin,
    "x-hcn-csrf": secondBrowserSession.browserSession.csrfToken,
    "content-type": "application/json"
  };
  const isolatedActionListResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/list`,
    {
      method: "POST",
      headers: secondHcnHeaders,
      body: "{}"
    }
  );
  assert.equal(isolatedActionListResponse.status, 200);
  assert.deepEqual((await isolatedActionListResponse.json()).plans, []);
  const isolatedActionDetailResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/detail`,
    {
      method: "POST",
      headers: secondHcnHeaders,
      body: JSON.stringify({ planId: preparedActionPlan.planId })
    }
  );
  assert.equal(isolatedActionDetailResponse.status, 404);
  assert.equal(
    JSON.stringify(await isolatedActionDetailResponse.json())
      .includes(exactNote),
    false
  );

  const employeeLoginResponse = await fetch(
    `${origin}/hcn/auth/login`,
    { redirect: "manual" }
  );
  assert.equal(employeeLoginResponse.status, 302);
  const employeeLoginCookie = employeeLoginResponse.headers
    .getSetCookie()[0]
    .split(";", 1)[0];
  const employeeLoginAuthorize = new URL(
    employeeLoginResponse.headers.get("location")
  );
  assert.equal(
    employeeLoginAuthorize.searchParams.get("client_id"),
    "hcn-employee-connector-client"
  );
  assert.equal(
    employeeLoginAuthorize.searchParams.get("scope"),
    "openid email profile"
  );
  const employeeLoginCallbackResponse = await fetch(
    `${origin}/oauth/google/callback?${new URLSearchParams({
      code: "hcn-employee-google-code",
      state: employeeLoginAuthorize.searchParams.get("state")
    })}`,
    {
      redirect: "manual",
      headers: { cookie: employeeLoginCookie }
    }
  );
  assert.equal(employeeLoginCallbackResponse.status, 302);
  const employeeSessionSetCookie =
    employeeLoginCallbackResponse.headers
      .getSetCookie()
      .find((value) =>
        value.startsWith("__Host-hcn_session=")
      );
  assert.ok(employeeSessionSetCookie);
  const employeeSessionCookie =
    employeeSessionSetCookie.split(";", 1)[0];
  const employeeBrowserSessionResponse = await fetch(
    `${origin}/hcn/auth/session`,
    { headers: { cookie: employeeSessionCookie } }
  );
  assert.equal(employeeBrowserSessionResponse.status, 200);
  const employeeBrowserSession =
    await employeeBrowserSessionResponse.json();
  assert.deepEqual(employeeBrowserSession.profile, {
    displayName: "Employee Fixture",
    email: "adjuster@wavepa.com",
    role: "employee"
  });
  assert.deepEqual(
    employeeBrowserSession.authorizedCapabilities,
    [
      "hcn.action_plans.execute",
      "hcn.action_plans.invalidate",
      "hcn.action_plans.prepare",
      "hcn.action_plans.read",
      "hcn.action_receipts.read",
      "hcn.assistant.conversations.manage",
      "hcn.assistant.conversations.read",
      "hcn.assistant.turn",
      "hcn.connectors.google.disconnect",
      "hcn.connectors.google.link",
      "hcn.connectors.quo_line.link",
      "hcn.connectors.read",
      "hcn.file.review",
      "hcn.work_center.read",
      "platform.session.read"
    ]
  );
  const serializedEmployeeSession =
    JSON.stringify(employeeBrowserSession);
  assert.doesNotMatch(
    serializedEmployeeSession,
    /hcn-employee-google-subject|fixture-other-owner/
  );
  const employeeHeaders = {
    cookie: employeeSessionCookie,
    origin,
    "x-hcn-csrf":
      employeeBrowserSession.browserSession.csrfToken,
    "content-type": "application/json"
  };

  const employeeDisconnectedStatusResponse = await fetch(
    `${origin}/hcn/api/v1/connectors/status`,
    {
      method: "POST",
      headers: employeeHeaders,
      body: "{}"
    }
  );
  assert.equal(employeeDisconnectedStatusResponse.status, 200);
  const employeeDisconnectedStatus =
    await employeeDisconnectedStatusResponse.json();
  assert.deepEqual(employeeDisconnectedStatus.google, {
    status: "not_connected",
    gmail: "not_connected",
    calendar: "not_connected",
    connectUrl: "/hcn/connect/google/start"
  });

  const employeeWorkCenterResponse = await fetch(
    `${origin}/hcn/api/v1/work-center`,
    {
      method: "POST",
      headers: employeeHeaders,
      body: JSON.stringify({ offset: 0, limit: 10 })
    }
  );
  assert.equal(employeeWorkCenterResponse.status, 200);
  const employeeWorkCenter =
    await employeeWorkCenterResponse.json();
  assert.equal(employeeWorkCenter.page.total, 1);
  assert.deepEqual(
    employeeWorkCenter.files.map((file) => file.jobNumber),
    ["HCN-1003"]
  );
  const serializedEmployeeWorkCenter =
    JSON.stringify(employeeWorkCenter);
  assert.equal(
    serializedEmployeeWorkCenter.includes("HCN-1001"),
    false
  );
  assert.equal(
    serializedEmployeeWorkCenter.includes(chanceOwnerId),
    false
  );
  assert.equal(
    serializedEmployeeWorkCenter.includes(otherOwnerId),
    false
  );

  const employeeManagementResponse = await fetch(
    `${origin}/hcn/api/v1/management-sweep`,
    {
      method: "POST",
      headers: employeeHeaders,
      body: JSON.stringify({ limitPerAdjuster: 10 })
    }
  );
  assert.equal(employeeManagementResponse.status, 403);
  const employeeActionResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/list`,
    {
      method: "POST",
      headers: employeeHeaders,
      body: "{}"
    }
  );
  assert.equal(employeeActionResponse.status, 200);
  assert.deepEqual(
    (await employeeActionResponse.json()).plans,
    []
  );
  const employeeCrossFilePrepareResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/prepare`,
    {
      method: "POST",
      headers: employeeHeaders,
      body: JSON.stringify({
        fileRef,
        operations: [{
          type: "jobnimbus.create_note",
          input: { note: "This cross-employee plan must be blocked." }
        }]
      })
    }
  );
  assert.equal(employeeCrossFilePrepareResponse.status, 409);
  assert.equal(jobNimbusMutationRequests.length, 0);

  const employeeFileRef = employeeWorkCenter.files[0].fileRef;
  const employeePrepareResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/prepare`,
    {
      method: "POST",
      headers: employeeHeaders,
      body: JSON.stringify({
        fileRef: employeeFileRef,
        operations: [{
          type: "jobnimbus.create_note",
          input: {
            note:
              "Employee fixture reviewed this assigned file."
          }
        }]
      })
    }
  );
  assert.equal(
    employeePrepareResponse.status,
    200,
    await employeePrepareResponse.clone().text()
  );
  const employeePreparedPlan =
    (await employeePrepareResponse.json()).plan;
  assert.equal(employeePreparedPlan.fileRef, employeeFileRef);
  assert.equal(employeePreparedPlan.status, "pending");
  assert.equal(jobNimbusMutationRequests.length, 0);
  const employeeInvalidateResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/invalidate`,
    {
      method: "POST",
      headers: employeeHeaders,
      body: JSON.stringify({
        planId: employeePreparedPlan.planId
      })
    }
  );
  assert.equal(employeeInvalidateResponse.status, 200);
  assert.equal(
    (await employeeInvalidateResponse.json()).plan.status,
    "invalidated"
  );

  const employeeConnectorStartResponse = await fetch(
    `${origin}/hcn/connect/google/start`,
    {
      redirect: "manual",
      headers: { cookie: employeeSessionCookie }
    }
  );
  assert.equal(employeeConnectorStartResponse.status, 302);
  const employeeConnectorAuthorize = new URL(
    employeeConnectorStartResponse.headers.get("location")
  );
  assert.equal(
    employeeConnectorAuthorize.searchParams.get("scope"),
    hcnConnectorScopeText
  );
  assert.equal(
    employeeConnectorAuthorize.searchParams.get("access_type"),
    "offline"
  );
  assert.equal(
    employeeConnectorAuthorize.searchParams.get("prompt"),
    "consent"
  );
  const employeeConnectorCallbackResponse = await fetch(
    `${origin}/oauth/google/callback?${new URLSearchParams({
      code: "hcn-employee-connector-code",
      state:
        employeeConnectorAuthorize.searchParams.get("state")
    })}`,
    {
      redirect: "manual",
      headers: { cookie: employeeSessionCookie }
    }
  );
  assert.equal(employeeConnectorCallbackResponse.status, 302);
  assert.equal(
    employeeConnectorCallbackResponse.headers.get("location"),
    "/hcn/?google=connected"
  );
  const employeeConnectedStatusResponse = await fetch(
    `${origin}/hcn/api/v1/connectors/status`,
    {
      method: "POST",
      headers: employeeHeaders,
      body: "{}"
    }
  );
  assert.equal(employeeConnectedStatusResponse.status, 200);
  const employeeConnectedStatus =
    await employeeConnectedStatusResponse.json();
  assert.deepEqual(employeeConnectedStatus.google, {
    status: "connected",
    gmail: "connected",
    calendar: "connected",
    connectUrl: "/hcn/connect/google/start"
  });
  assert.equal(
    employeeConnectedStatus.profile.email,
    "adjuster@wavepa.com"
  );
  assert.doesNotMatch(
    JSON.stringify(employeeConnectedStatus),
    /hcn-employee-google-subject|hcn-employee-connector-(?:access|refresh)-token/
  );

  const chanceStillConnectedResponse = await fetch(
    `${origin}/hcn/api/v1/connectors/status`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: "{}"
    }
  );
  assert.equal(chanceStillConnectedResponse.status, 200);
  assert.equal(
    (await chanceStillConnectedResponse.json()).google.status,
    "connected"
  );

  const receiptsBeforeExecutionResponse = await fetch(
    `${origin}/hcn/api/v1/action-receipts/list`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: "{}"
    }
  );
  assert.equal(receiptsBeforeExecutionResponse.status, 200);
  assert.deepEqual(
    (await receiptsBeforeExecutionResponse.json()).receipts,
    []
  );

  const disabledExecutionResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/execute`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ planId: preparedActionPlan.planId })
    }
  );
  assert.equal(disabledExecutionResponse.status, 503);
  assert.equal(jobNimbusMutationRequests.length, 0);
  const stillPendingResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/detail`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ planId: preparedActionPlan.planId })
    }
  );
  assert.equal(stillPendingResponse.status, 200);
  assert.equal((await stillPendingResponse.json()).plan.status, "pending");

  const invalidateActionResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/invalidate`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ planId: preparedActionPlan.planId })
    }
  );
  assert.equal(invalidateActionResponse.status, 200);
  assert.equal((await invalidateActionResponse.json()).plan.status, "invalidated");
  const invalidatedExecutionResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/execute`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ planId: preparedActionPlan.planId })
    }
  );
  assert.equal(invalidatedExecutionResponse.status, 503);
  assert.equal(jobNimbusMutationRequests.length, 0);

  const logoutPendingPrepareResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/prepare`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({
        fileRef,
        operations: [{
          type: "jobnimbus.create_note",
          input: { note: "Pending plan must be invalidated by logout." }
        }]
      })
    }
  );
  assert.equal(logoutPendingPrepareResponse.status, 200);
  assert.equal(
    (await logoutPendingPrepareResponse.json()).plan.status,
    "pending"
  );

  serveUnknownContactsWrapper = true;
  const unknownWrapperResponse = await fetch(
    `${origin}/hcn/api/v1/work-center`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ offset: 0, limit: 10 })
    }
  );
  serveUnknownContactsWrapper = false;
  assert.equal(unknownWrapperResponse.status, 502);
  const unknownWrapperBody = await unknownWrapperResponse.json();
  assert.equal(unknownWrapperBody.error, "Fresh JobNimbus evidence is unavailable.");
  assert.doesNotMatch(JSON.stringify(unknownWrapperBody), /unknownWrapper/);

  allContacts.push({
    ...activeContact,
    jnid: "jn-fixture-duplicate-correlation",
    number: "HCN-1005",
    display_name: "Fixture Duplicate Correlation",
    email: "duplicate.alias@example.test",
    primary_email: activeContact.email,
    mobile_phone: "+12145550005",
    home_phone: activeContact.mobile_phone,
    "Claim #": "HCN-CLAIM-1005",
    claimNumber: activeContact["Claim #"],
    owners: [{ id: "fixture-other-owner" }]
  });
  const requestsBeforeAmbiguousCorrelation = hcnProviderRequests.length;
  const ambiguousCorrelationResponse = await fetch(
    `${origin}/hcn/api/v1/file-review`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ fileRef, recentLimit: 10 })
    }
  );
  allContacts.pop();
  assert.equal(ambiguousCorrelationResponse.status, 200);
  const ambiguousCorrelationFile = await ambiguousCorrelationResponse.json();
  assert.equal(ambiguousCorrelationFile.evidenceStatus, "partial");
  for (const source of ["gmail", "quo"]) {
    assert.deepEqual(
      {
        status: ambiguousCorrelationFile.sources[source].status,
        completeness: ambiguousCorrelationFile.sources[source].completeness,
        failureCode: ambiguousCorrelationFile.sources[source].failureCode
      },
      {
        status: "incomplete",
        completeness: "none",
        failureCode:
          source === "quo"
            ? "phone_match_unverified"
            : "source_unavailable"
      }
    );
    assert.deepEqual(ambiguousCorrelationFile.recent[source], []);
  }
  const requestsAfterAmbiguousCorrelation = hcnProviderRequests.slice(
    requestsBeforeAmbiguousCorrelation
  );
  assert.equal(
    requestsAfterAmbiguousCorrelation.some(
      (request) => request.startsWith("gmail:")
    ),
    false
  );
  assert.equal(
    requestsAfterAmbiguousCorrelation.some(
      (request) =>
        request === "quo:/quo/messages"
        || request === "quo:/quo/calls"
    ),
    false
  );

  const forgedFileResponse = await fetch(
    `${origin}/hcn/api/v1/file-review`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({
        fileRef: `subject_${"0".repeat(32)}`,
        recentLimit: 10
      })
    }
  );
  assert.equal(forgedFileResponse.status, 404);

  const unknownKeyResponse = await fetch(
    `${origin}/hcn/api/v1/work-center`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({ offset: 0, limit: 10, unexpected: true })
    }
  );
  assert.equal(unknownKeyResponse.status, 400);

  const oversizedBodyResponse = await fetch(
    `${origin}/hcn/api/v1/work-center`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: JSON.stringify({
        offset: 0,
        limit: 10,
        padding: "x".repeat(5000)
      })
    }
  );
  assert.equal(oversizedBodyResponse.status, 413);

  assert.deepEqual(await readFile(legacyCanaryPath), legacyCanaryBytes);
  const legacyCanaryAfter = await stat(legacyCanaryPath);
  assert.equal(legacyCanaryAfter.mtimeMs, legacyCanaryBefore.mtimeMs);

  const ambiguousResponse = await fetch(`${origin}/api/v1/session`, {
    headers: {
      cookie: sessionCookie,
      authorization: "Bearer fixture-shared-bridge-token-for-ambiguity"
    }
  });
  assert.equal(ambiguousResponse.status, 400);

  const missingOriginLogout = await fetch(`${origin}/hcn/auth/logout`, {
    method: "POST",
    headers: {
      cookie: sessionCookie,
      "x-hcn-csrf": browserSession.browserSession.csrfToken,
      "content-type": "application/json"
    },
    body: "{}"
  });
  assert.equal(missingOriginLogout.status, 403);

  for (let index = 0; index < 4; index += 1) {
    const allowedConnectorStart = await fetch(
      `${origin}/hcn/connect/google/start`,
      {
        redirect: "manual",
        headers: { cookie: sessionCookie }
      }
    );
    assert.equal(allowedConnectorStart.status, 302);
  }
  const limitedConnectorStart = await fetch(
    `${origin}/hcn/connect/google/start`,
    {
      redirect: "manual",
      headers: { cookie: sessionCookie }
    }
  );
  assert.equal(limitedConnectorStart.status, 429);
  for (let index = 0; index < 130; index += 1) {
    const repeatedLocalRejection = await fetch(
      `${origin}/hcn/connect/google/start`,
      {
        redirect: "manual",
        headers: { cookie: sessionCookie }
      }
    );
    assert.equal(repeatedLocalRejection.status, 429);
  }
  const otherEmployeeStillAdmitted = await fetch(
    `${origin}/hcn/connect/google/start`,
    {
      redirect: "manual",
      headers: { cookie: employeeSessionCookie }
    }
  );
  assert.equal(otherEmployeeStillAdmitted.status, 302);

  const disconnectResponse = await fetch(
    `${origin}/hcn/api/v1/connectors/google/disconnect`,
    {
      method: "POST",
      headers: hcnReadHeaders,
      body: "{}"
    }
  );
  assert.equal(disconnectResponse.status, 200);
  assert.deepEqual(await disconnectResponse.json(), {
    schema: "hcn.console.connector-mutation.v1",
    provider: "google",
    providerRevocation: "revoked",
    status: "not_connected"
  });
  assert.deepEqual(
    revokedGoogleGrants,
    ["hcn-google-connector-refresh-token"]
  );

  const logoutResponse = await fetch(`${origin}/hcn/auth/logout`, {
    method: "POST",
    headers: {
      cookie: sessionCookie,
      origin,
      "x-hcn-csrf": browserSession.browserSession.csrfToken,
      "content-type": "application/json"
    },
    body: "{}"
  });
  assert.equal(logoutResponse.status, 200);
  assert.match(logoutResponse.headers.get("set-cookie"), /^__Host-hcn_session=;/);
  assert.deepEqual(await logoutResponse.json(), { signedOut: true });
  assert.equal(jobNimbusMutationRequests.length, 0);

  const revokedSessionResponse = await fetch(`${origin}/api/v1/session`, {
    headers: { cookie: sessionCookie }
  });
  assert.equal(revokedSessionResponse.status, 401);
  const revokedConsoleResponse = await fetch(`${origin}/hcn/`, {
    redirect: "manual",
    headers: { cookie: sessionCookie }
  });
  assert.equal(revokedConsoleResponse.status, 200);
  const revokedConsoleHtml = await revokedConsoleResponse.text();
  assert.match(revokedConsoleHtml, /Sign in to HCN/);
  assert.doesNotMatch(revokedConsoleHtml, /Work My Files|Company Sweep/);
  for (const pathname of [
    "/hcn/app.css?shell=v15",
    "/hcn/app.js?shell=v15",
    "/hcn/manifest.webmanifest?shell=v15",
    "/hcn/sw.js?shell=v15"
  ]) {
    const revokedPrivateSurface = await fetch(`${origin}${pathname}`, {
      headers: { cookie: sessionCookie }
    });
    assert.equal(revokedPrivateSurface.status, 401, pathname);
  }
  const publicSignInStyle = await fetch(`${origin}/hcn/sign-in.css?shell=v15`);
  assert.equal(publicSignInStyle.status, 200);

  for (let index = 0; index < 3; index += 1) {
    const retryLogin = await fetch(`${origin}/hcn/auth/login`, {
      redirect: "manual"
    });
    assert.equal(retryLogin.status, 302);
  }
  const rateLimitedLogin = await fetch(`${origin}/hcn/auth/login`, {
    redirect: "manual"
  });
  assert.equal(rateLimitedLogin.status, 429);
  assert.ok(
    Number(rateLimitedLogin.headers.get("retry-after")) >= 590
    && Number(rateLimitedLogin.headers.get("retry-after")) <= 600
  );
  assert.equal(
    (await rateLimitedLogin.json()).error,
    "rate_limited"
  );
});

test("HCN action execution is receipt-first, metadata-only, durable across Chance sessions, and Brain-disconnected", async (t) => {
  const bridgePort = 18932;
  const fakeProviderPort = 18933;
  const origin = `http://127.0.0.1:${bridgePort}`;
  const chanceOwnerId = "fixture-hcn-action-owner";
  const providerJobId = "provider-hcn-action-job-private";
  const providerCreatedNoteId = "provider-hcn-created-note-private";
  const exactNote =
    "Andrea needs to reach out for the declaration page or policy.";
  const contact = {
    jnid: providerJobId,
    number: "HCN-ACTION-1001",
    record_type_name: "Insurance",
    owners: [{ id: chanceOwnerId }],
    display_name: "Fixture Action Homeowner",
    status_name: "Claim Filed",
    is_active: true,
    date_updated: "2026-07-28T14:00:00.000Z",
    email: "hcn.action.homeowner@example.test",
    mobile_phone: "2145552121",
    "Claim #": "HCN-ACTION-CLAIM-1001",
    "Policy #": "HCN-ACTION-POLICY-1001"
  };
  const memoryRoot = await mkdtemp(path.join(tmpdir(), "hcn-action-execution-"));
  t.after(() => rm(memoryRoot, { recursive: true, force: true }));
  const receiptStorePath = path.join(
    memoryRoot,
    "bridge",
    "hcn-action-receipts.json"
  );
  const actionBatchStorePath = path.join(
    memoryRoot,
    "bridge",
    "action-batches.json"
  );
  const thresherStorePath = path.join(
    memoryRoot,
    "thresher",
    "state.enc.json"
  );
  const thresherStoreKey =
    Buffer.alloc(32, 0x6c).toString("base64url");
  const thresherReferenceKey =
    Buffer.alloc(32, 0x6d).toString("base64url");
  const thresherSigningKey =
    Buffer.alloc(32, 0x6e).toString("base64url");
  const legacyCanaryPath = path.join(
    memoryRoot,
    "data",
    "memory",
    "files",
    `${createHash("sha256").update(providerJobId).digest("hex")}.json`
  );
  const legacyCanaryBytes = Buffer.from(
    `${JSON.stringify({
      version: 1,
      subjectKey: providerJobId,
      canary: "legacy-v1-action-execution-must-not-change"
    })}\n`
  );
  await mkdir(path.dirname(legacyCanaryPath), { recursive: true });
  await writeFile(legacyCanaryPath, legacyCanaryBytes);
  const legacyCanaryBefore = await stat(legacyCanaryPath);

  let receiptFirstObservation = null;
  const jobNimbusMutations = [];
  const fakeProviderRequests = [];
  const fakeProvider = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${fakeProviderPort}`);
    fakeProviderRequests.push(`${req.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/token" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: "hcn-action-google-access-token",
        expires_in: 3600,
        token_type: "Bearer"
      }));
      return;
    }
    if (url.pathname === "/tokeninfo" && req.method === "GET") {
      assert.equal(
        url.searchParams.get("access_token"),
        "hcn-action-google-access-token"
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        audience: "hcn-action-employee-client",
        expires_in: 3600,
        verified_email: true,
        scope: "openid email profile"
      }));
      return;
    }
    if (url.pathname === "/userinfo" && req.method === "GET") {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-action-google-access-token"
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        sub: "hcn-action-google-subject",
        email: "chance@wavepa.com",
        email_verified: true,
        hd: "wavepa.com",
        name: "Chance Action Fixture"
      }));
      return;
    }
    if (
      url.pathname === "/account/users"
      && req.method === "GET"
    ) {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-action-jobnimbus-key"
      );
      res.writeHead(200, {
        "content-type": "application/json"
      });
      res.end(JSON.stringify({
        total: 1,
        users: [{
          jnid: chanceOwnerId,
          email: "chance@wavepa.com",
          display_name: "Chance Action Fixture",
          is_active: true
        }]
      }));
      return;
    }
    if (url.pathname === "/contacts" && req.method === "GET") {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-action-jobnimbus-key"
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ contacts: [contact] }));
      return;
    }
    if (
      url.pathname === `/contacts/${encodeURIComponent(providerJobId)}`
      && req.method === "GET"
    ) {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-action-jobnimbus-key"
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(contact));
      return;
    }
    if (
      ["/activities", "/tasks", "/files"].includes(url.pathname)
      && req.method === "GET"
    ) {
      const collection = url.pathname.slice(1);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ [collection]: [] }));
      return;
    }
    if (url.pathname === "/activities" && req.method === "POST") {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-action-jobnimbus-key"
      );
      receiptFirstObservation = JSON.parse(
        await readFile(receiptStorePath, "utf8")
      );
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      jobNimbusMutations.push({
        method: req.method,
        pathname: url.pathname,
        body
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jnid: providerCreatedNoteId,
        record_type_name: "Note"
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "fixture route not found" }));
  });
  await new Promise((resolve) =>
    fakeProvider.listen(fakeProviderPort, "127.0.0.1", resolve)
  );
  t.after(() => fakeProvider.close());

  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(bridgePort),
      PUBLIC_BASE_URL: origin,
      HCN_CONSOLE_ENABLED: "true",
      HCN_CONSOLE_ORIGIN: origin,
      HCN_TENANT_ID: "tenant_abcdef0123456789",
      HCN_REFERENCE_KEY: Buffer.alloc(32, 0x6b).toString("base64url"),
      ALLOW_GOOGLE_USER_AUTH: "true",
      GOOGLE_CLIENT_ID: "hcn-action-google-client",
      GOOGLE_CLIENT_SECRET: "hcn-action-google-secret",
      HCN_GOOGLE_CLIENT_ID: "hcn-action-employee-client",
      HCN_GOOGLE_CLIENT_SECRET: "hcn-action-employee-secret",
      GOOGLE_REFRESH_TOKEN: "",
      GOOGLE_TOKEN_URL: `http://127.0.0.1:${fakeProviderPort}/token`,
      GOOGLE_TOKENINFO_URL:
        `http://127.0.0.1:${fakeProviderPort}/tokeninfo`,
      GOOGLE_USERINFO_URL:
        `http://127.0.0.1:${fakeProviderPort}/userinfo`,
      GOOGLE_OAUTH_ALLOWED_DOMAIN: "wavepa.com",
      CHANCE_GOOGLE_EMAIL: "chance@wavepa.com",
      CHANCE_GOOGLE_SUBJECT: "hcn-action-google-subject",
      CHANCE_JOBNIMBUS_OWNER_ID: chanceOwnerId,
      OAUTH_SESSION_SECRET:
        "hcn-action-session-sealing-secret-for-local-tests",
      GPT_OAUTH_CLIENT_SECRET: "",
      WAVE_AUTH_USERS_JSON: JSON.stringify([{
        email: "chance@wavepa.com",
        name: "Chance Action Fixture",
        role: "chance",
        enabled: true,
        googleSubject: "hcn-action-google-subject",
        jobNimbusScope: "assigned"
      }]),
      AUTO_ENROLL_WAVE_USERS: "false",
      JOBNIMBUS_BRIDGE_TOKEN: "",
      CODEX_OPERATOR_TOKEN: "",
      JOBNIMBUS_API_KEY: "hcn-action-jobnimbus-key",
      JOBNIMBUS_API_BASE_URL:
        `http://127.0.0.1:${fakeProviderPort}`,
      HCN_OPERATIONS_ROOT: memoryRoot,
      HCN_THRESHER_ENABLED: "true",
      HCN_THRESHER_STORE_PATH: thresherStorePath,
      HCN_THRESHER_STORE_KEY: thresherStoreKey,
      HCN_THRESHER_REFERENCE_KEY: thresherReferenceKey,
      HCN_THRESHER_SIGNING_KEY: thresherSigningKey,
      HCN_ACTION_RECEIPT_STORE_PATH: receiptStorePath,
      ACTION_APPROVAL_STORE_PATH:
        path.join(memoryRoot, "bridge", "action-approvals.json"),
      ACTION_BATCH_STORE_PATH: actionBatchStorePath,
      BRIDGE_ALLOW_WRITES: "true",
      HCN_ACTION_EXECUTION_ENABLED: "true",
      ALLOW_GMAIL_SEND: "false",
      ALLOW_QUO_SEND: "false",
      ALLOW_VOICE_CALLS: "false",
      ALLOW_RETELL_CALLS: "false",
      ALLOW_CLIENT_COORDINATOR_CALLS: "false",
      ALLOW_CARRIER_FOLLOWUP_CALLS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, bridgePort);
  const healthResponse = await fetch(`${origin}/health`);
  assert.equal(healthResponse.status, 200);
  const activeHealth = await healthResponse.json();
  assert.equal(
    activeHealth.hcnConsole.clientDataPersistence,
    "thresher_encrypted_minimized_operational_state"
  );
  assert.equal(
    activeHealth.hcnOperationsBrain.mode,
    "isolated_v2_active"
  );
  assert.equal(
    activeHealth.hcnOperationsBrain.persistenceConfigured,
    true
  );
  assert.equal(activeHealth.hcnOperationsBrain.modelCanExecute, false);
  assert.equal(activeHealth.hcnOperationsBrain.externalActions, false);
  assert.equal(
    activeHealth.platform.boundaries.hcnOperationsBrain,
    "active_isolated_encrypted_operational_state"
  );

  async function createActionSession(code) {
    const loginResponse = await fetch(`${origin}/hcn/auth/login`, {
      redirect: "manual"
    });
    assert.equal(loginResponse.status, 302);
    const loginCookie = loginResponse.headers
      .getSetCookie()[0]
      .split(";", 1)[0];
    const googleAuthorize = new URL(loginResponse.headers.get("location"));
    assert.equal(
      googleAuthorize.searchParams.get("client_id"),
      "hcn-action-employee-client"
    );
    const callbackResponse = await fetch(
      `${origin}/oauth/google/callback?${new URLSearchParams({
        code,
        state: googleAuthorize.searchParams.get("state")
      })}`,
      {
        redirect: "manual",
        headers: { cookie: loginCookie }
      }
    );
    assert.equal(callbackResponse.status, 302);
    const sessionCookie = callbackResponse.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-hcn_session="))
      .split(";", 1)[0];
    const sessionResponse = await fetch(`${origin}/hcn/auth/session`, {
      headers: { cookie: sessionCookie }
    });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    return {
      cookie: sessionCookie,
      headers: {
        cookie: sessionCookie,
        origin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      }
    };
  }

  const primarySession = await createActionSession(
    "hcn-action-execution-code-primary"
  );
  const workCenterResponse = await fetch(
    `${origin}/hcn/api/v1/work-center`,
    {
      method: "POST",
      headers: primarySession.headers,
      body: JSON.stringify({ offset: 0, limit: 10 })
    }
  );
  assert.equal(
    workCenterResponse.status,
    200,
    await workCenterResponse.clone().text()
  );
  const workCenter = await workCenterResponse.json();
  assert.equal(workCenter.files.length, 1);
  const fileRef = workCenter.files[0].fileRef;

  const prepareResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/prepare`,
    {
      method: "POST",
      headers: primarySession.headers,
      body: JSON.stringify({
        fileRef,
        operations: [{
          type: "jobnimbus.create_note",
          input: { note: exactNote }
        }]
      })
    }
  );
  assert.equal(
    prepareResponse.status,
    200,
    `${await prepareResponse.clone().text()}\n${JSON.stringify(fakeProviderRequests)}`
  );
  const prepared = await prepareResponse.json();
  assert.equal(prepared.plan.status, "pending");
  assert.equal(jobNimbusMutations.length, 0);
  await assert.rejects(
    readFile(receiptStorePath, "utf8"),
    (error) => error?.code === "ENOENT"
  );

  const executeResponse = await fetch(
    `${origin}/hcn/api/v1/action-plans/execute`,
    {
      method: "POST",
      headers: primarySession.headers,
      body: JSON.stringify({ planId: prepared.plan.planId })
    }
  );
  assert.equal(executeResponse.status, 200);
  assert.equal(
    executeResponse.headers.get("cache-control"),
    "no-store, max-age=0"
  );
  const execution = await executeResponse.json();
  assert.equal(execution.plan.status, "completed_pending_verification");
  assert.equal(execution.receipt.status, "completed_pending_verification");
  assert.equal(execution.receipt.operationCount, 1);
  assert.equal(execution.receipt.succeededCount, 1);
  assert.equal(execution.receipt.unknownCount, 0);
  assert.equal(
    Object.hasOwn(execution.receipt, "sessionPrincipalRef"),
    false
  );
  assert.equal(jobNimbusMutations.length, 1);
  assert.deepEqual(jobNimbusMutations[0], {
    method: "POST",
    pathname: "/activities",
    body: {
      note: exactNote,
      date_created: jobNimbusMutations[0].body.date_created,
      record_type_name: "Note",
      primary: { id: providerJobId }
    }
  });
  assert.equal(
    Number.isInteger(jobNimbusMutations[0].body.date_created),
    true
  );

  assert.equal(receiptFirstObservation?.schemaVersion, 1);
  assert.equal(receiptFirstObservation?.records?.length, 1);
  assert.equal(receiptFirstObservation.records[0].status, "executing");
  assert.equal(
    receiptFirstObservation.records[0].planId,
    prepared.plan.planId
  );
  const durableReceiptDocument = JSON.parse(
    await readFile(receiptStorePath, "utf8")
  );
  assert.equal(durableReceiptDocument.schemaVersion, 1);
  assert.equal(durableReceiptDocument.records.length, 1);
  assert.equal(
    durableReceiptDocument.records[0].status,
    "completed_pending_verification"
  );
  const thresherInspector = createActiveThresherRuntime({
    store: createThresherStore({
      filePath: thresherStorePath,
      encryptionKey: thresherStoreKey,
      tenantRef: "tenant_abcdef0123456789"
    }),
    tenantRef: "tenant_abcdef0123456789",
    referenceKey: thresherReferenceKey,
    signingKey: thresherSigningKey
  });
  const thresherState = await thresherInspector.snapshot({
    principalRef: durableReceiptDocument.records[0].sessionPrincipalRef,
    fileRef
  });
  thresherInspector.close();
  assert.equal(thresherState.persistence, "active_encrypted_minimized");
  assert.equal(thresherState.authority.authorizesAction, false);
  assert.equal(thresherState.authority.executesAction, false);
  assert.equal(thresherState.snapshot.receipts.length, 1);
  assert.equal(
    thresherState.snapshot.receipts[0].outcomeCode,
    "uncertain"
  );
  const encryptedThresherState = await readFile(
    thresherStorePath,
    "utf8"
  );
  for (const forbidden of [
    exactNote,
    contact.display_name,
    contact.email,
    contact.mobile_phone,
    contact["Claim #"],
    contact["Policy #"],
    providerJobId,
    providerCreatedNoteId
  ]) {
    assert.equal(
      JSON.stringify(thresherState).includes(forbidden),
      false
    );
    assert.equal(encryptedThresherState.includes(forbidden), false);
  }
  const serializedReceipts = JSON.stringify({
    executionReceipt: execution.receipt,
    receiptFirstObservation,
    durableReceiptDocument
  });
  for (const forbidden of [
    providerJobId,
    providerCreatedNoteId,
    exactNote,
    contact.display_name,
    contact.email,
    contact.mobile_phone,
    contact["Claim #"],
    contact["Policy #"],
    "/activities",
    "approvalChallenge",
    "hcn-action-jobnimbus-key",
    "hcn-action-google-access-token"
  ]) {
    assert.equal(
      serializedReceipts.includes(forbidden),
      false,
      `HCN durable receipt leaked ${forbidden}`
    );
  }

  const receiptListResponse = await fetch(
    `${origin}/hcn/api/v1/action-receipts/list`,
    {
      method: "POST",
      headers: primarySession.headers,
      body: "{}"
    }
  );
  assert.equal(receiptListResponse.status, 200);
  const receiptList = await receiptListResponse.json();
  assert.equal(receiptList.receipts.length, 1);
  assert.equal(receiptList.receipts[0].planId, prepared.plan.planId);
  const receiptDetailResponse = await fetch(
    `${origin}/hcn/api/v1/action-receipts/detail`,
    {
      method: "POST",
      headers: primarySession.headers,
      body: JSON.stringify({ planId: prepared.plan.planId })
    }
  );
  assert.equal(receiptDetailResponse.status, 200);
  assert.deepEqual(
    (await receiptDetailResponse.json()).receipt,
    execution.receipt
  );

  const resumedChanceSession = await createActionSession(
    "hcn-action-execution-code-resumed"
  );
  const resumedReceiptListResponse = await fetch(
    `${origin}/hcn/api/v1/action-receipts/list`,
    {
      method: "POST",
      headers: resumedChanceSession.headers,
      body: "{}"
    }
  );
  assert.equal(resumedReceiptListResponse.status, 200);
  const resumedReceipts = (await resumedReceiptListResponse.json()).receipts;
  assert.equal(resumedReceipts.length, 1);
  assert.equal(
    resumedReceipts[0].planId,
    prepared.plan.planId
  );
  const resumedReceiptDetailResponse = await fetch(
    `${origin}/hcn/api/v1/action-receipts/detail`,
    {
      method: "POST",
      headers: resumedChanceSession.headers,
      body: JSON.stringify({ planId: prepared.plan.planId })
    }
  );
  assert.equal(resumedReceiptDetailResponse.status, 200);
  assert.deepEqual(
    (await resumedReceiptDetailResponse.json()).receipt,
    execution.receipt
  );

  async function preparePlan(session, operations) {
    const response = await fetch(
      `${origin}/hcn/api/v1/action-plans/prepare`,
      {
        method: "POST",
        headers: session.headers,
        body: JSON.stringify({ fileRef, operations })
      }
    );
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).plan;
  }

  async function executePlan(session, planId) {
    const response = await fetch(
      `${origin}/hcn/api/v1/action-plans/execute`,
      {
        method: "POST",
        headers: session.headers,
        body: JSON.stringify({ planId })
      }
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }

  async function appendPriorBatch(row) {
    const rows = JSON.parse(await readFile(actionBatchStorePath, "utf8"));
    const principalRef = rows.find((item) => item.principalRef)
      ?.principalRef;
    rows.push({
      ...row,
      ...(principalRef ? { principalRef } : {})
    });
    await writeFile(
      actionBatchStorePath,
      `${JSON.stringify(rows, null, 2)}\n`,
      "utf8"
    );
  }

  const duplicateVerificationPlan = await preparePlan(
    resumedChanceSession,
    [{
      type: "jobnimbus.create_note",
      input: { note: exactNote }
    }]
  );
  const duplicateVerification = await executePlan(
    resumedChanceSession,
    duplicateVerificationPlan.planId
  );
  assert.equal(
    duplicateVerification.receipt.status,
    "completed_pending_verification"
  );
  assert.equal(duplicateVerification.receipt.succeededCount, 1);
  assert.equal(duplicateVerification.receipt.unknownCount, 0);
  assert.equal(jobNimbusMutations.length, 1);

  const inProgressPlan = await preparePlan(
    resumedChanceSession,
    [{
      type: "jobnimbus.create_note",
      input: {
        note: "In-progress duplicate must require fresh reconciliation."
      }
    }]
  );
  await appendPriorBatch({
    id: "fixture-hcn-in-progress-batch",
    approvalId: "fixture-hcn-in-progress-approval",
    approvalDigest: inProgressPlan.approvalDigest,
    status: "in_progress",
    createdAt: "2026-07-28T15:00:00.000Z",
    operationCount: 1,
    completed: []
  });
  const inProgressDuplicate = await executePlan(
    resumedChanceSession,
    inProgressPlan.planId
  );
  assert.equal(
    inProgressDuplicate.receipt.status,
    "reconciliation_required"
  );
  assert.equal(inProgressDuplicate.receipt.succeededCount, 0);
  assert.equal(inProgressDuplicate.receipt.unknownCount, 1);
  assert.equal(jobNimbusMutations.length, 1);

  const partialPlan = await preparePlan(
    resumedChanceSession,
    [
      {
        type: "jobnimbus.create_note",
        input: {
          note: "First partial-duplicate action is already recorded."
        }
      },
      {
        type: "jobnimbus.create_note",
        input: {
          note: "Second partial-duplicate action remains uncertain."
        }
      }
    ]
  );
  await appendPriorBatch({
    id: "fixture-hcn-partial-batch",
    approvalId: "fixture-hcn-partial-approval",
    approvalDigest: partialPlan.approvalDigest,
    status: "partial_failure",
    createdAt: "2026-07-28T15:01:00.000Z",
    updatedAt: "2026-07-28T15:01:30.000Z",
    operationCount: 2,
    completed: [{
      index: 0,
      type: "jobnimbus.create_note",
      status: "executed",
      receipt: { mode: "executed" }
    }],
    failedAt: 1,
    error: "fixture provider uncertainty"
  });
  const partialDuplicate = await executePlan(
    resumedChanceSession,
    partialPlan.planId
  );
  assert.equal(
    partialDuplicate.receipt.status,
    "reconciliation_required"
  );
  assert.equal(partialDuplicate.receipt.succeededCount, 1);
  assert.equal(partialDuplicate.receipt.unknownCount, 1);
  assert.equal(jobNimbusMutations.length, 1);

  const persistenceFailureSession = await createActionSession(
    "hcn-action-execution-code-persistence-failure"
  );
  const unavailablePersistencePlan = await preparePlan(
    persistenceFailureSession,
    [{
      type: "jobnimbus.create_note",
      input: {
        note: "This action must not reach JobNimbus when Thresher is unavailable."
      }
    }]
  );
  await writeFile(thresherStorePath, "corrupt", "utf8");
  const mutationCountBeforeFailure = jobNimbusMutations.length;
  const unavailablePersistenceExecution = await fetch(
    `${origin}/hcn/api/v1/action-plans/execute`,
    {
      method: "POST",
      headers: persistenceFailureSession.headers,
      body: JSON.stringify({
        planId: unavailablePersistencePlan.planId
      })
    }
  );
  assert.equal(unavailablePersistenceExecution.status, 503);
  assert.match(
    (await unavailablePersistenceExecution.json()).error,
    /Thresher persistence is unavailable|Nothing was intentionally executed/i
  );
  assert.equal(jobNimbusMutations.length, mutationCountBeforeFailure);

  assert.deepEqual(await readFile(legacyCanaryPath), legacyCanaryBytes);
  const legacyCanaryAfter = await stat(legacyCanaryPath);
  assert.equal(legacyCanaryAfter.mtimeMs, legacyCanaryBefore.mtimeMs);
});

test("production startup rejects weak OAuth secrets and unreviewed Google endpoints", async () => {
  await expectBridgeStartupFailure({
    GOOGLE_CLIENT_ID: "reused-google-client",
    HCN_GOOGLE_CLIENT_ID: "reused-google-client"
  }, /HCN_GOOGLE_CLIENT_ID must identify a dedicated employee connector client/);

  await expectBridgeStartupFailure({
    GOOGLE_CLIENT_ID: "legacy-google-client",
    HCN_GOOGLE_CLIENT_ID: "hcn-google-client",
    GOOGLE_CLIENT_SECRET: "reused-google-client-secret",
    HCN_GOOGLE_CLIENT_SECRET: "reused-google-client-secret"
  }, /HCN_GOOGLE_CLIENT_SECRET must be different from GOOGLE_CLIENT_SECRET/);

  await expectBridgeStartupFailure({
    OAUTH_SESSION_SECRET: "weak",
    GOOGLE_TOKEN_URL: "",
    GOOGLE_TOKENINFO_URL: "",
    GOOGLE_USERINFO_URL: ""
  }, /OAUTH_SESSION_SECRET must be 32-1024 bytes/);

  await expectBridgeStartupFailure({
    OAUTH_SESSION_SECRET: "",
    GOOGLE_TOKEN_URL: "https://credential-sink.example/token",
    GOOGLE_TOKENINFO_URL: "",
    GOOGLE_USERINFO_URL: ""
  }, /Google token endpoint must use the reviewed Google HTTPS URL/);

  await expectBridgeStartupFailure({
    OAUTH_SESSION_SECRET: "",
    GOOGLE_REVOKE_URL:
      "https://credential-sink.example/revoke"
  }, /Google revoke endpoint must use the reviewed Google HTTPS URL/);

  await expectBridgeStartupFailure({
    RENDER: "true",
    HCN_OPERATIONS_ROOT: ""
  }, /Render startup requires an isolated, absolute HCN_OPERATIONS_ROOT/);

  const reusedSecret =
    Buffer.alloc(32, 0x2f).toString("base64url");
  await expectBridgeStartupFailure({
    OAUTH_SESSION_SECRET: reusedSecret,
    HCN_GOOGLE_GRANT_KEY: reusedSecret
  }, /HCN_GOOGLE_GRANT_KEY must be different from OAUTH_SESSION_SECRET/);

  await expectBridgeStartupFailure({
    HCN_REFERENCE_KEY: reusedSecret,
    HCN_GOOGLE_GRANT_KEY: reusedSecret
  }, /HCN_GOOGLE_GRANT_KEY must be different from HCN_REFERENCE_KEY/);

  await expectBridgeStartupFailure({
    JOBNIMBUS_API_KEY: reusedSecret,
    HCN_GOOGLE_GRANT_KEY: reusedSecret
  }, /HCN_GOOGLE_GRANT_KEY must be different from JOBNIMBUS_API_KEY/);
  await expectBridgeStartupFailure({
    HCN_QUO_LINK_KEY: reusedSecret,
    TWILIO_AUTH_TOKEN: reusedSecret
  }, /HCN_QUO_LINK_KEY must be different from TWILIO_AUTH_TOKEN/);
  await expectBridgeStartupFailure({
    OAUTH_SESSION_SECRET: reusedSecret,
    HCN_REFERENCE_KEY: reusedSecret
  }, /HCN_REFERENCE_KEY must be different from OAUTH_SESSION_SECRET/);

  const thresherRoot = path.join(
    tmpdir(),
    "hcn-thresher-startup-boundary"
  );
  const thresherEnvironment = {
    HCN_OPERATIONS_ROOT: thresherRoot,
    HCN_TENANT_ID: "tenant_0123456789abcdef",
    HCN_THRESHER_STORE_PATH:
      path.join(thresherRoot, "thresher", "state.enc.json"),
    HCN_THRESHER_STORE_KEY:
      Buffer.alloc(32, 0x41).toString("base64url"),
    HCN_THRESHER_REFERENCE_KEY:
      Buffer.alloc(32, 0x42).toString("base64url"),
    HCN_THRESHER_SIGNING_KEY:
      Buffer.alloc(32, 0x43).toString("base64url")
  };
  await expectBridgeStartupFailure({
    ...thresherEnvironment,
    HCN_THRESHER_SIGNING_KEY: ""
  }, /All dedicated Thresher keys must be configured together/);
  await expectBridgeStartupFailure({
    ...thresherEnvironment,
    HCN_REFERENCE_KEY: thresherEnvironment.HCN_THRESHER_STORE_KEY
  }, /HCN_THRESHER_STORE_KEY must be different from HCN_REFERENCE_KEY/);
});

test("Retell configuration creates an editable draft before publishing", async (t) => {
  const bridgePort = 18882;
  const fakeRetellPort = 18883;
  const requests = [];
  let publishedBody = null;
  const fakeRetell = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${fakeRetellPort}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : {};
    requests.push({ method: req.method, path: url.pathname, version: url.searchParams.get("version"), body });

    let status = 200;
    let response;
    if (req.method === "GET" && url.pathname === "/get-agent/fixture-coordinator-agent") {
      response = {
        agent_id: "fixture-coordinator-agent",
        version: 7,
        is_published: true,
        response_engine: { type: "retell-llm", llm_id: "fixture-coordinator-llm", version: 4 }
      };
    } else if (req.method === "POST" && url.pathname === "/create-agent-version/fixture-coordinator-agent") {
      assert.equal(body.base_version, 7);
      status = 201;
      response = {
        agent_id: "fixture-coordinator-agent",
        version: 8,
        base_version: 7,
        is_published: false,
        response_engine: { type: "retell-llm", llm_id: "fixture-coordinator-llm", version: 5 }
      };
    } else if (req.method === "PATCH" && url.pathname === "/update-retell-llm/fixture-coordinator-llm") {
      assert.equal(url.searchParams.get("version"), "5");
      assert.match(body.general_prompt, /respond naturally in one short sentence/);
      assert.deepEqual(body.general_tools.map((tool) => tool.name), ["end_call"]);
      assert.equal(body.begin_message, "");
      assert.equal(body.start_speaker, "user");
      response = { llm_id: "fixture-coordinator-llm", version: 5, is_published: false };
    } else if (req.method === "PATCH" && url.pathname === "/update-agent/fixture-coordinator-agent") {
      assert.equal(url.searchParams.get("version"), "8");
      assert.equal(body.response_engine.version, 5);
      assert.equal(body.reminder_trigger_ms, 30000);
      assert.equal(body.reminder_max_count, 1);
      assert.equal(body.end_call_after_silence_ms, 90000);
      assert.equal(body.max_call_duration_ms, 300000);
      assert.deepEqual(body.voicemail_option, { action: { type: "hangup" } });
      assert.deepEqual(body.ivr_option, { action: { type: "hangup" } });
      response = {
        agent_id: "fixture-coordinator-agent",
        version: 8,
        is_published: false,
        response_engine: body.response_engine
      };
    } else if (req.method === "POST" && url.pathname === "/publish-agent-version/fixture-coordinator-agent") {
      publishedBody = body;
      response = {};
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve) => fakeRetell.listen(fakeRetellPort, "127.0.0.1", resolve));
  t.after(() => fakeRetell.close());

  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(bridgePort),
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-token",
      RETELL_API_BASE_URL: `http://127.0.0.1:${fakeRetellPort}`,
      RETELL_API_KEY: "fixture-retell-key",
      RETELL_AGENT_ID: "fixture-carrier-agent",
      RETELL_HOMEOWNER_AGENT_ID: "fixture-coordinator-agent",
      RETELL_CLIENT_COORDINATOR_AGENT_ID: "fixture-coordinator-agent",
      BRIDGE_ALLOW_WRITES: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, bridgePort);

  const dryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/retell/configure-client-coordinator`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ execute: false })
  });
  assert.equal(dryRunResponse.status, 200);
  const dryRun = await dryRunResponse.json();
  assert.equal(dryRun.mode, "dry_run");
  assert.deepEqual(dryRun.toolNames, ["end_call"]);
  assert.match(dryRun.exactConfiguration.generalPrompt, /respond naturally in one short sentence/);
  assert.equal(dryRun.exactConfiguration.startSpeaker, "user");
  assert.equal(dryRun.exactConfiguration.agentSettings.max_call_duration_ms, 300000);

  const publishResponse = await fetch(`http://127.0.0.1:${bridgePort}/retell/configure-client-coordinator`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ execute: true, publish: true, configDigest: dryRun.configDigest })
  });
  assert.equal(publishResponse.status, 200);
  const published = await publishResponse.json();
  assert.equal(published.mode, "executed");
  assert.equal(published.published, true);
  assert.equal(published.draftAgentVersion, 8);
  assert.equal(published.publishedAgentVersion, 8);
  assert.equal(published.retellLlmVersion, 5);
  assert.equal(publishedBody.version, 8);
  assert.equal(requests.filter((request) => request.path.includes("create-agent-version")).length, 1);
});

test("prepare route reads fresh evidence and enforces Chance ownership", async (t) => {
  const bridgePort = 18880;
  const fakeApiPort = 18881;
  const memoryRoot = await mkdtemp(path.join(tmpdir(), "jobnimbus-bridge-smoke-"));
  t.after(() => rm(memoryRoot, { recursive: true, force: true }));
  const chanceOwnerId = "fc95a213f70e4c9daddc5fa366be9941";
  const chance = {
    jnid: "contact-chance",
    number: 2739,
    record_type_name: "Insurance",
    owners: [{ id: chanceOwnerId }],
    display_name: "Fixture Homeowner",
    status_name: "Ready for PA Review",
    address_line1: "100 Test St",
    city: "Dallas",
    state_text: "TX",
    zip: "75201",
    mobile_phone: "2145551212",
    email: "fixture@example.test",
    cf_string_1: "State Farm",
    cf_string_3: "POLICY-1",
    cf_string_5: "Hail / wind",
    cf_date_1: "2026-04-25"
  };
  const other = {
    ...chance,
    jnid: "contact-other",
    number: 9999,
    display_name: "Other Owner 9999",
    status_name: "Submitted (Awaiting Two Key Confirmations)",
    owners: [{ id: "someone-else" }]
  };
  const hidden = {
    ...chance,
    jnid: "contact-hidden",
    number: 8888,
    display_name: "Hidden Owner 8888",
    owners: [{ id: "someone-else" }]
  };
  const fixturePdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "ascii");
  let fixtureTaskCompleted = false;
  let fixtureNoteCreated = false;
  let relatedFilterRequests = 0;
  let fixtureGmailDraftExists = false;
  let fixtureGmailDraftCreateCount = 0;
  let fixtureGmailDraftSendCount = 0;
  let fixtureGmailDraftDuplicateTo = false;
  let fixtureGmailDraftInlineAttachment = false;
  let fixtureGmailDraftAlternateBody = false;
  let fixtureTdiMutationMode = false;
  let fixtureTdiDownloadCount = 0;
  const fakeApi = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${fakeApiPort}`);
    if (["/activities", "/tasks", "/files"].includes(url.pathname) && String(url.searchParams.get("filter") || "").includes("related.id")) {
      relatedFilterRequests += 1;
    }
    if (url.pathname === "/geocoder") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        result: {
          addressMatches: [{
            matchedAddress: "100 TEST ST, DALLAS, TX, 75201",
            coordinates: { x: -96.797, y: 32.777 }
          }]
        }
      }));
      return;
    }
    if (url.pathname === "/lsr") {
      res.writeHead(200, { "content-type": "text/csv" });
      res.end([
        "VALID,VALID2,LAT,LON,MAG,WFO,TYPECODE,TYPETEXT,CITY,COUNTY,STATE,SOURCE,REMARK,UGC,UGCNAME,QUALIFIER",
        '202604252130,2026/04/25 21:30,32.779,-96.795,1.75,FWD,H,HAIL,Dallas,Dallas,TX,Public,"Golf ball hail, photographed.",TXC113,Dallas,M'
      ].join("\n"));
      return;
    }
    if (url.pathname === "/oauth-token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "fixture-google-token", expires_in: 3600 }));
      return;
    }
    if (url.pathname === "/phone-numbers" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "PN-fixture", name: "Chance", number: "+19725550100" }] }));
      return;
    }
    if (url.pathname === "/messages" && req.method === "POST") {
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: {
          id: "AC-fixture-message",
          phoneNumberId: "PN-fixture",
          from: "+19725550100",
          to: ["+12145551212"],
          direction: "outgoing",
          status: "queued",
          createdAt: "2026-07-16T12:00:00Z"
        }
      }));
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/messages" && req.method === "GET" && String(url.searchParams.get("q") || "").includes("Wave W-9.pdf")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: [{ id: "gmail-w9-message", threadId: "gmail-w9-thread" }] }));
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/messages/gmail-w9-message" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "gmail-w9-message",
        threadId: "gmail-w9-thread",
        payload: {
          mimeType: "multipart/mixed",
          headers: [{ name: "From", value: "Richard <richard@wavepa.com>" }],
          parts: [{
            filename: "Wave W-9.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "gmail-w9-attachment", size: fixturePdf.length }
          }]
        }
      }));
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/messages/gmail-w9-message/attachments/gmail-w9-attachment" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: fixturePdf.toString("base64url"), size: fixturePdf.length }));
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/drafts/draft-1" && req.method === "GET") {
      if (!fixtureGmailDraftExists) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Draft not found" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      const draftPayload = fixtureGmailDraftInlineAttachment
        ? {
            mimeType: "multipart/mixed",
            headers: [
              { name: "To", value: "carrier@example.test" },
              ...(fixtureGmailDraftDuplicateTo ? [{ name: "To", value: "hidden@example.test" }] : []),
              { name: "Subject", value: "DRAFT-CLAIM" }
            ],
            parts: [
              {
                partId: "0",
                mimeType: "text/plain",
                body: { data: Buffer.from("Approved Gmail draft body.").toString("base64url") }
              },
              {
                partId: "1",
                filename: "small-inline.pdf",
                mimeType: "application/pdf",
                body: { data: fixturePdf.toString("base64url"), size: fixturePdf.length }
              }
            ]
          }
        : fixtureGmailDraftAlternateBody
          ? {
              mimeType: "multipart/alternative",
              headers: [
                { name: "To", value: "carrier@example.test" },
                ...(fixtureGmailDraftDuplicateTo ? [{ name: "To", value: "hidden@example.test" }] : []),
                { name: "Subject", value: "DRAFT-CLAIM" }
              ],
              parts: [
                {
                  partId: "0",
                  mimeType: "text/plain",
                  body: { data: Buffer.from("Approved Gmail draft body.").toString("base64url") }
                },
                {
                  partId: "1",
                  mimeType: "text/html",
                  body: { data: Buffer.from("<p>Alternate HTML body.</p>").toString("base64url") }
                }
              ]
            }
          : {
              mimeType: "text/plain",
              headers: [
                { name: "To", value: "carrier@example.test" },
                ...(fixtureGmailDraftDuplicateTo ? [{ name: "To", value: "hidden@example.test" }] : []),
                { name: "Subject", value: "DRAFT-CLAIM" }
              ],
              body: { data: Buffer.from("Approved Gmail draft body.").toString("base64url") }
            };
      res.end(JSON.stringify({
        id: "draft-1",
        message: {
          id: "draft-message-1",
          threadId: "draft-thread-1",
          snippet: "Approved Gmail draft body.",
          payload: draftPayload
        }
      }));
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/drafts" && req.method === "POST") {
      fixtureGmailDraftExists = true;
      fixtureGmailDraftCreateCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1", threadId: "draft-thread-1" } }));
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/messages/send" && req.method === "POST") {
      if (!fixtureGmailDraftExists) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Draft not found" } }));
        return;
      }
      fixtureGmailDraftSendCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "sent-message-1",
        threadId: "draft-thread-1",
        payload: { headers: [
          { name: "To", value: "carrier@example.test" },
          { name: "Subject", value: "DRAFT-CLAIM" }
        ] }
      }));
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/drafts/draft-1" && req.method === "DELETE") {
      fixtureGmailDraftExists = false;
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/file-content/file-1") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(fixturePdf);
      return;
    }
    if (url.pathname === "/file-content/file-policy") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(fixturePdf);
      return;
    }
    if (url.pathname === "/file-content/file-other") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(fixturePdf);
      return;
    }
    if (url.pathname === "/file-content/file-hidden") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(fixturePdf);
      return;
    }
    if (url.pathname === "/file-content/file-tdi") {
      fixtureTdiDownloadCount += 1;
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(
        fixtureTdiMutationMode && fixtureTdiDownloadCount >= 3
          ? Buffer.concat([fixturePdf, Buffer.from("\nchanged-after-approval", "utf8")])
          : fixturePdf
      );
      return;
    }
    if (url.pathname === "/tasks/task-1" && req.method === "PUT") {
      fixtureTaskCompleted = true;
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("jnLog is not a function");
      return;
    }
    if (url.pathname === "/tasks/task-1") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jnid: "task-1", primary: { id: chance.jnid }, title: "File claim", is_completed: fixtureTaskCompleted }));
      return;
    }
    if (url.pathname === "/activities" && req.method === "POST") {
      fixtureNoteCreated = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jnid: "activity-created", primary: { id: chance.jnid }, record_type_name: "Note" }));
      return;
    }
    let body = {};
    if (url.pathname === "/contacts") body = { contacts: [chance, other] };
    else if (url.pathname === "/contacts/contact-chance") body = chance;
    else if (url.pathname === "/contacts/contact-other") body = other;
    else if (url.pathname === "/contacts/contact-hidden") body = hidden;
    else if (url.pathname === "/activities") body = { activities: [{ jnid: "activity-1", primary: { id: chance.jnid }, note: "Exterior hail damage documented." }] };
    else if (url.pathname === "/tasks") body = { tasks: [{ jnid: "task-1", primary: { id: chance.jnid }, title: "File claim", is_completed: fixtureTaskCompleted }] };
    else if (url.pathname === "/files") body = { files: [
      ...Array.from({ length: 120 }, (_, index) => ({
        jnid: `file-photo-${index + 1}`,
        primary: { id: chance.jnid },
        filename: `inspection-photo-${index + 1}.jpg`,
        content_type: "image/jpeg"
      })),
      { jnid: "file-1", primary: { id: chance.jnid }, filename: "Carrier estimate.pdf", content_type: "application/pdf" },
      { jnid: "file-tdi", primary: { id: chance.jnid }, filename: "Fixture Homeowner - TDI.pdf", content_type: "application/pdf" },
      { jnid: "file-policy", primary: { id: chance.jnid }, filename: "Fixture Homeowner Insurance.pdf", content_type: "application/pdf" },
      { jnid: "file-2", primary: { id: chance.jnid }, filename: "roof-photo.jpg", content_type: "image/jpeg" },
      { jnid: "file-other", primary: { id: other.jnid }, filename: "Other Owner - TDI.pdf", content_type: "application/pdf" },
      { jnid: "file-hidden", primary: { id: hidden.jnid }, filename: "Hidden Owne\u0301r - TDI .pdf", content_type: "application/pdf" }
    ] };
    else { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => fakeApi.listen(fakeApiPort, "127.0.0.1", resolve));
  t.after(() => fakeApi.close());

  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(bridgePort),
      JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      JOBNIMBUS_FILE_BASE_URL: `http://127.0.0.1:${fakeApiPort}/file-content`,
      JOBNIMBUS_API_KEY: "fixture-key",
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-token",
      CODEX_OPERATOR_TOKEN: "fixture-codex-operator-token-1234567890",
      CODEX_MAC_OPERATOR_TOKEN: "fixture-codex-mac-operator-token-1234567890",
      CENSUS_GEOCODER_URL: `http://127.0.0.1:${fakeApiPort}/geocoder`,
      HAIL_REPORTS_URL: `http://127.0.0.1:${fakeApiPort}/lsr`,
      RETELL_AGENT_ID: "fixture-agent",
      RETELL_FROM_NUMBER: "+12145550100",
      RETELL_API_KEY: "fixture-retell-key",
      ALLOW_RETELL_CALLS: "false",
      ALLOW_CLIENT_COORDINATOR_CALLS: "false",
      BRIDGE_ALLOW_WRITES: "true",
      HCN_OPERATIONS_ROOT: memoryRoot,
      ALLOW_GMAIL_SEND: "true",
      GOOGLE_CLIENT_ID: "fixture-google-client",
      GOOGLE_CLIENT_SECRET: "fixture-google-secret",
      GOOGLE_REFRESH_TOKEN: "fixture-google-refresh",
      STANDARD_W9_GMAIL_MESSAGE_ID: "gmail-w9-message",
      STANDARD_W9_GMAIL_ATTACHMENT_ID: "gmail-w9-attachment",
      STANDARD_W9_SHA256: createHash("sha256").update(fixturePdf).digest("hex"),
      GOOGLE_TOKEN_URL: `http://127.0.0.1:${fakeApiPort}/oauth-token`,
      GMAIL_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      QUO_API_KEY: "fixture-quo-key",
      QUO_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      QUO_DEFAULT_FROM_NUMBER: "+19725550100",
      ALLOW_QUO_SEND: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, bridgePort);

  const chanceIdentityResponse = await fetch(`http://127.0.0.1:${bridgePort}/auth/whoami`, {
    headers: { authorization: "Bearer fixture-token" }
  });
  assert.equal(chanceIdentityResponse.status, 200);
  const chanceIdentity = await chanceIdentityResponse.json();
  assert.equal(chanceIdentity.identity.email, "cpearson@wavepa.com");
  assert.equal(chanceIdentity.identity.quoLineConfigured, true);

  const preparedResponse = await fetch(`http://127.0.0.1:${bridgePort}/claim-filing/prepare`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739" })
  });
  assert.equal(preparedResponse.status, 200);
  const prepared = await preparedResponse.json();
  assert.equal(prepared.file.id, "contact-chance");
  assert.equal(prepared.readiness.ready, true);
  assert.equal(prepared.evidence.documentsReviewed, 3);
  assert.equal(prepared.evidence.photoFilesExcluded, 121);
  assert.ok(relatedFilterRequests >= 3);
  assert.equal(prepared.callPlan.to, "+18444584300");
  assert.equal(prepared.packet.verifiedFileFacts.stormTime, "Approximately 4:30 PM CDT based on a nearby reported hail event");
  assert.equal(prepared.stormTimeEvidence.verifiedWeatherMatch, true);
  assert.equal(prepared.stormTimeEvidence.dateMatchedToJobNimbusDol, "2026-04-25");
  assert.match(prepared.packet.scriptInstruction, /Do not invent or rewrite an opening script/);
  assert.match(prepared.planDigest, /^[a-f0-9]{64}$/);

  const labeledPreparedResponse = await fetch(`http://127.0.0.1:${bridgePort}/claim-filing/prepare`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "JobNimbus #2739" })
  });
  assert.equal(labeledPreparedResponse.status, 200);
  assert.equal((await labeledPreparedResponse.json()).file.id, "contact-chance");

  const brainResponse = await fetch(`http://127.0.0.1:${bridgePort}/brain/context`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ maxPerSection: 25 })
  });
  assert.equal(brainResponse.status, 404);

  const chanceIndexResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/review-chance-files`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ indexOnly: true, activeOnly: true, includeGmail: false, includeQuo: false })
  });
  assert.equal(chanceIndexResponse.status, 200);
  const chanceIndex = await chanceIndexResponse.json();
  assert.equal(chanceIndex.mode, "index");
  assert.equal(chanceIndex.total, 1);
  assert.equal(chanceIndex.files[0].number, 2739);
  assert.equal(chanceIndex.files[0].missing.claimNumber, true);
  assert.equal(chanceIndex.files[0].missing.policyNumber, false);
  assert.equal(chanceIndex.brain.systemId, "hcn_operations");
  assert.equal(chanceIndex.brain.status, "isolated_foundation");
  assert.equal(chanceIndex.brain.persistedClientMemory, false);

  const exactChanceReviewResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/review-chance-files`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739", limit: 1, includeGmail: false, includeQuo: false })
  });
  assert.equal(exactChanceReviewResponse.status, 200);
  const exactChanceReview = await exactChanceReviewResponse.json();
  assert.equal(exactChanceReview.packets[0].clientMemory.snapshot.file.id, chance.jnid);
  assert.equal(exactChanceReview.packets[0].clientMemory.persisted, false);
  assert.equal(
    exactChanceReview.packets[0].clientMemory.snapshot.counts
      .operationalDocumentCount,
    3
  );
  assert.equal(exactChanceReview.brain.status, "isolated_foundation");
  assert.equal(exactChanceReview.brain.persistedClientMemory, false);

  const coordinatorDryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/retell/client-coordinator-call`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      mode: "status_update",
      statusUpdate: "the claim file is being reviewed before the next carrier step.",
      includeGmail: false,
      includeQuo: false,
      execute: false
    })
  });
  assert.equal(coordinatorDryRunResponse.status, 200);
  const coordinatorDryRun = await coordinatorDryRunResponse.json();
  assert.equal(coordinatorDryRun.mode, "dry_run");
  assert.equal(coordinatorDryRun.file.id, chance.jnid);
  assert.equal(coordinatorDryRun.conversation.mode, "status_update");
  assert.equal(coordinatorDryRun.evidence.complete, true);
  assert.equal(coordinatorDryRun.evidence.jobNimbus.operationalDocuments.length, 3);
  assert.equal(coordinatorDryRun.evidence.jobNimbus.excludedPhotoLikeDocumentCount, 121);
  assert.equal(coordinatorDryRun.automaticFallbackText, false);
  assert.equal(coordinatorDryRun.automaticJobNimbusWriteback, false);
  assert.match(coordinatorDryRun.planDigest, /^[a-f0-9]{64}$/);

  const coordinatorRepeatResponse = await fetch(`http://127.0.0.1:${bridgePort}/retell/client-coordinator-call`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      mode: "status_update",
      statusUpdate: "the claim file is being reviewed before the next carrier step.",
      includeGmail: false,
      includeQuo: false,
      execute: false
    })
  });
  assert.equal(coordinatorRepeatResponse.status, 200);
  const coordinatorRepeat = await coordinatorRepeatResponse.json();
  assert.equal(coordinatorRepeat.planDigest, coordinatorDryRun.planDigest);

  const appointmentCompatibilityResponse = await fetch(`http://127.0.0.1:${bridgePort}/retell/client-coordinator-call`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      mode: "appointment_confirmation",
      dateStart: "2026-07-17T14:00:00-05:00",
      dateEnd: "2026-07-17T16:00:00-05:00",
      includeGmail: false,
      includeQuo: false,
      execute: false
    })
  });
  assert.equal(appointmentCompatibilityResponse.status, 200);
  const appointmentCompatibility = await appointmentCompatibilityResponse.json();
  assert.equal(
    appointmentCompatibility.request.retell_llm_dynamic_variables.goal,
    "homeowner_appointment_confirmation"
  );
  assert.match(
    appointmentCompatibility.request.retell_llm_dynamic_variables.homeownerOutreachMessage,
    /adjuster appointment scheduled/
  );

  const documentFileResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/document-file`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739", documentQuery: "Carrier estimate.pdf" })
  });
  assert.equal(documentFileResponse.status, 200);
  const documentFile = await documentFileResponse.json();
  assert.equal(documentFile.file.id, chance.jnid);
  assert.equal(documentFile.document.id, "file-1");
  assert.equal(documentFile.openaiFileResponse.length, 1);
  assert.equal(documentFile.openaiFileResponse[0].name, "Carrier estimate.pdf");
  assert.equal(documentFile.openaiFileResponse[0].mime_type, "application/pdf");
  assert.deepEqual(Buffer.from(documentFile.openaiFileResponse[0].content, "base64"), fixturePdf);
  assert.match(documentFile.reviewInstruction, /actual file/i);

  const reliableDocumentReviewResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/document-review`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739", documentPurpose: "insurance_policy" })
  });
  assert.equal(reliableDocumentReviewResponse.status, 200);
  const reliableDocumentReview = await reliableDocumentReviewResponse.json();
  assert.equal(reliableDocumentReview.document.id, "file-policy");
  assert.equal(reliableDocumentReview.nativeReviewRequired, true);
  assert.equal(reliableDocumentReview.openaiFileResponse.length, 1);
  assert.equal(reliableDocumentReview.openaiFileResponse[0].name, "Fixture Homeowner Insurance.pdf");
  assert.deepEqual(Buffer.from(reliableDocumentReview.openaiFileResponse[0].content, "base64"), fixturePdf);
  assert.match(reliableDocumentReview.reviewInstruction, /every relevant page/i);

  const companyDocumentResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/document-file`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "Other Owner", documentQuery: "Other Owner - TDI.pdf" })
  });
  assert.equal(companyDocumentResponse.status, 200);
  const companyDocument = await companyDocumentResponse.json();
  assert.equal(companyDocument.file.id, other.jnid);
  assert.equal(companyDocument.readScope, "explicit_company_read");
  assert.equal(companyDocument.openaiFileResponse[0].name, "Other Owner - TDI.pdf");
  assert.deepEqual(Buffer.from(companyDocument.openaiFileResponse[0].content, "base64"), fixturePdf);

  const operatorCompanyDocumentResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/document-file`, {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-codex-operator-token-1234567890",
      "content-type": "application/json"
    },
    body: JSON.stringify({ query: "Other Owner", documentQuery: "Other Owner - TDI.pdf" })
  });
  assert.equal(operatorCompanyDocumentResponse.status, 400);
  assert.match((await operatorCompanyDocumentResponse.json()).error, /No Chance Pearson JobNimbus insurance file/i);

  const macCompanyDocumentResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/document-file`, {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-codex-mac-operator-token-1234567890",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      query: "Other Owner",
      documentQuery: "Other Owner - TDI.pdf",
      operatorScope: "company"
    })
  });
  assert.equal(macCompanyDocumentResponse.status, 200);
  const macCompanyDocument = await macCompanyDocumentResponse.json();
  assert.equal(macCompanyDocument.file.id, other.jnid);
  assert.equal(macCompanyDocument.readScope, "explicit_company_file");
  assert.equal(macCompanyDocument.openaiFileResponse[0].name, "Other Owner - TDI.pdf");

  const catalogDocumentResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/document-file`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "Hidden Owner", documentQuery: "Hidden Owner - TDI.pdf" })
  });
  assert.equal(catalogDocumentResponse.status, 200);
  const catalogDocument = await catalogDocumentResponse.json();
  assert.equal(catalogDocument.file.id, hidden.jnid);
  assert.equal(catalogDocument.readScope, "explicit_company_document_read");
  assert.equal(catalogDocument.openaiFileResponse[0].name, "Hidden Owne_r - TDI .pdf");

  const dolResearchResponse = await fetch(`http://127.0.0.1:${bridgePort}/weather/dol-research`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739", startDate: "2025-01-01", endDate: "2026-07-16" })
  });
  assert.equal(dolResearchResponse.status, 200);
  const dolResearch = await dolResearchResponse.json();
  assert.equal(dolResearch.file.id, chance.jnid);
  assert.equal(dolResearch.currentJobNimbusDateOfLoss, "2026-04-25");
  assert.equal(dolResearch.mode, "read_only_weather_research");
  assert.equal(dolResearch.recommendedCandidate.date, "2026-04-25");
  assert.match(dolResearch.instruction, /Never file a claim or update JobNimbus/i);

  const broadCompanyDocumentResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/document-file`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "Other", documentQuery: "Other Owner - TDI.pdf" })
  });
  assert.equal(broadCompanyDocumentResponse.status, 400);

  const updateDryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/process-update`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739", fields: { cf_date_1: "2026-04-27" }, execute: false })
  });
  assert.equal(updateDryRunResponse.status, 200);
  const updateDryRun = await updateDryRunResponse.json();
  assert.equal(updateDryRun.updates.contact.body.cf_date_1, 1777291200);

  const statusAliasDryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/process-update`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      fields: { cf_string_2: "0833375173" },
      status: "Submitted Awaiting Confirmation",
      note: "Claim filed. Awaiting adjuster assignment.",
      execute: false
    })
  });
  assert.equal(statusAliasDryRunResponse.status, 200);
  const statusAliasDryRun = await statusAliasDryRunResponse.json();
  assert.equal(statusAliasDryRun.requestedStatus, "Submitted Awaiting Confirmation");
  assert.equal(statusAliasDryRun.resolvedStatus, "Submitted (Awaiting Two Key Confirmations)");
  assert.equal(statusAliasDryRun.updates.contact.body.status_name, "Submitted (Awaiting Two Key Confirmations)");

  const invalidStatusDryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/process-update`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739", status: "Definitely Not A Real Workflow Stage", execute: false })
  });
  assert.equal(invalidStatusDryRunResponse.status, 400);
  const invalidStatusDryRun = await invalidStatusDryRunResponse.json();
  assert.match(invalidStatusDryRun.error, /approval dry run was blocked before execution/i);

  const calendarDryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/create-calendar-event`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      title: "Adjuster Meeting",
      dateStart: "2026-07-17T14:00:00-05:00",
      dateEnd: "2026-07-17T16:00:00-05:00",
      location: "100 Test St, Dallas, TX 75201",
      execute: false
    })
  });
  assert.equal(calendarDryRunResponse.status, 200);
  const calendarDryRun = await calendarDryRunResponse.json();
  assert.equal(calendarDryRun.plan.body.location, undefined);
  assert.deepEqual(calendarDryRun.plan.body.owners, [{ id: chanceOwnerId }]);
  assert.deepEqual(calendarDryRun.plan.schedule, {
    timeZone: "America/Chicago",
    start: "Jul 17, 2026, 2:00 PM CDT",
    end: "Jul 17, 2026, 4:00 PM CDT"
  });

  const uploadDryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/upload-file`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      filename: "Certified policy.pdf",
      description: "Certified carrier policy.",
      contentBase64: Buffer.from("fixture document").toString("base64"),
      execute: false
    })
  });
  assert.equal(uploadDryRunResponse.status, 200);
  const uploadDryRun = await uploadDryRunResponse.json();
  assert.equal(uploadDryRun.mode, "dry_run");
  assert.equal(uploadDryRun.file.id, chance.jnid);
  assert.equal(uploadDryRun.plan.filename, "Certified policy.pdf");
  assert.equal(uploadDryRun.plan.sizeBytes, 16);
  assert.deepEqual(uploadDryRun.plan.related, [chance.jnid]);

  const gmailDryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/gmail/send`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      to: "carrier@example.test",
      subject: "CLAIM-1",
      body: "Approved test body.",
      execute: false
    })
  });
  assert.equal(gmailDryRunResponse.status, 200);
  const gmailDryRun = await gmailDryRunResponse.json();
  assert.match(gmailDryRun.approvalDigest, /^[a-f0-9]{64}$/);

  const paymentTemplatePdf = Buffer.from("%PDF-1.4\n%%EOF").toString("base64");
  const paymentRedirectionDraftResponse = await fetch(`http://127.0.0.1:${bridgePort}/gmail/draft`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      to: "claims@example.test",
      subject: "CLAIM-PAYMENT-TEMPLATE",
      body: "Generic wording that must not survive.",
      attachments: [
        { source: "base64", filename: "Fixture_LOR.pdf", contentType: "application/pdf", contentBase64: paymentTemplatePdf },
        { source: "base64", filename: "Fixture_TDI.pdf", contentType: "application/pdf", contentBase64: paymentTemplatePdf },
        { source: "base64", filename: "Wave_W-9.pdf", contentType: "application/pdf", contentBase64: paymentTemplatePdf }
      ],
      execute: false
    })
  });
  assert.equal(paymentRedirectionDraftResponse.status, 200);
  const paymentRedirectionDraft = await paymentRedirectionDraftResponse.json();
  assert.equal(paymentRedirectionDraft.plan.bodyTemplate, "payment_redirection");
  assert.match(paymentRedirectionDraft.plan.body, /Please send payment to our office with Wave Public Adjusting LLC included as a payee\./);
  assert.doesNotMatch(paymentRedirectionDraft.plan.body, /Generic wording/);

  const generatedPackageResponse = await fetch(`http://127.0.0.1:${bridgePort}/gmail/draft`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      to: "claims@example.test",
      subject: "43-TEST-123",
      template: "payment_redirection",
      attachments: [
        { source: "generated_lor", insuredName: "Fixture Signed Name", claimNumber: "43-TEST-123" },
        { source: "jobnimbus", documentQuery: "Fixture Homeowner - TDI.pdf" },
        { source: "standard_w9" }
      ],
      execute: false
    })
  });
  assert.equal(generatedPackageResponse.status, 200);
  const generatedPackage = await generatedPackageResponse.json();
  assert.equal(generatedPackage.plan.bodyTemplate, "payment_redirection");
  assert.deepEqual(generatedPackage.plan.attachments.map((attachment) => attachment.source), ["generated_lor", "jobnimbus", "standard_w9"]);
  assert.match(generatedPackage.plan.attachments[0].filename, /^Fixture_Signed_Name_LOR_43_TEST_123\.pdf$/);
  assert.ok(generatedPackage.plan.attachments[0].bytes > 1000);
  assert.equal(generatedPackage.plan.attachments[0].sourceFile.number, 2739);
  assert.equal(generatedPackage.plan.attachments[0].sourceFile.name, "Fixture Homeowner");
  assert.equal(generatedPackage.plan.attachments[0].generatedFacts.insuredName, "Fixture Signed Name");
  assert.equal(generatedPackage.plan.attachments[0].generatedFacts.claimNumber, "43-TEST-123");
  assert.equal(generatedPackage.plan.attachments[1].filename, "Fixture Homeowner - TDI.pdf");
  assert.equal(generatedPackage.plan.attachments[1].sourceFile.number, 2739);
  assert.equal(generatedPackage.plan.attachments[2].filename, "Wave_W-9.pdf");
  assert.match(generatedPackage.plan.attachments[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(generatedPackage.plan.body, /policyholder: Fixture Signed Name/);

  const gmailUnapprovedResponse = await fetch(`http://127.0.0.1:${bridgePort}/gmail/send`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      to: "carrier@example.test",
      subject: "CLAIM-1",
      body: "Approved test body.",
      execute: true
    })
  });
  assert.equal(gmailUnapprovedResponse.status, 400);

  const gmailChangedResponse = await fetch(`http://127.0.0.1:${bridgePort}/gmail/send`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      to: "carrier@example.test",
      subject: "CLAIM-1",
      body: "Changed after approval.",
      approvalDigest: gmailDryRun.approvalDigest,
      execute: true
    })
  });
  assert.equal(gmailChangedResponse.status, 409);

  fixtureTdiMutationMode = true;
  fixtureTdiDownloadCount = 0;
  const changingDraftOperation = {
    type: "gmail.create_draft",
    payload: {
      query: "2739",
      to: "carrier@example.test",
      subject: "CHANGING-ATTACHMENT",
      body: "Approved Gmail draft body.",
      attachments: [{
        source: "jobnimbus",
        documentQuery: "Fixture Homeowner - TDI.pdf"
      }]
    }
  };
  const changingDraftBatchResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ operations: [changingDraftOperation], execute: false })
  });
  assert.equal(changingDraftBatchResponse.status, 200);
  const changingDraftBatch = await changingDraftBatchResponse.json();
  const executeChangingDraftResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      operations: [changingDraftOperation],
      execute: true,
      approvalDigest: changingDraftBatch.approvalDigest,
      approvalChallenge: changingDraftBatch.approvalChallenge
    })
  });
  assert.equal(executeChangingDraftResponse.status, 200);
  const executeChangingDraft = await executeChangingDraftResponse.json();
  assert.equal(executeChangingDraft.mode, "partial_failure");
  assert.match(executeChangingDraft.batch.error, /no longer matches the current plan/i);
  assert.equal(fixtureGmailDraftCreateCount, 0);
  fixtureTdiMutationMode = false;

  const retryChangingDraftPlanResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ operations: [changingDraftOperation], execute: false })
  });
  assert.equal(retryChangingDraftPlanResponse.status, 200);
  const retryChangingDraftPlan = await retryChangingDraftPlanResponse.json();
  assert.equal(retryChangingDraftPlan.approvalDigest, changingDraftBatch.approvalDigest);
  const retryChangingDraftExecuteResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      operations: [changingDraftOperation],
      execute: true,
      approvalDigest: retryChangingDraftPlan.approvalDigest,
      approvalChallenge: retryChangingDraftPlan.approvalChallenge
    })
  });
  assert.equal(retryChangingDraftExecuteResponse.status, 200);
  const retryChangingDraftExecute = await retryChangingDraftExecuteResponse.json();
  assert.equal(retryChangingDraftExecute.mode, "blocked_duplicate");
  assert.equal(retryChangingDraftExecute.batch.status, "partial_failure");
  assert.equal(fixtureGmailDraftCreateCount, 0);

  const createDraftOperation = {
    type: "gmail.create_draft",
    payload: {
      query: "2739",
      to: "carrier@example.test",
      subject: "DRAFT-CLAIM",
      body: "Approved Gmail draft body."
    }
  };
  const createDraftBatchResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ operations: [createDraftOperation], execute: false })
  });
  assert.equal(createDraftBatchResponse.status, 200);
  const createDraftBatch = await createDraftBatchResponse.json();
  const executeCreateDraftResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      operations: [createDraftOperation],
      execute: true,
      approvalDigest: createDraftBatch.approvalDigest,
      approvalChallenge: createDraftBatch.approvalChallenge
    })
  });
  assert.equal(executeCreateDraftResponse.status, 200);
  assert.equal(fixtureGmailDraftCreateCount, 1);

  const operatorDraftHeaders = {
    authorization: "Bearer fixture-codex-operator-token-1234567890",
    "content-type": "application/json"
  };
  const operatorDraftSendOperation = {
    type: "gmail.send",
    payload: { query: "2739", draftId: "draft-1" }
  };
  fixtureGmailDraftInlineAttachment = true;
  const inlineAttachmentDraftResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: operatorDraftHeaders,
    body: JSON.stringify({ operations: [operatorDraftSendOperation], execute: false })
  });
  assert.equal(inlineAttachmentDraftResponse.status, 200);
  const inlineAttachmentDraft = await inlineAttachmentDraftResponse.json();
  const inlineAttachmentPlan = inlineAttachmentDraft.operations[0].plan.plan;
  assert.equal(inlineAttachmentPlan.attachments[0].filename, "small-inline.pdf");
  assert.equal(inlineAttachmentPlan.attachments[0].bytes, fixturePdf.length);
  assert.match(inlineAttachmentPlan.attachments[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(inlineAttachmentPlan.bodyRepresentations[0].content, "Approved Gmail draft body.");
  fixtureGmailDraftInlineAttachment = false;

  fixtureGmailDraftAlternateBody = true;
  const alternateBodyDraftResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: operatorDraftHeaders,
    body: JSON.stringify({ operations: [operatorDraftSendOperation], execute: false })
  });
  assert.equal(alternateBodyDraftResponse.status, 400);
  assert.match((await alternateBodyDraftResponse.json()).error, /exactly one UTF-8 text\/plain body/i);
  fixtureGmailDraftAlternateBody = false;

  fixtureGmailDraftDuplicateTo = true;
  const duplicateHeaderDraftResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: operatorDraftHeaders,
    body: JSON.stringify({
      operations: [{
        type: "gmail.send",
        payload: { query: "2739", draftId: "draft-1" }
      }],
      execute: false
    })
  });
  assert.equal(duplicateHeaderDraftResponse.status, 400);
  assert.match((await duplicateHeaderDraftResponse.json()).error, /duplicate delivery header: to/i);
  fixtureGmailDraftDuplicateTo = false;

  const duplicateDraftResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ operations: [createDraftOperation], execute: false })
  });
  assert.equal(duplicateDraftResponse.status, 200);
  const duplicateDraft = await duplicateDraftResponse.json();
  assert.equal(duplicateDraft.operations[0].plan.mode, "dry_run");
  assert.equal(duplicateDraft.operations[0].plan.draft, undefined);
  assert.equal(fixtureGmailDraftCreateCount, 1);

  const rebuiltSendResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      operations: [{
        type: "gmail.send",
        payload: {
          query: "2739",
          to: "carrier@example.test",
          subject: "DRAFT-CLAIM",
          body: "Approved Gmail draft body."
        }
      }],
      execute: false
    })
  });
  assert.equal(rebuiltSendResponse.status, 200);
  const rebuiltSend = await rebuiltSendResponse.json();
  assert.equal(rebuiltSend.operations[0].plan.mode, "dry_run");
  assert.match(
    rebuiltSend.operations[0].plan.approvalDigest,
    /^[a-f0-9]{64}$/
  );

  const sendDraftOperation = { type: "gmail.send", payload: { query: "2739", draftId: "draft-1" } };
  const sendDraftBatchResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: operatorDraftHeaders,
    body: JSON.stringify({ operations: [sendDraftOperation], execute: false })
  });
  assert.equal(sendDraftBatchResponse.status, 200);
  const sendDraftBatch = await sendDraftBatchResponse.json();
  assert.equal(sendDraftBatch.operations[0].plan.plan.action, "send_existing_draft");
  assert.equal(sendDraftBatch.operations[0].plan.plan.draftId, "draft-1");
  assert.equal(sendDraftBatch.operations[0].plan.plan.deliveryHeaders.to, "carrier@example.test");
  assert.equal(sendDraftBatch.operations[0].plan.plan.deliveryHeaders.subject, "DRAFT-CLAIM");
  assert.equal(sendDraftBatch.operations[0].plan.plan.fileScope.id, chance.jnid);
  assert.equal(sendDraftBatch.operations[0].plan.plan.fileScope.number, 2739);
  assert.match(sendDraftBatch.operations[0].plan.approvalDigest, /^[a-f0-9]{64}$/);

  const executeSendDraftResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: operatorDraftHeaders,
    body: JSON.stringify({
      operations: [sendDraftOperation],
      execute: true,
      approvalDigest: sendDraftBatch.approvalDigest,
      approvalChallenge: sendDraftBatch.approvalChallenge
    })
  });
  assert.equal(executeSendDraftResponse.status, 200);
  const executeSendDraft = await executeSendDraftResponse.json();
  assert.equal(executeSendDraft.mode, "executed");
  assert.equal(fixtureGmailDraftSendCount, 1);
  assert.equal(fixtureGmailDraftExists, true);
  assert.equal(
    executeSendDraft.batch.completed[0].receipt.sourceDraftRetention,
    "retained_for_separate_cleanup"
  );
  assert.equal(executeSendDraft.batch.completed[0].receipt.sourceDraftId, "draft-1");
  assert.equal(executeSendDraft.batch.completed[0].receipt.fileId, chance.jnid);
  assert.equal(executeSendDraft.batch.completed[0].receipt.fileNumber, 2739);

  const reusedSourceDraftResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: operatorDraftHeaders,
    body: JSON.stringify({ operations: [sendDraftOperation], execute: false })
  });
  assert.equal(reusedSourceDraftResponse.status, 409);
  assert.match(await reusedSourceDraftResponse.text(), /source was already used.*new source draft/i);
  assert.equal(fixtureGmailDraftSendCount, 1);

  const quoDryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/quo/send`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739", content: "Approved homeowner text.", execute: false })
  });
  assert.equal(quoDryRunResponse.status, 200);
  const quoDryRun = await quoDryRunResponse.json();
  assert.equal(quoDryRun.plan.from, "+19725550100");
  assert.match(quoDryRun.approvalDigest, /^[a-f0-9]{64}$/);

  const quoTextAliasDryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/quo/send`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739", text: "Approved adjuster text.", execute: false })
  });
  assert.equal(quoTextAliasDryRunResponse.status, 200);
  const quoTextAliasDryRun = await quoTextAliasDryRunResponse.json();
  assert.equal(quoTextAliasDryRun.plan.content, "Approved adjuster text.");
  assert.match(quoTextAliasDryRun.approvalDigest, /^[a-f0-9]{64}$/);

  const quoUnapprovedResponse = await fetch(`http://127.0.0.1:${bridgePort}/quo/send`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739", content: "Approved homeowner text.", execute: true })
  });
  assert.equal(quoUnapprovedResponse.status, 400);

  const quoChangedResponse = await fetch(`http://127.0.0.1:${bridgePort}/quo/send`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      content: "Changed homeowner text.",
      approvalDigest: quoDryRun.approvalDigest,
      execute: true
    })
  });
  assert.equal(quoChangedResponse.status, 409);

  const quoExecutedResponse = await fetch(`http://127.0.0.1:${bridgePort}/quo/send`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      content: "Approved homeowner text.",
      approvalDigest: quoDryRun.approvalDigest,
      execute: true
    })
  });
  assert.equal(quoExecutedResponse.status, 200);
  const quoExecuted = await quoExecutedResponse.json();
  assert.equal(quoExecuted.delivery.status, "queued");
  assert.equal(quoExecuted.delivery.confirmed, false);
  assert.equal(quoExecuted.delivery.failed, false);
  assert.match(quoExecuted.delivery.instruction, /not confirmed/i);
  assert.equal(quoExecuted.memoryCloseout.systemId, "hcn_operations");
  assert.equal(quoExecuted.memoryCloseout.recorded, false);

  const fileReferencesResponse = await fetch(`http://127.0.0.1:${bridgePort}/memory/file-actions`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739" })
  });
  assert.equal(fileReferencesResponse.status, 404);

  const batchPayload = {
    operations: [{
      type: "jobnimbus.create_note",
      payload: { query: "2739", note: "Approved fixture note." }
    }],
    execute: false
  };
  const firstBatchResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify(batchPayload)
  });
  assert.equal(firstBatchResponse.status, 200);
  const firstBatch = await firstBatchResponse.json();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const secondBatchResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      ...batchPayload,
      operations: [{
        ...batchPayload.operations[0],
        payload: { ...batchPayload.operations[0].payload, nonce: "ignored-payload-key" }
      }]
    })
  });
  assert.equal(secondBatchResponse.status, 200);
  const secondBatch = await secondBatchResponse.json();
  assert.equal(secondBatch.approvalDigest, firstBatch.approvalDigest);
  assert.notEqual(secondBatch.approvalChallenge, firstBatch.approvalChallenge);

  const claimMilestoneBatchResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      operations: [
        {
          type: "jobnimbus.process_update",
          payload: {
            query: "2739",
            fields: { cf_string_2: "0833375173" },
            status: "Submitted Awaiting Confirmation",
            note: "Claim filed. Awaiting adjuster assignment."
          }
        },
        {
          type: "gmail.create_draft",
          payload: {
            to: "carrier@example.test",
            subject: "0833375173",
            body: "Approved representation package body."
          }
        }
      ],
      execute: false
    })
  });
  assert.equal(claimMilestoneBatchResponse.status, 200);
  const claimMilestoneBatch = await claimMilestoneBatchResponse.json();
  assert.equal(claimMilestoneBatch.mode, "dry_run");
  assert.equal(
    claimMilestoneBatch.operations[0].plan.resolvedStatus,
    "Submitted (Awaiting Two Key Confirmations)"
  );
  assert.match(claimMilestoneBatch.approvalDigest, /^[a-f0-9]{64}$/);

  const taskAndNoteBatchResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      operations: [
        {
          type: "jobnimbus.update_task",
          payload: { taskId: "task-1", completed: true }
        },
        {
          type: "jobnimbus.create_note",
          payload: { query: "2739", note: "Approved inspection milestone." }
        }
      ],
      execute: false
    })
  });
  assert.equal(taskAndNoteBatchResponse.status, 200);
  const taskAndNoteBatch = await taskAndNoteBatchResponse.json();
  assert.equal(taskAndNoteBatch.mode, "dry_run");
  assert.equal(taskAndNoteBatch.operationCount, 2);
  assert.equal(taskAndNoteBatch.operations[0].plan.plan.body.is_completed, true);
  assert.equal(taskAndNoteBatch.operations[1].plan.plan.body.note, "Approved inspection milestone.");

  const taskAndNoteExecuteResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      operations: [
        {
          type: "jobnimbus.update_task",
          payload: { taskId: "task-1", completed: true }
        },
        {
          type: "jobnimbus.create_note",
          payload: { query: "2739", note: "Approved inspection milestone." }
        }
      ],
      approvalDigest: taskAndNoteBatch.approvalDigest,
      approvalChallenge: taskAndNoteBatch.approvalChallenge,
      execute: true
    })
  });
  assert.equal(taskAndNoteExecuteResponse.status, 200);
  const taskAndNoteExecute = await taskAndNoteExecuteResponse.json();
  assert.equal(taskAndNoteExecute.mode, "executed");
  assert.equal(taskAndNoteExecute.batch.completed.length, 2);
  assert.equal(fixtureTaskCompleted, true);
  assert.equal(fixtureNoteCreated, true);
  assert.equal(
    taskAndNoteExecute.batch.completed.some((item) => item.receipt?.clientSnapshotRefreshed === true),
    false
  );
  assert.equal(
    taskAndNoteExecute.batch.completed.every(
      (item) => !item.receipt?.memoryReceiptId
    ),
    true
  );

  const timezoneFreeResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/create-calendar-event`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({
      query: "2739",
      title: "Bad timezone-free meeting",
      dateStart: "2026-07-17T14:00:00",
      dateEnd: "2026-07-17T16:00:00",
      execute: false
    })
  });
  assert.equal(timezoneFreeResponse.status, 400);
  const timezoneFree = await timezoneFreeResponse.json();
  assert.match(timezoneFree.error, /explicit offset/);

  const rejectedResponse = await fetch(`http://127.0.0.1:${bridgePort}/claim-filing/prepare`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "9999" })
  });
  assert.equal(rejectedResponse.status, 400);
  const rejected = await rejectedResponse.json();
  assert.match(rejected.error, /No Chance Pearson/);
});

async function seedAcceptedEmployeeInvitation({
  root,
  key,
  email,
  displayName,
  role,
  jobNimbusOwnerId,
  googleSubject
}) {
  const timestamp = Date.now();
  const store = createHcnInvitationStore({
    filePath: path.join(
      root,
      "platform",
      "employee-invitations.enc.json"
    ),
    key,
    allowedDomain: "",
    now: () => timestamp
  });
  const invitation = await store.createInvitation({
    email,
    displayName,
    role,
    jobNimbusOwnerId,
    jobNimbusScope: "assigned",
    invitedByRef: `principal_${"a".repeat(64)}`,
    expiresAt: new Date(
      timestamp + 72 * 60 * 60_000
    ).toISOString()
  });
  await store.acceptInvitation({
    invitationRef: invitation.invitationRef,
    email,
    googleSubject,
    inviteToken: invitation.inviteToken
  });
}

async function expectBridgeStartupFailure(environment, pattern) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      RENDER: "",
      HCN_CONSOLE_ENABLED: "false",
      ...environment
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  let timeout;
  try {
    const result = await Promise.race([
      once(child, "close"),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("Invalid bridge configuration did not fail startup"));
        }, 3_000);
      })
    ]);
    assert.notEqual(result[0], 0);
    assert.match(output, pattern);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

async function waitForServer(child, port) {
  let output = "";
  const capture = (chunk) => {
    const text = chunk.toString("utf8");
    output += text;
    if (process.env.DEBUG_SERVER_SMOKE === "1") process.stderr.write(text);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited before smoke test: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for server: ${output}`);
}
