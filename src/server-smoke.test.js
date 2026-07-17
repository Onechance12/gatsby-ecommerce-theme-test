import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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
      BRIDGE_ALLOW_WRITES: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, port);

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
  assert.equal(health.brain.mode, "verified_company_context_with_live_client_snapshots_and_action_receipts");
  assert.equal(health.brain.clientSnapshots, true);
  assert.equal(health.brain.automaticRefreshOnReview, true);
  assert.equal(health.brain.doesNotAuthorizeActions, true);
  assert.equal(health.brain.autonomousLearning, false);
  assert.equal(health.brain.externalActions, false);
  assert.equal(health.outboundSafety.automaticEmailOrTextSending, false);
  assert.equal(health.outboundSafety.explicitChanceApprovalRequired, true);
  assert.equal(health.chatgptDocumentReturn.nativeConversationFile, true);
  assert.equal(health.chatgptDocumentReturn.readOnly, true);
  assert.equal(health.dateOfLossResearch.mode, "read_only_candidate_research");
  assert.equal(health.dateOfLossResearch.automaticJobNimbusUpdate, false);
  assert.equal(health.voice.streamPath, "/voice/twilio-stream");
  assert.equal(health.voice.streamUrl, undefined);

  const schemaResponse = await fetch(`http://127.0.0.1:${port}/openapi.json`);
  assert.equal(schemaResponse.status, 200);
  const schema = await schemaResponse.json();
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
  assert.equal(schema.paths["/retell/homeowner-call"].post.operationId, "placeApprovedHomeownerAppointmentCall");
  assert.equal(schema.paths["/retell/homeowner-call-result"].post.operationId, "reviewHomeownerAppointmentCall");
  assert.equal(schema.paths["/brain/context"].post.operationId, "readWaveJobNimbusBrain");
  assert.equal(schema.paths["/ops/review-chance-files"].post.operationId, "reviewChanceFilesForApproval");
  assert.equal(schema.paths["/ops/action-batch"].post.operationId, "processApprovedWaveActionBatch");
  assert.equal(schema.paths["/quo/send"].post.operationId, "sendApprovedQuoText");
  assert.equal(schema.paths["/quo/send"].post["x-openai-isConsequential"], true);
  assert.equal(schema.paths["/gmail/send"].post["x-openai-isConsequential"], true);
  assert.equal(schema.paths["/ops/action-batch"].post["x-openai-isConsequential"], true);
  assert.equal(schema.paths["/gmail/attachment-review"].post.operationId, "reviewGmailAttachment");
  assert.equal(schema.paths["/jobnimbus/document-file"].post.operationId, "attachJobNimbusDocumentToChat");
  assert.equal(schema.paths["/jobnimbus/upload-file"].post.operationId, "uploadJobNimbusFile");
  assert.equal(schema.paths["/weather/dol-research"].post.operationId, "researchPropertyHailDates");

  const chatgptSchemaResponse = await fetch(`http://127.0.0.1:${port}/openapi-chatgpt.json`);
  assert.equal(chatgptSchemaResponse.status, 200);
  const chatgptSchema = await chatgptSchemaResponse.json();
  assert.equal(Object.values(chatgptSchema.paths).flatMap((path) => Object.values(path)).length, 23);
  assert.equal(chatgptSchema.paths["/memory/file-actions"].post.operationId, "readChanceFileActionReceipts");
  assert.equal(chatgptSchema.paths["/retell/configure-agent"].post.operationId, "configureApprovedRetellAgent");
  assert.equal(chatgptSchema.paths["/ops/review-chance-files"].post.operationId, "reviewChanceFilesForApproval");
  assert.equal(chatgptSchema.paths["/ops/action-batch"].post["x-openai-isConsequential"], true);
  assert.equal(chatgptSchema.paths["/claim-filing/prepare"].post.operationId, "prepareClaimFilingCall");
  assert.equal(chatgptSchema.paths["/jobnimbus/document-file"].post.operationId, "attachJobNimbusDocumentToChat");
  assert.equal(chatgptSchema.paths["/weather/dol-research"].post.operationId, "researchPropertyHailDates");
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

  const protectedBrainResponse = await fetch(`http://127.0.0.1:${port}/brain/context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(protectedBrainResponse.status, 401);
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
      res.end(JSON.stringify({
        id: "draft-1",
        message: {
          id: "draft-message-1",
          threadId: "draft-thread-1",
          snippet: "Approved Gmail draft body.",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "To", value: "carrier@example.test" },
              { name: "Subject", value: "DRAFT-CLAIM" }
            ],
            body: { data: Buffer.from("Approved Gmail draft body.").toString("base64url") }
          }
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
    if (url.pathname === "/gmail/v1/users/me/drafts/send" && req.method === "POST") {
      if (!fixtureGmailDraftExists) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Draft not found" } }));
        return;
      }
      fixtureGmailDraftExists = false;
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
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(fixturePdf);
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
      PORT: String(bridgePort),
      JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${fakeApiPort}`,
      JOBNIMBUS_FILE_BASE_URL: `http://127.0.0.1:${fakeApiPort}/file-content`,
      JOBNIMBUS_API_KEY: "fixture-key",
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-token",
      CENSUS_GEOCODER_URL: `http://127.0.0.1:${fakeApiPort}/geocoder`,
      HAIL_REPORTS_URL: `http://127.0.0.1:${fakeApiPort}/lsr`,
      RETELL_AGENT_ID: "fixture-agent",
      RETELL_FROM_NUMBER: "+12145550100",
      RETELL_API_KEY: "fixture-retell-key",
      ALLOW_RETELL_CALLS: "false",
      ALLOW_CLIENT_COORDINATOR_CALLS: "false",
      BRIDGE_ALLOW_WRITES: "true",
      MEMORY_ROOT: memoryRoot,
      ALLOW_GMAIL_SEND: "true",
      GOOGLE_CLIENT_ID: "fixture-google-client",
      GOOGLE_CLIENT_SECRET: "fixture-google-secret",
      GOOGLE_REFRESH_TOKEN: "fixture-google-refresh",
      STANDARD_W9_GMAIL_MESSAGE_ID: "gmail-w9-message",
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
  assert.equal(brainResponse.status, 200);
  const brain = await brainResponse.json();
  assert.equal(brain.scope, "company_only");
  assert.equal(brain.execution, "none");
  assert.match(brain.context, /Memory, snapshots, receipts, and proposals never authorize or execute external actions/);
  assert.match(brain.context, /UNVERIFIED CANDIDATES/);

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
  assert.equal(chanceIndex.brain.scope, "company_only");
  assert.equal(chanceIndex.brain.execution, "none");

  const exactChanceReviewResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/review-chance-files`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739", limit: 1, includeGmail: false, includeQuo: false })
  });
  assert.equal(exactChanceReviewResponse.status, 200);
  const exactChanceReview = await exactChanceReviewResponse.json();
  assert.equal(exactChanceReview.packets[0].clientMemory.snapshot.subjectKey, chance.jnid);
  assert.equal(exactChanceReview.packets[0].clientMemory.snapshot.authority.doesNotAuthorizeActions, true);
  assert.equal(exactChanceReview.packets[0].clientMemory.snapshot.jobNimbus.operationalDocuments.length, 3);
  assert.equal(exactChanceReview.packets[0].clientMemory.snapshot.jobNimbus.excludedPhotoLikeDocumentCount, 121);
  assert.equal(exactChanceReview.brain.scope, "company_and_exact_file");
  assert.match(exactChanceReview.brain.context, /CURRENT CLIENT SNAPSHOT/);
  assert.match(exactChanceReview.brain.context, /continuity, not authority/i);

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
  assert.equal(generatedPackage.plan.attachments[1].filename, "Fixture Homeowner - TDI.pdf");
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
    body: JSON.stringify({ operations: [createDraftOperation], execute: true, approvalDigest: createDraftBatch.approvalDigest })
  });
  assert.equal(executeCreateDraftResponse.status, 200);
  assert.equal(fixtureGmailDraftCreateCount, 1);

  const duplicateDraftResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ operations: [createDraftOperation], execute: false })
  });
  assert.equal(duplicateDraftResponse.status, 200);
  const duplicateDraft = await duplicateDraftResponse.json();
  assert.equal(duplicateDraft.operations[0].plan.mode, "existing_draft");
  assert.equal(duplicateDraft.operations[0].plan.draft.id, "draft-1");
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
  assert.equal(rebuiltSendResponse.status, 400);
  assert.match(await rebuiltSendResponse.text(), /send the reviewed draft.*draftId/i);

  const sendDraftOperation = { type: "gmail.send", payload: { query: "2739", draftId: "draft-1" } };
  const sendDraftBatchResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ operations: [sendDraftOperation], execute: false })
  });
  assert.equal(sendDraftBatchResponse.status, 200);
  const sendDraftBatch = await sendDraftBatchResponse.json();
  assert.equal(sendDraftBatch.operations[0].plan.plan.action, "send_existing_draft");
  assert.equal(sendDraftBatch.operations[0].plan.plan.draftId, "draft-1");
  assert.match(sendDraftBatch.operations[0].plan.approvalDigest, /^[a-f0-9]{64}$/);

  const executeSendDraftResponse = await fetch(`http://127.0.0.1:${bridgePort}/ops/action-batch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ operations: [sendDraftOperation], execute: true, approvalDigest: sendDraftBatch.approvalDigest })
  });
  assert.equal(executeSendDraftResponse.status, 200);
  const executeSendDraft = await executeSendDraftResponse.json();
  assert.equal(executeSendDraft.mode, "executed");
  assert.equal(fixtureGmailDraftSendCount, 1);
  assert.equal(fixtureGmailDraftExists, false);

  const quoDryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/quo/send`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739", content: "Approved homeowner text.", execute: false })
  });
  assert.equal(quoDryRunResponse.status, 200);
  const quoDryRun = await quoDryRunResponse.json();
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

  const fileReferencesResponse = await fetch(`http://127.0.0.1:${bridgePort}/memory/file-actions`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739" })
  });
  assert.equal(fileReferencesResponse.status, 200);
  const fileReferences = await fileReferencesResponse.json();
  assert.equal(fileReferences.subjectKey, chance.jnid);
  assert.equal(fileReferences.references.some((row) => row.source === "quo" && row.id === "AC-fixture-message"), true);
  assert.equal(fileReferences.clientMemory.snapshot.recentActionReceipts.some((row) => row.externalId === "AC-fixture-message"), true);
  assert.equal(fileReferences.clientMemory.snapshot.authority.doesNotAuthorizeActions, true);

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
    body: JSON.stringify(batchPayload)
  });
  assert.equal(secondBatchResponse.status, 200);
  const secondBatch = await secondBatchResponse.json();
  assert.equal(secondBatch.approvalDigest, firstBatch.approvalDigest);

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

async function waitForServer(child, port) {
  let output = "";
  const capture = (chunk) => { output += chunk.toString("utf8"); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  for (let attempt = 0; attempt < 50; attempt += 1) {
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
