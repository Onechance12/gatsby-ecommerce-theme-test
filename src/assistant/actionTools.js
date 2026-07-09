import { ReadOnlyJobNimbusClient } from "../jobnimbus/client.js";
import { findMatches, loadReviews } from "./fileReview.js";

const ACTION_DEFINITIONS = [
  {
    name: "create_jobnimbus_note",
    description: "Create an internal JobNimbus note on one client/file. Dry-run unless execute:true and ALLOW_JOBNIMBUS_WRITES=true.",
    input: { query: "string", note: "string", allowPolicyException: "boolean optional", execute: "boolean optional" },
    writes: ["JobNimbus activities"]
  },
  {
    name: "append_jobnimbus_assistant_log",
    description: "Create or update one consolidated assistant log note on a JobNimbus client/file. Dry-run unless execute:true and ALLOW_JOBNIMBUS_WRITES=true.",
    input: { query: "string", entry: "string", allowPolicyException: "boolean optional", execute: "boolean optional" },
    writes: ["JobNimbus activities"]
  },
  {
    name: "create_jobnimbus_task",
    description: "Create a JobNimbus task related to one client/file. Dry-run unless execute:true and ALLOW_JOBNIMBUS_WRITES=true.",
    input: { query: "string", title: "string", description: "string optional", dueDate: "YYYY-MM-DD optional", startDateTime: "ISO local datetime optional", endDateTime: "ISO local datetime optional", recordTypeName: "string optional", ownerIds: "array optional", execute: "boolean optional" },
    writes: ["JobNimbus tasks"]
  },
  {
    name: "update_jobnimbus_contact",
    description: "Update exact fields on one JobNimbus contact/file. Dry-run unless execute:true and ALLOW_JOBNIMBUS_WRITES=true.",
    input: { query: "string", fields: "object", execute: "boolean optional" },
    writes: ["JobNimbus contacts"]
  },
  {
    name: "append_jobnimbus_description",
    description: "Append a labeled line (e.g. 'Time of Loss: ...', 'Occupancy: ...') to a contact's Description field, without erasing what's already there. Dry-run unless execute:true and ALLOW_JOBNIMBUS_WRITES=true.",
    input: { query: "string", label: "string", value: "string", execute: "boolean optional" },
    writes: ["JobNimbus contacts (description)"]
  }
];

export async function runActionTool(config, args) {
  const [actionName, ...rest] = args;

  if (!actionName || actionName === "list") {
    printJson({
      actions: ACTION_DEFINITIONS,
      safety: {
        defaultMode: "dry_run",
        executeRequirements: ["input execute:true", "environment ALLOW_JOBNIMBUS_WRITES=true"],
        scope: "JobNimbus only. Quo/Gmail sends must happen through their own explicit connector actions."
      }
    });
    return;
  }

  const input = parseInput(rest.join(" "));
  const reviews = loadReviews(config);
  const query = required(input.query || input._, "query");
  const { review, alternates } = requireFileMatch(reviews, query);

  let plan;
  if (actionName === "create_jobnimbus_note") {
    plan = planCreateNote(config, review, input);
  } else if (actionName === "append_jobnimbus_assistant_log") {
    plan = planAppendAssistantLog(config, review, input);
  } else if (actionName === "create_jobnimbus_task") {
    plan = planCreateTask(config, review, input);
  } else if (actionName === "update_jobnimbus_contact") {
    plan = planUpdateContact(config, review, input);
  } else if (actionName === "append_jobnimbus_description") {
    plan = await planAppendDescription(config, review, input);
  } else {
    throw new Error(`Unknown action tool: ${actionName}. Run \`npm run chat:action -- list\`.`);
  }

  plan.alternates = alternates.map((item) => ({
    id: item.file.id,
    customer: item.file.customer,
    status: item.file.status,
    address: item.file.address || ""
  }));

  if (!truthy(input.execute)) {
    printJson({
      mode: "dry_run",
      action: actionName,
      file: fileSummary(review),
      plan,
      execute: {
        allowed: false,
        reason: "Add execute:true and run with ALLOW_JOBNIMBUS_WRITES=true to perform this exact JobNimbus write."
      }
    });
    return;
  }

  if (plan.policyViolations?.length && !truthy(input.allowPolicyException)) {
    printJson({
      mode: "blocked",
      action: actionName,
      file: fileSummary(review),
      plan,
      execute: {
        allowed: false,
        reason: "JobNimbus note policy violation. Revise the note or pass allowPolicyException:true only for an intentional legal/document exception."
      }
    });
    return;
  }

  ensureCanExecute(config);
  const client = new ReadOnlyJobNimbusClient(config);
  const result = await executePlan(client, plan);

  printJson({
    mode: "executed",
    action: actionName,
    file: fileSummary(review),
    request: {
      method: plan.method,
      endpoint: plan.endpoint,
      body: plan.body
    },
    result
  });
}

function planCreateNote(config, review, input) {
  const note = required(input.note, "note");
  const policyViolations = notePolicyViolations(note);
  return {
    method: "POST",
    endpoint: config.endpoints.activities,
    body: {
      note,
      date_created: nowUnix(),
      record_type_name: "Note",
      primary: { id: review.file.id }
    },
    warnings: noteWarnings(note),
    policyViolations
  };
}

function planAppendAssistantLog(config, review, input) {
  const entry = required(input.entry, "entry");
  const existing = findAssistantLog(review);
  const stampedEntry = `- ${formatCentralTimestamp()} - ${entry}`;
  const note = existing
    ? appendLogEntry(existing.body, stampedEntry)
    : createAssistantLog(review, stampedEntry);

  if (existing) {
    const policyViolations = notePolicyViolations(note);
    return {
      method: "PUT",
      endpoint: `${config.endpoints.activities}/${encodeURIComponent(existing.id)}`,
      body: {
        note,
        date_updated: nowUnix()
      },
      warnings: noteWarnings(note),
      policyViolations
    };
  }

  const policyViolations = notePolicyViolations(note);
  return {
    method: "POST",
    endpoint: config.endpoints.activities,
    body: {
      note,
      date_created: nowUnix(),
      record_type_name: "Note",
      primary: { id: review.file.id }
    },
    warnings: noteWarnings(note),
    policyViolations
  };
}

function planCreateTask(config, review, input) {
  const title = required(input.title, "title");
  const body = {
    title,
    related: [{ id: review.file.id }],
    record_type_name: input.recordTypeName || "Task"
  };

  if (input.description) body.description = String(input.description);
  if (input.recordType !== undefined) body.record_type = Number(input.recordType);
  if (Array.isArray(input.ownerIds) && input.ownerIds.length) {
    body.owners = input.ownerIds.map((id) => ({ id: String(id) }));
  }
  if (input.startDateTime) {
    body.date_start = dateTimeToUnix(input.startDateTime, "startDateTime");
    body.date_end = dateTimeToUnix(input.endDateTime || input.startDateTime, "endDateTime");
  } else if (input.endDateTime) {
    throw new Error("endDateTime requires startDateTime.");
  }
  if (input.dueDate) {
    body.date_start = dateToUnix(input.dueDate);
    body.date_end = body.date_start;
  }

  return {
    method: "POST",
    endpoint: config.endpoints.tasks,
    body,
    warnings: []
  };
}

function planUpdateContact(config, review, input) {
  const fields = input.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error("Missing required input: fields object");
  }
  if (!Object.keys(fields).length) {
    throw new Error("fields object cannot be empty");
  }

  return {
    method: "PUT",
    endpoint: `${config.endpoints.contacts}/${encodeURIComponent(review.file.id)}`,
    body: fields,
    warnings: [
      "Field names must match JobNimbus exactly. Use dry-run first when updating custom fields or workflow/status values."
    ]
  };
}

const DESCRIPTION_LABEL_PATTERN = (label) =>
  new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:.*$`, "im");

async function planAppendDescription(config, review, input) {
  const label = required(input.label, "label");
  const value = required(input.value, "value");

  // Always read the live description (not the possibly-stale sweep snapshot) so
  // we never clobber something added since the last sweep.
  const client = new ReadOnlyJobNimbusClient(config);
  const live = await client.getJson(`${config.endpoints.contacts}/${encodeURIComponent(review.file.id)}`);
  const current = String(live?.description || "").trim();

  const line = `${label}: ${value}`;
  const labelPattern = DESCRIPTION_LABEL_PATTERN(label);
  let nextDescription;
  if (current && labelPattern.test(current)) {
    // Replace an existing line with this same label instead of duplicating it.
    nextDescription = current.replace(labelPattern, line);
  } else if (current) {
    nextDescription = `${current}\n${line}`;
  } else {
    nextDescription = line;
  }

  return {
    method: "PUT",
    endpoint: `${config.endpoints.contacts}/${encodeURIComponent(review.file.id)}`,
    body: { description: nextDescription },
    warnings: [],
    preview: { before: current || "(empty)", after: nextDescription }
  };
}

async function executePlan(client, plan) {
  if (plan.method === "POST") return client.postJson(plan.endpoint, plan.body);
  if (plan.method === "PUT") return client.putJson(plan.endpoint, plan.body);
  throw new Error(`Unsupported action method: ${plan.method}`);
}

function ensureCanExecute(config) {
  if (config.useFixtures) {
    throw new Error("Cannot execute JobNimbus writes in fixture mode. Set JOBNIMBUS_USE_FIXTURES=false.");
  }
  if (!config.allowJobNimbusWrites) {
    throw new Error("JobNimbus writes are blocked. Set ALLOW_JOBNIMBUS_WRITES=true and pass execute:true to run a write.");
  }
}

function requireFileMatch(reviews, query) {
  const matches = findMatches(reviews, query);
  if (!matches.length) throw new Error(`No matching files found for: ${query}`);
  return { review: matches[0], alternates: matches.slice(1, 6) };
}

function parseInput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  return { _: trimmed };
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`Missing required input: ${name}`);
  return text;
}

function fileSummary(review) {
  return {
    id: review.file.id,
    customer: review.file.customer,
    status: review.file.status,
    address: review.file.address || "",
    carrier: review.file.carrier || "",
    claimNumber: cleanClaimNumber(review.file.claimNumber)
  };
}

function cleanClaimNumber(value) {
  return String(value || "")
    .replace(/\bReference\s*#?\b/gi, "")
    .replace(/\bClaim\s*#?:?\s*/gi, "")
    .replace(/\s+#\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function noteWarnings(note) {
  const warnings = [];
  const text = note.toLowerCase();
  if (text.includes("texted") || text.includes("quo") || text.includes("sms")) {
    warnings.push("User preference: do not log text-message content in JobNimbus unless explicitly requested.");
  }
  if (text.includes("damage") || text.includes("roof") || text.includes("siding") || text.includes("interior")) {
    warnings.push("User preference: do not include reported damages in routine JobNimbus notes.");
  }
  return warnings;
}

export function notePolicyViolations(note) {
  const violations = [];
  const text = String(note || "");
  if (/^\s*ops update\s*:/i.test(text)) {
    violations.push("Do not start JobNimbus notes with `Ops update:` unless explicitly requested.");
  }
  if (/\b(home claim network|wave public adjusting|hcn)\b/i.test(text)) {
    violations.push("Do not type company branding/name drops in JobNimbus client/file notes unless explicitly required.");
  }
  return violations;
}

function dateToUnix(value) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid dueDate: ${value}. Expected YYYY-MM-DD.`);
  }
  return Math.floor(date.getTime() / 1000);
}

function dateTimeToUnix(value, name) {
  const text = String(value || "").trim();
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${name}: ${value}. Expected ISO datetime like 2026-07-03T14:00:00-05:00.`);
  }
  return Math.floor(date.getTime() / 1000);
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

const ASSISTANT_LOG_MARKER = "CHANCE LOCAL ASSISTANT LOG";

function findAssistantLog(review) {
  return (review.file.notes || [])
    .filter((note) => note.id && String(note.body || "").includes(ASSISTANT_LOG_MARKER))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0];
}

function createAssistantLog(review, stampedEntry) {
  return [
    ASSISTANT_LOG_MARKER,
    `File: ${review.file.customer || "Unknown"}${review.file.claimNumber ? ` / Claim ${cleanClaimNumber(review.file.claimNumber)}` : ""}`,
    "Purpose: consolidated assistant action log. Newest entries first.",
    "",
    stampedEntry
  ].join("\n");
}

function appendLogEntry(existingBody, stampedEntry) {
  const lines = String(existingBody || "").trim().split(/\r?\n/);
  const insertAt = Math.min(lines.length, 4);
  lines.splice(insertAt, 0, stampedEntry);
  return lines.join("\n");
}

function formatCentralTimestamp() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  }).format(new Date());
}

function truthy(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
