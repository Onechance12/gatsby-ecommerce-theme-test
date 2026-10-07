import { createHash } from "node:crypto";
import {
  resolveUniqueActiveJobNimbusUser,
  validateCompleteJobNimbusUserSnapshot
} from "../jobnimbus/user-directory.js";

export const COMPANY_ROSTER_LIMITS = Object.freeze({
  pageSize: 500, maxRecordsPerCollection: 10_000,
  maxProviderRequests: 100, deadlineMs: 60_000, maxResponseBytes: 12 * 1024 * 1024
});

export class CompanyRosterError extends Error {
  constructor(code = "hcn_company_roster_source_unavailable", statusCode = 503) {
    super("The complete company roster is unavailable; no partial inventory was returned.");
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function validateCompanyRosterInput(input) {
  if (!plain(input) || Object.keys(input).length !== 0) {
    throw new CompanyRosterError("hcn_company_roster_invalid_request", 400);
  }
}

// fetchPage is injected by the bridge and may perform only provider GETs to
// /account/users, /contacts, and /jobs. No caller-controlled URL or owner filter.
export async function readCompanyRoster({ fetchPage, referenceFactory, anchorEmail, anchorUserId, now = Date.now }) {
  const startedAt = new Date(now()).toISOString();
  const budget = {
    maximum: COMPANY_ROSTER_LIMITS.maxProviderRequests,
    used: 0,
    deadlineAt: now() + COMPANY_ROSTER_LIMITS.deadlineMs
  };
  try {
    const directory = validateCompleteJobNimbusUserSnapshot(
      await fetchPage("/account/users", budget)
    );
    const anchor = resolveUniqueActiveJobNimbusUser(directory, anchorEmail);
    if (!anchor || anchor.id !== anchorUserId) throw new CompanyRosterError();
    const contacts = await loadCollection("contacts", fetchPage, budget);
    const jobs = await loadCollection("jobs", fetchPage, budget);
    const users = new Map(directory.map(row => [recordId(row), row]));
    const knownContacts = new Set(contacts.rows.map(recordId));
    const rows = [
      ...contacts.rows.map(row => projectRow(row, "contact", users, knownContacts, referenceFactory)),
      ...jobs.rows.map(row => projectRow(row, "job", users, knownContacts, referenceFactory))
    ].sort((a, b) => a.sourceKind.localeCompare(b.sourceKind)
      || a.sourceId.localeCompare(b.sourceId));
    // A single API-key connection must not mix source account identifiers.
    const accountIds = new Set([...contacts.rows, ...jobs.rows]
      .map(row => scalar(row.customer, 128)).filter(Boolean));
    if (accountIds.size > 1) throw new CompanyRosterError();
    if (now() > budget.deadlineAt) throw new CompanyRosterError();
    const finishedAt = new Date(now()).toISOString();
    const result = {
      schema: "hcn.company-roster.v1",
      tenantId: referenceFactory.tenantId,
      source: "jobnimbus",
      scope: "configured_jobnimbus_account_metadata",
      readOnly: true,
      externalWrites: false,
      ephemeral: true,
      complete: true,
      coverage: {
        contacts: contacts.proof,
        jobs: jobs.proof,
        employeeDirectory: "complete_account_snapshot",
        ownerFilterApplied: false,
        statusFilterApplied: false,
        providerRequests: budget.used,
        startedAt,
        finishedAt,
        transactionalSnapshot: false
      },
      totals: {
        contacts: contacts.rows.length,
        jobs: jobs.rows.length,
        insuranceContacts: rows.filter(r => r.sourceKind === "contact" && r.recordType.toLowerCase() === "insurance").length,
        unassigned: rows.filter(r => r.ownerIds.length === 0).length,
        unknownOwner: rows.filter(r => r.flags.includes("unknown_owner")).length,
        missingPropertyAddress: rows.filter(r => r.flags.includes("missing_property_address")).length,
        recordTypes: counts(rows, r => `${r.sourceKind}:${r.recordType || "unspecified"}`),
        statuses: counts(rows, r => `${r.sourceKind}:${r.status || "unspecified"}`),
        lifecycle: counts(rows, r => r.lifecycle)
      },
      owners: [...users.entries()].map(([id, row]) => ({
        id,
        name: scalar(row.display_name || row.name || [row.first_name, row.last_name].filter(Boolean).join(" "), 240),
        active: typeof row.is_active === "boolean" ? row.is_active : null,
        contacts: rows.filter(r => r.sourceKind === "contact" && r.ownerIds.includes(id)).length,
        insuranceContacts: rows.filter(r => r.sourceKind === "contact" && r.recordType.toLowerCase() === "insurance" && r.ownerIds.includes(id)).length,
        jobs: rows.filter(r => r.sourceKind === "job" && r.ownerIds.includes(id)).length
      })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      rows,
      limitations: [
        "Complete means the contacts and jobs catalogs visible to the configured JobNimbus API credential, with an explicit empty end page for each.",
        "Provider permission limits, deleted records, and hidden-record behavior are not independently attested.",
        "Offset pagination is not a transactional snapshot; concurrent source edits may require a reviewed rerun.",
        "Contact and job totals are separate source catalogs, not a deduplicated claim count. Related records and repeated names are retained, never merged.",
        "Closed status labels are preserved verbatim; lifecycle uses explicit source booleans, not guesses from workflow names."
      ]
    };
    result.inventorySha256 = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    if (Buffer.byteLength(JSON.stringify(result, null, 2)) > COMPANY_ROSTER_LIMITS.maxResponseBytes - 4096) throw new CompanyRosterError();
    return result;
  } catch (error) {
    if (error instanceof CompanyRosterError) throw error;
    throw new CompanyRosterError();
  }
}

async function loadCollection(collection, fetchPage, budget) {
  const rows = [], ids = new Set();
  let offset = 0, expectedTotal = null, pages = 0;
  while (true) {
    // At the bound, request a single row: only zero proves completion.
    const size = offset === COMPANY_ROSTER_LIMITS.maxRecordsPerCollection
      ? 1 : Math.min(COMPANY_ROSTER_LIMITS.pageSize, COMPANY_ROSTER_LIMITS.maxRecordsPerCollection - offset);
    const query = new URLSearchParams({ size: String(size), from: String(offset), sort_field: "date_created", sort_direction: "asc" });
    const payload = await fetchPage(`/${collection}?${query}`, budget);
    pages += 1;
    const batch = listRows(payload, collection);
    if (batch.length > size) throw new CompanyRosterError();
    const total = listTotal(payload);
    if (total !== null) {
      if (expectedTotal !== null && total !== expectedTotal) throw new CompanyRosterError();
      expectedTotal = total;
      if (total > COMPANY_ROSTER_LIMITS.maxRecordsPerCollection) throw new CompanyRosterError();
    }
    if (batch.length === 0) {
      if (expectedTotal !== null && offset !== expectedTotal) throw new CompanyRosterError();
      return { rows, proof: { complete: true, records: rows.length, pages, reportedTotal: expectedTotal, endProof: "empty_page_at_next_offset" } };
    }
    for (const row of batch) {
      const id = recordId(row);
      if (ids.has(id)) throw new CompanyRosterError();
      ids.add(id);
      rows.push(row);
    }
    offset += batch.length;
    if (offset > COMPANY_ROSTER_LIMITS.maxRecordsPerCollection
      || (expectedTotal !== null && offset > expectedTotal)) throw new CompanyRosterError();
    // Continue after short pages; provider page caps never imply completion.
  }
}

function projectRow(row, sourceKind, users, knownContacts, references) {
  const sourceId = recordId(row), flags = [];
  const ownerIds = owners(row);
  if (ownerIds.some(id => !users.has(id))) flags.push("unknown_owner");
  const address = scalar(row.property_address || row.full_address, 600)
    || [row.address_line1, row.address_line2, row.city, row.state_text, row.zip].map(v => scalar(v, 240)).filter(Boolean).join(", ");
  if (!address) flags.push("missing_property_address");
  const relationCandidates = [row.contact_id, row.parent_contact_id,
    ...(Array.isArray(row.related) ? row.related.map(r => r?.id || r?.jnid) : [])]
    .filter(v => v !== undefined && v !== null && v !== "")
    .map(v => stableId(v));
  const relatedContactIds = [...new Set(relationCandidates.filter(id => knownContacts.has(id) && !(sourceKind === "contact" && id === sourceId)))].sort();
  if (relationCandidates.some(id => !knownContacts.has(id))) flags.push("unresolved_relationship");
  const lifecycle = row.is_archived === true || row.archived === true ? "archived"
    : row.is_closed === true || row.closed === true ? "closed"
    : row.is_active === false ? "inactive"
    : row.is_active === true ? "active" : "unknown";
  return {
    sourceKind, sourceId,
    sourceRef: references.sourceRecordRef("jobnimbus", `${sourceKind}:${sourceId}`),
    number: scalar(row.number, 80),
    clientName: scalar(row.display_name || row.name || [row.first_name, row.last_name].filter(Boolean).join(" "), 240),
    propertyAddress: address,
    recordType: scalar(row.record_type_name, 160),
    status: scalar(row.status_name, 160),
    lifecycle,
    isActive: typeof row.is_active === "boolean" ? row.is_active : null,
    ownerIds,
    ownerNames: ownerIds.map(id => scalar(users.get(id)?.display_name || users.get(id)?.name, 240)),
    salesRepId: row.sales_rep ? stableId(row.sales_rep) : "",
    relatedContactIds,
    sourceCreatedAt: timestamp(row.date_created),
    sourceUpdatedAt: timestamp(row.date_updated),
    flags
  };
}

function owners(row) {
  const raw = row.owners ?? [];
  if (!Array.isArray(raw) || raw.length > 100) throw new CompanyRosterError();
  return [...new Set(raw.map(v => stableId(plain(v) ? v.id || v.jnid : v)))].sort();
}
function recordId(row) {
  if (!plain(row)) throw new CompanyRosterError();
  return stableId(row.jnid || row.id || row.user_id || row.userId);
}
function stableId(value) {
  if ((typeof value !== "string" && typeof value !== "number")
    || !/^[A-Za-z0-9._-]{1,128}$/.test(String(value))) throw new CompanyRosterError();
  return String(value);
}
function scalar(value, maximum) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") throw new CompanyRosterError();
  const text = String(value).trim();
  if (text.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new CompanyRosterError();
  return text;
}
function timestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  if (!Number.isFinite(ms)) throw new CompanyRosterError();
  return new Date(ms).toISOString();
}
function listRows(payload, collection) {
  if (Array.isArray(payload)) return payload;
  if (!plain(payload)) throw new CompanyRosterError();
  const present = [collection, collection.slice(0, -1), "results", "data", "items"].filter(k => Object.hasOwn(payload, k));
  if (present.length !== 1 || !Array.isArray(payload[present[0]])) throw new CompanyRosterError();
  return payload[present[0]];
}
function listTotal(payload) {
  if (!plain(payload)) return null;
  const values = [payload.total, payload.total_count, payload.totalCount, plain(payload.meta) ? payload.meta.total : undefined]
    .filter(v => v !== undefined && v !== null).map(v => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) ? Number(v) : v);
  if (!values.length) return null;
  if (values.some(v => !Number.isSafeInteger(v) || v < 0) || new Set(values).size !== 1) throw new CompanyRosterError();
  return values[0];
}
function counts(rows, key) {
  const values = new Map();
  for (const row of rows) values.set(key(row), (values.get(key(row)) || 0) + 1);
  return [...values].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => ({ value, count }));
}
function plain(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
