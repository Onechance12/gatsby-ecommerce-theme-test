import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createJobroloActivityExportService, JOBROLO_ACTIVITY_EXPORT_MAX_BYTES, jobroloActivityExportEnabled, validateJobroloActivityExportInput } from "./jobrolo-activity-export.js";

const fileRef = `subject_${"a".repeat(32)}`;
const input = { fileRef, retentionIntent: "private_job_history", recentLimit: 20 };
const occurredAt = "2026-09-20T12:00:00.000Z";
const item = { providerFileId: "file-a", providerRecordId: "message-1", kind: "email",
  occurredAt, title: "Claim correspondence", body: "Full matched body beyond any snippet.",
  direction: "incoming", status: "received", contentCompleteness: "complete" };
const envelope = (items = [item]) => ({ providerFileId: "file-a", exactFileMatch: true,
  complete: false, limitations: ["bounded_identifier_search"], items });
function fixture(overrides = {}) {
  return createJobroloActivityExportService({ enabled: true, accountScope: "account-a",
    resolveFile: async () => ({ fileRef, providerFileId: "file-a" }),
    sourceRecordRef: (provider, id) => createHash("sha256").update(`${provider}:${id}`).digest("hex"),
    now: () => new Date("2026-09-27T12:00:00.000Z"),
    loaders: { gmail: async () => envelope(), jobnimbus: async () => envelope([]),
      quo: async () => { throw new Error("provider credential private detail"); } }, ...overrides });
}

test("retained export requires explicit intent and is disabled before any reads", async () => {
  assert.equal(jobroloActivityExportEnabled(), false);
  assert.equal(jobroloActivityExportEnabled({ JOBROLO_ACTIVITY_EXPORT_ENABLED: "true" }), true);
  assert.equal(jobroloActivityExportEnabled({ JOBROLO_ACTIVITY_EXPORT_ENABLED: "1" }), false);
  let reads = 0;
  const service = fixture({ enabled: false, resolveFile: async () => { reads++; } });
  await assert.rejects(service(input), { code: "jobrolo_activity_export_disabled" });
  assert.equal(reads, 0);
  for (const value of [{ ...input, retentionIntent: "no_store" }, { ...input, fileRef: "file-a" },
    { ...input, recentLimit: 0 }, { ...input, recentLimit: 21 }, { ...input, extra: true }, null]) {
    assert.throws(() => validateJobroloActivityExportInput(value));
  }
  assert.equal(validateJobroloActivityExportInput({ fileRef, retentionIntent: "private_job_history" }).recentLimit, 20);
});

test("replays have stable opaque IDs/revisions and never disclose source/account IDs", async () => {
  const first = await fixture()(input);
  assert.deepEqual(first, await fixture()(input));
  assert.equal(first.schema, "hcn.job_activity.export.v1");
  assert.equal(first.records[0].body, item.body);
  assert.match(first.records[0].sourceRef, /^activity_[a-f0-9]{64}$/);
  assert.match(first.records[0].revision, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), /account-a|file-a|message-1|credential/);
  assert.notEqual(first.records[0].sourceRef,
    (await fixture({ accountScope: "account-b" })(input)).records[0].sourceRef);
  assert.equal(first.coverage.gmail.completeness, "partial");
  assert.equal(first.coverage.quo.status, "unavailable");
});

test("changed content changes revision, not source identity", async () => {
  const before = await fixture()(input);
  const after = await fixture({ loaders: { gmail: async () => envelope([{ ...item, body: "Updated message." }]) } })(input);
  assert.equal(before.records[0].sourceRef, after.records[0].sourceRef);
  assert.notEqual(before.records[0].revision, after.records[0].revision);
});

test("mismatched exact-file envelope and foreign rows cannot be retained", async () => {
  const result = await fixture({ loaders: {
    gmail: async () => envelope([{ ...item, providerFileId: "file-b", body: "foreign secret" }, item]),
    quo: async () => ({ ...envelope([item]), providerFileId: "file-b" })
  } })(input);
  assert.equal(result.records.length, 1);
  assert.equal(result.coverage.quo.status, "unavailable");
  assert.ok(result.coverage.gmail.limitations.includes("unverifiable_records_omitted"));
  assert.doesNotMatch(JSON.stringify(result), /foreign secret/);
  await assert.rejects(fixture({ resolveFile: async () => ({ fileRef: "wrong", providerFileId: "file-a" }) })(input),
    { code: "jobrolo_activity_export_scope" });
  let checks = 0;
  await assert.rejects(fixture({ resolveFile: async () => ({ fileRef, providerFileId: ++checks === 1 ? "file-a" : "file-b" }) })(input),
    { code: "jobrolo_activity_export_scope" });
});

test("bounds, partial text, call metadata and missing timestamps stay explicit", async () => {
  const result = await fixture({ loaders: {
    gmail: async () => envelope(Array.from({ length: 25 }, (_, index) => ({ ...item,
      providerRecordId: `email-${index}`, body: "x".repeat(12001) }))),
    quo: async () => envelope([{ ...item, kind: "call", body: "", contentCompleteness: "metadata_only" }]),
    jobnimbus: async () => envelope([{ ...item, kind: "task", occurredAt: null }])
  } })(input);
  assert.equal(result.records.length, 21);
  assert.equal(result.records.filter((row) => row.provider === "gmail").length, 20);
  assert.equal(result.records.find((row) => row.provider === "gmail").body.length, 12000);
  assert.equal(result.records.find((row) => row.provider === "gmail").contentCompleteness, "partial");
  assert.equal(result.records.find((row) => row.kind === "call").contentCompleteness, "metadata_only");
  assert.ok(result.coverage.jobnimbus.limitations.includes("unverifiable_records_omitted"));
  assert.ok(result.coverage.gmail.limitations.includes("recent_record_limit"));
});

test("aggregate UTF-8 response budget drops oldest records deterministically and reports it", async () => {
  const loaders = Object.fromEntries(["gmail", "quo", "jobnimbus"].map((provider) => [provider,
    async () => envelope(Array.from({ length: 20 }, (_, index) => ({ ...item,
      providerRecordId: `${provider}-${index}`, body: "界".repeat(12000),
      kind: provider === "gmail" ? "email" : provider === "quo" ? "sms" : "note",
      occurredAt: new Date(Date.parse(occurredAt) + index * 1000).toISOString() }))) ]));
  const first = await fixture({ loaders })(input);
  assert.deepEqual(first, await fixture({ loaders })(input));
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= JOBROLO_ACTIVITY_EXPORT_MAX_BYTES);
  assert.ok(first.records.length < 60 && first.records.length > 0);
  assert.ok(first.records.every(row => row.body.length === 12000));
  assert.ok(Object.values(first.coverage).some(source => source.limitations.includes("aggregate_byte_limit")));
  assert.ok(Object.values(first.coverage).every(source => source.completeness === "partial"));
  assert.ok(first.records.every(row => row.occurredAt >= first.records.at(-1).occurredAt));
});
