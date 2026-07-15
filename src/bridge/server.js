#!/usr/bin/env node

import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../lib/config.js";
import { ensureRuntimeDirs } from "../lib/paths.js";

const READ_TOOL_COMMANDS = {
  search_files: ["chat:tool", "search_files"],
  review_file: ["chat:tool", "review_file"],
  claim_packet: ["chat:tool", "claim_packet"],
  claim_call_prompt: ["chat:tool", "claim_call_prompt"],
  draft_message: ["chat:tool", "draft_message"],
  next_actions: ["chat:tool", "next_actions"],
  gmail_search: ["gmail", "search"],
  gmail_thread: ["gmail", "thread"],
  gmail_attachment: ["gmail", "attachment"],
  gmail_delivery: ["gmail", "delivery"],
  quo_history: ["quo", "history"],
  quo_messages: ["quo", "messages"],
  quo_calls: ["quo", "calls"]
};
const ACTION_COMMANDS = {
  create_jobnimbus_note: ["chat:action", "create_jobnimbus_note"],
  append_jobnimbus_assistant_log: ["chat:action", "append_jobnimbus_assistant_log"],
  create_jobnimbus_task: ["chat:action", "create_jobnimbus_task"],
  update_jobnimbus_contact: ["chat:action", "update_jobnimbus_contact"],
  update_jobnimbus_note: ["chat:action", "update_jobnimbus_note"],
  append_jobnimbus_description: ["chat:action", "append_jobnimbus_description"],
  send_quo_message: ["quo", "send"],
  create_gmail_draft: ["gmail", "draft"],
  send_gmail_message: ["gmail", "send"],
  prepare_lor_package: ["lor-package"],
  memory_closeout: ["memory", "closeout"]
};
const READ_TOOLS = Object.keys(READ_TOOL_COMMANDS);
const WRITE_ACTIONS = Object.keys(ACTION_COMMANDS);
const JOBNIMBUS_ACTIONS = new Set(WRITE_ACTIONS.filter((name) => name.includes("jobnimbus")));
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
  console.log(`- bridge execution: ${config.bridge.allowWrites ? "ENABLED" : "blocked (dry-run only)"}`);
  console.log(`- JobNimbus writes: ${config.allowJobNimbusWrites ? "enabled" : "blocked"}`);
  console.log(`- Quo sends: ${config.quo.allowSend ? "enabled" : "blocked"}`);
  console.log(`- Gmail sends: ${config.google.allowSend ? "enabled" : "blocked (drafts still available)"}`);
});

async function handle(request, response) {
  const url = new URL(request.url, "http://localhost");

  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    sendJson(response, 200, {
      ok: true,
      service: "jobnimbus-chat-bridge",
      executionEnabled: config.bridge.allowWrites,
      channels: {
        jobnimbusWrites: config.allowJobNimbusWrites,
        quoSends: config.quo.allowSend,
        gmailDrafts: true,
        gmailSends: config.google.allowSend
      }
    });
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
      executionEnabled: config.bridge.allowWrites,
      channelGates: {
        jobnimbus: config.allowJobNimbusWrites,
        quo: config.quo.allowSend,
        gmailDraft: true,
        gmailSend: config.google.allowSend
      },
      usage: {
        read: "POST /tools/<name> with a JSON body, e.g. POST /tools/review_file {\"query\":\"Rosa Sanchez\"}",
        write: "POST /actions/<name> with a JSON body. Every external action is dry-run by default; execution requires BRIDGE_ALLOW_WRITES plus its channel-specific gate."
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
    const result = runCli([...READ_TOOL_COMMANDS[name], JSON.stringify(body)]);
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
    if (name === "memory_closeout" && !wantsExecute) {
      sendJson(response, 200, { mode: "dry_run", action: name, plan: body, note: "Pass execute:true after the external action has been independently verified." });
      return;
    }
    if (wantsExecute && !config.bridge.allowWrites) {
      sendJson(response, 403, {
        error: "Execution is disabled on this bridge. Set BRIDGE_ALLOW_WRITES=true to enable approved actions.",
        hint: "Without execute:true the action runs as a dry run and returns the proposed change."
      });
      return;
    }
    const gateError = actionGateError(name, body);
    if (wantsExecute && gateError) {
      sendJson(response, 403, { error: gateError });
      return;
    }
    const result = runCli([...ACTION_COMMANDS[name], JSON.stringify(body)]);
    sendCliResult(response, result);
    return;
  }

  sendJson(response, 404, { error: "Not found", endpoints: ["GET /health", "GET /tools", "POST /tools/<name>", "POST /actions/<name>"] });
}

function actionGateError(name, body) {
  if (JOBNIMBUS_ACTIONS.has(name) && !config.allowJobNimbusWrites) {
    return "JobNimbus writes are disabled. Set ALLOW_JOBNIMBUS_WRITES=true.";
  }
  if (name === "send_quo_message" && !config.quo.allowSend) {
    return "Quo sending is disabled. Set ALLOW_QUO_SEND=true.";
  }
  if (name === "send_gmail_message" && !config.google.allowSend) {
    return "Gmail sending is disabled. Set ALLOW_GMAIL_SEND=true.";
  }
  if (name === "prepare_lor_package" && body.send === true && !config.google.allowSend) {
    return "LOR delivery is disabled. Set ALLOW_GMAIL_SEND=true, or omit send:true to create a Gmail draft.";
  }
  return "";
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
