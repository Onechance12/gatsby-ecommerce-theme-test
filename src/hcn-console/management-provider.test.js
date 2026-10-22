import assert from "node:assert/strict";
import test from "node:test";
import { createHcnReferenceFactory } from "../hcn-ops/references.js";
import { projectManagementCoverageExceptions, summarizeUnsupportedManagementActivities } from "./management-exceptions.js";

import {
  HCN_MANAGEMENT_ESTIMATING_STATUS_CODES,
  mapManagementJobNimbusEnvelope
} from "./management-provider.js";

const NOW = "2026-07-29T12:00:00.000Z";
const VALID_UNTIL = "2026-07-29T12:02:00.000Z";
const ADJUSTERS = [
  { ownerId: "owner_a", displayName: "Adjuster A" },
  { ownerId: "owner_b", displayName: "Adjuster B" },
  { ownerId: "owner_c", displayName: "Adjuster C" }
];

function contact(id, ownerId, overrides = {}) {
  return {
    jnid: id,
    number: `FILE-${id.slice(-1).toUpperCase()}`,
    display_name: `Synthetic File ${id.slice(-1).toUpperCase()}`,
    record_type_name: "Insurance",
    owners: [{ id: ownerId }],
    status_name: "Carrier Review",
    stage_name: "Open",
    is_active: true,
    date_created: "2026-06-01T12:00:00.000Z",
    date_updated: "2026-07-20T12:00:00.000Z",
    ...overrides
  };
}

function envelope(overrides = {}) {
  return {
    contacts: [
      contact("file_a", "owner_a"),
      contact("file_b", "owner_b"),
      contact("file_c", "owner_c")
    ],
    activities: [],
    tasks: [],
    contactsComplete: true,
    activitiesComplete: true,
    tasksComplete: true,
    asOf: NOW,
    checkedAt: NOW,
    validUntil: VALID_UNTIL,
    ...overrides
  };
}

test("management provider emits only active files owned by one configured adjuster", () => {
  const input = envelope({
    contacts: [
      contact("file_a", "owner_a"),
      contact("file_f", "owner_a", {
        created_by: { id: "owner_b" },
        updated_by: { id: "owner_c" }
      }),
      contact("file_b", "owner_b", { is_active: false }),
      contact("file_c", "owner_other"),
      contact("file_d", "owner_c", { record_type_name: "Retail" }),
      contact("file_e", "owner_c", {
        owners: [{ id: "owner_b" }, { id: "owner_c" }]
      })
    ]
  });
  const result = mapManagementJobNimbusEnvelope(input, {
    adjusters: ADJUSTERS
  });
  assert.equal(result.data.files.length, 2);
  assert.equal(result.data.files[0].providerFileId, "file_a");
  assert.equal(result.data.files[0].assignedAdjusterId, "owner_a");
  assert.equal(result.data.files[1].providerFileId, "file_f");
  assert.equal(result.data.files[1].assignedAdjusterId, "owner_a");
  assert.deepEqual(result.data.excluded, {
    inactive: 1,
    nonInsurance: 1,
    unknownFileType: 0,
    unknownOwner: 0,
    unknownActivityState: 0,
    unconfiguredOwner: 1,
    ambiguousOwner: 1,
    outsideWorkflowStatus: 0
  });
});

test("shared-owner exception metadata preserves scope and stops before active-state admission", () => {
  const shared = contact("synthetic_shared", "owner_a", {
    owners: [{ id: "owner_a" }, { id: "owner_b" }, { id: "outside_owner" }],
    number: {}, display_name: {}, notes: "private body must not project"
  });
  Object.defineProperty(shared, "is_active", { get() { throw new Error("must not inspect active state"); } });
  const result = mapManagementJobNimbusEnvelope(envelope({ contacts: [shared,
    contact("outside_shared", "outside_owner", { owners: [{ id: "outside_owner" }, { id: "outside_second" }] }),
    contact("retail_shared", "owner_a", { record_type_name: "Retail", owners: [{ id: "owner_a" }, { id: "owner_b" }] })
  ] }), { adjusters: ADJUSTERS });
  assert.equal(result.data.files.length, 0);
  assert.equal(result.data.excluded.ambiguousOwner, 1);
  assert.deepEqual(result.data.ownershipExceptions, [{
    providerFileId: "synthetic_shared", jobNumber: null, displayName: "Unnamed file", matchingOwnerIds: ["owner_a", "owner_b"]
  }]);
  assert.equal(result.data.census.activeFileCount, 0);
  const projected = projectManagementCoverageExceptions(result.data, projectionOptions());
  assert.equal(projected.ownership.totalCount, 1);
  assert.equal(projected.ownership.truncated, false);
  assert.deepEqual(projected.ownership.items[0].adjusterRefs, ["adjuster_0", "adjuster_1"]);
  assert.equal(projected.ownership.items[0].activityState, "not_evaluated");
  assert.doesNotMatch(JSON.stringify(projected), /synthetic_shared|outside_|private body|owner_a|owner_b/);
});

function projectionOptions() {
  return {
    references: createHcnReferenceFactory({ hmacKey: Buffer.alloc(32, 1), tenantId: "tenant_0123456789abcdef" }),
    adjusters: ADJUSTERS.map((owner, i) => ({ ...owner, adjusterRef: `adjuster_${i}` }))
  };
}

test("unsupported groups identify normalized type/state without changing activity classifications", () => {
  const activities = [
    ["a", "Email", "Draft"], ["b", "Email", "Draft"],
    ["c", "Custom Activity", "New"], ["d", "Note", "Recorded"],
    ["e", "Contact Updated", "Recorded"], ["f", "Photo Deleted", "Recorded"],
    ["g", "Note", "Recorded"]
  ].map(([id, type, state], i) => ({
    jnid: `synthetic_event_${id}`, related: [{ id: "file_a" }], record_type_name: type, status_name: state,
    date_created: `2026-07-2${i + 1}T12:00:00.000Z`, note: "DO NOT PROJECT BODY", ...(id === "g" ? { is_automated: true } : {})
  }));
  const result = mapManagementJobNimbusEnvelope(envelope({ activities }), { adjusters: ADJUSTERS });
  const original = JSON.stringify(result.data.events);
  const summary = summarizeUnsupportedManagementActivities(result.data.events);
  assert.deepEqual(result.data.events.map(e => e.classification), ["unsupported", "unsupported", "unsupported", "operational", "operational", "operational", "noise"]);
  assert.equal(summary.totalRecordCount, 3);
  assert.equal(summary.totalGroupCount, 2);
  assert.deepEqual(summary.items.map(({ kind, state, count }) => ({ kind, state, count })), [
    { kind: "custom_activity", state: "new", count: 1 }, { kind: "email", state: "draft", count: 2 }
  ]);
  const projected = projectManagementCoverageExceptions({ ...result.data, files: [{ ...result.data.files[0],
    unsupportedActivities: summary, eventSummary: { unsupportedEventCount: 3 }
  }] }, projectionOptions());
  assert.equal(projected.unsupportedActivities.totalRecordCount, 3);
  assert.equal(projected.unsupportedActivities.returnedGroupCount, 2);
  assert.equal(projected.unsupportedActivities.items[1].latestAt, "2026-07-22T12:00:00.000Z");
  assert.match(projected.unsupportedActivities.items[1].evidenceRef, /^ref_[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(projected), /synthetic_event|file_a|owner_a|DO NOT PROJECT BODY/);
  assert.equal(JSON.stringify(result.data.events), original);
});

test("exception detail limits never truncate census counts or silently hide omitted types", () => {
  const result = mapManagementJobNimbusEnvelope(envelope({ contacts: Array.from({ length: 105 }, (_, i) =>
    contact(`shared_${i}`, "owner_a", { owners: [{ id: "owner_a" }, { id: "owner_b" }] }))
  }), { adjusters: ADJUSTERS });
  const events = Array.from({ length: 105 }, (_, i) => ({ classification: "unsupported", kind: `custom_${i}`, state: "recorded",
    occurredAt: NOW, evidenceId: `synthetic_${i}` }));
  const summary = summarizeUnsupportedManagementActivities(events);
  const output = projectManagementCoverageExceptions({ ...result.data, files: [{ providerFileId: "file_a", displayName: "Synthetic",
    jobNumber: "SYN-1", assignedAdjusterId: "owner_a", unsupportedActivities: summary, eventSummary: { unsupportedEventCount: 105 }
  }] }, projectionOptions());
  assert.equal(output.ownership.totalCount, 105);
  assert.equal(output.ownership.returnedCount, 100);
  assert.equal(output.ownership.truncated, true);
  assert.equal(output.unsupportedActivities.totalRecordCount, 105);
  assert.equal(output.unsupportedActivities.totalGroupCount, 105);
  assert.equal(output.unsupportedActivities.returnedGroupCount, 100);
  assert.equal(output.unsupportedActivities.truncated, true);
  assert.equal(result.data.files.length, 0);
});

test("default census includes the whole assigned portfolio before activity and top-ten selection", () => {
  const contacts = Array.from({ length: 540 }, (_, i) => contact(`file_${i}`, ADJUSTERS[i % 3].ownerId, {
    number: `SYN-${i}`, status_name: ["Appraisal Interest", "Legal", "Ready for Production", "Refile", "On Hold", "Submitted"][i % 6]
  }));
  contacts.push(
    contact("closed", "owner_a", { is_closed: true }),
    contact("unknown", "owner_b", { is_active: undefined }),
    contact("conflict", "owner_b", { isActive: false }),
    contact("ambiguous", "owner_c", { owners: [{ id: "owner_a" }, { id: "owner_c" }] }),
    contact("unassigned", "owner_a", { owners: [] }),
    contact("bad_owner", "owner_a", { owners: [{}] }),
    contact("missing_owner", "owner_a", { owners: null }),
    contact("retail", "owner_a", { record_type_name: "Retail" }),
    contact("unknown_type", "owner_a", { record_type_name: undefined })
  );
  const result = mapManagementJobNimbusEnvelope(envelope({ contacts }), { adjusters: ADJUSTERS });
  const c = result.data.census;
  assert.equal(result.data.files.length, 540);
  assert.equal(c.scannedContactCount, 549);
  assert.equal(c.insuranceContactCount, 547);
  assert.equal(c.assignedInsuranceCount, 544);
  assert.equal(c.singleAssignedCount, 543);
  assert.equal(c.activeFileCount, 540);
  assert.equal(c.inactiveFileCount, 1);
  assert.equal(c.unknownActivityStateCount, 2);
  assert.equal(c.ambiguousOwnerCount, 1);
  assert.equal(c.unknownOwnerCount, 2);
  assert.equal(c.outsideConfiguredOwnerCount, 1);
  assert.equal(c.outsideWorkflowStatusCount, 0);
  assert.deepEqual(c.adjusters.map(g => [g.assignedInsuranceCount, g.activeFileCount]), [[182, 180], [182, 180], [181, 180]]);
  assert.equal(c.scannedContactCount, result.data.files.length + Object.values(result.data.excluded).reduce((a, b) => a + b, 0));
  assert.equal(c.assignedInsuranceCount, c.singleAssignedCount + c.ambiguousOwnerCount);
  assert.equal(c.singleAssignedCount, c.activeFileCount + c.inactiveFileCount + c.unknownActivityStateCount);
  const filtered = mapManagementJobNimbusEnvelope(envelope({ contacts }), { adjusters: ADJUSTERS, workflowScope: "estimating_board" });
  assert.equal(filtered.data.census.assignedInsuranceCount, c.assignedInsuranceCount);
  assert.equal(filtered.data.census.activeFileCount, 540);
  assert.equal(filtered.data.files.length, 90);
  assert.equal(filtered.data.excluded.outsideWorkflowStatus, 450);
});

test("duplicate index rows are rejected even when they would not enter the ranked population", () => {
  const row = contact("duplicate_closed", "owner_other", { is_active: false });
  assert.throws(() => mapManagementJobNimbusEnvelope(envelope({ contacts: [row, row] }), { adjusters: ADJUSTERS }), /duplicate JobNimbus file in index/);
});

test("automation metadata on ordinary notes cannot reset the gap clock", () => {
  const markers = [{ is_automated: true }, { automated: "true" }, { is_system: 1 },
    { source_type: "integration" }, { origin: "Zapier" }, { created_by_name: "System Automation" },
    { actor_type: "system" }, { is_imported: true }];
  const result = mapManagementJobNimbusEnvelope(envelope({ activities: markers.map((marker, index) => ({
    jnid: `synthetic_auto_${index}`, related: [{ id: "file_a" }], record_type_name: "Note",
    status_name: "Recorded", date_created: NOW, created_by: "owner_a", ...marker
  })) }), { adjusters: ADJUSTERS });
  assert.equal(result.data.events.length, markers.length);
  assert.ok(result.data.events.every(event => event.classification === "noise"));
});

test("estimating-board scope filters the fixed six statuses before ranking evidence", () => {
  const estimatingLabels = [
    "Photo File / Estimate Needed",
    "Ready for PA Review",
    "Submitted Awaiting Confirmation",
    "Submitted",
    "HOT/Final Negotiation",
    "Estimating Finalized (Awaiting ACV)"
  ];
  const contacts = estimatingLabels.map((statusName, index) =>
    contact(`estimating_${index}`, "owner_a", {
      number: `EST-${index + 1}`,
      status_name: statusName
    })
  );
  contacts.push(
    contact("appraisal_file", "owner_a", {
      number: "APP-1",
      status_name: "Appraisal Interest"
    }),
    contact("production_file", "owner_b", {
      number: "PROD-1",
      status_name: "Ready for Production"
    }),
    contact("legal_file", "owner_c", {
      number: "LEGAL-1",
      status_name: "Legal"
    })
  );

  const result = mapManagementJobNimbusEnvelope(envelope({ contacts }), {
    adjusters: ADJUSTERS,
    workflowScope: "estimating_board"
  });

  assert.deepEqual(
    result.data.files.map(({ statusCode }) => statusCode),
    [...HCN_MANAGEMENT_ESTIMATING_STATUS_CODES]
  );
  assert.equal(result.data.excluded.outsideWorkflowStatus, 3);
  assert.equal(Object.isFrozen(HCN_MANAGEMENT_ESTIMATING_STATUS_CODES), true);
  assert.throws(
    () => HCN_MANAGEMENT_ESTIMATING_STATUS_CODES.push("appraisal_interest"),
    TypeError
  );
});

test("management provider rejects caller-defined workflow scopes", () => {
  assert.throws(
    () => mapManagementJobNimbusEnvelope(envelope(), {
      adjusters: ADJUSTERS,
      workflowScope: "appraisal"
    }),
    /invalid management workflow scope/
  );
});

test("management provider classifies communication, attempts, operations, and noise", () => {
  const result = mapManagementJobNimbusEnvelope(envelope({
    activities: [
      {
        jnid: "event_success",
        related: [{ id: "file_a" }],
        owners: [{ id: "owner_a" }],
        record_type_name: "Phone Call",
        status_name: "Answered",
        date_created: "2026-07-28T10:00:00.000Z"
      },
      {
        jnid: "event_attempt",
        related: [{ id: "file_a" }],
        record_type_name: "Text Message",
        status_name: "Failed",
        date_created: "2026-07-27T10:00:00.000Z"
      },
      {
        jnid: "event_note",
        related: [{ id: "file_b" }],
        record_type_name: "Note",
        status_name: "Recorded",
        date_created: 1785060000
      },
      {
        jnid: "event_noise",
        related: [{ id: "file_c" }],
        record_type_name: "System_Sync",
        status_name: "Recorded",
        date_created: "2026-07-25T10:00:00.000Z"
      }
    ]
  }), { adjusters: ADJUSTERS });

  assert.deepEqual(
    result.data.events.map((event) => event.classification),
    [
      "successful_communication",
      "contact_attempt",
      "operational",
      "noise"
    ]
  );
  assert.equal(result.data.events[0].actorAdjusterId, "owner_a");
  assert.equal(result.data.events[2].occurredAt, "2026-07-26T10:00:00.000Z");
});

test("management provider counts JobNimbus Status Changed records as operational activity", () => {
  const result = mapManagementJobNimbusEnvelope(envelope({
    activities: [{
      jnid: "event_status_changed",
      related: [{ id: "file_a" }],
      owners: [{ id: "owner_a" }],
      record_type_name: "Status Changed",
      date_created: NOW
    }]
  }), { adjusters: ADJUSTERS });

  assert.equal(result.data.events.length, 1);
  assert.equal(result.data.events[0].kind, "status_changed");
  assert.equal(result.data.events[0].state, "recorded");
  assert.equal(result.data.events[0].classification, "operational");
  assert.equal(result.data.events[0].actorAdjusterId, "owner_a");
});

test("management provider recognizes human file work from the JobNimbus activity stream", () => {
  const result = mapManagementJobNimbusEnvelope(envelope({
    activities: [
      {
        jnid: "event_comment_created",
        related: { id: "file_a" },
        record_type_name: "Comment",
        status_name: "Created",
        date_created: NOW
      },
      {
        jnid: "event_task_created",
        related: { id: "file_a" },
        record_type_name: "Task",
        status_name: "Created",
        date_created: NOW
      },
      {
        jnid: "event_task_updated",
        related: { id: "file_a" },
        record_type_name: "Task",
        status_name: "Updated",
        date_created: NOW
      },
      {
        jnid: "event_task_completed",
        related: { id: "file_a" },
        record_type_name: "Task",
        status_name: "Completed",
        date_created: NOW
      },
      {
        jnid: "event_field_changed",
        related: { id: "file_b" },
        record_type_name: "Field Changed",
        date_created: NOW
      },
      {
        jnid: "event_contact_modified",
        related: { id: "file_b" },
        record_type_name: "Contact Modified",
        date_created: NOW
      },
      {
        jnid: "event_assigned_contact",
        related: { id: "file_b" },
        record_type_name: "Assigned Contact",
        date_created: NOW
      },
      {
        jnid: "event_attachment_deleted",
        related: { id: "file_b" },
        record_type_name: "Attachment Deleted",
        status_name: "Deleted",
        date_created: NOW
      },
      {
        jnid: "event_related_to_task",
        related: { id: "file_b" },
        record_type_name: "Related to Task",
        date_created: NOW
      },
      {
        jnid: "event_document_created",
        related: { id: "file_b" },
        record_type_name: "Document",
        status_name: "Created",
        date_created: NOW
      },
      {
        jnid: "event_photo_uploaded",
        related: { id: "file_b" },
        record_type_name: "Photo",
        status_name: "Uploaded",
        date_created: NOW
      },
      {
        jnid: "event_form_submitted",
        related: { id: "file_c" },
        record_type_name: "Form",
        status_name: "Submitted",
        date_created: NOW
      },
      {
        jnid: "event_estimate_created",
        related: { id: "file_c" },
        record_type_name: "Estimate",
        status_name: "Created",
        date_created: NOW
      },
      {
        jnid: "event_call_recorded",
        related: { id: "file_c" },
        record_type_name: "Phone Call",
        status_name: "Recorded",
        date_created: NOW
      },
      {
        jnid: "event_note_created",
        related: { id: "file_c" },
        record_type_name: "Note",
        status_name: "Created",
        date_created: NOW
      }
    ]
  }), { adjusters: ADJUSTERS });

  assert.equal(result.data.events.length, 15);
  assert.equal(
    result.data.events.every((event) => event.classification === "operational"),
    true
  );
});

test("management provider excludes non-work activity from the gap clock", () => {
  const result = mapManagementJobNimbusEnvelope(envelope({
    activities: [
      {
        jnid: "event_email_draft",
        related: { id: "file_a" },
        record_type_name: "Email",
        status_name: "Draft",
        date_created: NOW
      },
      {
        jnid: "event_note_automated",
        related: { id: "file_a" },
        record_type_name: "Note",
        status_name: "Automated",
        date_created: NOW
      },
      {
        jnid: "event_note_system",
        related: { id: "file_a" },
        record_type_name: "Note",
        status_name: "System",
        date_created: NOW
      },
      {
        jnid: "event_file_opened",
        related: { id: "file_b" },
        record_type_name: "File",
        status_name: "Opened",
        date_created: NOW
      },
      {
        jnid: "event_document_viewed",
        related: { id: "file_b" },
        record_type_name: "Document",
        status_name: "Viewed",
        date_created: NOW
      },
      {
        jnid: "event_imported",
        related: { id: "file_c" },
        record_type_name: "Imported Activity",
        status_name: "Recorded",
        date_created: NOW
      },
      {
        jnid: "event_unknown",
        related: { id: "file_c" },
        date_created: NOW
      }
    ]
  }), { adjusters: ADJUSTERS });

  assert.deepEqual(
    result.data.events.map((event) => event.classification),
    ["unsupported", "noise", "noise", "unsupported", "unsupported", "noise", "unsupported"]
  );
});

test("mutable task timestamps never count as activity while open tasks remain separate", () => {
  const result = mapManagementJobNimbusEnvelope(envelope({
    tasks: [
      {
        jnid: "task_complete",
        related: { id: "file_a" },
        owners: [{ id: "owner_a" }],
        is_completed: true,
        date_updated: "2026-07-28T08:00:00.000Z"
      },
      {
        jnid: "task_open",
        related: { id: "file_a" },
        owners: [{ id: "owner_a" }],
        is_completed: false,
        date_updated: "2026-07-20T08:00:00.000Z",
        date_start: "2026-07-25T08:00:00.000Z",
        priority_name: "High"
      }
    ]
  }), { adjusters: ADJUSTERS });
  assert.equal(result.data.events.length, 0);
  assert.equal(result.data.openTasks.length, 1);
  assert.equal(result.data.openTasks[0].priority, "high");
});

test("management provider refuses incomplete or cross-file ambiguous evidence", () => {
  assert.throws(
    () => mapManagementJobNimbusEnvelope(
      envelope({ activitiesComplete: false }),
      { adjusters: ADJUSTERS }
    ),
    /pagination is incomplete/
  );

  const result = mapManagementJobNimbusEnvelope(envelope({
    activities: [{
      jnid: "event_ambiguous",
      related: [{ id: "file_a" }, { id: "file_b" }],
      record_type_name: "Note",
      status_name: "Recorded",
      date_created: NOW
    }]
  }), { adjusters: ADJUSTERS });
  assert.equal(result.data.events.length, 0);
  assert.equal(result.data.diagnostics.ambiguousLinks, 1);
});

test("management provider never emits raw note or task text", () => {
  const result = mapManagementJobNimbusEnvelope(envelope({
    activities: [{
      jnid: "event_private",
      related: { id: "file_a" },
      record_type_name: "Note",
      status_name: "Recorded",
      date_created: NOW,
      note: "private synthetic note body"
    }],
    tasks: [{
      jnid: "task_private",
      related: { id: "file_a" },
      is_completed: false,
      date_updated: NOW,
      title: "private synthetic task title"
    }]
  }), { adjusters: ADJUSTERS });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private synthetic/);
  assert.doesNotMatch(serialized, /note body|task title/);
  assert(Object.isFrozen(result.data.events));
});

test("management provider fails closed on malformed and duplicate evidence", () => {
  assert.throws(
    () => mapManagementJobNimbusEnvelope(envelope({
      activities: [
        {
          jnid: "duplicate",
          related: { id: "file_a" },
          date_created: NOW
        },
        {
          jnid: "duplicate",
          related: { id: "file_b" },
          date_created: NOW
        }
      ]
    }), { adjusters: ADJUSTERS }),
    /duplicate JobNimbus evidence/
  );
  assert.throws(
    () => mapManagementJobNimbusEnvelope(envelope({
      contactsComplete: false
    }), { adjusters: ADJUSTERS }),
    /contacts pagination is incomplete/
  );
  assert.throws(
    () => mapManagementJobNimbusEnvelope(envelope({
      contacts: [
        contact("file_a", "owner_a", {
          display_name: "Unsafe\nDisplay Name"
        })
      ]
    }), { adjusters: ADJUSTERS }),
    /invalid provider text/
  );
  assert.throws(
    () => mapManagementJobNimbusEnvelope(envelope({
      contacts: [
        contact("file_a", "owner_a", {
          date_created: null
        })
      ]
    }), { adjusters: ADJUSTERS }),
    /invalid JobNimbus file creation time/
  );
  assert.throws(
    () => mapManagementJobNimbusEnvelope(envelope({
      activities: [{
        jnid: "updated_only_activity",
        related: { id: "file_a" },
        record_type_name: "Note",
        status_name: "Recorded",
        date_updated: NOW
      }]
    }), { adjusters: ADJUSTERS }),
    /invalid JobNimbus activity/
  );
});
