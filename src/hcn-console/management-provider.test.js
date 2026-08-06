import assert from "node:assert/strict";
import test from "node:test";

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
    unconfiguredOwner: 1,
    ambiguousOwner: 1,
    outsideWorkflowStatus: 0
  });
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

test("management provider never promotes drafts, task creation, file views, automation, or unknown records", () => {
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
        jnid: "event_task_created",
        related: { id: "file_a" },
        record_type_name: "Task",
        status_name: "Created",
        date_created: NOW
      },
      {
        jnid: "event_note_automated",
        related: { id: "file_b" },
        record_type_name: "Note",
        status_name: "Automated",
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
        jnid: "event_unknown",
        related: { id: "file_c" },
        date_created: NOW
      }
    ]
  }), { adjusters: ADJUSTERS });

  assert.deepEqual(
    result.data.events.map((event) => event.classification),
    ["unsupported", "unsupported", "noise", "unsupported", "unsupported"]
  );
});

test("task timestamps never count as activity while open tasks remain separate", () => {
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
