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

  const schemaResponse = await fetch(`http://127.0.0.1:${port}/openapi.json`);
  assert.equal(schemaResponse.status, 200);
  const schema = await schemaResponse.json();
  assert.equal(schema.paths["/claim-filing/prepare"].post.operationId, "prepareClaimFilingCall");
  assert.equal(schema.paths["/claim-filing/call"].post.operationId, "placeApprovedClaimFilingCall");
  assert.equal(schema.paths["/claim-filing/result"].post.operationId, "reviewClaimFilingCallResult");
  assert.equal(schema.paths["/claim-filing/callbacks"].post.operationId, "listPendingClaimCallbacks");
  assert.equal(schema.paths["/claim-filing/writeback"].post.operationId, "processApprovedClaimFilingWriteback");

  const protectedResponse = await fetch(`http://127.0.0.1:${port}/claim-filing/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "2739" })
  });
  assert.equal(protectedResponse.status, 401);
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
  const fakeApi = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${fakeApiPort}`);
    let body = {};
    if (url.pathname === "/contacts") body = { contacts: [chance, other] };
    else if (url.pathname === "/contacts/contact-chance") body = chance;
    else if (url.pathname === "/contacts/contact-other") body = other;
    else if (url.pathname === "/activities") body = { activities: [{ jnid: "activity-1", primary: { id: chance.jnid }, note: "Exterior hail damage documented." }] };
    else if (url.pathname === "/tasks") body = { tasks: [{ jnid: "task-1", primary: { id: chance.jnid }, title: "File claim" }] };
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
      JOBNIMBUS_API_KEY: "fixture-key",
      JOBNIMBUS_BRIDGE_TOKEN: "fixture-token",
      RETELL_AGENT_ID: "fixture-agent",
      RETELL_FROM_NUMBER: "+12145550100",
      RETELL_API_KEY: "fixture-retell-key",
      ALLOW_RETELL_CALLS: "false",
      BRIDGE_ALLOW_WRITES: "false"
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
