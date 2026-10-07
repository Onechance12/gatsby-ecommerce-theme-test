import { createHash } from "node:crypto";

export const HCN_JOBROLO_ACTIVITY_EXPORT_ROUTE =
  "/integrations/jobrolo/v1/file-activity-export";
export const JOBROLO_ACTIVITY_EXPORT_SCHEMA = "hcn.job_activity.export.v1";
export const JOBROLO_ACTIVITY_EXPORT_MAX_BYTES = 1536 * 1024;
const PROVIDERS = ["jobnimbus", "gmail", "quo"];

export function jobroloActivityExportEnabled(environment = {}) {
  return environment.JOBROLO_ACTIVITY_EXPORT_ENABLED === "true";
}

export function validateJobroloActivityExportInput(input) {
  if (!record(input)
    || Object.keys(input).some((key) => !["fileRef", "retentionIntent", "recentLimit"].includes(key))
    || !/^subject_[a-f0-9]{32}$/.test(input.fileRef || "")
    || input.retentionIntent !== "private_job_history"
    || (input.recentLimit !== undefined && (!Number.isInteger(input.recentLimit)
      || input.recentLimit < 1 || input.recentLimit > 20))) {
    fail(400, "invalid_jobrolo_activity_export", "Exact file and private job history retention intent are required.");
  }
  return { fileRef: input.fileRef, retentionIntent: input.retentionIntent,
    recentLimit: input.recentLimit ?? 20 };
}

/** Explicit retained export, separate from ephemeral/no_store review results. */
export function createJobroloActivityExportService({ enabled, resolveFile,
  accountScope, sourceRecordRef, loaders, now = () => new Date() }) {
  return async (input) => {
    if (enabled !== true) fail(503, "jobrolo_activity_export_disabled", "Private job activity export is not enabled.");
    const request = validateJobroloActivityExportInput(input);
    if (typeof accountScope !== "string" || !accountScope
      || typeof sourceRecordRef !== "function") {
      fail(503, "jobrolo_activity_export_unavailable", "Private activity source identity is unavailable.");
    }
    const generatedAt = now().toISOString();
    const scope = await resolveFile(request.fileRef);
    if (scope?.fileRef !== request.fileRef || !scope.providerFileId) {
      fail(404, "jobrolo_activity_export_scope", "The exact assigned file is unavailable.");
    }
    const records = [];
    const coverage = {};
    for (const provider of PROVIDERS) {
      let source;
      try {
        source = await loaders[provider]({ providerFileId: scope.providerFileId,
          recentLimit: request.recentLimit, requestedAt: generatedAt });
      } catch (error) {
        const reason = ["google_not_linked", "file_phone_missing", "phone_match_unverified",
          "provider_check_failed", "scope_check_failed", "work_line_not_linked"]
          .includes(error?.hcnSourceFailureCode) ? error.hcnSourceFailureCode : "source_unavailable";
        coverage[provider] = unavailable(reason);
        continue;
      }
      if (!record(source) || source.providerFileId !== scope.providerFileId
        || source.exactFileMatch !== true || !Array.isArray(source.items)
        || source.items.length > 1500) {
        coverage[provider] = unavailable("source_scope_unverified");
        continue;
      }
      const accepted = [];
      let dropped = false;
      const seen = new Set();
      for (const item of source.items) {
        if (!record(item) || item.providerFileId !== scope.providerFileId
          || typeof item.providerRecordId !== "string" || !item.providerRecordId
          || !timestamp(item.occurredAt)
          || !["note", "task", "document", "email", "sms", "call"].includes(item.kind)
          || !["complete", "partial", "metadata_only"].includes(item.contentCompleteness)) {
          dropped = true;
          continue;
        }
        const privateIdentity = JSON.stringify(["retained-activity-v1", accountScope,
          scope.providerFileId, item.kind, item.providerRecordId]);
        const sourceRef = `activity_${hash(sourceRecordRef(provider, privateIdentity))}`;
        if (seen.has(sourceRef)) { dropped = true; continue; }
        seen.add(sourceRef);
        const body = safeText(item.body, 12000);
        const entry = {
          sourceRef, provider, kind: item.kind, occurredAt: item.occurredAt,
          title: safeText(item.title, 240), body,
          direction: ["incoming", "outgoing"].includes(item.direction) ? item.direction : "unknown",
          status: safeText(item.status, 80) || "unknown",
          contentCompleteness: typeof item.body === "string" && item.body.length > 12000
            ? "partial" : item.contentCompleteness
        };
        accepted.push({ ...entry, revision: hash(JSON.stringify(entry)) });
      }
      accepted.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)
        || a.sourceRef.localeCompare(b.sourceRef));
      records.push(...accepted.slice(0, request.recentLimit));
      const limitations = [...new Set([
        ...(Array.isArray(source.limitations) ? source.limitations : []),
        ...(dropped ? ["unverifiable_records_omitted"] : []),
        ...(accepted.length > request.recentLimit ? ["recent_record_limit"] : []),
        ...(accepted.some((item) => item.contentCompleteness === "partial") ? ["content_truncated"] : [])
      ])].filter((value) => typeof value === "string" && value).slice(0, 10)
        .map((value) => safeText(value, 240));
      coverage[provider] = { status: "available",
        completeness: source.complete === true && limitations.length === 0 ? "complete" : "partial",
        limitations };
    }
    // Recheck the exact assigned identity after provider reads before disclosure.
    const current = await resolveFile(request.fileRef);
    if (current?.fileRef !== scope.fileRef || current?.providerFileId !== scope.providerFileId) {
      fail(404, "jobrolo_activity_export_scope", "The exact assigned file changed during export.");
    }
    records.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)
      || a.sourceRef.localeCompare(b.sourceRef));
    const result = { schema: JOBROLO_ACTIVITY_EXPORT_SCHEMA, generatedAt,
      fileRef: request.fileRef, retention: "private_job_history", records, coverage };
    while (Buffer.byteLength(JSON.stringify(result), "utf8") > JOBROLO_ACTIVITY_EXPORT_MAX_BYTES) {
      // Records are newest first with a stable ref tiebreaker. Never silently
      // lose text within a record or call a byte-bounded export complete.
      const omitted = records.pop();
      const source = coverage[omitted.provider];
      source.completeness = "partial";
      source.limitations = [...new Set(["aggregate_byte_limit", ...source.limitations])].slice(0, 10);
    }
    return result;
  };
}

function unavailable(reason = "source_unavailable") {
  return { status: "unavailable", completeness: "partial", limitations: [reason] };
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function safeText(value, limit) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, limit).replace(/[\ud800-\udbff]$/u, "");
}
function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function record(value) { return value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function fail(statusCode, code, message) {
  const error = new Error(message); error.statusCode = statusCode; error.code = code; throw error;
}
