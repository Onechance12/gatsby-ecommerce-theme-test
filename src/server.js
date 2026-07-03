import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.RENDER ? "0.0.0.0" : "127.0.0.1";
const API_BASE = stripTrailingSlash(process.env.JOBNIMBUS_API_BASE_URL || "https://app.jobnimbus.com/api1");
const API_KEY = process.env.JOBNIMBUS_API_KEY || "";
const BRIDGE_TOKEN = process.env.JOBNIMBUS_BRIDGE_TOKEN || "";
const ALLOW_WRITES = process.env.BRIDGE_ALLOW_WRITES === "true";

const routes = new Map([
  ["GET /health", health],
  ["GET /openapi.json", openapi],
  ["POST /jobnimbus/search", searchContacts],
  ["POST /jobnimbus/review-file", reviewFile],
  ["POST /jobnimbus/update-contact", updateContact],
  ["POST /jobnimbus/create-note", createNote]
]);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const handler = routes.get(`${req.method} ${url.pathname}`);
    if (!handler) return send(res, 404, { error: "Not found" });
    if (!authorized(req)) return send(res, 401, { error: "Unauthorized" });
    const body = req.method === "GET" ? {} : await readJson(req);
    const result = await handler(body);
    send(res, 200, result);
  } catch (error) {
    send(res, error.statusCode || 500, { error: error.message || String(error) });
  }
}).listen(PORT, HOST, () => {
  console.log(`JobNimbus ChatGPT bridge listening on http://${HOST}:${PORT}`);
  console.log(`Auth: ${BRIDGE_TOKEN ? "enabled" : "disabled"}`);
  console.log(`Writes: ${ALLOW_WRITES ? "enabled" : "dry-run only"}`);
});

function health() {
  return {
    ok: true,
    service: "jobnimbus-chatgpt-bridge",
    jobNimbusConfigured: Boolean(API_KEY),
    writesAllowed: ALLOW_WRITES
  };
}

function openapi() {
  return OPENAPI;
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
    const rows = Array.isArray(batch) ? batch : batch.results || batch.data || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

async function listRelated(endpoint, contactId, limit) {
  const rows = await jobNimbus(`${endpoint}?size=1000&from=0`);
  const list = Array.isArray(rows) ? rows : rows.results || rows.data || [];
  return list.filter((item) => referencesContact(item, contactId)).slice(0, limit);
}

function referencesContact(item, contactId) {
  const ids = [];
  for (const key of ["primary", "related", "customer", "contact"]) collectIds(item?.[key], ids);
  return ids.includes(contactId);
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

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
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

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function clamp(value, min, max) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}

const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "JobNimbus ChatGPT Bridge", version: "0.1.0" },
  servers: [{ url: "https://YOUR-RENDER-SERVICE.onrender.com" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } }
  },
  paths: {
    "/health": { get: { operationId: "health", responses: { "200": { description: "OK" } } } },
    "/jobnimbus/search": { post: { operationId: "searchJobNimbus", requestBody: jsonBody(), responses: { "200": { description: "Matches" } } } },
    "/jobnimbus/review-file": { post: { operationId: "reviewJobNimbusFile", requestBody: jsonBody(), responses: { "200": { description: "File review" } } } },
    "/jobnimbus/update-contact": { post: { operationId: "updateJobNimbusContact", requestBody: jsonBody(), responses: { "200": { description: "Dry run or update result" } } } },
    "/jobnimbus/create-note": { post: { operationId: "createJobNimbusNote", requestBody: jsonBody(), responses: { "200": { description: "Dry run or note result" } } } }
  }
};

function jsonBody() {
  return { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } };
}
