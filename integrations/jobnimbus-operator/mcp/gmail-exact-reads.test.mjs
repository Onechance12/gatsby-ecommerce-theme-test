import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerExactGmailReads } from "./gmail-exact-reads.mjs";

// Real SDK tool-schema/protocol wiring with synthetic bridge responses only.
// No installed entrypoint, network, Keychain or native app-host is exercised.
async function harness(t, rejectedReviewEnabled = false) {
  const server = new McpServer({ name: "synthetic-gmail-audit", version: "0.0.0" });
  const client = new Client({ name: "synthetic-audit-client", version: "0.0.0" });
  const requests = [];
  const inspections = [];
  registerExactGmailReads((name, description, inputSchema, handler) => {
    server.registerTool(name, { description, inputSchema }, async input => ({
      content: [{ type: "text", text: JSON.stringify(await handler(input)) }]
    }));
  }, async (method, route, body) => {
    requests.push({ method, route, body });
    return { synthetic: true, correlationAudit: { readOnly: true, changesAdmission: false } };
  }, { rejectedReviewEnabled, reviewRejectedMessage: async input => {
    inspections.push(input);
    return { synthetic: true, readOnly: true, verifiedFileEvidence: false, authorizesAction: false };
  } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, requests, inspections };
}

test("native Gmail read registration exposes and forwards the opt-in audit through MCP", async t => {
  const { client, requests } = await harness(t);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name), ["gmail_search_exact_file", "gmail_read_thread_exact_file"]);
  for (const tool of tools) assert.equal(tool.inputSchema.properties.includeCorrelationAudit.type, "boolean");
  const search = { fileQuery: "#2739", completeReview: true, includeCorrelationAudit: true,
    communicationDays: 365, limit: 25 };
  const thread = { fileQuery: "#2739", threadId: "synthetic-thread", completeReview: true, includeCorrelationAudit: true };
  for (const [name, input] of [[tools[0].name, search], [tools[1].name, thread]]) {
    const result = await client.callTool({ name, arguments: input });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(JSON.parse(result.content[0].text).correlationAudit.changesAdmission, false);
  }
  assert.deepEqual(requests, [
    { method: "POST", route: "/gmail/search", body: search },
    { method: "POST", route: "/gmail/thread", body: thread }
  ]);
});

test("activated native reads automatically request the rejected list and expose only a reference-bound inspector", async t => {
  const { client, requests, inspections } = await harness(t, true);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name), ["gmail_search_exact_file", "gmail_read_thread_exact_file", "gmail_review_rejected_message"]);
  const result = await client.callTool({ name: "gmail_search_exact_file", arguments: { fileQuery: "#990001", completeReview: true } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(requests[0].body, { fileQuery: "#990001", completeReview: true, includeRejectedReview: true });
  const input = { fileQuery: "#990001", reviewRef: "synthetic.reference" };
  assert.notEqual((await client.callTool({ name: "gmail_review_rejected_message", arguments: input })).isError, true);
  assert.deepEqual(inspections, [input]);
  for (const patch of [{ messageId: "arbitrary" }, { mailbox: "other@example.test" }, { execute: true }, { operatorScope: "company" }]) {
    assert.equal((await client.callTool({ name: "gmail_review_rejected_message", arguments: { ...input, ...patch } })).isError, true);
  }
  assert.equal(inspections.length, 1);
  assert.equal(requests.length, 1);
});

test("inactive native release cannot opt into rich rejected reads", async t => {
  const { client, requests } = await harness(t);
  const result = await client.callTool({ name: "gmail_search_exact_file", arguments: { fileQuery: "#990001", completeReview: true, includeRejectedReview: true } });
  assert.equal(result.isError, true);
  assert.equal(requests.length, 0);
});

test("native Gmail audit schema rejects bypass inputs before any synthetic bridge request", async t => {
  const { client, requests } = await harness(t);
  for (const input of [
    { fileQuery: "#2739", includeCorrelationAudit: true },
    { fileQuery: "#2739", completeReview: true, includeCorrelationAudit: "true" },
    { fileQuery: "#2739", completeReview: true, includeCorrelationAudit: true, operatorScope: "company" },
    { fileQuery: "#2739", query: "arbitrary mailbox query" },
    { fileQuery: "#2739", completeReview: true, includeCorrelationAudit: true, execute: true }
  ]) {
    const result = await client.callTool({ name: "gmail_search_exact_file", arguments: input });
    assert.equal(result.isError, true);
  }
  assert.equal(requests.length, 0);
  const result = await client.callTool({ name: "gmail_search_exact_file", arguments: { fileQuery: "#2739" } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(requests[0].body, { fileQuery: "#2739" });
});
