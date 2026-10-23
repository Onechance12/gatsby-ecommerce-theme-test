// INERT synthetic MCP server. Never import the installed Operator entrypoint.
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createEncryptedApprovalStore } from "../approval-store.mjs";

globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN_IN_SYNTHETIC_HARNESS"); };
const { harness, SEND_OPERATIONS, NOW } = await import(pathToFileURL(process.argv[2]));
let time = NOW;
const approvals = createEncryptedApprovalStore({ directory: process.argv[3],
  secret: "synthetic-credential-not-a-real-secret", namespace: "synthetic-mcp-harness-v1", now: () => time });
const h = harness({ approvals, now: () => time });
const server = new McpServer({ name: "synthetic-approval-harness", version: "1.0.0" });
const result = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
server.registerTool("synthetic_plan", { inputSchema: {} }, async () => {
  return result(await h.coordinator.planActionBatch(SEND_OPERATIONS));
});
server.registerTool("synthetic_execute", { inputSchema: {
  approvalDigest: z.string(), approvalId: z.string().uuid(),
  scenario: z.enum(["normal", "expired", "boot", "input", "preflight_unavailable", "unknown", "crash_after_request"]).default("normal")
} }, async ({ approvalDigest, approvalId, scenario }) => {
  if (scenario === "expired") time += 900001;
  if (scenario === "boot") h.state.policy.bridgeBootId = "synthetic-other-boot";
  if (scenario === "preflight_unavailable") h.state.whoami = () => {}; // structuredClone throws on synthetic GET
  if (scenario === "unknown") h.state.mutateExecutionResponse = () => { throw new Error("Synthetic response lost"); };
  if (scenario === "crash_after_request") h.state.mutateExecutionResponse = () => process.exit(76);
  const operations = structuredClone(SEND_OPERATIONS);
  if (scenario === "input") operations[0].payload.draftId = "synthetic-other-draft";
  try {
    const response = await h.coordinator.executeActionBatch(approvalDigest, operations, "assigned", approvalId);
    return result({ ok: true, mode: response.mode, effectPosts: h.requests.filter(r => r.body?.execute).length });
  } catch (error) {
    return result({ ok: false, reason: error.message, effectPosts: h.requests.filter(r => r.body?.execute).length });
  }
});
await server.connect(new StdioServerTransport());
