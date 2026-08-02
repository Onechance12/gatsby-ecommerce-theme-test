import assert from "node:assert/strict";
import test from "node:test";

import {
  CLOSED_FILE_BENCHMARK_SCHEMA_VERSION,
  buildClosedFileBenchmark,
  isClosedBenchmarkContact
} from "./core.js";

const NOW = "2026-08-01T16:00:00.000Z";
const START = "2022-08-01T16:00:00.000Z";

function contact(id, overrides = {}) {
  return {
    jnid: id,
    number: id.replace(/\D/g, "") || "1000",
    display_name: `Client ${id}`,
    record_type_name: "Insurance",
    status_name: "Closed - Collected",
    is_active: false,
    is_closed: true,
    date_created: "2024-01-01T12:00:00.000Z",
    date_updated: "2025-01-01T12:00:00.000Z",
    ...overrides
  };
}

function bundle(id, activities) {
  return { providerFileId: id, complete: true, activities };
}

function activity(id, at, note) {
  return {
    jnid: id,
    date_created: at,
    record_type_name: "Note",
    note
  };
}

test("ranks verified payment above a larger estimate-only mention", () => {
  const result = buildClosedFileBenchmark({
    generatedAt: NOW,
    rangeStart: START,
    limit: 10,
    contacts: [contact("file-1"), contact("file-2")],
    activityBundles: [
      bundle("file-1", [
        activity("a1", "2024-06-01T12:00:00.000Z", "Carrier estimate is $250,000.00.")
      ]),
      bundle("file-2", [
        activity("a2", "2024-07-01T12:00:00.000Z", "Final settlement received and client paid $125,000.00.")
      ])
    ]
  });

  assert.equal(result.schemaVersion, CLOSED_FILE_BENCHMARK_SCHEMA_VERSION);
  assert.equal(result.candidates[0].providerFileId, "file-2");
  assert.equal(result.candidates[0].financial.verifiedOutcomeAmount, 125000);
  assert.equal(result.candidates[1].financial.verifiedOutcomeAmount, 0);
  assert.equal(result.candidates[1].financial.mentionedAmount, 250000);
});

test("separates outcome and repeatability rankings", () => {
  const routine = [
    activity("r1", "2024-01-05T12:00:00.000Z", "Claim filed."),
    activity("r2", "2024-01-06T12:00:00.000Z", "Letter of Representation sent."),
    activity("r3", "2024-01-10T12:00:00.000Z", "Adjuster inspection completed."),
    activity("r4", "2024-01-15T12:00:00.000Z", "Estimate prepared and submitted."),
    activity("r5", "2024-02-01T12:00:00.000Z", "Settlement approved for $80,000."),
    activity("r6", "2024-02-05T12:00:00.000Z", "Payment received $80,000.")
  ];
  const appraisal = [
    activity("x1", "2024-01-05T12:00:00.000Z", "Claim filed."),
    activity("x2", "2025-06-01T12:00:00.000Z", "Appraisal award settled and paid $200,000.")
  ];
  const result = buildClosedFileBenchmark({
    generatedAt: NOW,
    rangeStart: START,
    limit: 10,
    contacts: [
      contact("file-10", { date_updated: "2024-02-05T12:00:00.000Z" }),
      contact("file-20", { date_updated: "2025-06-01T12:00:00.000Z" })
    ],
    activityBundles: [bundle("file-10", routine), bundle("file-20", appraisal)]
  });

  assert.equal(result.candidates[0].providerFileId, "file-20");
  assert.equal(result.repeatabilityLeaders[0].providerFileId, "file-10");
  assert.equal(result.candidates[0].workflow.appraisalDependent, true);
});

test("filters non-insurance, open, negative, and out-of-range records", () => {
  const rows = [
    contact("eligible"),
    contact("open", { is_active: true, is_closed: false, status_name: "Estimating" }),
    contact("denied", { status_name: "Closed - Denied" }),
    contact("old", { date_updated: "2021-01-01T12:00:00.000Z" }),
    contact("retail", { record_type_name: "Retail" })
  ];
  assert.equal(isClosedBenchmarkContact(rows[0], { generatedAt: NOW, rangeStart: START }), true);
  assert.equal(isClosedBenchmarkContact(rows[1], { generatedAt: NOW, rangeStart: START }), false);
  const result = buildClosedFileBenchmark({
    generatedAt: NOW,
    rangeStart: START,
    contacts: rows,
    activityBundles: rows.map((row) => bundle(row.jnid, [])),
    limit: 10
  });
  assert.equal(result.summary.eligibleClosedFileCount, 1);
  assert.deepEqual(result.exclusions, {
    nonInsurance: 1,
    notClosed: 1,
    outsideRange: 1,
    negativeOutcome: 1,
    missingActivityBundle: 0
  });
});

test("redacts contact details from financial evidence excerpts", () => {
  const result = buildClosedFileBenchmark({
    generatedAt: NOW,
    rangeStart: START,
    contacts: [contact("file-30")],
    activityBundles: [bundle("file-30", [
      activity(
        "a30",
        "2024-08-01T12:00:00.000Z",
        "Payment received $42,500. Call 214-555-1212 or client@example.com about claim ABCD-12345."
      )
    ])],
    limit: 10
  });
  const excerpt = result.candidates[0].financial.evidence[0].excerpt;
  assert.doesNotMatch(excerpt, /214-555|client@example|ABCD-12345/);
  assert.match(excerpt, /\$42,500/);
});

test("parses uncommaed dollar amounts without truncating them", () => {
  const result = buildClosedFileBenchmark({
    generatedAt: NOW,
    rangeStart: START,
    contacts: [contact("file-40")],
    activityBundles: [bundle("file-40", [
      activity("a40", "2024-08-01T12:00:00.000Z", "Payment received $6850.")
    ])],
    limit: 10
  });
  assert.equal(result.candidates[0].financial.verifiedPaidAmount, 6850);
  assert.equal(result.candidates[0].financial.verifiedOutcomeAmount, 6850);
});

test("classifies each amount in a mixed payment and estimate note independently", () => {
  const result = buildClosedFileBenchmark({
    generatedAt: NOW,
    rangeStart: START,
    contacts: [contact("file-50")],
    activityBundles: [bundle("file-50", [
      activity(
        "a50",
        "2024-08-01T12:00:00.000Z",
        "Total Payment Made: $35,973.26 - Estimated Damages: $53,979.48 - Remaining Settlement Due: $18,006.22"
      )
    ])],
    limit: 10
  });
  const financial = result.candidates[0].financial;
  assert.equal(financial.verifiedPaidAmount, 35973.26);
  assert.equal(financial.verifiedOutcomeAmount, 35973.26);
  assert.equal(financial.mentionedAmount, 53979.48);
});

test("does not promote vendor estimates, desired outcomes, or under-deductible awards", () => {
  const rows = [contact("estimate"), contact("desired"), contact("under-ded")];
  const result = buildClosedFileBenchmark({
    generatedAt: NOW,
    rangeStart: START,
    contacts: rows,
    activityBundles: [
      bundle("estimate", [activity("e1", "2024-08-01T12:00:00.000Z", "Vendor Estimate RCV $41,633.67. Appraisal minimum threshold.")]),
      bundle("desired", [activity("e2", "2024-08-01T12:00:00.000Z", "Client is looking to get approved and receive $12,000 from us.")]),
      bundle("under-ded", [activity("e3", "2024-08-01T12:00:00.000Z", "The appraisal award is under the $12,000 deductible. There is no payment due.")])
    ],
    limit: 10
  });
  for (const candidate of result.candidates) {
    assert.equal(candidate.financial.verifiedOutcomeAmount, 0);
  }
});

test("keeps a signed RCV award as a verified award, separate from paid money", () => {
  const result = buildClosedFileBenchmark({
    generatedAt: NOW,
    rangeStart: START,
    contacts: [contact("award")],
    activityBundles: [bundle("award", [
      activity("a60", "2024-08-01T12:00:00.000Z", "Appraisal award was signed today. Total RCV: $33,961.97")
    ])],
    limit: 10
  });
  const financial = result.candidates[0].financial;
  assert.equal(financial.verifiedAwardAmount, 33961.97);
  assert.equal(financial.verifiedPaidAmount, 0);
  assert.equal(financial.verifiedOutcomeAmount, 33961.97);
});
