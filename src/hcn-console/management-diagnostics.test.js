import assert from "node:assert/strict";
import test from "node:test";
import { BoundedJsonProviderError } from "../http/bounded-json.js";
import { createManagementReportDiagnostics, managementReportTransport,
  markManagementFailure } from "./management-diagnostics.js";

test("management diagnostics are limited to the two existing report routes", () => {
  assert.equal(managementReportTransport("POST", "/hcn/api/v1/management-sweep"), "native");
  assert.equal(managementReportTransport("POST", "/integrations/jobrolo/v1/management-sweep"), "jobrolo");
  assert.equal(managementReportTransport("GET", "/hcn/api/v1/management-sweep"), null);
  assert.equal(managementReportTransport("POST", "/hcn/api/v1/assistant/turns"), null);
  assert.equal(createManagementReportDiagnostics("private caller value"), null);
});

test("diagnostics preserve thrown error identity and first inner failure", async () => {
  const diagnostic = createManagementReportDiagnostics("native");
  const failure = new BoundedJsonProviderError("PRIVATE_CODE", 504, "timeout");
  failure.message = "PRIVATE BODY AND URL";
  await assert.rejects(diagnostic.observe("report_assembly", () =>
    diagnostic.observe("index_read", () => { throw failure; })), error => error === failure);
  const event = diagnostic.failureEvent(new Error("outer replacement"), 503, 17000);
  assert.equal(event.stage, "index_read");
  assert.equal(event.reason, "provider_timeout");
  assert.equal(event.upstreamStatus, 504);
  assert.equal(event.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE|outer replacement/);
});

test("safe diagnostic fields never include arbitrary errors, headers or bodies", () => {
  const error = Object.assign(new Error("SECRET_BODY"), {
    code: "SECRET_CODE", stack: "SECRET_STACK", reason: "SECRET_REASON",
    headers: { authorization: "SECRET_TOKEN" }, address: "SECRET_ADDRESS"
  });
  const diagnostic = createManagementReportDiagnostics("jobrolo");
  diagnostic.set("SECRET_KEY", 1);
  diagnostic.set("eligibleFiles", "SECRET_VALUE");
  diagnostic.capture("SECRET_STAGE", error);
  const event = diagnostic.failureEvent(error, "SECRET_STATUS", "SECRET_DURATION");
  assert.equal(event.stage, "unknown");
  assert.equal(event.reason, "unavailable");
  assert.equal(event.statusCode, 500);
  assert.equal(event.durationMs, null);
  assert.equal(event.counters.eligibleFiles, null);
  assert.doesNotMatch(JSON.stringify(event), /SECRET/);
  assert.match(event.diagnosticId, /^report_diag_[a-f0-9]{32}$/);
  const forged = new BoundedJsonProviderError("PRIVATE", 403, "SECRET_REASON");
  const second = createManagementReportDiagnostics("native");
  assert.equal(second.failureEvent(forged, 503, 1).reason, "provider_unavailable");
});

test("trusted failure tags are allowlisted and do not alter public error fields", () => {
  const error = new Error("unchanged public error");
  const before = JSON.stringify(error);
  assert.equal(markManagementFailure(error, "duplicate_contact_id"), error);
  assert.equal(JSON.stringify(error), before);
  assert.equal(error.message, "unchanged public error");
  const diagnostic = createManagementReportDiagnostics("native");
  diagnostic.capture("index_read", error);
  assert.equal(diagnostic.failureEvent(error, 503, 0).reason, "duplicate_contact_id");
  const other = createManagementReportDiagnostics("native");
  assert.equal(other.failureEvent(markManagementFailure(new Error(), "secret"), 503, 0).reason, "unavailable");
});

test("concurrent reads preserve the first failed stage and freeze terminal counts", async () => {
  const diagnostic = createManagementReportDiagnostics("native");
  let rejectLater;
  const later = diagnostic.observe("document_read", () => new Promise((_, reject) => { rejectLater = reject; }));
  const caughtLater = later.catch(error => error);
  const first = markManagementFailure(new Error(), "reference_mismatch");
  await assert.rejects(diagnostic.observe("activity_primary_read", () => { throw first; }));
  diagnostic.set("providerReads", 5);
  const event = diagnostic.failureEvent(first, 503, 4);
  rejectLater(new BoundedJsonProviderError("FIXTURE", 429, "http_status"));
  await caughtLater;
  diagnostic.increment("providerReads");
  assert.equal(diagnostic.failureEvent(new Error(), 500, 99), event);
  assert.equal(event.reason, "reference_mismatch");
  assert.equal(event.stage, "activity_primary_read");
  assert.equal(event.counters.providerReads, 5);
});

test("independent reports have independent IDs, counters and errors", async () => {
  const first = createManagementReportDiagnostics("native");
  const second = createManagementReportDiagnostics("jobrolo");
  assert.notEqual(first.diagnosticId, second.diagnosticId);
  assert.equal(await second.observe("index_read", () => 42), 42);
  first.set("providerReads", 99999);
  first.set("eligibleFiles", -1);
  const a = first.failureEvent(new Error(), 503, 999999);
  const b = second.failureEvent(new Error(), 403, 0);
  assert.equal(a.counters.providerReads, 2500);
  assert.equal(a.counters.eligibleFiles, null);
  assert.equal(a.durationMs, 300000);
  assert.equal(b.counters.providerReads, null, "unknown is not zero");
  assert.equal(b.stage, "authorization");
});
