#!/usr/bin/env node

import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../lib/config.js";
import { ensureRuntimeDirs } from "../lib/paths.js";

const READ_TOOLS = ["search_files", "review_file", "claim_packet", "claim_call_prompt", "draft_message", "next_actions"];
const WRITE_ACTIONS = ["create_jobnimbus_note", "create_jobnimbus_task", "update_jobnimbus_contact"];
const MAX_BODY_BYTES = 256 * 1024;

const config = loadConfig();
ensureRuntimeDirs(config);

const server = http.createServer(async (request, response) => {
  try {
    await handle(request, response);
  } catch (error) {
    sendJson(response, 500, { error: config.redact(error.message || String(error)) });
  }
});

server.listen(config.bridge.port, () => {
  console.log("JobNimbus chat bridge");
  console.log(`- listening on port ${config.bridge.port}`);
  console.log(`- auth: ${config.bridge.token ? "bearer token required" : "OPEN (set JOBNIMBUS_BRIDGE_TOKEN before exposing publicly)"}`);
  console.log(`- writes: ${config.bridge.allowWrites && config.allowJobNimbusWrites ? "ENABLED" : "blocked (read-only)"}`);
});

async function handle(request, response) {
  const url = new URL(request.url, "http://localhost");

  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    sendJson(response, 200, { ok: true, service: "jobnimbus-chat-bridge", readOnly: !(config.bridge.allowWrites && config.allowJobNimbusWrites) });
    return;
  }

  if (!authorized(request)) {
    sendJson(response, 401, { error: "Unauthorized. Send Authorization: Bearer <JOBNIMBUS_BRIDGE_TOKEN>." });
    return;
  }

  if (request.method === "GET" && url.pathname === "/tools") {
    sendJson(response, 200, {
      readTools: READ_TOOLS,
      writeActions: WRITE_ACTIONS,
      writesEnabled: config.bridge.allowWrites && config.allowJobNimbusWrites,
      usage: {
        read: "POST /tools/<name> with a JSON body, e.g. POST /tools/review_file {\"query\":\"Rosa Sanchez\"}",
        write: "POST /actions/<name> with a JSON body; blocked unless BRIDGE_ALLOW_WRITES and ALLOW_JOBNIMBUS_WRITES are both true"
      }
    });
    return;
  }

  const toolMatch = url.pathname.match(/^\/tools\/([a-z_]+)$/);
  if (request.method === "POST" && toolMatch) {
    const name = toolMatch[1];
    if (!READ_TOOLS.includes(name)) {
      sendJson(response, 404, { error: `Unknown tool: ${name}`, available: READ_TOOLS });
      return;
    }
    const body = await readBody(request);
    const result = runCli(["chat:tool", name, JSON.stringify(body)]);
    sendCliResult(response, result);
    return;
  }

  const actionMatch = url.pathname.match(/^\/actions\/([a-z_]+)$/);
  if (request.method === "POST" && actionMatch) {
    const name = actionMatch[1];
    if (!WRITE_ACTIONS.includes(name)) {
      sendJson(response, 404, { error: `Unknown action: ${name}`, available: WRITE_ACTIONS });
      return;
    }
    const body = await readBody(request);
    const wantsExecute = body.execute === true;
    if (wantsExecute && !(config.bridge.allowWrites && config.allowJobNimbusWrites)) {
      sendJson(response, 403, {
        error: "Writes are disabled on this bridge. Set BRIDGE_ALLOW_WRITES=true and ALLOW_JOBNIMBUS_WRITES=true to enable execution.",
        hint: "Without execute:true the action runs as a dry run and returns the proposed change."
      });
      return;
    }
    const result = runCli(["chat:action", name, JSON.stringify(body)]);
    sendCliResult(response, result);
    return;
  }

  sendJson(response, 404, { error: "Not found", endpoints: ["GET /health", "GET /tools", "POST /tools/<name>", "POST /actions/<name>"] });
}

function authorized(request) {
  if (!config.bridge.token) return true;
  const header = String(request.headers.authorization || "");
  return header === `Bearer ${config.bridge.token}`;
}

function runCli(args) {
  return spawnSync(process.execPath, [path.join(config.projectRoot, "src", "index.js"), ...args], {
    cwd: config.projectRoot,
    encoding: "utf8",
    timeout: 120000,
    env: process.env
  });
}

function sendCliResult(response, result) {
  const stdout = String(result.stdout || "").trim();
  const stderr = config.redact(String(result.stderr || "").trim());

  if (result.status !== 0 && !stdout) {
    sendJson(response, 502, { error: stderr || "tool failed with no output" });
    return;
  }
  try {
    sendJson(response, 200, JSON.parse(stdout));
  } catch {
    sendJson(response, 200, { output: config.redact(stdout), stderr: stderr || undefined });
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Request body must be JSON"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}
