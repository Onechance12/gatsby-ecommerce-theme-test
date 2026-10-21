import { randomBytes } from "node:crypto";
import { BoundedJsonProviderError } from "../http/bounded-json.js";

const STAGES = new Set([
  "authorization", "admission", "report_assembly", "index_read",
  "index_normalize", "scope_bound", "activity_primary_read",
  "activity_related_read", "activity_merge", "document_read",
  "history_normalize", "report_normalize", "freshness"
]);
const REASONS = new Set([
  "unavailable", "not_configured", "pagination_shape", "duplicate_contact_id",
  "invalid_contact_id", "reference_mismatch", "inconsistent_activity",
  "incomplete_index", "incomplete_history", "scope_bound", "budget_exceeded",
  "normalization_failed", "scope_changed", "freshness_expired"
]);
const PROVIDER_REASONS = new Set([
  "timeout", "transport", "http_status", "invalid_response", "content_type",
  "missing_body", "size_limit", "invalid_json", "invalid_json_shape"
]);
const COUNTERS = Object.freeze({
  providerReads: 2500, providerReadLimit: 2500, indexPages: 11,
  indexRecords: 5000, eligibleFiles: 5000, fileLimit: 500,
  historiesStarted: 500, historiesCompleted: 500
});
const failureReasons = new WeakMap();

// Error identity/message/status and all admission decisions remain unchanged.
export function markManagementFailure(error, reason) {
  if (error && typeof error === "object" && REASONS.has(reason)) {
    failureReasons.set(error, reason);
  }
  return error;
}

function boundedInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum) : null;
}

function safeStatus(value) {
  return Number.isSafeInteger(value) && value >= 400 && value <= 599
    ? value : null;
}

function failureDetails(error) {
  if (error instanceof BoundedJsonProviderError) {
    return {
      reason: PROVIDER_REASONS.has(error.failureKind)
        ? `provider_${error.failureKind}` : "provider_unavailable",
      upstreamStatus: safeStatus(error.statusCode)
    };
  }
  return { reason: failureReasons.get(error) || "unavailable", upstreamStatus: null };
}

export function managementReportTransport(method, pathname) {
  if (method !== "POST") return null;
  if (pathname === "/hcn/api/v1/management-sweep") return "native";
  if (pathname === "/integrations/jobrolo/v1/management-sweep") return "jobrolo";
  return null;
}

export function createManagementReportDiagnostics(transport) {
  if (!["native", "jobrolo"].includes(transport)) return null;
  const diagnosticId = `report_diag_${randomBytes(16).toString("hex")}`;
  const counters = Object.fromEntries(Object.keys(COUNTERS).map(key => [key, null]));
  let failure = null;
  let terminal = null;
  function capture(stage, error) {
    // The first failing inner operation wins, including concurrent histories.
    // Never inspect later failures after the terminal snapshot is taken.
    if (!failure && !terminal) {
      failure = {
        stage: STAGES.has(stage) ? stage : "unknown",
        ...failureDetails(error)
      };
    }
  }
  return Object.freeze({
    diagnosticId,
    set(key, value) {
      if (!terminal && Object.hasOwn(COUNTERS, key)) {
        counters[key] = boundedInteger(value, COUNTERS[key]);
      }
    },
    increment(key) {
      if (!terminal && Object.hasOwn(COUNTERS, key)) {
        counters[key] = Math.min((counters[key] ?? 0) + 1, COUNTERS[key]);
      }
    },
    capture,
    async observe(stage, work) {
      try { return await work(); }
      catch (error) { capture(stage, error); throw error; }
    },
    failureEvent(error, statusCode, durationMs) {
      if (terminal) return terminal;
      capture("authorization", error);
      terminal = Object.freeze({
        type: "hcn_management_report_failed",
        schema: "hcn.management-report-diagnostic.v1",
        diagnosticId, transport, ...failure,
        statusCode: safeStatus(statusCode) ?? 500,
        durationMs: boundedInteger(durationMs, 300_000),
        counters: Object.freeze({ ...counters }),
        automaticRetry: false, customerDataIncluded: false
      });
      return terminal;
    }
  });
}
