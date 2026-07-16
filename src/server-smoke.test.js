import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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
  assert.equal(health.brain.mode, "verified_company_context_with_private_action_receipts");
  assert.equal(health.brain.autonomousLearning, false);
  assert.equal(health.brain.externalActions, false);
  assert.equal(health.outboundSafety.automaticEmailOrTextSending, false);
  assert.equal(health.outboundSafety.explicitChanceApprovalRequired, true);
  assert.equal(health.chatgptDocumentReturn.nativeConversationFile, true);
  assert.equal(health.chatgptDocumentReturn.readOnly, true);
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

  const chatgptSchemaResponse = await fetch(`http://127.0.0.1:${port}/openapi-chatgpt.json`);
  assert.equal(chatgptSchemaResponse.status, 200);
  const chatgptSchema = await chatgptSchemaResponse.json();
  assert.equal(Object.values(chatgptSchema.paths).flatMap((path) => Object.values(path)).length, 20);
  assert.equal(chatgptSchema.paths["/ops/review-chance-files"].post.operationId, "reviewChanceFilesForApproval");
  assert.equal(chatgptSchema.paths["/ops/action-batch"].post["x-openai-isConsequential"], true);
  assert.equal(chatgptSchema.paths["/claim-filing/prepare"].post.operationId, "prepareClaimFilingCall");
  assert.equal(chatgptSchema.paths["/jobnimbus/document-file"].post.operationId, "attachJobNimbusDocumentToChat");
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

test("prepare route reads fresh evidence and enforces Chance ownership", async (t) => {
  const bridgePort = 18880;
  const fakeApiPort = 18881;
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
    display_name: "Other Owner",
    owners: [{ id: "someone-else" }]
  };
  const fixturePdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "ascii");
  let fixtureTaskCompleted = false;
  let fixtureNoteCreated = false;
  const fakeApi = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${fakeApiPort}`);
    if (url.pathname === "/file-content/file-1") {
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
    else if (url.pathname === "/activities") body = { activities: [{ jnid: "activity-1", primary: { id: chance.jnid }, note: "Exterior hail damage documented." }] };
    else if (url.pathname === "/tasks") body = { tasks: [{ jnid: "task-1", primary: { id: chance.jnid }, title: "File claim", is_completed: fixtureTaskCompleted }] };
    else if (url.pathname === "/files") body = { files: [
      { jnid: "file-1", primary: { id: chance.jnid }, filename: "Carrier estimate.pdf", content_type: "application/pdf" },
      { jnid: "file-2", primary: { id: chance.jnid }, filename: "roof-photo.jpg", content_type: "image/jpeg" }
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
      RETELL_AGENT_ID: "fixture-agent",
      RETELL_FROM_NUMBER: "+12145550100",
      RETELL_API_KEY: "fixture-retell-key",
      ALLOW_RETELL_CALLS: "false",
      ALLOW_CLIENT_COORDINATOR_CALLS: "false",
      BRIDGE_ALLOW_WRITES: "true",
      ALLOW_GMAIL_SEND: "true",
      QUO_API_KEY: "fixture-quo-key",
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
  assert.equal(prepared.evidence.documentsReviewed, 1);
  assert.equal(prepared.evidence.photoFilesExcluded, 1);
  assert.equal(prepared.callPlan.to, "+18444584300");
  assert.match(prepared.planDigest, /^[a-f0-9]{64}$/);

  const brainResponse = await fetch(`http://127.0.0.1:${bridgePort}/brain/context`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ maxPerSection: 25 })
  });
  assert.equal(brainResponse.status, 200);
  const brain = await brainResponse.json();
  assert.equal(brain.scope, "company_only");
  assert.equal(brain.execution, "none");
  assert.match(brain.context, /Memory and proposals never authorize or execute external actions/);
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
  assert.equal(coordinatorDryRun.evidence.jobNimbus.operationalDocuments.length, 1);
  assert.equal(coordinatorDryRun.evidence.jobNimbus.excludedPhotoLikeDocumentCount, 1);
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

  const updateDryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/jobnimbus/process-update`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739", fields: { cf_date_1: "2026-04-27" }, execute: false })
  });
  assert.equal(updateDryRunResponse.status, 200);
  const updateDryRun = await updateDryRunResponse.json();
  assert.equal(updateDryRun.updates.contact.body.cf_date_1, 1777248000);

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

  const quoDryRunResponse = await fetch(`http://127.0.0.1:${bridgePort}/quo/send`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "2739", content: "Approved homeowner text.", execute: false })
  });
  assert.equal(quoDryRunResponse.status, 200);
  const quoDryRun = await quoDryRunResponse.json();
  assert.match(quoDryRun.approvalDigest, /^[a-f0-9]{64}$/);

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
