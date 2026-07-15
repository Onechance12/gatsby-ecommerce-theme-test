// Direct Quo (formerly OpenPhone) API client. Reads scan every team line
// because a homeowner or adjuster may have communicated through any of them.
// Sending remains approval-gated by both execute:true and ALLOW_QUO_SEND=true.

const MIN_REQUEST_INTERVAL_MS = 140;
let requestQueue = Promise.resolve();
let nextRequestAt = 0;

export async function listQuoNumbers(config) {
  requireConfigured(config);
  const payload = await request(config, "GET", "/phone-numbers");
  return (Array.isArray(payload.data) ? payload.data : []).map((row) => ({
    id: row.id || "",
    name: row.name || "",
    number: row.number || ""
  }));
}

export async function readQuoHistory(config, input = {}) {
  requireConfigured(config);
  const phone = toE164(input.phone || "");
  if (!phone) throw new Error("Quo history requires a valid US phone number");
  const maxResults = clamp(Number(input.maxResults || 25), 1, 50);
  const numbers = await listQuoNumbers(config);
  const nameById = Object.fromEntries(numbers.map((row) => [row.id, row.name || row.number]));
  const [messages, calls] = await Promise.all([
    collectAcrossLines(config, numbers, nameById, phone, "messages", maxResults),
    collectAcrossLines(config, numbers, nameById, phone, "calls", maxResults)
  ]);

  const transcripts = [];
  if (input.includeTranscripts === true) {
    const recentCalls = [...calls].sort((a, b) => String(b.atUtc).localeCompare(String(a.atUtc))).slice(0, 3);
    for (const call of recentCalls) {
      const transcript = await readQuoTranscript(config, call.id, { allowMissing: true });
      if (transcript) transcripts.push(transcript);
    }
  }

  return {
    phone,
    messageCount: messages.length,
    callCount: calls.length,
    timeline: [...messages, ...calls].sort((a, b) => String(a.atUtc).localeCompare(String(b.atUtc))),
    transcripts
  };
}

export async function readQuoTranscript(config, callId, options = {}) {
  requireConfigured(config);
  const id = String(callId || "").trim();
  if (!id) throw new Error("callId is required");
  try {
    const payload = await request(config, "GET", `/call-transcripts/${encodeURIComponent(id)}`);
    const row = payload.data || {};
    return {
      callId: id,
      status: row.status || "",
      duration: row.duration || 0,
      dialogue: (Array.isArray(row.dialogue) ? row.dialogue : []).map((segment) => ({
        who: segment.identifier || "",
        at: segment.start || 0,
        text: String(segment.content || "").trim()
      }))
    };
  } catch (error) {
    if (options.allowMissing && /Quo API (404|422)/.test(error.message)) return null;
    throw error;
  }
}

export async function sendQuoText(config, input = {}) {
  requireConfigured(config);
  const from = toE164(input.from || config.defaultFrom || "");
  const to = toE164(input.to || "");
  const content = String(input.content || input.message || "").trim();
  if (!from) throw new Error("Quo send requires a configured from number");
  if (!to) throw new Error("Quo send requires a valid destination number");
  if (!content) throw new Error("Quo send requires content");
  if (content.length > 1600) throw new Error("Quo message exceeds the 1600-character API limit");

  const plan = { from, to, content, characterCount: content.length };
  if (input.execute !== true) return { mode: "dry_run", plan };
  if (!config.allowSend) throw new Error("Quo sending is disabled. Set ALLOW_QUO_SEND=true.");

  const sendingLine = await resolveSendingLine(config, from);
  const body = { content, from: sendingLine.id, to: [to] };
  if (input.userId) body.userId = String(input.userId);
  const response = await request(config, "POST", "/messages", body);
  const message = response.data || {};
  return {
    mode: "executed",
    message: {
      id: message.id || "",
      conversationId: message.conversationId || "",
      from: message.from || sendingLine.number,
      phoneNumberId: message.phoneNumberId || sendingLine.id,
      to: message.to || [to],
      direction: message.direction || "outgoing",
      status: message.status || "accepted",
      createdAt: message.createdAt || ""
    }
  };
}

async function collectAcrossLines(config, numbers, nameById, phone, kind, maxResults) {
  const byId = new Map();
  for (const line of numbers) {
    try {
      const endpoint = `/${kind}?phoneNumberId=${encodeURIComponent(line.id)}&participants[]=${encodeURIComponent(phone)}&maxResults=${maxResults}`;
      const payload = await request(config, "GET", endpoint);
      for (const row of Array.isArray(payload.data) ? payload.data : []) {
        const id = row.id || `${line.id}:${row.createdAt}:${kind}`;
        if (byId.has(id)) continue;
        byId.set(id, kind === "messages" ? {
          id,
          type: "text",
          line: nameById[line.id] || line.number,
          at: toCentral(row.createdAt),
          atUtc: row.createdAt || "",
          direction: row.direction || "",
          status: row.status || "",
          text: String(row.text || row.content || "").replace(/\s+/g, " ").trim()
        } : {
          id,
          type: "call",
          line: nameById[line.id] || line.number,
          at: toCentral(row.createdAt),
          atUtc: row.createdAt || "",
          direction: row.direction || "",
          status: row.status || "",
          durationSec: row.duration || 0,
          aiHandled: Boolean(row.aiHandled)
        });
      }
    } catch (error) {
      // Some team lines cannot expose every history type. Continue scanning so
      // one restricted line does not hide communications on the others.
      if (!/Quo API (400|403|404)/.test(error.message)) throw error;
    }
  }
  return [...byId.values()].sort((a, b) => String(a.atUtc).localeCompare(String(b.atUtc)));
}

async function request(config, method, endpoint, body, attempt = 0) {
  await waitForRequestSlot();
  const response = await fetch(`${config.baseUrl}${endpoint}`, {
    method,
    headers: {
      authorization: config.apiKey,
      "content-type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (response.status === 429 && attempt < 2) {
    const retryAfter = Math.max(1, Number(response.headers.get("retry-after") || 1));
    await delay(retryAfter * 1000);
    return request(config, method, endpoint, body, attempt + 1);
  }
  if (!response.ok) {
    const detail = config.redact ? config.redact(JSON.stringify(json)) : JSON.stringify(json);
    const error = new Error(`Quo API ${response.status}: ${detail.slice(0, 500)}`);
    error.statusCode = response.status;
    throw error;
  }
  return json;
}

async function resolveSendingLine(config, from) {
  const numbers = await listQuoNumbers(config);
  const line = numbers.find((row) => toE164(row.number) === from);
  if (!line?.id) throw new Error("Configured Quo from number is not available to this API key");
  return line;
}

async function waitForRequestSlot() {
  const turn = requestQueue.then(async () => {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs) await delay(waitMs);
    nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
  });
  requestQueue = turn.catch(() => {});
  await turn;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireConfigured(config) {
  if (!config?.apiKey) throw new Error("Quo is not configured. Set QUO_API_KEY in Render.");
}

function toE164(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+") && digits.length >= 10) return `+${digits}`;
  return "";
}

function toCentral(isoUtc) {
  if (!isoUtc) return "";
  try {
    return new Date(isoUtc).toLocaleString("en-US", {
      timeZone: "America/Chicago",
      month: "numeric",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });
  } catch {
    return isoUtc;
  }
}

function clamp(value, min, max) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}
