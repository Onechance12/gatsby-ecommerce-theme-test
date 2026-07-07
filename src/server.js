import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.RENDER ? "0.0.0.0" : "127.0.0.1";
const API_BASE = stripTrailingSlash(process.env.JOBNIMBUS_API_BASE_URL || "https://app.jobnimbus.com/api1");
const API_KEY = process.env.JOBNIMBUS_API_KEY || "";
const BRIDGE_TOKEN = process.env.JOBNIMBUS_BRIDGE_TOKEN || "";
const ALLOW_WRITES = process.env.BRIDGE_ALLOW_WRITES === "true";
const PUBLIC_BASE_URL = stripTrailingSlash(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "https://jobnimbus-chatgpt-bridge.onrender.com");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "";
const GMAIL_USER = process.env.GMAIL_USER || "me";
const HANDOFF_STORE_PATH = process.env.HANDOFF_STORE_PATH || path.join(tmpdir(), "jobnimbus-chatgpt-handoffs.json");
const HANDOFF_UPLOAD_DIR = process.env.HANDOFF_UPLOAD_DIR || path.join(tmpdir(), "jobnimbus-chatgpt-handoff-uploads");
const MAX_JSON_BODY_BYTES = Number(process.env.MAX_JSON_BODY_BYTES || 12 * 1024 * 1024);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const OPENAI_VOICE = process.env.OPENAI_VOICE || "marin";
const VOICE_PUBLIC_BASE_URL = stripTrailingSlash(process.env.VOICE_PUBLIC_BASE_URL || PUBLIC_BASE_URL);
const VOICE_STREAM_TOKEN = process.env.VOICE_STREAM_TOKEN || BRIDGE_TOKEN || "";
const VOICE_STREAM_PATH = "/voice/twilio-stream";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
const TWILIO_STATUS_CALLBACK_URL = process.env.TWILIO_STATUS_CALLBACK_URL || "";
const TWILIO_VERIFIED_TEST_NUMBER = process.env.TWILIO_VERIFIED_TEST_NUMBER || "";
const ALLOW_VOICE_CALLS = process.env.ALLOW_VOICE_CALLS === "true";
const OPENAI_INPUT_TRANSCRIPTION_MODEL = process.env.OPENAI_INPUT_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
const REALTIME_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
const voiceCallLogs = new Map();

const routes = new Map([
  ["GET /health", health],
  ["GET /openapi.json", openapi],
  ["GET /privacy", privacy],
  ["GET /handoff", handoffPage],
  ["GET /voice/twiml", voiceTwiml],
  ["POST /voice/outbound-call", outboundVoiceCall],
  ["POST /voice/transcript", voiceTranscript],
  ["POST /handoff", createHandoff],
  ["POST /handoff/chunk", createHandoffChunk],
  ["POST /handoff/pending", pendingHandoffs],
  ["POST /handoff/get", getHandoff],
  ["POST /handoff/process", processHandoff],
  ["POST /handoff/complete", completeHandoff],
  ["POST /jobnimbus/search", searchContacts],
  ["POST /jobnimbus/review-file", reviewFile],
  ["POST /jobnimbus/assigned-files", assignedFiles],
  ["POST /jobnimbus/assigned-counts", assignedCounts],
  ["POST /jobnimbus/document-text", documentText],
  ["POST /jobnimbus/document-review", documentReview],
  ["POST /jobnimbus/update-contact", updateContact],
  ["POST /jobnimbus/update-status", updateStatus],
  ["POST /jobnimbus/process-update", processUpdate],
  ["POST /jobnimbus/create-note", createNote],
  ["POST /jobnimbus/create-task", createTask],
  ["POST /jobnimbus/update-task", updateTask],
  ["POST /jobnimbus/create-calendar-event", createCalendarEvent],
  ["POST /jobnimbus/update-calendar-event", updateCalendarEvent],
  ["POST /gmail/search", gmailSearch],
  ["POST /gmail/thread", gmailThread],
  ["POST /gmail/draft", gmailDraft],
  ["POST /gmail/send", gmailSend]
]);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const handler = routes.get(`${req.method} ${url.pathname}`);
    if (!handler) return send(res, 404, { error: "Not found" });
    if (!isPublicRoute(req.method, url.pathname) && !authorized(req)) return send(res, 401, { error: "Unauthorized" });
    const body = req.method === "GET" ? {} : await readJson(req);
    const result = await handler(body);
    if (result?.html) sendHtml(res, 200, result.html);
    else if (typeof result === "string") sendText(res, 200, result);
    else send(res, 200, result);
  } catch (error) {
    send(res, error.statusCode || 500, { error: error.message || String(error) });
  }
});

const voiceWebSocketServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== VOICE_STREAM_PATH && !url.pathname.startsWith(`${VOICE_STREAM_PATH}/`)) {
    socket.destroy();
    return;
  }

  if (!voiceStreamAuthorized(url)) {
    console.log(JSON.stringify({
      type: "twilio_stream_rejected",
      reason: "invalid_stream_token",
      pathHasToken: url.pathname.startsWith(`${VOICE_STREAM_PATH}/`),
      queryHasToken: url.searchParams.has("token")
    }));
    socket.destroy();
    return;
  }

  voiceWebSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
    bridgeTwilioToOpenAI(webSocket, req);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`JobNimbus ChatGPT bridge listening on http://${HOST}:${PORT}`);
  console.log(`Auth: ${BRIDGE_TOKEN ? "enabled" : "disabled"}`);
  console.log(`Writes: ${ALLOW_WRITES ? "enabled" : "dry-run only"}`);
  console.log(`Voice stream: ${OPENAI_API_KEY ? "available" : "missing OPENAI_API_KEY"}`);
});

function health() {
  return {
    ok: true,
    service: "jobnimbus-chatgpt-bridge",
    jobNimbusConfigured: Boolean(API_KEY),
    gmailConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN),
    writesAllowed: ALLOW_WRITES,
    ocrMode: "poppler+tesseract",
    voice: {
      available: Boolean(OPENAI_API_KEY),
      model: OPENAI_REALTIME_MODEL,
      voice: OPENAI_VOICE,
      streamUrl: voiceStreamUrl(),
      streamAuth: VOICE_STREAM_TOKEN ? "token_required" : "disabled",
      twilioConfigured: Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER),
      callsAllowed: ALLOW_VOICE_CALLS
    }
  };
}

function openapi() {
  return { ...OPENAPI, servers: [{ url: PUBLIC_BASE_URL }] };
}

function privacy() {
  return [
    "JobNimbus ChatGPT Bridge Privacy Policy",
    "",
    "This private bridge is used by Chance Pearson to connect ChatGPT to JobNimbus operations data.",
    "It does not sell or share data.",
    "Requests are authenticated before JobNimbus data is accessed.",
    "The bridge passes user-authorized requests to JobNimbus and returns the response to ChatGPT.",
    "JobNimbus API keys and bridge tokens are stored as Render environment variables and are not exposed by this page."
  ].join("\n");
}

function voiceTwiml() {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<Response>",
    "  <Connect>",
    `    <Stream url="${escapeXml(voiceStreamUrl())}" />`,
    "  </Connect>",
    "</Response>"
  ].join("");
}

async function outboundVoiceCall(input) {
  const to = normalizePhone(input.to || TWILIO_VERIFIED_TEST_NUMBER);
  const from = normalizePhone(input.from || TWILIO_FROM_NUMBER);
  const goal = String(input.goal || "test").trim();
  const prompt = String(input.prompt || "").trim();
  const voice = normalizeRealtimeVoice(input.voice || OPENAI_VOICE);
  const callId = randomUUID();
  const execute = input.execute === true;
  const streamUrl = voiceStreamUrlWithContext({ goal, prompt, voice, callId });

  const plan = {
    from,
    to,
    streamUrl,
    goal,
    voice,
    callId,
    prompt: prompt ? "[set]" : "(not set)",
    execute,
    requirements: {
      twilioAccountSid: Boolean(TWILIO_ACCOUNT_SID),
      twilioAuthToken: Boolean(TWILIO_AUTH_TOKEN),
      openaiApiKey: Boolean(OPENAI_API_KEY),
      fromNumber: Boolean(from),
      toNumber: Boolean(to),
      publicWssStreamUrl: /^wss:\/\//i.test(streamUrl),
      allowVoiceCalls: ALLOW_VOICE_CALLS
    }
  };

  const missing = Object.entries(plan.requirements)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  if (!execute) {
    return {
      mode: "dry_run",
      plan,
      instruction: "This did not place a call. Set execute:true only after user approval."
    };
  }

  if (missing.length) {
    return {
      mode: "blocked",
      plan,
      missing,
      reason: "Realtime voice calls require Twilio credentials, OpenAI credentials, ALLOW_VOICE_CALLS=true, and a public wss:// stream URL."
    };
  }

  initVoiceCallLog(callId, { to, from, goal, prompt, voice });
  const result = await createTwilioRealtimeCall({ to, from, streamUrl, goal, prompt });
  const log = voiceCallLogs.get(callId);
  if (log) {
    log.twilioCallSid = result.sid;
    log.status = result.status || "created";
    log.updatedAt = new Date().toISOString();
  }
  return {
    mode: "executed",
    call: {
      callId,
      sid: result.sid,
      status: result.status,
      to: result.to,
      from: result.from,
      direction: result.direction
    }
  };
}

async function voiceTranscript(input) {
  const id = String(input.callId || input.sid || input.twilioCallSid || "").trim();
  if (!id) badRequest("callId or sid is required");
  const log = voiceCallLogs.get(id) || Array.from(voiceCallLogs.values()).find((item) => item.twilioCallSid === id);
  if (!log) {
    return {
      found: false,
      id,
      message: "No transcript found. Render memory may have restarted, or the call may not have connected to the media stream."
    };
  }
  return {
    found: true,
    call: summarizeVoiceCallLog(log),
    turns: log.turns,
    transcript: log.turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n")
  };
}

function handoffPage() {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JobNimbus Handoff Inbox</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #101114; color: #f4f4f5; }
    main { max-width: 920px; margin: 0 auto; padding: 28px 18px 48px; }
    h1 { font-size: 28px; margin: 0 0 8px; letter-spacing: 0; }
    p { color: #c7c9d1; line-height: 1.45; }
    label { display: block; margin: 18px 0 8px; color: #d9dbe3; font-weight: 600; }
    input, textarea, button { width: 100%; box-sizing: border-box; border-radius: 8px; border: 1px solid #3a3d46; background: #17191f; color: #f4f4f5; font: inherit; }
    input { padding: 12px; }
    textarea { min-height: 330px; padding: 12px; resize: vertical; }
    button { margin-top: 16px; padding: 12px 14px; background: #2f6fed; border-color: #2f6fed; cursor: pointer; font-weight: 700; }
    button.secondary { background: #242732; border-color: #3a3d46; }
    pre { white-space: pre-wrap; background: #17191f; border: 1px solid #30333d; padding: 14px; border-radius: 8px; min-height: 48px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 720px) { .row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>JobNimbus Handoff Inbox</h1>
    <p>Paste Gmail/Quo findings from another ChatGPT chat here. The JobNimbus assistant can then read the pending handoffs and turn them into approval-ready actions.</p>

    <label for="token">Bridge Token</label>
    <input id="token" type="password" autocomplete="off" placeholder="Optional for submitting; required to load pending">

    <div class="row">
      <div>
        <label for="source">Source</label>
        <input id="source" value="regular-chat" placeholder="regular-chat, gmail, quo">
      </div>
      <div>
        <label for="client">Client/File</label>
        <input id="client" placeholder="Optional client name, job number, claim number">
      </div>
    </div>

    <label for="payload">Handoff Text or JSON</label>
    <input id="payloadFile" type="file" accept=".json,.txt,application/json,text/plain">
    <textarea id="payload" placeholder='Example: {"client":"Rosa Sanchez","summary":"Adjuster replied...","recommendedActions":["Send LOR"],"needsApproval":true}'></textarea>

    <button id="submit">Submit Handoff</button>
    <button class="secondary" id="pending">Load Pending</button>

    <label for="result">Result</label>
    <pre id="result"></pre>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    function headers() {
      const token = $("token").value.trim();
      return token
        ? { "content-type": "application/json", "authorization": "Bearer " + token }
        : { "content-type": "application/json" };
    }
    function parsePayload(text) {
      try { return JSON.parse(text); } catch { return { text }; }
    }
    $("payloadFile").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      $("payload").value = await file.text();
    });
    $("submit").addEventListener("click", async () => {
      $("result").textContent = "Submitting...";
      const source = $("source").value.trim() || "regular-chat";
      const client = $("client").value.trim();
      const payloadText = $("payload").value.trim();
      if (payloadText.length > 700000) {
        let uploadId = "";
        const chunkSize = 450000;
        const total = Math.ceil(payloadText.length / chunkSize);
        for (let index = 0; index < total; index += 1) {
          const chunk = payloadText.slice(index * chunkSize, (index + 1) * chunkSize);
          const res = await fetch("/handoff/chunk", {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ uploadId, source, client, index, total, chunk })
          });
          const result = await res.json();
          $("result").textContent = JSON.stringify(result, null, 2);
          if (!res.ok) return;
          uploadId = result.uploadId;
        }
        return;
      }
      const body = { source, client, payload: parsePayload(payloadText) };
      const res = await fetch("/handoff", { method: "POST", headers: headers(), body: JSON.stringify(body) });
      $("result").textContent = JSON.stringify(await res.json(), null, 2);
    });
    $("pending").addEventListener("click", async () => {
      $("result").textContent = "Loading...";
      const res = await fetch("/handoff/pending", { method: "POST", headers: headers(), body: JSON.stringify({ limit: 25 }) });
      $("result").textContent = JSON.stringify(await res.json(), null, 2);
    });
  </script>
</body>
</html>`;
  return { html };
}

async function createHandoff(input) {
  const handoffs = await readHandoffStore();
  const payload = normalizeHandoffPayload(input);
  const handoff = {
    id: randomUUID(),
    status: "pending",
    source: payload.source,
    client: payload.client,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: "",
    payload: payload.payload,
    assistantRead: buildHandoffAssistantRead(payload)
  };
  handoffs.unshift(handoff);
  await writeHandoffStore(handoffs);
  return { created: true, handoff };
}

async function createHandoffChunk(input) {
  const uploadId = normalizeUploadId(input.uploadId || randomUUID());
  const index = Number(input.index);
  const total = Number(input.total);
  const chunk = String(input.chunk ?? "");
  if (!Number.isInteger(index) || index < 0) badRequest("index must be a zero-based integer");
  if (!Number.isInteger(total) || total < 1 || total > 1000) badRequest("total must be between 1 and 1000");
  if (index >= total) badRequest("index must be less than total");
  if (!chunk) badRequest("chunk is required");

  const dir = path.join(HANDOFF_UPLOAD_DIR, uploadId);
  await mkdir(dir, { recursive: true });
  const metaPath = path.join(dir, "meta.json");
  const metadata = cleanObject({
    uploadId,
    source: String(input.source || "regular-chat").trim(),
    client: String(input.client || "").trim(),
    total,
    createdAt: new Date().toISOString()
  });
  if (index === 0) await writeFile(metaPath, JSON.stringify(metadata, null, 2));
  await writeFile(path.join(dir, `${index}.part`), chunk);

  const received = (await readdir(dir)).filter((name) => name.endsWith(".part")).length;
  if (received < total) return { uploadId, complete: false, received, total };

  const savedMeta = await readJsonFile(metaPath, metadata);
  const chunks = [];
  for (let part = 0; part < total; part += 1) {
    chunks.push(await readFile(path.join(dir, `${part}.part`), "utf8"));
  }
  const raw = chunks.join("");
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  const handoff = await createHandoff({
    source: savedMeta.source || metadata.source,
    client: savedMeta.client || metadata.client,
    ...(parsed && typeof parsed === "object" ? { payload: parsed } : { text: raw })
  });
  await rm(dir, { recursive: true, force: true });
  return { uploadId, complete: true, received, total, handoff };
}

async function pendingHandoffs(input = {}) {
  const limit = clamp(Number(input.limit || 25), 1, 100);
  const includeCompleted = input.includeCompleted === true;
  const clientQuery = normalizeCompare(input.client || input.query || "");
  const handoffs = await readHandoffStore();
  const matches = handoffs
    .filter((handoff) => includeCompleted || handoff.status !== "completed")
    .filter((handoff) => !clientQuery || normalizeCompare(`${handoff.client} ${JSON.stringify(handoff.payload)}`).includes(clientQuery))
    .slice(0, limit);
  return {
    count: matches.length,
    handoffs: matches,
    assistantRead: matches.map((handoff) => handoff.assistantRead).join("\n\n---\n\n")
  };
}

async function getHandoff(input) {
  const id = required(input.id || input.handoffId, "id");
  const handoff = await findHandoffById(id);
  return { handoff, assistantRead: handoff.assistantRead };
}

async function processHandoff(input) {
  const id = required(input.id || input.handoffId, "id");
  const handoff = await findHandoffById(id);
  const update = extractHandoffJobNimbusUpdate(handoff, input);
  if (!update) {
    return {
      mode: "no_action",
      handoff,
      error: "No jobNimbusUpdate payload found. Add payload.jobNimbusUpdate with query, fields, status, and/or note."
    };
  }
  const execute = input.execute === true || update.execute === true;
  const result = await processUpdate({ ...update, execute });
  if (execute && input.completeOnSuccess !== false) {
    const completionNote = String(input.completionNote || "Processed through processHandoff.").trim();
    await markHandoffComplete(handoff.id, completionNote);
  }
  return {
    mode: execute ? "executed" : "dry_run",
    handoff,
    result
  };
}

async function completeHandoff(input) {
  const id = required(input.id || input.handoffId, "id");
  const completionNote = String(input.completionNote || input.note || "").trim();
  const handoff = await markHandoffComplete(id, completionNote);
  return { completed: true, handoff };
}

async function searchContacts(input) {
  const query = required(input.query, "query").toLowerCase();
  const limit = clamp(Number(input.limit || 10), 1, 25);
  const contacts = await listContacts({ maxPages: Number(input.maxPages || 10) });
  const matches = contacts.filter((contact) => contactMatches(contact, query)).slice(0, limit);
  const compactMatches = matches.map(compactContact);
  return {
    query,
    count: compactMatches.length,
    matches: compactMatches,
    contacts: compactMatches,
    jobs: []
  };
}

async function reviewFile(input) {
  const query = required(input.query, "query");
  const { contact, alternatives } = await findOneContact(query);
  const activities = await listRelated("/activities", contact.jnid, 30);
  const tasks = await listRelated("/tasks", contact.jnid, 30);
  const documents = await listRelated("/files", contact.jnid, 50);
  return {
    file: compactContact(contact),
    rawContact: contact,
    recentActivities: activities.map(compactActivity),
    openTasks: tasks.filter((task) => !task.is_completed).map(compactTask),
    documents: documents.map(compactDocument),
    alternatives: alternatives.map(compactContact),
    assistantRead: buildAssistantRead(contact, activities, tasks, documents)
  };
}

async function assignedFiles(input = {}) {
  const ownerId = String(input.ownerId || "fc95a213f70e4c9daddc5fa366be9941").trim();
  const activeOnly = input.activeOnly !== false;
  const limit = clamp(Number(input.limit || 100), 1, 250);
  const contacts = await listContacts({ maxPages: Number(input.maxPages || 25) });
  const files = contacts
    .filter((contact) => isInsuranceFile(contact))
    .filter((contact) => assignedTo(contact, ownerId))
    .filter((contact) => !activeOnly || isOpenActive(contact))
    .sort(fileSort)
    .slice(0, limit)
    .map(compactContact);
  return {
    ownerId,
    ownerName: ownerId === "fc95a213f70e4c9daddc5fa366be9941" ? "Chance Pearson" : "",
    activeOnly,
    count: files.length,
    files
  };
}

async function assignedCounts(input = {}) {
  const ownerId = String(input.ownerId || "fc95a213f70e4c9daddc5fa366be9941").trim();
  const contacts = await listContacts({ maxPages: Number(input.maxPages || 25) });
  const assigned = contacts
    .filter((contact) => isInsuranceFile(contact))
    .filter((contact) => assignedTo(contact, ownerId));
  const active = assigned.filter(isOpenActive);
  return {
    ownerId,
    ownerName: ownerId === "fc95a213f70e4c9daddc5fa366be9941" ? "Chance Pearson" : "",
    totalAssigned: assigned.length,
    activeAssigned: active.length,
    closedOrInactive: assigned.length - active.length,
    byStatus: countBy(active, (contact) => contact.status_name || "Unknown"),
    byCarrier: countBy(active, (contact) => fieldValue(contact, ["Insurance Company", "Carrier", "insurance_company", "cf_string_1"]) || "Unknown"),
    files: active.sort(fileSort).slice(0, clamp(Number(input.sampleLimit || 25), 1, 100)).map(compactContact)
  };
}

async function updateContact(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute updates.");
  }
  const query = required(input.query, "query");
  const fields = input.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) badRequest("fields object is required");
  const { contact } = await findOneContact(query);
  const plan = { endpoint: `/contacts/${contact.jnid}`, fields };
  if (input.execute !== true) return { mode: "dry_run", file: compactContact(contact), plan };
  const result = await jobNimbus(`/contacts/${encodeURIComponent(contact.jnid)}`, { method: "PUT", body: fields });
  return { mode: "executed", file: compactContact(contact), result };
}

async function updateStatus(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute status updates.");
  }
  const query = required(input.query, "query");
  const status = required(input.status || input.statusName || input.workflowStatus, "status");
  const { contact } = await findOneContact(query);
  const body = { status_name: status };
  const plan = { endpoint: `/contacts/${contact.jnid}`, body };
  if (input.execute !== true) return { mode: "dry_run", file: compactContact(contact), plan };
  const result = await jobNimbus(`/contacts/${encodeURIComponent(contact.jnid)}`, { method: "PUT", body });
  return { mode: "executed", file: compactContact(contact), result };
}

async function processUpdate(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute bundled JobNimbus updates.");
  }
  const query = required(input.query || input.job || input.client, "query");
  const fields = input.fields && typeof input.fields === "object" && !Array.isArray(input.fields) ? input.fields : {};
  const status = String(input.status || input.statusName || input.workflowStatus || "").trim();
  const note = String(input.note || input.internalNote || "").trim();
  if (!Object.keys(fields).length && !status && !note) {
    badRequest("At least one of fields, status, or note is required.");
  }
  const { contact } = await findOneContact(query);
  const file = compactContact(contact);
  const contactBody = cleanObject({ ...fields, ...(status ? { status_name: status } : {}) });
  const noteBody = note ? {
    note,
    date_created: Math.floor(Date.now() / 1000),
    record_type_name: "Note",
    primary: { id: contact.jnid }
  } : null;
  const plan = {
    file,
    updates: cleanObject({
      contact: Object.keys(contactBody).length ? { endpoint: `/contacts/${contact.jnid}`, body: contactBody } : null,
      note: noteBody ? { endpoint: "/activities", body: noteBody } : null
    })
  };
  if (input.execute !== true) return { mode: "dry_run", ...plan };

  const results = {};
  if (Object.keys(contactBody).length) {
    results.contact = await jobNimbus(`/contacts/${encodeURIComponent(contact.jnid)}`, { method: "PUT", body: contactBody });
  }
  if (noteBody) {
    results.note = await jobNimbus("/activities", { method: "POST", body: noteBody });
  }
  return { mode: "executed", file, results };
}

async function documentText(input) {
  const query = required(input.query, "query");
  const documentQuery = String(input.documentQuery || input.documentId || "").trim();
  const maxChars = clamp(Number(input.maxChars || 12000), 1000, 50000);
  const maxOcrPages = clamp(Number(input.maxOcrPages || 5), 1, 20);
  const { contact } = await findOneContact(query);
  const documents = await listRelated("/files", contact.jnid, 100);
  const document = selectDocument(documents, documentQuery);
  if (!document) {
    return {
      file: compactContact(contact),
      error: documentQuery ? `No matching document found for: ${documentQuery}` : "No documents found on this file.",
      availableDocuments: documents.map(compactDocument).slice(0, 50)
    };
  }
  const downloaded = await downloadJobNimbusFile(document);
  const extracted = await extractDocumentText(downloaded, document, maxChars, {
    forceOcr: input.forceOcr === true,
    maxOcrPages
  });
  return {
    file: compactContact(contact),
    document: compactDocument(document),
    contentType: downloaded.contentType,
    bytes: downloaded.bytes.length,
    ...extracted
  };
}

async function documentReview(input) {
  const query = required(input.query, "query");
  const documentQuery = String(input.documentQuery || input.documentId || "").trim();
  const maxChars = clamp(Number(input.maxChars || 20000), 1000, 50000);
  const maxOcrPages = clamp(Number(input.maxOcrPages || 5), 1, 20);
  const { contact } = await findOneContact(query);
  const documents = await listRelated("/files", contact.jnid, 100);
  const document = selectDocument(documents, documentQuery);
  if (!document) {
    return {
      file: compactContact(contact),
      error: documentQuery ? `No matching document found for: ${documentQuery}` : "No documents found on this file.",
      availableDocuments: documents.map(compactDocument).slice(0, 50)
    };
  }
  const downloaded = await downloadJobNimbusFile(document);
  const extracted = await extractDocumentText(downloaded, document, maxChars, {
    forceOcr: input.forceOcr === true,
    maxOcrPages
  });
  const review = reviewExtractedDocument(extracted.text || "", document, compactContact(contact));
  return {
    file: compactContact(contact),
    document: compactDocument(document),
    contentType: downloaded.contentType,
    bytes: downloaded.bytes.length,
    extraction: extracted.extraction,
    pageCount: extracted.pageCount || null,
    truncated: Boolean(extracted.truncated),
    extractionError: extracted.error || "",
    textPreview: (extracted.text || "").slice(0, clamp(Number(input.previewChars || 4000), 500, 12000)),
    review
  };
}

async function createNote(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute notes.");
  }
  const query = required(input.query, "query");
  const note = required(input.note, "note");
  const { contact } = await findOneContact(query);
  const body = {
    note,
    date_created: Math.floor(Date.now() / 1000),
    record_type_name: "Note",
    primary: { id: contact.jnid }
  };
  if (input.execute !== true) return { mode: "dry_run", file: compactContact(contact), plan: { endpoint: "/activities", body } };
  const result = await jobNimbus("/activities", { method: "POST", body });
  return { mode: "executed", file: compactContact(contact), result };
}

async function createTask(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute tasks.");
  }
  const query = required(input.query, "query");
  const title = required(input.title || input.subject, "title");
  const { contact } = await findOneContact(query);
  const body = cleanObject({
    title,
    subject: title,
    description: input.description || input.note || "",
    note: input.note || input.description || "",
    date_start: toUnixSeconds(input.dateStart || input.dueDate),
    date_end: toUnixSeconds(input.dateEnd || input.dueDate),
    is_completed: Boolean(input.completed || false),
    record_type_name: input.recordTypeName || "Task",
    primary: { id: contact.jnid },
    related: [{ id: contact.jnid }]
  });
  if (input.execute !== true) return { mode: "dry_run", file: compactContact(contact), plan: { endpoint: "/tasks", body } };
  const result = await jobNimbus("/tasks", { method: "POST", body });
  return { mode: "executed", file: compactContact(contact), result };
}

async function updateTask(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute task updates.");
  }
  const taskId = String(input.taskId || input.id || "").trim();
  if (!taskId) badRequest("taskId is required");
  const fields = input.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) badRequest("fields object is required");
  const body = normalizeDateFields(fields);
  if (input.execute !== true) return { mode: "dry_run", plan: { endpoint: `/tasks/${taskId}`, body } };
  const result = await jobNimbus(`/tasks/${encodeURIComponent(taskId)}`, { method: "PUT", body });
  return { mode: "executed", taskId, result };
}

async function createCalendarEvent(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute calendar events.");
  }
  const query = required(input.query, "query");
  const title = required(input.title || input.subject, "title");
  const dateStart = toUnixSeconds(required(input.dateStart || input.start, "dateStart"));
  const dateEnd = toUnixSeconds(input.dateEnd || input.end) || dateStart;
  const { contact } = await findOneContact(query);
  const body = cleanObject({
    title,
    subject: title,
    note: input.note || input.description || "",
    description: input.description || input.note || "",
    location: input.location || compactContact(contact).address,
    date_start: dateStart,
    date_end: dateEnd,
    record_type_name: input.recordTypeName || "Event",
    primary: { id: contact.jnid },
    related: [{ id: contact.jnid }]
  });
  if (input.execute !== true) return { mode: "dry_run", file: compactContact(contact), plan: { endpoint: "/activities", body } };
  const result = await jobNimbus("/activities", { method: "POST", body });
  return { mode: "executed", file: compactContact(contact), result };
}

async function updateCalendarEvent(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute calendar event updates.");
  }
  const eventId = String(input.eventId || input.activityId || input.id || "").trim();
  if (!eventId) badRequest("eventId is required");
  const fields = input.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) badRequest("fields object is required");
  const body = normalizeDateFields(fields);
  if (input.execute !== true) return { mode: "dry_run", plan: { endpoint: `/activities/${eventId}`, body } };
  const result = await jobNimbus(`/activities/${encodeURIComponent(eventId)}`, { method: "PUT", body });
  return { mode: "executed", eventId, result };
}

async function gmailSearch(input) {
  const query = required(input.query, "query");
  const limit = clamp(Number(input.limit || 10), 1, 25);
  const messages = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`);
  const rows = Array.isArray(messages.messages) ? messages.messages : [];
  const hydrated = [];
  for (const row of rows) {
    const message = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/${encodeURIComponent(row.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`);
    hydrated.push(compactGmailMessage(message));
  }
  return {
    query,
    count: hydrated.length,
    messages: hydrated,
    threads: groupGmailMessagesByThread(hydrated)
  };
}

async function gmailThread(input) {
  const threadId = required(input.threadId, "threadId");
  const thread = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/threads/${encodeURIComponent(threadId)}?format=full`);
  const messages = Array.isArray(thread.messages) ? thread.messages.map(compactGmailFullMessage) : [];
  return {
    id: thread.id || threadId,
    historyId: thread.historyId || "",
    messageCount: messages.length,
    messages,
    assistantRead: buildGmailAssistantRead(messages)
  };
}

async function gmailDraft(input) {
  const to = required(input.to, "to");
  const subject = required(input.subject, "subject");
  const body = required(input.body, "body");
  const cc = String(input.cc || "").trim();
  const bcc = String(input.bcc || "").trim();
  const threadId = String(input.threadId || "").trim();
  const raw = buildRawEmail({ to, cc, bcc, subject, body });
  const draftBody = { message: cleanObject({ raw, threadId }) };
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      plan: {
        endpoint: "/gmail/v1/users/me/drafts",
        to,
        cc,
        bcc,
        subject,
        body,
        threadId
      }
    };
  }
  if (!ALLOW_WRITES) badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to create Gmail drafts.");
  const result = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/drafts`, {
    method: "POST",
    body: draftBody
  });
  return { mode: "executed", draft: compactGmailDraft(result) };
}

async function gmailSend(input) {
  const to = required(input.to, "to");
  const subject = required(input.subject, "subject");
  const body = required(input.body, "body");
  const cc = String(input.cc || "").trim();
  const bcc = String(input.bcc || "").trim();
  const threadId = String(input.threadId || "").trim();
  const raw = buildRawEmail({ to, cc, bcc, subject, body });
  const sendBody = cleanObject({ raw, threadId });
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      plan: {
        endpoint: "/gmail/v1/users/me/messages/send",
        to,
        cc,
        bcc,
        subject,
        body,
        threadId
      }
    };
  }
  if (!ALLOW_WRITES) badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to send Gmail messages.");
  const result = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/send`, {
    method: "POST",
    body: sendBody
  });
  return { mode: "executed", message: compactGmailMessage(result) };
}

async function findOneContact(query) {
  const matches = (await searchContacts({ query, limit: 6, maxPages: 15 })).matches;
  if (!matches.length) badRequest(`No JobNimbus contact found for: ${query}`);
  const contact = await jobNimbus(`/contacts/${encodeURIComponent(matches[0].id)}`);
  return { contact, alternatives: matches.slice(1) };
}

async function listContacts({ maxPages }) {
  const all = [];
  const pageSize = 1000;
  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const batch = await jobNimbus(`/contacts?size=${pageSize}&from=${offset}`);
    const rows = unwrapList(batch, "contacts");
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

async function listRelated(endpoint, contactId, limit) {
  const rows = await jobNimbus(`${endpoint}?size=1000&from=0&related=${encodeURIComponent(contactId)}`);
  const list = unwrapList(rows, endpoint.replace("/", ""));
  return list.filter((item) => referencesContact(item, contactId)).slice(0, limit);
}

function unwrapList(payload, name) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    name,
    singular(name),
    "results",
    "data",
    "items",
    "contacts",
    "contact",
    "jobs",
    "job",
    "tasks",
    "task",
    "activities",
    "activity",
    "files",
    "file"
  ];
  for (const key of candidates) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function singular(name) {
  if (name === "activities") return "activity";
  if (name === "files") return "files";
  if (name.endsWith("s")) return name.slice(0, -1);
  return name;
}

function referencesContact(item, contactId) {
  const ids = [];
  for (const key of ["primary", "related", "customer", "contact"]) collectIds(item?.[key], ids);
  return ids.includes(contactId);
}

function selectDocument(documents, documentQuery) {
  if (!documents.length) return null;
  if (!documentQuery) return documents[0];
  const needle = documentQuery.toLowerCase();
  return documents.find((doc) => String(doc.jnid || doc.id || "").toLowerCase() === needle)
    || documents.find((doc) => documentMatches(doc, needle))
    || null;
}

function documentMatches(doc, needle) {
  return [
    doc.jnid,
    doc.id,
    doc.name,
    doc.filename,
    doc.file_name,
    doc.description,
    doc.record_type_name,
    doc.type
  ].filter(Boolean).join(" ").toLowerCase().includes(needle);
}

async function downloadJobNimbusFile(doc) {
  const id = doc.jnid || doc.id;
  if (!id) badRequest("Selected document does not have a JobNimbus file id.");
  const response = await fetch(`https://app.jobnimbus.com/files/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${API_KEY}` }
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const text = bytes.toString("utf8", 0, Math.min(bytes.length, 500));
    const error = new Error(`JobNimbus file download ${response.status}: ${text}`);
    error.statusCode = response.status;
    throw error;
  }
  return {
    bytes,
    contentType: response.headers.get("content-type") || "",
    filename: doc.name || doc.filename || doc.file_name || ""
  };
}

async function extractDocumentText(downloaded, doc, maxChars, options = {}) {
  const filename = String(downloaded.filename || doc.name || doc.filename || doc.file_name || "").toLowerCase();
  const contentType = String(downloaded.contentType || "").toLowerCase();
  const looksPdf = contentType.includes("pdf") || filename.endsWith(".pdf");
  const looksImage = contentType.startsWith("image/") || /\.(png|jpe?g|tiff?|bmp|webp)$/i.test(filename);
  const looksText = contentType.startsWith("text/") || /\.(txt|csv|json|xml|html|md)$/i.test(filename);

  if (looksPdf) {
    let pdfText = "";
    let pageCount = null;
    let pdfError = "";
    try {
      const pdfParseModule = await import("pdf-parse");
      const pdfParse = pdfParseModule.default || pdfParseModule;
      const parsed = await pdfParse(downloaded.bytes);
      pdfText = cleanExtractedText(parsed.text || "");
      pageCount = parsed.numpages || parsed.numrender || null;
      if (!options.forceOcr && hasUsefulExtractedText(pdfText)) {
        return {
          extraction: "pdf-parse",
          pageCount,
          truncated: pdfText.length > maxChars,
          ocrAttempted: false,
          text: pdfText.slice(0, maxChars)
        };
      }
    } catch (error) {
      pdfError = error.message;
    }

    const ocr = await ocrPdf(downloaded.bytes, {
      filename,
      maxPages: options.maxOcrPages || 5,
      maxChars
    });
    const combinedText = cleanExtractedText([pdfText, ocr.text].filter(Boolean).join("\n\n"));
    if (combinedText) {
      return {
        extraction: pdfText ? "pdf-parse+ocr" : "ocr",
        pageCount,
        truncated: combinedText.length > maxChars || Boolean(ocr.truncated),
        ocrAttempted: true,
        ocrPages: ocr.pages,
        ocrErrors: ocr.errors,
        text: combinedText.slice(0, maxChars),
        error: pdfError && !ocr.text ? `PDF extraction failed: ${pdfError}` : ""
      };
    }

    return {
      extraction: "failed",
      pageCount,
      truncated: false,
      ocrAttempted: true,
      ocrPages: ocr.pages,
      ocrErrors: ocr.errors,
      error: `No usable text extracted. PDF error: ${pdfError || "none"}. OCR error: ${ocr.errors.join("; ") || "no text returned"}.`,
      text: ""
    };
  }

  if (looksImage) {
    const ocr = await ocrImage(downloaded.bytes, { filename, maxChars });
    return {
      extraction: ocr.text ? "ocr" : "failed",
      truncated: Boolean(ocr.truncated),
      ocrAttempted: true,
      ocrPages: ocr.pages,
      ocrErrors: ocr.errors,
      error: ocr.text ? "" : `OCR returned no usable text. ${ocr.errors.join("; ")}`,
      text: ocr.text.slice(0, maxChars)
    };
  }

  if (looksText) {
    const raw = downloaded.bytes.toString("utf8");
    return {
      extraction: "plain-text",
      truncated: raw.length > maxChars,
      ocrAttempted: false,
      text: cleanExtractedText(raw).slice(0, maxChars)
    };
  }

  return {
    extraction: "unsupported",
    error: "This file type is not currently text-extractable by the bridge. Use Drive/file tools or download metadata only.",
    text: ""
  };
}

function hasUsefulExtractedText(text) {
  return text.split(/\s+/).filter(Boolean).length >= 25;
}

async function ocrPdf(bytes, options) {
  const dir = await mkdtemp(path.join(tmpdir(), "jn-ocr-"));
  const inputPath = path.join(dir, sanitizeFilename(options.filename || "document.pdf", ".pdf"));
  const prefix = path.join(dir, "page");
  const errors = [];
  try {
    await writeFile(inputPath, bytes);
    const convert = await runCommand("pdftoppm", [
      "-png",
      "-r",
      "200",
      "-f",
      "1",
      "-l",
      String(options.maxPages || 5),
      inputPath,
      prefix
    ]);
    if (convert.stderr) errors.push(convert.stderr.trim());
    const files = (await readdir(dir))
      .filter((file) => /^page-\d+\.png$/i.test(file))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const pageTexts = [];
    for (const file of files) {
      const imagePath = path.join(dir, file);
      const result = await runCommand("tesseract", [imagePath, "stdout", "--psm", "6"]);
      if (result.stderr) errors.push(`${file}: ${result.stderr.trim()}`);
      pageTexts.push(result.stdout);
      if (cleanExtractedText(pageTexts.join("\n\n")).length >= options.maxChars) break;
    }
    const text = cleanExtractedText(pageTexts.join("\n\n"));
    return {
      text: text.slice(0, options.maxChars),
      truncated: text.length > options.maxChars,
      pages: files.length,
      errors: errors.filter(Boolean)
    };
  } catch (error) {
    return { text: "", truncated: false, pages: 0, errors: [error.message] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ocrImage(bytes, options) {
  const dir = await mkdtemp(path.join(tmpdir(), "jn-ocr-"));
  const inputPath = path.join(dir, sanitizeFilename(options.filename || "image.png", ".png"));
  try {
    await writeFile(inputPath, bytes);
    const result = await runCommand("tesseract", [inputPath, "stdout", "--psm", "6"]);
    const text = cleanExtractedText(result.stdout);
    return {
      text: text.slice(0, options.maxChars),
      truncated: text.length > options.maxChars,
      pages: text ? 1 : 0,
      errors: result.stderr ? [result.stderr.trim()] : []
    };
  } catch (error) {
    return { text: "", truncated: false, pages: 0, errors: [error.message] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sanitizeFilename(name, fallbackExt) {
  const safe = String(name || "document")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 120);
  return /\.[a-z0-9]{2,5}$/i.test(safe) ? safe : `${safe}${fallbackExt}`;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

function cleanExtractedText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function reviewExtractedDocument(text, document, file) {
  const normalized = cleanExtractedText(text);
  const documentName = compactDocument(document).name;
  const type = classifyDocument(documentName, normalized);
  const extractedFields = extractCommonClaimFields(normalized);
  const estimate = extractEstimateFields(normalized);
  const coverage = extractCoverageFields(normalized);
  const conflicts = findFieldConflicts(file, extractedFields);
  const textQuality = assessTextQuality(normalized);
  const suggestedUses = suggestDocumentUses(type, extractedFields, estimate, coverage, textQuality);
  return {
    documentType: type,
    textQuality,
    extractedFields,
    estimate,
    coverage,
    conflictsWithJobNimbus: conflicts,
    suggestedUses,
    needsOcr: textQuality.needsOcr,
    notes: buildDocumentReviewNotes(type, textQuality, conflicts)
  };
}

function classifyDocument(name, text) {
  const haystack = `${name}\n${text}`.toLowerCase();
  if (/\b(declarations?|dec page|policy)\b/.test(haystack)) return "policy_or_declarations";
  if (/\btdi\b|texas department of insurance|property insurance notice/.test(haystack)) return "tdi_or_notice_form";
  if (/\bxactimate\b|estimate|replacement cost value|actual cash value|depreciation/.test(haystack)) return "estimate_or_scope";
  if (/\bappraisal\b|umpire|appraiser|demand/.test(haystack)) return "appraisal_document";
  if (/\bclaim number|claim #|loss date|date of loss|adjuster\b/.test(haystack)) return "carrier_claim_document";
  if (!text.trim()) return "unreadable_or_image_only";
  return "unknown_text_document";
}

function extractCommonClaimFields(text) {
  return cleanObject({
    carrier: firstMatch(text, [
      /(?:insurance company|insurer|company)\s*[:#-]?\s*([A-Z][A-Za-z0-9&.,' -]{2,70})/i,
      /\b(State Farm|Allstate|Travelers|Liberty Mutual|USAA|Texas Farm Bureau|Farmers|Nationwide|Progressive|Chubb|Safeco|National Summit)\b/i
    ]),
    policyNumber: normalizePolicy(firstMatch(text, [
      /(?:policy(?:\s*(?:number|no\.?|#))?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9 -]{4,40})/i,
      /\bpolicy\s+([A-Z0-9][A-Z0-9 -]{4,40})/i
    ])),
    claimNumber: normalizePolicy(firstMatch(text, [
      /(?:claim(?:\s*(?:number|no\.?|#))?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9 -]{4,40})/i,
      /\bclaim\s+([A-Z0-9][A-Z0-9 -]{4,40})/i
    ])),
    dateOfLoss: firstDate(text, [
      /(?:date of loss|loss date|dol)\s*[:#-]?\s*([A-Za-z0-9,/-]{6,24})/i
    ]),
    effectiveDate: firstDate(text, [
      /(?:effective date|policy period|coverage period)\s*[:#-]?\s*([A-Za-z0-9,/-]{6,24})/i
    ]),
    expirationDate: firstDate(text, [
      /(?:expiration date|expires|to)\s*[:#-]?\s*([A-Za-z0-9,/-]{6,24})/i
    ]),
    namedInsured: firstMatch(text, [
      /(?:named insured|insured name|insured)\s*[:#-]?\s*([A-Z][A-Za-z.,' -]{3,80})/i
    ]),
    propertyAddress: extractAddress(text),
    adjusterName: firstMatch(text, [
      /(?:adjuster|claims representative|claim representative)\s*[:#-]?\s*([A-Z][A-Za-z.' -]{3,60})/i
    ]),
    adjusterPhone: firstMatch(text, [
      /(?:adjuster|claims representative|phone|tel|mobile)[^\n]{0,40}?(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/i
    ]),
    adjusterEmail: firstMatch(text, [
      /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i
    ])
  });
}

function extractEstimateFields(text) {
  return cleanObject({
    rcv: firstMoney(text, [
      /(?:replacement cost value|rcv|total rcv)\s*[:#-]?\s*\$?\s*([\d,]+\.\d{2})/i
    ]),
    acv: firstMoney(text, [
      /(?:actual cash value|acv|total acv)\s*[:#-]?\s*\$?\s*([\d,]+\.\d{2})/i
    ]),
    depreciation: firstMoney(text, [
      /(?:depreciation|recoverable depreciation)\s*[:#-]?\s*\$?\s*([\d,]+\.\d{2})/i
    ]),
    deductible: firstMoney(text, [
      /(?:deductible)\s*[:#-]?\s*\$?\s*([\d,]+\.\d{2})/i
    ]),
    netClaim: firstMoney(text, [
      /(?:net claim|net actual cash value|net acv)\s*[:#-]?\s*\$?\s*([\d,]+\.\d{2})/i
    ])
  });
}

function extractCoverageFields(text) {
  return cleanObject({
    dwellingLimit: firstMoney(text, [
      /(?:dwelling|coverage a|cov a)[^\n$]{0,50}\$?\s*([\d,]+(?:\.\d{2})?)/i
    ]),
    otherStructuresLimit: firstMoney(text, [
      /(?:other structures|coverage b|cov b)[^\n$]{0,50}\$?\s*([\d,]+(?:\.\d{2})?)/i
    ]),
    personalPropertyLimit: firstMoney(text, [
      /(?:personal property|coverage c|cov c)[^\n$]{0,50}\$?\s*([\d,]+(?:\.\d{2})?)/i
    ]),
    lossOfUseLimit: firstMoney(text, [
      /(?:loss of use|coverage d|cov d)[^\n$]{0,50}\$?\s*([\d,]+(?:\.\d{2})?)/i
    ]),
    windHailDeductible: firstMoney(text, [
      /(?:wind\/hail|wind and hail|hail|wind)[^\n$]{0,80}(?:deductible)[^\n$]{0,40}\$?\s*([\d,]+(?:\.\d{2})?)/i
    ]),
    allOtherPerilsDeductible: firstMoney(text, [
      /(?:all other perils|aop)[^\n$]{0,80}(?:deductible)[^\n$]{0,40}\$?\s*([\d,]+(?:\.\d{2})?)/i
    ])
  });
}

function assessTextQuality(text) {
  const chars = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const hasUsefulText = words >= 25;
  return {
    chars,
    words,
    hasUsefulText,
    needsOcr: !hasUsefulText,
    confidence: hasUsefulText ? (words > 200 ? "high" : "medium") : "low"
  };
}

function suggestDocumentUses(type, fields, estimate, coverage, quality) {
  const uses = [];
  if (quality.needsOcr) uses.push("Needs OCR/visual review before relying on this document.");
  if (fields.policyNumber) uses.push("Can support updating/confirming JobNimbus policy number.");
  if (fields.claimNumber) uses.push("Can support updating/confirming JobNimbus claim number.");
  if (fields.dateOfLoss) uses.push("Can support date-of-loss confirmation.");
  if (fields.adjusterEmail || fields.adjusterPhone) uses.push("Can support adjuster contact cleanup.");
  if (Object.keys(estimate).length) uses.push("Can support estimate/payment/appraisal gap review.");
  if (Object.keys(coverage).length) uses.push("Can support coverage/deductible review.");
  if (type === "policy_or_declarations") uses.push("Use to verify active coverage period, named insured, policy number, and deductibles.");
  if (type === "estimate_or_scope") uses.push("Use to summarize scope totals and compare against carrier/payment.");
  return uses;
}

function buildDocumentReviewNotes(type, quality, conflicts) {
  const notes = [];
  if (quality.needsOcr) notes.push("No reliable text was extracted. This is probably scanned/photo-based or image-only.");
  if (conflicts.length) notes.push("Some extracted values conflict with existing JobNimbus fields; do not update without approval.");
  if (type === "unknown_text_document") notes.push("Document type was not confidently classified; review text preview before acting.");
  return notes;
}

function findFieldConflicts(file, fields) {
  const checks = [
    ["policyNumber", "policyNumber", "policy #"],
    ["claimNumber", "claimNumber", "claim #"],
    ["dateOfLoss", "dateOfLoss", "DOL"],
    ["carrier", "carrier", "carrier"]
  ];
  const conflicts = [];
  for (const [fileKey, fieldKey, label] of checks) {
    if (!file[fileKey] || !fields[fieldKey]) continue;
    if (normalizeCompare(file[fileKey]) !== normalizeCompare(fields[fieldKey])) {
      conflicts.push({ field: label, jobNimbus: file[fileKey], document: fields[fieldKey] });
    }
  }
  return conflicts;
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim().replace(/\s{2,}/g, " ");
  }
  return "";
}

function firstMoney(text, patterns) {
  const value = firstMatch(text, patterns);
  return value ? `$${value.replace(/[^\d.,]/g, "")}` : "";
}

function firstDate(text, patterns) {
  const value = firstMatch(text, patterns);
  return value ? value.replace(/\s{2,}/g, " ").trim() : "";
}

function normalizePolicy(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeCompare(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractAddress(text) {
  const match = text.match(/\b\d{2,6}\s+[A-Za-z0-9 .'-]+(?:st|street|rd|road|dr|drive|ave|avenue|ln|lane|ct|court|cir|circle|way|blvd|boulevard|trl|trail|pkwy|parkway)\b[^\n,]*(?:,\s*[A-Za-z .'-]+,\s*[A-Z]{2}\s*\d{5})?/i);
  return match ? match[0].trim().replace(/\s{2,}/g, " ") : "";
}

function isInsuranceFile(contact) {
  return String(contact.record_type_name || "").toLowerCase() === "insurance";
}

function assignedTo(contact, ownerId) {
  return (Array.isArray(contact.owners) ? contact.owners : []).some((owner) => String(owner?.id || owner?.jnid || owner) === ownerId);
}

function isOpenActive(contact) {
  return contact.is_active !== false && contact.is_archived !== true && contact.is_closed !== true;
}

function fileSort(a, b) {
  return Number(b.date_updated || 0) - Number(a.date_updated || 0);
}

function countBy(rows, keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = String(keyFn(row) || "Unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function collectIds(value, ids) {
  if (!value) return;
  if (typeof value === "string") ids.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectIds(v, ids));
  else if (typeof value === "object") {
    if (value.id) ids.push(value.id);
    if (value.jnid) ids.push(value.jnid);
  }
}

function normalizeHandoffPayload(input = {}) {
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {
    text: String(input.text || input.summary || input.message || "").trim()
  };
  const source = String(input.source || payload.source || "regular-chat").trim();
  const client = String(input.client || input.query || payload.client || payload.file || payload.name || "").trim();
  if (!client && !JSON.stringify(payload).trim()) badRequest("client or payload is required");
  return { source, client, payload };
}

function buildHandoffAssistantRead({ source, client, payload }) {
  const summary = String(payload.summary || payload.text || payload.message || "").trim();
  const recommendedActions = Array.isArray(payload.recommendedActions)
    ? payload.recommendedActions
    : Array.isArray(payload.recommended_actions)
      ? payload.recommended_actions
      : [];
  const sources = Array.isArray(payload.sources) ? payload.sources : Array.isArray(payload.source) ? payload.source : [source];
  const lines = [
    `Handoff source: ${sources.filter(Boolean).join(", ") || source}`,
    `Client/file: ${client || "unspecified"}`,
    summary ? `Summary: ${summary}` : "",
    payload.issue || payload.bottleneck ? `Issue/bottleneck: ${payload.issue || payload.bottleneck}` : "",
    recommendedActions.length ? `Recommended actions:\n${recommendedActions.map((item, index) => `${index + 1}. ${String(item)}`).join("\n")}` : "",
    payload.needsApproval !== undefined ? `Needs approval: ${Boolean(payload.needsApproval || payload.needs_approval)}` : "",
    `Raw payload: ${JSON.stringify(payload, null, 2)}`
  ].filter(Boolean);
  return lines.join("\n");
}

async function readHandoffStore() {
  try {
    const raw = await readFile(HANDOFF_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeHandoffStore(handoffs) {
  await mkdir(path.dirname(HANDOFF_STORE_PATH), { recursive: true });
  await writeFile(HANDOFF_STORE_PATH, JSON.stringify(handoffs.slice(0, 500), null, 2));
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeUploadId(value) {
  const uploadId = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(uploadId)) badRequest("uploadId may only contain letters, numbers, underscore, or hyphen");
  return uploadId;
}

async function findHandoffById(id) {
  const handoffs = await readHandoffStore();
  const handoff = handoffs.find((row) => row.id === id);
  if (!handoff) badRequest(`No handoff found for id: ${id}`);
  return handoff;
}

function extractHandoffJobNimbusUpdate(handoff, input = {}) {
  const payload = handoff?.payload && typeof handoff.payload === "object" ? handoff.payload : {};
  const update = payload.jobNimbusUpdate || payload.jobNimbus_update || payload.jobnimbusUpdate;
  const directUpdate = payload.query || payload.fields || payload.status || payload.note
    ? {
        query: payload.query,
        fields: payload.fields,
        status: payload.status,
        note: payload.note,
        execute: payload.execute
      }
    : null;
  const selected = update && typeof update === "object" ? update : directUpdate;
  if (!selected) return null;
  return cleanObject({
    ...selected,
    query: input.query || selected.query || selected.job || selected.client || handoff.client,
    fields: input.fields || selected.fields,
    status: input.status || input.statusName || input.workflowStatus || selected.status || selected.statusName || selected.workflowStatus,
    note: input.note || input.internalNote || selected.note || selected.internalNote,
    execute: input.execute === true || selected.execute === true
  });
}

async function markHandoffComplete(id, completionNote = "") {
  const handoffs = await readHandoffStore();
  const handoff = handoffs.find((row) => row.id === id);
  if (!handoff) badRequest(`No handoff found for id: ${id}`);
  handoff.status = "completed";
  handoff.completedAt = new Date().toISOString();
  handoff.updatedAt = handoff.completedAt;
  handoff.completionNote = completionNote;
  await writeHandoffStore(handoffs);
  return handoff;
}

async function jobNimbus(endpoint, options = {}) {
  if (!API_KEY) badRequest("JOBNIMBUS_API_KEY is not configured.");
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!response.ok) {
    const error = new Error(`JobNimbus API ${response.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
    error.statusCode = response.status;
    throw error;
  }
  return json;
}

async function gmailApi(endpoint, options = {}) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    badRequest("Gmail is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in Render.");
  }
  const token = await getGoogleAccessToken();
  const response = await fetch(`https://gmail.googleapis.com${endpoint}`, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!response.ok) {
    const error = new Error(`Gmail API ${response.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
    error.statusCode = response.status;
    throw error;
  }
  return json;
}

async function getGoogleAccessToken() {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    const error = new Error(`Google OAuth ${response.status}: ${JSON.stringify(json)}`);
    error.statusCode = response.status;
    throw error;
  }
  return json.access_token;
}

function compactGmailMessage(message) {
  const headers = gmailHeaders(message);
  return {
    id: message.id || "",
    threadId: message.threadId || "",
    historyId: message.historyId || "",
    internalDate: message.internalDate || "",
    date: headers.date || "",
    from: headers.from || "",
    to: headers.to || "",
    cc: headers.cc || "",
    subject: headers.subject || "",
    snippet: message.snippet || ""
  };
}

function compactGmailFullMessage(message) {
  return {
    ...compactGmailMessage(message),
    plainText: extractGmailBody(message.payload, "text/plain").slice(0, 12000),
    htmlText: stripHtml(extractGmailBody(message.payload, "text/html")).slice(0, 6000),
    attachments: listGmailAttachments(message.payload)
  };
}

function compactGmailDraft(draft) {
  return {
    id: draft.id || "",
    message: draft.message ? compactGmailMessage(draft.message) : null
  };
}

function gmailHeaders(message) {
  const headers = Array.isArray(message?.payload?.headers) ? message.payload.headers : [];
  const out = {};
  for (const header of headers) {
    const key = String(header.name || "").toLowerCase();
    if (["from", "to", "cc", "subject", "date"].includes(key)) out[key] = header.value || "";
  }
  return out;
}

function groupGmailMessagesByThread(messages) {
  const map = new Map();
  for (const message of messages) {
    if (!map.has(message.threadId)) {
      map.set(message.threadId, {
        threadId: message.threadId,
        subject: message.subject,
        from: message.from,
        date: message.date,
        latestSnippet: message.snippet,
        messageIds: []
      });
    }
    map.get(message.threadId).messageIds.push(message.id);
  }
  return [...map.values()];
}

function buildGmailAssistantRead(messages) {
  const latest = messages[messages.length - 1] || {};
  const combined = messages
    .map((message) => `From: ${message.from}\nDate: ${message.date}\nSubject: ${message.subject}\n${message.plainText || message.htmlText || message.snippet}`)
    .join("\n\n---\n\n");
  return {
    latestFrom: latest.from || "",
    latestDate: latest.date || "",
    latestSubject: latest.subject || "",
    possibleClaimNumbers: uniqueMatches(combined, /\b(?:claim(?:\s*(?:number|no\.?|#))?\s*[:#-]?\s*)?([A-Z0-9]{2,4}[- ]?[A-Z0-9]{3,6}[- ]?[A-Z0-9]{2,6})\b/gi, 1).slice(0, 10),
    possiblePolicyNumbers: uniqueMatches(combined, /\b(?:policy(?:\s*(?:number|no\.?|#))?\s*[:#-]?\s*)?([A-Z0-9][A-Z0-9 -]{5,40})\b/gi, 1).slice(0, 10),
    emails: uniqueMatches(combined, /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi, 1).slice(0, 20),
    phones: uniqueMatches(combined, /(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g, 1).slice(0, 20),
    attachmentCount: messages.reduce((sum, message) => sum + message.attachments.length, 0)
  };
}

function extractGmailBody(part, mimeType) {
  if (!part) return "";
  const chunks = [];
  walkGmailParts(part, (item) => {
    if (item.mimeType === mimeType && item.body?.data) chunks.push(base64UrlDecode(item.body.data));
  });
  return cleanExtractedText(chunks.join("\n\n"));
}

function listGmailAttachments(part) {
  const attachments = [];
  walkGmailParts(part, (item) => {
    if (item.filename && item.body?.attachmentId) {
      attachments.push({
        filename: item.filename,
        mimeType: item.mimeType || "",
        attachmentId: item.body.attachmentId,
        size: item.body.size || 0
      });
    }
  });
  return attachments;
}

function walkGmailParts(part, visitor) {
  visitor(part);
  for (const child of Array.isArray(part.parts) ? part.parts : []) walkGmailParts(child, visitor);
}

function buildRawEmail({ to, cc, bcc, subject, body }) {
  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    bcc ? `Bcc: ${bcc}` : "",
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8"
  ].filter(Boolean);
  return base64UrlEncode(`${headers.join("\r\n")}\r\n\r\n${body}`);
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function base64UrlEncode(value) {
  return Buffer.from(String(value || ""), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function uniqueMatches(text, pattern, group = 0) {
  const seen = new Set();
  const out = [];
  for (const match of String(text || "").matchAll(pattern)) {
    const value = String(match[group] || "").trim();
    const key = normalizeCompare(value);
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function contactMatches(contact, query) {
  const haystack = [
    contact.jnid,
    contact.id,
    contact.number,
    contact.recid,
    contact.display_name,
    contact.name,
    contact.description,
    contact.first_name,
    contact.last_name,
    contact.email,
    contact.home_phone,
    contact.mobile_phone,
    contact.work_phone,
    contact.address_line1,
    contact.city,
    contact.state_text,
    contact.zip,
    contact.cf_string_1,
    contact.cf_string_2,
    contact.cf_string_4,
    contact["Insurance Company"],
    contact["Claim #"],
    contact["Policy #"]
  ].filter(Boolean).join(" ").toLowerCase();
  const fullRecord = safeStringify(contact).toLowerCase();
  return haystack.includes(query) || fullRecord.includes(query);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) || "";
  } catch {
    return "";
  }
}

function fieldValue(record, names) {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null && record[name] !== "") return record[name];
  }
  const lowerMap = new Map(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));
  for (const name of names) {
    const value = lowerMap.get(String(name).toLowerCase());
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function compactContact(contact) {
  return {
    id: contact.jnid || contact.id,
    number: contact.number || String(contact.recid || ""),
    name: contact.display_name || [contact.first_name, contact.last_name].filter(Boolean).join(" "),
    status: contact.status_name || "",
    address: [contact.address_line1, contact.city, contact.state_text, contact.zip].filter(Boolean).join(", "),
    phone: contact.mobile_phone || contact.home_phone || contact.work_phone || "",
    email: contact.email || "",
    carrier: fieldValue(contact, ["Insurance Company", "Carrier", "insurance_company", "cf_string_1"]),
    claimNumber: fieldValue(contact, ["Claim #", "Claim Number", "claim_number", "cf_string_10", "cf_string_2"]),
    policyNumber: fieldValue(contact, ["Policy #", "Policy Number", "policy_number", "cf_string_4", "cf_string_3"]),
    typeOfLoss: fieldValue(contact, ["Type Of Loss", "Type of Loss", "Cause of Loss", "cf_string_5"]),
    dateOfLoss: fieldValue(contact, ["Date of Loss", "DOL", "cf_date_1"]),
    adjusterName: fieldValue(contact, ["Carrier DA", "Carrier Adjuster", "Adjuster", "cf_string_7"]),
    adjusterPhone: fieldValue(contact, ["Carrier DA Contact #", "Adjuster Phone", "cf_string_8"]),
    adjusterEmail: fieldValue(contact, ["Carrier DA Email", "Adjuster Email", "cf_string_9"])
  };
}

function compactActivity(activity) {
  return {
    id: activity.jnid || activity.id,
    dateCreated: activity.date_created || "",
    type: activity.record_type_name || activity.type || "",
    note: activity.note || activity.description || ""
  };
}

function compactTask(task) {
  return {
    id: task.jnid || task.id,
    title: task.title || task.subject || "",
    dueDate: task.date_start || task.date_end || "",
    completed: Boolean(task.is_completed)
  };
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function normalizeDateFields(fields) {
  const body = { ...fields };
  for (const [inputKey, outputKey] of [
    ["dateStart", "date_start"],
    ["start", "date_start"],
    ["dueDate", "date_start"],
    ["dateEnd", "date_end"],
    ["end", "date_end"]
  ]) {
    if (body[inputKey] !== undefined) {
      body[outputKey] = toUnixSeconds(body[inputKey]);
      delete body[inputKey];
    }
  }
  return cleanObject(body);
}

function toUnixSeconds(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 9999999999 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return toUnixSeconds(Number(text));
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) badRequest(`Invalid date/time: ${value}`);
  return Math.floor(parsed / 1000);
}

function compactDocument(doc) {
  return {
    id: doc.jnid || doc.id,
    name: doc.name || doc.filename || doc.file_name || "",
    type: doc.record_type_name || doc.type || ""
  };
}

function buildAssistantRead(contact, activities, tasks, documents) {
  const file = compactContact(contact);
  const missing = [];
  if (!file.carrier) missing.push("carrier");
  if (!file.policyNumber) missing.push("policy number");
  if (!file.claimNumber) missing.push("claim number");
  if (!file.dateOfLoss) missing.push("date of loss");
  if (!file.adjusterName && !file.adjusterPhone && !file.adjusterEmail) missing.push("adjuster contact");
  return {
    missingInfo: missing,
    likelyStage: file.status || "unknown",
    nextAction: missing.includes("claim number") ? "Prepare or confirm claim filing." : "Review recent activity and push the next carrier/appraisal step.",
    documentNames: documents.slice(0, 20).map((doc) => compactDocument(doc).name),
    recentNoteCount: activities.length,
    openTaskCount: tasks.filter((task) => !task.is_completed).length
  };
}

function authorized(req) {
  if (!BRIDGE_TOKEN) return true;
  return req.headers.authorization === `Bearer ${BRIDGE_TOKEN}`;
}

function isPublicRoute(method, pathname) {
  return (method === "GET" && ["/openapi.json", "/privacy", "/handoff", "/voice/twiml"].includes(pathname))
    || (method === "POST" && ["/handoff", "/handoff/chunk"].includes(pathname));
}

function bridgeTwilioToOpenAI(twilioSocket, req) {
  let streamSid = "";
  let callSid = "";
  const callId = voiceCallId(req);
  const log = ensureVoiceCallLog(callId, {
    goal: voiceContext(req).goal,
    prompt: voiceContext(req).prompt,
    voice: voiceContext(req).voice
  });
  let assistantTranscript = "";
  let openAiReady = false;
  let twilioStarted = false;
  let greetingSent = false;
  let assistantSpeaking = false;
  let closed = false;

  if (!OPENAI_API_KEY) {
    twilioSocket.close(1011, "OPENAI_API_KEY is not configured");
    return;
  }

  const openAiSocket = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    {
      headers: openAiRealtimeHeaders()
    }
  );

  openAiSocket.on("open", () => {
    sendOpenAI(openAiSocket, {
      type: "session.update",
      session: {
        type: "realtime",
        model: OPENAI_REALTIME_MODEL,
        instructions: voiceInstructions(req),
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: {
              model: OPENAI_INPUT_TRANSCRIPTION_MODEL
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 700
            }
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: voiceContext(req).voice
          }
        }
      }
    });
  });

  openAiSocket.on("message", (raw) => {
    const event = parseSocketJson(raw);
    if (!event) return;

    if (event.type === "session.updated") {
      openAiReady = true;
      maybeSendGreeting();
      return;
    }

    if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
      if (!streamSid || !event.delta) return;
      assistantSpeaking = true;
      sendTwilio(twilioSocket, {
        event: "media",
        streamSid,
        media: { payload: event.delta }
      });
      return;
    }

    if (event.type === "response.audio_transcript.delta" || event.type === "response.output_audio_transcript.delta") {
      if (event.delta) assistantTranscript += event.delta;
      return;
    }

    if (event.type === "response.done") {
      assistantSpeaking = false;
      if (assistantTranscript.trim()) {
        appendVoiceTurn(log, "assistant", assistantTranscript.trim());
        assistantTranscript = "";
      }
      console.log(JSON.stringify({
        type: "openai_response_done",
        status: event.response?.status || null
      }));
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      appendVoiceTurn(log, "caller", event.transcript.trim());
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      if (assistantSpeaking && streamSid) {
        sendTwilio(twilioSocket, { event: "clear", streamSid });
        sendOpenAI(openAiSocket, { type: "response.cancel" });
      }
      return;
    }

    if (event.type === "error") {
      console.log(JSON.stringify({
        type: "openai_realtime_error",
        message: event.error?.message || "unknown error",
        code: event.error?.code || null
      }));
    }
  });

  openAiSocket.on("error", (error) => {
    console.log(JSON.stringify({ type: "openai_socket_error", message: error.message }));
  });
  openAiSocket.on("close", (code, reason) => {
    console.log(JSON.stringify({
      type: "openai_socket_closed",
      code,
      reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "")
    }));
    cleanup();
  });

  twilioSocket.on("message", (raw) => {
    const event = parseSocketJson(raw);
    if (!event) return;

    if (event.event === "start") {
      streamSid = event.start?.streamSid || "";
      callSid = event.start?.callSid || "";
      log.twilioCallSid = callSid;
      log.streamSid = streamSid;
      log.status = "connected";
      log.updatedAt = new Date().toISOString();
      twilioStarted = true;
      console.log(JSON.stringify({ type: "twilio_stream_started", callSid, streamSid }));
      maybeSendGreeting();
      return;
    }

    if (event.event === "media") {
      if (!event.media?.payload) return;
      sendOpenAI(openAiSocket, {
        type: "input_audio_buffer.append",
        audio: event.media.payload
      });
      return;
    }

    if (event.event === "stop") {
      log.status = "stopped";
      log.updatedAt = new Date().toISOString();
      console.log(JSON.stringify({ type: "twilio_stream_stopped", callSid, streamSid }));
      cleanup();
    }
  });

  twilioSocket.on("error", (error) => {
    console.log(JSON.stringify({ type: "twilio_socket_error", message: error.message }));
  });
  twilioSocket.on("close", (code, reason) => {
    console.log(JSON.stringify({
      type: "twilio_socket_closed",
      callSid,
      streamSid,
      code,
      reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "")
    }));
    cleanup();
  });

  function maybeSendGreeting() {
    if (greetingSent || !openAiReady || !twilioStarted) return;
    greetingSent = true;
    sendOpenAI(openAiSocket, {
      type: "response.create",
      response: {
        instructions: "Start the call now using the call context. Keep it short."
      }
    });
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    log.status = log.status === "connected" ? "closed" : log.status;
    log.updatedAt = new Date().toISOString();
    if (openAiSocket.readyState === WebSocket.OPEN || openAiSocket.readyState === WebSocket.CONNECTING) {
      openAiSocket.close();
    }
    if (twilioSocket.readyState === WebSocket.OPEN || twilioSocket.readyState === WebSocket.CONNECTING) {
      twilioSocket.close();
    }
  }
}

function openAiRealtimeHeaders() {
  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}` };
  if (!/^gpt-realtime-2(?:$|-)/.test(OPENAI_REALTIME_MODEL)) {
    headers["OpenAI-Beta"] = "realtime=v1";
  }
  return headers;
}

function voiceContext(req) {
  const url = new URL(req.url || "/", "http://localhost");
  return {
    callId: url.searchParams.get("callId") || "",
    goal: url.searchParams.get("goal") || "test",
    prompt: url.searchParams.get("prompt") || "",
    voice: normalizeRealtimeVoice(url.searchParams.get("voice") || OPENAI_VOICE)
  };
}

function voiceCallId(req) {
  return voiceContext(req).callId || randomUUID();
}

function voiceInstructions(req) {
  const { goal, prompt } = voiceContext(req);
  return [
    "You are Chance Pearson's live voice assistant for property insurance claim operations.",
    "This call may be a test unless the call context clearly says otherwise.",
    "Speak naturally in short sentences. Ask one question at a time.",
    "If calling a carrier, immediately state the purpose of the call and use only the verified claim packet facts in the call context.",
    "If this is a test call, say you are testing the live phone connection and ask Chance one simple confirmation question.",
    "Do not mention internal tools, APIs, tokens, or implementation details.",
    "Do not claim to be the homeowner. If asked who you are, say you are assisting Chance Pearson.",
    "For a test call, start by saying: Hey Chance, the OpenAI voice connection is live. I can hear you when you speak.",
    `Call goal: ${goal}`,
    prompt ? `Additional call context: ${prompt}` : ""
  ].filter(Boolean).join("\n\n");
}

function voiceStreamUrl() {
  const base = VOICE_PUBLIC_BASE_URL || PUBLIC_BASE_URL;
  const url = `${base.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}${VOICE_STREAM_PATH}`;
  if (!VOICE_STREAM_TOKEN) return url;
  return `${url}/${encodeURIComponent(VOICE_STREAM_TOKEN)}`;
}

function voiceStreamUrlWithContext({ goal, prompt, voice, callId }) {
  const parsed = new URL(voiceStreamUrl());
  if (callId) parsed.searchParams.set("callId", String(callId));
  if (goal) parsed.searchParams.set("goal", String(goal).slice(0, 160));
  if (prompt) parsed.searchParams.set("prompt", String(prompt).slice(0, 1200));
  if (voice) parsed.searchParams.set("voice", normalizeRealtimeVoice(voice));
  return parsed.toString();
}

function voiceStreamAuthorized(url) {
  if (!VOICE_STREAM_TOKEN) return true;
  const pathToken = url.pathname.startsWith(`${VOICE_STREAM_PATH}/`)
    ? decodeURIComponent(url.pathname.slice(`${VOICE_STREAM_PATH}/`.length))
    : "";
  return pathToken === VOICE_STREAM_TOKEN || url.searchParams.get("token") === VOICE_STREAM_TOKEN;
}

function normalizeRealtimeVoice(value) {
  const voice = String(value || "").trim().toLowerCase();
  return REALTIME_VOICES.has(voice) ? voice : OPENAI_VOICE;
}

function initVoiceCallLog(callId, context) {
  const log = ensureVoiceCallLog(callId, context);
  log.status = "created";
  log.updatedAt = new Date().toISOString();
  return log;
}

function ensureVoiceCallLog(callId, context = {}) {
  const id = callId || randomUUID();
  if (!voiceCallLogs.has(id)) {
    voiceCallLogs.set(id, {
      callId: id,
      twilioCallSid: "",
      streamSid: "",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      context: cleanObject({
        to: context.to,
        from: context.from,
        goal: context.goal,
        prompt: context.prompt ? "[set]" : "",
        voice: context.voice
      }),
      turns: []
    });
  }
  return voiceCallLogs.get(id);
}

function appendVoiceTurn(log, speaker, text) {
  const cleanText = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleanText) return;
  log.turns.push({
    speaker,
    text: cleanText,
    at: new Date().toISOString()
  });
  log.updatedAt = new Date().toISOString();
}

function summarizeVoiceCallLog(log) {
  return {
    callId: log.callId,
    twilioCallSid: log.twilioCallSid,
    streamSid: log.streamSid,
    status: log.status,
    createdAt: log.createdAt,
    updatedAt: log.updatedAt,
    context: log.context,
    turnCount: log.turns.length
  };
}

async function createTwilioRealtimeCall({ to, from, streamUrl }) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls.json`;
  const body = new URLSearchParams({
    To: to,
    From: from,
    Twiml: [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<Response>",
      "  <Connect>",
      `    <Stream url="${escapeXml(streamUrl)}" />`,
      "  </Connect>",
      "</Response>"
    ].join("")
  });

  if (TWILIO_STATUS_CALLBACK_URL) {
    body.set("StatusCallback", TWILIO_STATUS_CALLBACK_URL);
    body.set("StatusCallbackEvent", "initiated ringing answered completed");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!response.ok) {
    const error = new Error(json.message || `Twilio call failed with HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  return json;
}

function normalizePhone(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("+")) return `+${text.slice(1).replace(/\D/g, "")}`;
  const digits = text.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return text;
}

function sendOpenAI(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function sendTwilio(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function parseSocketJson(raw) {
  try {
    return JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
  } catch {
    return null;
  }
}

async function readJson(req) {
  let raw = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BODY_BYTES) {
      const error = new Error(`Request body too large. Limit is ${MAX_JSON_BODY_BYTES} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    raw += chunk;
  }
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { badRequest("Request body must be valid JSON."); }
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text) badRequest(`${name} is required`);
  return text;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function clamp(value, min, max) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}

const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "JobNimbus ChatGPT Bridge", version: "0.1.0" },
  servers: [{ url: "https://jobnimbus-chatgpt-bridge.onrender.com" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: {
      SearchRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, JobNimbus number, claim number, policy number, phone, email, or address to search for." },
          limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
          maxPages: { type: "integer", minimum: 1, maximum: 25, default: 10 }
        },
        required: ["query"]
      },
      ReviewFileRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, JobNimbus number, claim number, policy number, phone, email, or address for the file to review." }
        },
        required: ["query"]
      },
      AssignedFilesRequest: {
        type: "object",
        properties: {
          ownerId: { type: "string", description: "JobNimbus owner/user id. Defaults to Chance Pearson." },
          activeOnly: { type: "boolean", default: true, description: "When true, excludes closed, archived, and inactive files." },
          limit: { type: "integer", minimum: 1, maximum: 250, default: 100 },
          maxPages: { type: "integer", minimum: 1, maximum: 25, default: 25 }
        }
      },
      AssignedCountsRequest: {
        type: "object",
        properties: {
          ownerId: { type: "string", description: "JobNimbus owner/user id. Defaults to Chance Pearson." },
          sampleLimit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          maxPages: { type: "integer", minimum: 1, maximum: 25, default: 25 }
        }
      },
      DocumentTextRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          documentQuery: { type: "string", description: "Document id, name, or partial filename. If omitted, the first related document is used." },
          maxChars: { type: "integer", minimum: 1000, maximum: 50000, default: 12000 },
          forceOcr: { type: "boolean", default: false, description: "When true, OCR is attempted even if PDF text extraction finds text." },
          maxOcrPages: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "Maximum PDF pages to OCR." }
        },
        required: ["query"]
      },
      DocumentReviewRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          documentQuery: { type: "string", description: "Document id, name, or partial filename. If omitted, the first related document is used." },
          maxChars: { type: "integer", minimum: 1000, maximum: 50000, default: 20000 },
          previewChars: { type: "integer", minimum: 500, maximum: 12000, default: 4000 },
          forceOcr: { type: "boolean", default: false, description: "When true, OCR is attempted even if PDF text extraction finds text." },
          maxOcrPages: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "Maximum PDF pages to OCR." }
        },
        required: ["query"]
      },
      UpdateContactRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          fields: { type: "object", additionalProperties: true, description: "Exact JobNimbus contact fields to update. Use for claim number, carrier, policy number, adjuster name, adjuster phone, adjuster email, date of loss, and known custom field keys." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["query", "fields"]
      },
      UpdateStatusRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          status: { type: "string", description: "JobNimbus workflow/status name, such as Submitted Awaiting Confirmation or Awaiting 2 Key Confirmations." },
          statusName: { type: "string", description: "Alias for status." },
          workflowStatus: { type: "string", description: "Alias for status." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["query", "status"]
      },
      ProcessUpdateRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier. Can be name, JobNimbus number, claim number, policy number, phone, email, or address." },
          job: { type: "string", description: "Alias for query." },
          client: { type: "string", description: "Alias for query." },
          fields: {
            type: "object",
            additionalProperties: true,
            description: "Exact JobNimbus contact fields to update. Use known field keys for claim number, carrier, policy number, adjuster name/phone/email, date of loss, and custom fields."
          },
          status: { type: "string", description: "Optional JobNimbus workflow/status name to set." },
          statusName: { type: "string", description: "Alias for status." },
          workflowStatus: { type: "string", description: "Alias for status." },
          note: { type: "string", description: "Optional internal JobNimbus note to create." },
          internalNote: { type: "string", description: "Alias for note." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run plan only. True requires bridge writes to be enabled." }
        }
      },
      CreateNoteRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          note: { type: "string", description: "Short JobNimbus note text." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["query", "note"]
      },
      CreateTaskRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          title: { type: "string", description: "Task title." },
          description: { type: "string", description: "Task details." },
          note: { type: "string", description: "Optional task note/details." },
          dueDate: { type: "string", description: "Due date/time as ISO string, natural date string, or Unix timestamp." },
          dateStart: { type: "string", description: "Start date/time as ISO string, natural date string, or Unix timestamp." },
          dateEnd: { type: "string", description: "End date/time as ISO string, natural date string, or Unix timestamp." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["query", "title"]
      },
      UpdateTaskRequest: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "JobNimbus task id." },
          fields: { type: "object", additionalProperties: true, description: "Task fields to update. Supports dateStart/dateEnd/dueDate aliases." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["taskId", "fields"]
      },
      CreateCalendarEventRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          title: { type: "string", description: "Calendar event title." },
          dateStart: { type: "string", description: "Start date/time as ISO string, natural date string, or Unix timestamp." },
          dateEnd: { type: "string", description: "End date/time as ISO string, natural date string, or Unix timestamp." },
          location: { type: "string", description: "Event location. Defaults to the file property address." },
          description: { type: "string", description: "Event details." },
          note: { type: "string", description: "Optional event note/details." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["query", "title", "dateStart"]
      },
      UpdateCalendarEventRequest: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "JobNimbus activity/event id." },
          fields: { type: "object", additionalProperties: true, description: "Calendar event fields to update. Supports dateStart/dateEnd aliases." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["eventId", "fields"]
      },
      GmailSearchRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query. Use Gmail operators like from:, to:, subject:, newer_than:, older_than:, has:attachment, or plain client/claim terms." },
          limit: { type: "integer", minimum: 1, maximum: 25, default: 10 }
        },
        required: ["query"]
      },
      GmailThreadRequest: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Gmail thread id returned by searchGmail." }
        },
        required: ["threadId"]
      },
      GmailMessageRequest: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address or comma-separated addresses." },
          cc: { type: "string", description: "Optional CC recipients." },
          bcc: { type: "string", description: "Optional BCC recipients." },
          subject: { type: "string", description: "Email subject. For insurance emails, use claim number only when applicable." },
          body: { type: "string", description: "Plain text email body." },
          threadId: { type: "string", description: "Optional Gmail thread id to reply in an existing thread." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["to", "subject", "body"]
      },
      VoiceCallRequest: {
        type: "object",
        properties: {
          to: { type: "string", description: "Destination phone number in E.164 or US 10-digit format. Defaults to the configured verified test number if omitted." },
          from: { type: "string", description: "Optional Twilio from number. Defaults to configured TWILIO_FROM_NUMBER." },
          goal: { type: "string", description: "Short call goal, such as file_new_claim, claim_status, or test." },
          voice: { type: "string", description: "Optional OpenAI Realtime voice. Use cedar for the best deeper/more masculine test voice; marin and cedar are recommended quality voices." },
          prompt: { type: "string", description: "Concise but complete call packet. Include: who the assistant is, exact call purpose, insured/property/carrier/policy/DOL/claim facts, what to ask for, what to avoid saying, and the desired result. Keep it focused to control OpenAI voice usage." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True places the call and requires explicit user approval plus ALLOW_VOICE_CALLS=true." }
        }
      },
      VoiceTranscriptRequest: {
        type: "object",
        properties: {
          callId: { type: "string", description: "Bridge call id returned by placeRealtimeVoiceCall." },
          sid: { type: "string", description: "Twilio call SID returned by placeRealtimeVoiceCall." },
          twilioCallSid: { type: "string", description: "Alias for sid." }
        }
      },
      CreateHandoffRequest: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source system or chat, such as regular-chat, gmail, quo, or ChatGPT Gmail/Quo chat." },
          client: { type: "string", description: "Optional client/file name, JobNimbus number, claim number, policy number, phone, email, or address." },
          payload: {
            type: "object",
            additionalProperties: true,
            description: "Structured handoff payload from another chat. Include summary, source details, recommendedActions, needsApproval, drafts, or raw text."
          },
          text: { type: "string", description: "Plain text handoff if no structured payload is available." }
        }
      },
      CreateHandoffChunkRequest: {
        type: "object",
        properties: {
          uploadId: { type: "string", description: "Optional upload id returned from the first chunk. Omit on the first chunk." },
          source: { type: "string", description: "Source system or chat, such as regular-chat, gmail, quo, or ChatGPT Gmail/Quo chat." },
          client: { type: "string", description: "Optional client/file name, JobNimbus number, claim number, policy number, phone, email, or address." },
          index: { type: "integer", minimum: 0, description: "Zero-based chunk index." },
          total: { type: "integer", minimum: 1, maximum: 1000, description: "Total number of chunks in the upload." },
          chunk: { type: "string", description: "Raw JSON/text slice for this chunk. The bridge assembles all chunks and creates one handoff." }
        },
        required: ["index", "total", "chunk"]
      },
      PendingHandoffsRequest: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          query: { type: "string", description: "Optional client/file search over pending handoffs." },
          client: { type: "string", description: "Optional client/file search over pending handoffs." },
          includeCompleted: { type: "boolean", default: false }
        }
      },
      GetHandoffRequest: {
        type: "object",
        properties: {
          id: { type: "string", description: "Handoff id returned by createHandoff or listPendingHandoffs." },
          handoffId: { type: "string", description: "Alias for id." }
        }
      },
      ProcessHandoffRequest: {
        type: "object",
        properties: {
          id: { type: "string", description: "Handoff id returned by createHandoff or listPendingHandoffs." },
          handoffId: { type: "string", description: "Alias for id." },
          query: { type: "string", description: "Override file/client identifier if the handoff did not include one." },
          fields: { type: "object", additionalProperties: true, description: "Override or provide exact JobNimbus contact fields to update." },
          status: { type: "string", description: "Override or provide JobNimbus workflow/status name to set." },
          statusName: { type: "string", description: "Alias for status." },
          workflowStatus: { type: "string", description: "Alias for status." },
          note: { type: "string", description: "Override or provide internal JobNimbus note text." },
          internalNote: { type: "string", description: "Alias for note." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." },
          completeOnSuccess: { type: "boolean", default: true, description: "When executing, mark the handoff completed after a successful update." },
          completionNote: { type: "string", description: "Optional note saved when marking the handoff complete." }
        }
      },
      CompleteHandoffRequest: {
        type: "object",
        properties: {
          id: { type: "string", description: "Handoff id returned by listPendingHandoffs." },
          handoffId: { type: "string", description: "Alias for id." },
          completionNote: { type: "string", description: "Optional note describing how the handoff was processed." },
          note: { type: "string", description: "Alias for completionNote." }
        }
      }
    }
  },
  paths: {
    "/health": { get: { operationId: "health", responses: { "200": { description: "OK" } } } },
    "/privacy": { get: { operationId: "privacy", responses: { "200": { description: "Privacy policy" } } } },
    "/voice/outbound-call": {
      post: {
        operationId: "placeRealtimeVoiceCall",
        requestBody: jsonBody("VoiceCallRequest"),
        responses: { "200": { description: "Dry-run plan or executed Twilio/OpenAI realtime voice call." } }
      }
    },
    "/voice/transcript": {
      post: {
        operationId: "getVoiceCallTranscript",
        requestBody: jsonBody("VoiceTranscriptRequest"),
        responses: { "200": { description: "Returns the stored transcript for a recent Twilio/OpenAI realtime voice call." } }
      }
    },
    "/handoff": {
      get: {
        operationId: "handoffInboxPage",
        security: [],
        responses: { "200": { description: "Human paste-in page for Gmail/Quo handoffs." } }
      },
      post: {
        operationId: "createHandoff",
        requestBody: jsonBody("CreateHandoffRequest"),
        responses: { "200": { description: "Created handoff for the JobNimbus assistant to process." } }
      }
    },
    "/handoff/chunk": {
      post: {
        operationId: "createHandoffChunk",
        security: [],
        requestBody: jsonBody("CreateHandoffChunkRequest"),
        responses: { "200": { description: "Receives one large handoff chunk and creates the handoff when all chunks arrive." } }
      }
    },
    "/handoff/pending": {
      post: {
        operationId: "listPendingHandoffs",
        requestBody: jsonBody("PendingHandoffsRequest"),
        responses: { "200": { description: "Pending handoffs from Gmail/Quo or other chats." } }
      }
    },
    "/handoff/get": {
      post: {
        operationId: "getHandoff",
        requestBody: jsonBody("GetHandoffRequest"),
        responses: { "200": { description: "Returns one handoff by id." } }
      }
    },
    "/handoff/process": {
      post: {
        operationId: "processHandoff",
        requestBody: jsonBody("ProcessHandoffRequest"),
        responses: { "200": { description: "Dry-runs or executes a JobNimbus update embedded in a handoff." } }
      }
    },
    "/handoff/complete": {
      post: {
        operationId: "completeHandoff",
        requestBody: jsonBody("CompleteHandoffRequest"),
        responses: { "200": { description: "Marks a handoff as completed after it is processed." } }
      }
    },
    "/jobnimbus/search": {
      post: {
        operationId: "searchJobNimbus",
        requestBody: jsonBody("SearchRequest"),
        responses: { "200": { description: "Matches" } }
      }
    },
    "/jobnimbus/review-file": {
      post: {
        operationId: "reviewJobNimbusFile",
        requestBody: jsonBody("ReviewFileRequest"),
        responses: { "200": { description: "File review" } }
      }
    },
    "/jobnimbus/assigned-files": {
      post: {
        operationId: "listAssignedJobNimbusFiles",
        requestBody: jsonBody("AssignedFilesRequest"),
        responses: { "200": { description: "Assigned JobNimbus files" } }
      }
    },
    "/jobnimbus/assigned-counts": {
      post: {
        operationId: "countAssignedJobNimbusFiles",
        requestBody: jsonBody("AssignedCountsRequest"),
        responses: { "200": { description: "Assigned JobNimbus counts and grouping" } }
      }
    },
    "/jobnimbus/document-text": {
      post: {
        operationId: "extractJobNimbusDocumentText",
        requestBody: jsonBody("DocumentTextRequest"),
        responses: { "200": { description: "Extracted text from a related JobNimbus document when supported." } }
      }
    },
    "/jobnimbus/document-review": {
      post: {
        operationId: "reviewJobNimbusDocument",
        requestBody: jsonBody("DocumentReviewRequest"),
        responses: { "200": { description: "No-API document review with extracted text preview, likely fields, conflicts, and suggested uses." } }
      }
    },
    "/jobnimbus/update-contact": {
      post: {
        operationId: "updateJobNimbusContact",
        requestBody: jsonBody("UpdateContactRequest"),
        responses: { "200": { description: "Dry run or update result" } }
      }
    },
    "/jobnimbus/update-status": {
      post: {
        operationId: "updateJobNimbusStatus",
        requestBody: jsonBody("UpdateStatusRequest"),
        responses: { "200": { description: "Dry run or status update result" } }
      }
    },
    "/jobnimbus/process-update": {
      post: {
        operationId: "processJobNimbusUpdate",
        requestBody: jsonBody("ProcessUpdateRequest"),
        responses: { "200": { description: "Dry run or bundled JobNimbus field/status/note update result" } }
      }
    },
    "/jobnimbus/create-note": {
      post: {
        operationId: "createJobNimbusNote",
        requestBody: jsonBody("CreateNoteRequest"),
        responses: { "200": { description: "Dry run or note result" } }
      }
    },
    "/jobnimbus/create-task": {
      post: {
        operationId: "createJobNimbusTask",
        requestBody: jsonBody("CreateTaskRequest"),
        responses: { "200": { description: "Dry run or task creation result" } }
      }
    },
    "/jobnimbus/update-task": {
      post: {
        operationId: "updateJobNimbusTask",
        requestBody: jsonBody("UpdateTaskRequest"),
        responses: { "200": { description: "Dry run or task update result" } }
      }
    },
    "/jobnimbus/create-calendar-event": {
      post: {
        operationId: "createJobNimbusCalendarEvent",
        requestBody: jsonBody("CreateCalendarEventRequest"),
        responses: { "200": { description: "Dry run or calendar event creation result" } }
      }
    },
    "/jobnimbus/update-calendar-event": {
      post: {
        operationId: "updateJobNimbusCalendarEvent",
        requestBody: jsonBody("UpdateCalendarEventRequest"),
        responses: { "200": { description: "Dry run or calendar event update result" } }
      }
    },
    "/gmail/search": {
      post: {
        operationId: "searchGmail",
        requestBody: jsonBody("GmailSearchRequest"),
        responses: { "200": { description: "Matching Gmail messages and grouped threads." } }
      }
    },
    "/gmail/thread": {
      post: {
        operationId: "readGmailThread",
        requestBody: jsonBody("GmailThreadRequest"),
        responses: { "200": { description: "Full Gmail thread with parsed text and attachment metadata." } }
      }
    },
    "/gmail/draft": {
      post: {
        operationId: "createGmailDraft",
        requestBody: jsonBody("GmailMessageRequest"),
        responses: { "200": { description: "Dry run or created Gmail draft." } }
      }
    },
    "/gmail/send": {
      post: {
        operationId: "sendGmail",
        requestBody: jsonBody("GmailMessageRequest"),
        responses: { "200": { description: "Dry run or sent Gmail message." } }
      }
    }
  }
};

function jsonBody(schemaName) {
  return {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schemaName}` }
      }
    }
  };
}
