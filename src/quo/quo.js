// Quo (formerly OpenPhone) client — the system of record for texts and calls.
// Reads are open. Sending is dry-run by default and requires BOTH execute:true
// and ALLOW_QUO_SEND=true. Successful sends create private memory receipts.
import { safeCloseoutAction } from "../memory/actionCloseout.js";

// NOTE: In this cloud sandbox the agent proxy 503s api.openphone.com for Node's
// fetch (undici TLS quirk); curl works. On a normal machine (Mac / Render) there
// is no such proxy and this fetch works directly. Verified against live data via
// curl: phone-numbers, messages, and calls all return 200.
export async function runQuoTool(config, args) {
  const [tool, ...rest] = args;
  const input = parseInput(rest.join(" "));

  if (!tool || tool === "list" || tool === "numbers") {
    requireQuoConfigured(config);
    const numbers = await listNumbers(config);
    printJson({ tool: "numbers", count: numbers.length, numbers: numbers.map((n) => ({ id: n.id, name: n.name, number: n.number })) });
    if (!tool || tool === "list") {
      console.log("\nCommands: numbers | history <phone|+E164> | messages <phone> | calls <phone> | send <json>");
    }
    return;
  }

  if (tool === "send") {
    const from = toE164(input.from || "");
    const to = toE164(input.to || input.phone || "");
    const content = String(input.content || input.message || "").trim();
    if (!from) throw new Error("Quo send requires from in E.164 format");
    if (!to) throw new Error("Quo send requires to in E.164 format");
    if (!content) throw new Error("Quo send requires content");
    if (content.length > 1600) throw new Error("Quo message exceeds the 1600-character API limit");

    const plan = { tool: "send", from, to, contentPreview: content.slice(0, 300) };
    if (input.execute !== true) {
      printJson({ mode: "dry_run", plan, note: "Add execute:true and set ALLOW_QUO_SEND=true to send." });
      return;
    }
    if (!config.quo.allowSend) {
      printJson({ mode: "blocked", plan, reason: "Quo sending is disabled. Set ALLOW_QUO_SEND=true." });
      process.exitCode = 1;
      return;
    }
    requireQuoConfigured(config);

    const payload = { content, from, to: [to] };
    if (input.userId) payload.userId = String(input.userId);
    const response = await quoRequest(config, "POST", "/messages", payload);
    const message = response.data || {};
    const memoryCloseout = safeCloseoutAction(config, {
      channel: "quo",
      action: "send_text",
      status: message.status || "accepted",
      subjectKey: String(input.subjectKey || ""),
      fileLabel: String(input.fileLabel || input.query || ""),
      summary: `Quo text sent${input.fileLabel || input.query ? ` for ${input.fileLabel || input.query}` : ""}; API status ${message.status || "accepted"}.`,
      externalId: message.id || "",
      followUps: input.followUps || [],
      evidence: message.id ? [`quo:${message.id}`] : []
    });
    printJson({ mode: "executed", message: compactSentMessage(message), memoryCloseout });
    return;
  }

  requireQuoConfigured(config);

  // Transcript / recording for a specific call id (calls must be RECORDED in Quo
  // — hit record on the call — before a transcript exists; otherwise 404).
  if (tool === "transcript") {
    const callId = String(input.callId || input._ || "").trim();
    if (!callId) { console.log(`Usage: npm run quo -- transcript '{"callId":"AC..."}'`); process.exitCode = 1; return; }
    try {
      const t = await quoGet(config, `/call-transcripts/${encodeURIComponent(callId)}`);
      const d = t.data || {};
      printJson({ tool, callId, status: d.status, duration: d.duration, dialogue: (d.dialogue || []).map((s) => ({ who: s.identifier, at: s.start, text: s.content })) });
    } catch (error) {
      console.log(`No transcript for ${callId}: ${config.redact(error.message)}. The call must have been recorded in Quo to be transcribed.`);
    }
    return;
  }

  const phone = toE164(input.phone || input._ || "");
  if (["history", "messages", "calls"].includes(tool) && !phone) {
    console.log(`Usage: npm run quo -- ${tool} '{"phone":"9725551212"}'  (or a bare 10/11-digit number)`);
    process.exitCode = 1;
    return;
  }

  const numbers = await listNumbers(config);
  const lineIds = numbers.map((n) => n.id);
  const nameById = Object.fromEntries(numbers.map((n) => [n.id, n.name || n.number]));

  if (tool === "messages" || tool === "history") {
    const messages = await collectAcrossLines(config, lineIds, phone, "messages", nameById);
    if (tool === "messages") { printJson({ tool, phone, count: messages.length, messages }); return; }
    const calls = await collectAcrossLines(config, lineIds, phone, "calls", nameById);
    const timeline = [...messages, ...calls].sort((a, b) => String(a.atUtc).localeCompare(String(b.atUtc)));
    printJson({ tool: "history", phone, messageCount: messages.length, callCount: calls.length, timeline });
    return;
  }

  if (tool === "calls") {
    const calls = await collectAcrossLines(config, lineIds, phone, "calls", nameById);
    // Flag which calls have a recording (and therefore a possible transcript).
    for (const c of calls) c.recorded = await hasRecording(config, c.id);
    printJson({ tool, phone, count: calls.length, calls });
    return;
  }

  console.log(`Unknown quo tool: ${tool}. Run: npm run quo -- list`);
  process.exitCode = 1;
}

async function listNumbers(config) {
  const data = await quoGet(config, "/phone-numbers");
  return Array.isArray(data.data) ? data.data : [];
}

// Messages/calls require a phoneNumberId + participants[]. Homeowner contact may
// run through any team line (Chance, Paula, Andrea, HCN), so scan every line.
async function collectAcrossLines(config, lineIds, phone, kind, nameById) {
  const out = [];
  for (const lineId of lineIds) {
    let payload;
    try {
      payload = await quoGet(config, `/${kind}?phoneNumberId=${encodeURIComponent(lineId)}&participants[]=${encodeURIComponent(phone)}&maxResults=50`);
    } catch {
      continue;
    }
    for (const row of payload.data || []) {
      if (kind === "messages") {
        out.push({ type: "text", line: nameById[lineId], at: toCentral(row.createdAt), atUtc: row.createdAt, direction: row.direction, text: (row.text || "").replace(/\s+/g, " ").trim() });
      } else {
        out.push({ type: "call", line: nameById[lineId], at: toCentral(row.createdAt), atUtc: row.createdAt, direction: row.direction, status: row.status, durationSec: row.duration, aiHandled: row.aiHandled, id: row.id });
      }
    }
  }
  return out.sort((a, b) => String(a.atUtc).localeCompare(String(b.atUtc)));
}

async function hasRecording(config, callId) {
  if (!callId) return false;
  try {
    const r = await quoGet(config, `/call-recordings/${encodeURIComponent(callId)}`);
    return Array.isArray(r.data) && r.data.length > 0;
  } catch {
    return false;
  }
}

async function quoGet(config, endpoint) {
  return quoRequest(config, "GET", endpoint);
}

async function quoRequest(config, method, endpoint, body) {
  const response = await fetch(`${config.quo.baseUrl}${endpoint}`, {
    method,
    headers: { authorization: config.quo.apiKey, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!response.ok) {
    throw new Error(`Quo API ${response.status}: ${config.redact(JSON.stringify(json)).slice(0, 300)}`);
  }
  return json;
}

function compactSentMessage(message) {
  return {
    id: message.id || "",
    conversationId: message.conversationId || "",
    from: message.from || "",
    to: message.to || [],
    direction: message.direction || "outgoing",
    status: message.status || "",
    createdAt: message.createdAt || ""
  };
}

function requireQuoConfigured(config) {
  if (!config.quo.apiKey) throw new Error("Quo not configured. Set QUO_API_KEY in .env.");
}

// Quo returns createdAt as UTC ISO. Always display Central time to Chance —
// showing raw UTC caused a real mix-up (a 1:44 PM call was reported as
// "6:44 PM" because the UTC hour was shown unconverted).
function toCentral(isoUtc) {
  if (!isoUtc) return "";
  try {
    return new Date(isoUtc).toLocaleString("en-US", {
      timeZone: "America/Chicago",
      month: "numeric", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true
    });
  } catch {
    return isoUtc;
  }
}

function toE164(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (String(value || "").startsWith("+")) return String(value).trim();
  return "";
}

function parseInput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed); } catch { return { _: trimmed }; }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
