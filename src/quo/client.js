// Direct Quo (formerly OpenPhone) API client. Reads scan every team line
// because a homeowner or adjuster may have communicated through any of them.
// Sending remains approval-gated by both execute:true and ALLOW_QUO_SEND=true.

import { fetchBoundedJson } from "../http/bounded-json.js";

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

export async function readQuoHistoryStrict(config, input = {}) {
  requireConfigured(config);
  const phone = toE164(input.phone || "");
  if (!phone) throw new Error("Quo history requires a valid US phone number");
  const maxResults = boundedInteger(input.maxResults, 25, 1, 50);
  const maxPages = boundedInteger(input.maxPages, 5, 1, 10);
  let lineInventory;
  try {
    lineInventory = await listQuoNumbersStrict(config, {
      maxPages
    });
  } catch {
    throw quoHistoryProviderFailure();
  }
  const requestedLineId = String(input.lineId || "").trim();
  const requestedLineNumberRaw = String(input.lineNumber || "").trim();
  const requestedLineNumber = toE164(requestedLineNumberRaw);
  if (
    (requestedLineId && !/^[A-Za-z0-9._~-]{1,255}$/.test(requestedLineId))
    || (requestedLineNumberRaw && !requestedLineNumber)
  ) {
    throw quoHistoryProviderFailure();
  }
  const numbers = requestedLineId || requestedLineNumber
    ? lineInventory.numbers.filter((line) =>
        (!requestedLineId || line.id === requestedLineId)
        && (
          !requestedLineNumber
          || toE164(line.number) === requestedLineNumber
        )
      )
    : lineInventory.numbers;
  if (numbers.length !== 1 && (requestedLineId || requestedLineNumber)) {
    throw quoHistoryProviderFailure();
  }

  const nameById = Object.fromEntries(numbers.map((row) => [row.id, row.name || row.number]));
  const byId = new Map();
  const incompleteReasons = new Set(lineInventory.incompleteReasons);
  let pagesScanned = 0;
  let restrictedStreamCount = 0;
  let duplicatesDropped = 0;

  for (const line of numbers) {
    for (const kind of ["messages", "calls"]) {
      let pageToken = "";
      const seenPageTokens = new Set();
      for (let page = 0; page < maxPages; page += 1) {
        const query = new URLSearchParams({
          phoneNumberId: line.id,
          maxResults: String(maxResults)
        });
        query.append("participants", phone);
        if (pageToken) query.set("pageToken", pageToken);

        let payload;
        try {
          payload = await requestStrict(
            config,
            "GET",
            `/${kind}?${query}`
          );
        } catch (error) {
          if (isRestrictedLineError(error)) {
            restrictedStreamCount += 1;
            incompleteReasons.add("restricted_line");
            break;
          }
          throw quoHistoryProviderFailure();
        }
        pagesScanned += 1;
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
          throw quoHistoryProviderFailure();
        }

        for (const row of payload.data) {
          if (!row || typeof row !== "object" || Array.isArray(row)) {
            throw quoHistoryProviderFailure();
          }
          const item = strictTimelineItem(
            row,
            line,
            nameById,
            kind,
            phone
          );
          const key = `${kind}:${item.id}`;
          if (byId.has(key)) {
            duplicatesDropped += 1;
            continue;
          }
          byId.set(key, item);
        }

        const next = strictNextPageToken(payload);
        if (next.malformed) {
          incompleteReasons.add("malformed_pagination");
          break;
        }
        if (!next.value) break;
        if (seenPageTokens.has(next.value)) {
          incompleteReasons.add("malformed_pagination");
          break;
        }
        seenPageTokens.add(next.value);
        if (page + 1 >= maxPages) {
          incompleteReasons.add("pagination_ceiling");
          break;
        }
        pageToken = next.value;
      }
    }
  }

  const matchedTimeline = [...byId.values()]
    .sort((a, b) => String(a.atUtc).localeCompare(String(b.atUtc)) || String(a.id).localeCompare(String(b.id)));
  if (matchedTimeline.length > maxResults) incompleteReasons.add("result_truncated");
  const timeline = matchedTimeline.slice(Math.max(0, matchedTimeline.length - maxResults));
  const reasons = [
    "restricted_line",
    "line_inventory_ceiling",
    "malformed_line_pagination",
    "pagination_ceiling",
    "malformed_pagination",
    "result_truncated"
  ].filter((reason) => incompleteReasons.has(reason));

  return {
    phone,
    messageCount: timeline.filter((item) => item.type === "text").length,
    callCount: timeline.filter((item) => item.type === "call").length,
    timeline,
    completeness: {
      complete: reasons.length === 0,
      reasons,
      lineCount: numbers.length,
      lineInventoryPagesScanned: lineInventory.pagesScanned,
      streamCount: numbers.length * 2,
      restrictedStreamCount,
      pagesScanned,
      maximumPagesPerStream: maxPages,
      resultLimit: maxResults,
      matchedCount: matchedTimeline.length,
      returnedCount: timeline.length,
      duplicatesDropped
    }
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

export async function readQuoInbox(config, input = {}) {
  requireConfigured(config);
  const days = clamp(Number(input.days || 14), 1, 90);
  const maxResults = clamp(Number(input.maxResults || 50), 1, 50);
  const transcriptLimit = clamp(Number(input.transcriptLimit || 12), 0, 25);
  const createdAfter = new Date(Date.now() - days * 86400000).toISOString();
  const numbers = await listQuoNumbers(config);
  const lineById = new Map(numbers.map((line) => [line.id, line]));
  const itemsById = new Map();
  const failures = [];
  const conversations = await listRecentConversations(config, numbers, createdAfter, maxResults);

  for (const conversation of conversations) {
    const line = lineById.get(String(conversation.phoneNumberId || ""));
    const participant = (Array.isArray(conversation.participants) ? conversation.participants : [])
      .map(toE164)
      .find(Boolean);
    if (!line?.id || !participant) continue;
    for (const kind of ["messages", "calls"]) {
      try {
        const rows = await listConversationActivity(config, {
          kind,
          phoneNumberId: line.id,
          participant,
          createdAfter
        });
        for (const row of rows) {
          const atUtc = String(row.createdAt || row.startedAt || "");
          if (atUtc && atUtc < createdAfter) continue;
          if (String(row.direction || "").toLowerCase() !== "incoming") continue;
          const id = String(row.id || `${line.id}:${atUtc}:${kind}`);
          if (itemsById.has(id)) continue;
          const otherParty = otherPartyNumber(row, line.number) || participant;
          const status = String(row.status || "").toLowerCase();
          const voicemail = voicemailText(row);
          itemsById.set(id, kind === "messages" ? {
            id,
            channel: "quo",
            type: "text",
            direction: "incoming",
            status,
            participant: otherParty,
            line: line.name || line.number,
            lineNumber: line.number,
            at: toCentral(atUtc),
            atUtc,
            text: String(row.text || row.content || "").replace(/\s+/g, " ").trim(),
            conversationId: String(row.conversationId || "")
          } : {
            id,
            channel: "quo",
            type: voicemail ? "voicemail" : ["missed", "no-answer", "abandoned"].includes(status) ? "missed_call" : "call",
            direction: "incoming",
            status,
            participant: otherParty,
            line: line.name || line.number,
            lineNumber: line.number,
            at: toCentral(atUtc),
            atUtc,
            durationSec: Number(row.duration || 0),
            conversationId: String(row.conversationId || ""),
            voicemail
          });
        }
      } catch (error) {
        if (!/Quo API (400|403|404)/.test(error.message)) throw error;
        failures.push({
          conversationId: String(conversation.id || ""),
          lineId: line.id,
          kind,
          error: String(error.message || "Quo request failed").slice(0, 240)
        });
      }
    }
  }

  const items = [...itemsById.values()].sort((a, b) => String(b.atUtc).localeCompare(String(a.atUtc)));
  const transcriptCandidates = items
    .filter((item) => item.type === "call" || item.type === "missed_call" || item.type === "voicemail")
    .sort((a, b) => transcriptPriority(b) - transcriptPriority(a) || String(b.atUtc).localeCompare(String(a.atUtc)))
    .slice(0, transcriptLimit);
  for (const item of transcriptCandidates) {
    const transcript = await readQuoTranscript(config, item.id, { allowMissing: true });
    if (!transcript) continue;
    item.transcriptStatus = transcript.status;
    item.transcript = transcript.dialogue.map((segment) => segment.text).filter(Boolean).join(" ");
    if (item.voicemail) item.type = "voicemail";
  }

  return {
    generatedAt: new Date().toISOString(),
    createdAfter,
    days,
    lineCount: numbers.length,
    conversationCount: conversations.length,
    count: items.length,
    partial: failures.length > 0,
    failures,
    items
  };
}

function transcriptPriority(item) {
  if (item.type === "voicemail" || item.voicemail) return 3;
  if (Number(item.durationSec || 0) > 0 || item.status === "completed") return 2;
  return 0;
}

async function listConversationActivity(config, { kind, phoneNumberId, participant, createdAfter }) {
  const rows = [];
  let pageToken = "";
  for (let page = 0; page < 5; page += 1) {
    const query = new URLSearchParams({
      phoneNumberId,
      createdAfter,
      maxResults: "100"
    });
    query.append("participants", participant);
    if (pageToken) query.set("pageToken", pageToken);
    const payload = await request(config, "GET", `/${kind}?${query}`);
    rows.push(...(Array.isArray(payload.data) ? payload.data : []));
    pageToken = String(payload.nextPageToken || "");
    if (!pageToken) break;
  }
  return rows;
}

async function listRecentConversations(config, numbers, updatedAfter, maxResults) {
  const byId = new Map();
  let pageToken = "";
  for (let page = 0; page < 5; page += 1) {
    const query = new URLSearchParams({
      updatedAfter,
      maxResults: "100"
    });
    for (const line of numbers) query.append("phoneNumbers", line.id);
    if (pageToken) query.set("pageToken", pageToken);
    const payload = await request(config, "GET", `/conversations?${query}`);
    for (const row of Array.isArray(payload.data) ? payload.data : []) {
      const id = String(row.id || `${row.phoneNumberId}:${(row.participants || []).join(",")}`);
      if (!byId.has(id)) byId.set(id, row);
    }
    pageToken = String(payload.nextPageToken || "");
    if (!pageToken) break;
  }
  return [...byId.values()]
    .filter((row) => !row.deletedAt)
    .sort((a, b) => String(b.lastActivityAt || b.updatedAt || "").localeCompare(String(a.lastActivityAt || a.updatedAt || "")))
    .slice(0, maxResults);
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
      const endpoint = `/${kind}?phoneNumberId=${encodeURIComponent(line.id)}&participants=${encodeURIComponent(phone)}&maxResults=${maxResults}`;
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

function strictTimelineItem(row, line, nameById, kind, expectedPhone) {
  assertStrictTimelineScope(row, line, kind, expectedPhone);
  const atUtc = String(row.createdAt || row.startedAt || "");
  const id = String(row.id || `${line.id}:${atUtc}:${kind}`);
  if (kind === "messages") {
    return {
      id,
      type: "text",
      line: nameById[line.id] || line.number,
      at: toCentral(atUtc),
      atUtc,
      direction: row.direction || "",
      status: row.status || "",
      text: String(row.text || row.content || "").replace(/\s+/g, " ").trim()
    };
  }
  return {
    id,
    type: "call",
    line: nameById[line.id] || line.number,
    at: toCentral(atUtc),
    atUtc,
    direction: row.direction || "",
    status: row.status || "",
    durationSec: row.duration || 0,
    aiHandled: Boolean(row.aiHandled)
  };
}

function assertStrictTimelineScope(row, line, kind, expectedPhone) {
  const providerLineId = String(row.phoneNumberId || "");
  if (!providerLineId || providerLineId !== line.id) {
    throw quoHistoryProviderFailure();
  }

  if (kind === "calls") {
    if (
      !Array.isArray(row.participants)
      || row.participants.length !== 1
      || toE164(row.participants[0]) !== expectedPhone
    ) {
      throw quoHistoryProviderFailure();
    }
    return;
  }

  const providerLineNumber = toE164(line.number || "");
  const from = toE164(row.from || "");
  const to = Array.isArray(row.to)
    ? row.to.map((value) => toE164(value || ""))
    : [];
  if (
    !providerLineNumber
    || !from
    || !to.length
    || to.some((value) => !value)
  ) {
    throw quoHistoryProviderFailure();
  }
  const participants = new Set(
    [from, ...to].filter((value) => value !== providerLineNumber)
  );
  if (
    ![from, ...to].includes(providerLineNumber)
    || participants.size !== 1
    || !participants.has(expectedPhone)
  ) {
    throw quoHistoryProviderFailure();
  }
}

function strictNextPageToken(payload) {
  const raw = payload.nextPageToken;
  if (raw === undefined || raw === null || raw === "") {
    return { malformed: false, value: "" };
  }
  if (typeof raw !== "string") return { malformed: true, value: "" };
  const value = raw.trim();
  if (!value || value.length > 2048) return { malformed: true, value: "" };
  return { malformed: false, value };
}

function isRestrictedLineError(error) {
  return Number(error?.statusCode) === 403;
}

function quoHistoryProviderFailure() {
  const error = new Error("Quo history provider request failed");
  error.code = "QUO_HISTORY_PROVIDER_FAILURE";
  return error;
}

async function listQuoNumbersStrict(
  config,
  {
    maxPages = 5,
    maximumLines = 250
  } = {}
) {
  const boundedPages = boundedInteger(maxPages, 5, 1, 10);
  const boundedLines = boundedInteger(maximumLines, 250, 1, 500);
  const numbers = [];
  const ids = new Set();
  const seenPageTokens = new Set();
  const incompleteReasons = new Set();
  let pageToken = "";
  let pagesScanned = 0;

  for (let page = 0; page < boundedPages; page += 1) {
    const query = new URLSearchParams();
    if (pageToken) query.set("pageToken", pageToken);
    const payload = await requestStrict(
      config,
      "GET",
      `/phone-numbers${query.size ? `?${query}` : ""}`
    );
    pagesScanned += 1;
    if (
      !payload
      || typeof payload !== "object"
      || Array.isArray(payload)
      || !Array.isArray(payload.data)
    ) {
      throw quoHistoryProviderFailure();
    }
    for (const row of payload.data) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw quoHistoryProviderFailure();
      }
      const id = String(row.id || "").trim();
      if (
        !id
        || id.length > 512
        || /[\s\x00-\x1f\x7f]/.test(id)
        || ids.has(id)
      ) {
        throw quoHistoryProviderFailure();
      }
      ids.add(id);
      numbers.push({
        id,
        name: String(row.name || "").slice(0, 120),
        number: String(row.number || "").slice(0, 32)
      });
      if (numbers.length > boundedLines) {
        throw quoHistoryProviderFailure();
      }
    }

    const next = strictNextPageToken(payload);
    if (next.malformed) {
      incompleteReasons.add("malformed_line_pagination");
      break;
    }
    if (!next.value) break;
    if (seenPageTokens.has(next.value)) {
      incompleteReasons.add("malformed_line_pagination");
      break;
    }
    seenPageTokens.add(next.value);
    if (page + 1 >= boundedPages) {
      incompleteReasons.add("line_inventory_ceiling");
      break;
    }
    pageToken = next.value;
  }

  if (!numbers.length) throw quoHistoryProviderFailure();
  return {
    numbers,
    pagesScanned,
    incompleteReasons: [...incompleteReasons]
  };
}

async function requestStrict(
  config,
  method,
  endpoint,
  body,
  attempt = 0
) {
  await waitForRequestSlot();
  try {
    return await fetchBoundedJson(
      fetch,
      `${config.baseUrl}${endpoint}`,
      {
        method,
        headers: {
          authorization: config.apiKey,
          accept: "application/json",
          "content-type": "application/json"
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      },
      {
        timeoutMs: 15_000,
        maxBytes: 2 * 1024 * 1024,
        errorCode: "QUO_HISTORY_PROVIDER_FAILURE"
      }
    );
  } catch (error) {
    if (Number(error?.statusCode) === 429 && attempt < 2) {
      await delay(1000);
      return requestStrict(
        config,
        method,
        endpoint,
        body,
        attempt + 1
      );
    }
    throw error;
  }
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

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.trunc(parsed)))
    : fallback;
}

function otherPartyNumber(row, ownNumber) {
  const own = toE164(ownNumber);
  const candidates = [];
  for (const value of [row.participant, row.from, row.to, ...(Array.isArray(row.participants) ? row.participants : [])]) {
    const raw = value && typeof value === "object" ? value.phoneNumber || value.number || value.phone : value;
    const phone = toE164(raw || "");
    if (phone && phone !== own) candidates.push(phone);
  }
  return candidates[0] || "";
}

function voicemailText(row) {
  const voicemail = row.voicemail && typeof row.voicemail === "object" ? row.voicemail : {};
  return String(voicemail.transcript || row.voicemailTranscript || "").replace(/\s+/g, " ").trim();
}
