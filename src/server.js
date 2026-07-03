import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.RENDER ? "0.0.0.0" : "127.0.0.1";
const API_BASE = stripTrailingSlash(process.env.JOBNIMBUS_API_BASE_URL || "https://app.jobnimbus.com/api1");
const API_KEY = process.env.JOBNIMBUS_API_KEY || "";
const BRIDGE_TOKEN = process.env.JOBNIMBUS_BRIDGE_TOKEN || "";
const ALLOW_WRITES = process.env.BRIDGE_ALLOW_WRITES === "true";
const PUBLIC_BASE_URL = stripTrailingSlash(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "https://jobnimbus-chatgpt-bridge.onrender.com");

const routes = new Map([
  ["GET /health", health],
  ["GET /openapi.json", openapi],
  ["GET /privacy", privacy],
  ["POST /jobnimbus/search", searchContacts],
  ["POST /jobnimbus/review-file", reviewFile],
  ["POST /jobnimbus/assigned-files", assignedFiles],
  ["POST /jobnimbus/assigned-counts", assignedCounts],
  ["POST /jobnimbus/document-text", documentText],
  ["POST /jobnimbus/document-review", documentReview],
  ["POST /jobnimbus/update-contact", updateContact],
  ["POST /jobnimbus/create-note", createNote],
  ["POST /jobnimbus/create-task", createTask],
  ["POST /jobnimbus/update-task", updateTask],
  ["POST /jobnimbus/create-calendar-event", createCalendarEvent],
  ["POST /jobnimbus/update-calendar-event", updateCalendarEvent]
]);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const handler = routes.get(`${req.method} ${url.pathname}`);
    if (!handler) return send(res, 404, { error: "Not found" });
    if (!isPublicRoute(req.method, url.pathname) && !authorized(req)) return send(res, 401, { error: "Unauthorized" });
    const body = req.method === "GET" ? {} : await readJson(req);
    const result = await handler(body);
    if (typeof result === "string") sendText(res, 200, result);
    else send(res, 200, result);
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

async function documentText(input) {
  const query = required(input.query, "query");
  const documentQuery = String(input.documentQuery || input.documentId || "").trim();
  const maxChars = clamp(Number(input.maxChars || 12000), 1000, 50000);
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
  const extracted = await extractDocumentText(downloaded, document, maxChars);
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
  const extracted = await extractDocumentText(downloaded, document, maxChars);
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

async function extractDocumentText(downloaded, doc, maxChars) {
  const filename = String(downloaded.filename || doc.name || doc.filename || doc.file_name || "").toLowerCase();
  const contentType = String(downloaded.contentType || "").toLowerCase();
  const looksPdf = contentType.includes("pdf") || filename.endsWith(".pdf");
  const looksText = contentType.startsWith("text/") || /\.(txt|csv|json|xml|html|md)$/i.test(filename);

  if (looksPdf) {
    try {
      const pdfParseModule = await import("pdf-parse");
      const pdfParse = pdfParseModule.default || pdfParseModule;
      const parsed = await pdfParse(downloaded.bytes);
      const text = cleanExtractedText(parsed.text || "").slice(0, maxChars);
      return {
        extraction: "pdf-parse",
        pageCount: parsed.numpages || parsed.numrender || null,
        truncated: (parsed.text || "").length > maxChars,
        text
      };
    } catch (error) {
      return {
        extraction: "failed",
        error: `PDF extraction failed: ${error.message}. Install/verify pdf-parse on Render or use Drive/file tools for this document.`,
        text: ""
      };
    }
  }

  if (looksText) {
    const raw = downloaded.bytes.toString("utf8");
    return {
      extraction: "plain-text",
      truncated: raw.length > maxChars,
      text: cleanExtractedText(raw).slice(0, maxChars)
    };
  }

  return {
    extraction: "unsupported",
    error: "This file type is not currently text-extractable by the bridge. Use Drive/file tools or download metadata only.",
    text: ""
  };
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
  return method === "GET" && ["/openapi.json", "/privacy"].includes(pathname);
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

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
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
          maxChars: { type: "integer", minimum: 1000, maximum: 50000, default: 12000 }
        },
        required: ["query"]
      },
      DocumentReviewRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          documentQuery: { type: "string", description: "Document id, name, or partial filename. If omitted, the first related document is used." },
          maxChars: { type: "integer", minimum: 1000, maximum: 50000, default: 20000 },
          previewChars: { type: "integer", minimum: 500, maximum: 12000, default: 4000 }
        },
        required: ["query"]
      },
      UpdateContactRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          fields: { type: "object", additionalProperties: true, description: "Exact JobNimbus contact fields to update." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["query", "fields"]
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
      }
    }
  },
  paths: {
    "/health": { get: { operationId: "health", responses: { "200": { description: "OK" } } } },
    "/privacy": { get: { operationId: "privacy", responses: { "200": { description: "Privacy policy" } } } },
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
