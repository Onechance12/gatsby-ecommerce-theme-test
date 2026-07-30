import assert from "node:assert/strict";
import test from "node:test";

import {
  HCN_ASSISTANT_ACTION_INPUT_FIELDS,
  HCN_ASSISTANT_ACTION_PLAN_SCHEMA,
  HCN_ASSISTANT_ACTION_SCHEMA,
  translateAssistantActionPlan
} from "./action-plan.js";

const FILE_REF = `subject_${"a".repeat(32)}`;
const TASK_REF = `ref_${"b".repeat(32)}`;
const EVENT_REF = `ref_${"c".repeat(32)}`;
const DRAFT_REF = `ref_${"d".repeat(32)}`;

function actionInput(overrides = {}) {
  return Object.fromEntries(
    HCN_ASSISTANT_ACTION_INPUT_FIELDS.map((field) => [
      field,
      Object.hasOwn(overrides, field) ? overrides[field] : null
    ])
  );
}

test("strict action schema is uniform, nullable, and covers all browser action types", () => {
  assert.equal(HCN_ASSISTANT_ACTION_PLAN_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    HCN_ASSISTANT_ACTION_PLAN_SCHEMA.required,
    ["file_ref", "actions"]
  );
  assert.equal(HCN_ASSISTANT_ACTION_SCHEMA.additionalProperties, false);
  assert.deepEqual(HCN_ASSISTANT_ACTION_SCHEMA.required, ["type", "input"]);
  assert.deepEqual(
    HCN_ASSISTANT_ACTION_SCHEMA.properties.type.enum,
    [
      "jobnimbus.create_note",
      "jobnimbus.create_task",
      "jobnimbus.update_task",
      "jobnimbus.update_status",
      "jobnimbus.update_contact",
      "jobnimbus.create_calendar_event",
      "jobnimbus.update_calendar_event",
      "gmail.create_draft",
      "gmail.send",
      "quo.send_text"
    ]
  );
  assert.deepEqual(
    HCN_ASSISTANT_ACTION_SCHEMA.properties.input.required,
    HCN_ASSISTANT_ACTION_INPUT_FIELDS
  );
  assert.equal(
    HCN_ASSISTANT_ACTION_SCHEMA.properties.input.additionalProperties,
    false
  );
  for (const field of HCN_ASSISTANT_ACTION_INPUT_FIELDS) {
    const type =
      HCN_ASSISTANT_ACTION_SCHEMA.properties.input.properties[field].type;
    assert.equal(Array.isArray(type), true);
    assert.equal(type.includes("null"), true);
  }
});

test("assistant action translation produces the exact validated browser contract for all 10 actions", () => {
  const startsAt = "2026-08-05T13:00:00.000Z";
  const endsAt = "2026-08-05T14:00:00.000Z";
  const input = {
    file_ref: FILE_REF,
    actions: [
      {
        type: "jobnimbus.create_note",
        input: actionInput({ note: "Andrea needs to review this file." })
      },
      {
        type: "jobnimbus.create_task",
        input: actionInput({
          title: "Review settlement",
          description: "Ask Richard how he wants to move forward.",
          due_date: "2026-08-05"
        })
      },
      {
        type: "jobnimbus.update_task",
        input: actionInput({
          task_ref: TASK_REF,
          completed: true
        })
      },
      {
        type: "jobnimbus.update_status",
        input: actionInput({ status: "Inspection Scheduled" })
      },
      {
        type: "jobnimbus.update_contact",
        input: actionInput({ date_of_loss: "2026-04-25" })
      },
      {
        type: "jobnimbus.create_calendar_event",
        input: actionInput({
          title: "Carrier inspection",
          description: "Homeowner and adjuster inspection.",
          starts_at: startsAt,
          ends_at: endsAt
        })
      },
      {
        type: "jobnimbus.update_calendar_event",
        input: actionInput({
          event_ref: EVENT_REF,
          title: "Carrier inspection confirmed",
          starts_at: startsAt,
          ends_at: endsAt
        })
      },
      {
        type: "gmail.create_draft",
        input: actionInput({
          to: "carrier@example.test",
          cc: "manager@example.test",
          subject: "Claim documents",
          body: "Please review the attached claim documents."
        })
      },
      {
        type: "gmail.send",
        input: actionInput({ draft_ref: DRAFT_REF })
      },
      {
        type: "quo.send_text",
        input: actionInput({
          to: "+12145550100",
          content: "Please confirm you will be present for the inspection."
        })
      }
    ]
  };

  const result = translateAssistantActionPlan(input);
  assert.deepEqual(result, {
    fileRef: FILE_REF,
    operations: [
      {
        type: "jobnimbus.create_note",
        input: { note: "Andrea needs to review this file." }
      },
      {
        type: "jobnimbus.create_task",
        input: {
          title: "Review settlement",
          description: "Ask Richard how he wants to move forward.",
          dueDate: "2026-08-05"
        }
      },
      {
        type: "jobnimbus.update_task",
        input: {
          taskRef: TASK_REF,
          completed: true
        }
      },
      {
        type: "jobnimbus.update_status",
        input: { status: "Inspection Scheduled" }
      },
      {
        type: "jobnimbus.update_contact",
        input: { dateOfLoss: "2026-04-25" }
      },
      {
        type: "jobnimbus.create_calendar_event",
        input: {
          title: "Carrier inspection",
          description: "Homeowner and adjuster inspection.",
          startsAt,
          endsAt
        }
      },
      {
        type: "jobnimbus.update_calendar_event",
        input: {
          eventRef: EVENT_REF,
          title: "Carrier inspection confirmed",
          startsAt,
          endsAt
        }
      },
      {
        type: "gmail.create_draft",
        input: {
          to: "carrier@example.test",
          cc: "manager@example.test",
          subject: "Claim documents",
          body: "Please review the attached claim documents."
        }
      },
      {
        type: "gmail.send",
        input: { draftRef: DRAFT_REF }
      },
      {
        type: "quo.send_text",
        input: {
          to: "+12145550100",
          content: "Please confirm you will be present for the inspection."
        }
      }
    ]
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.operations), true);
  assert.equal(Object.isFrozen(result.operations[0].input), true);
});

test("assistant action translation rejects hidden material and incomplete changes", () => {
  assert.throws(
    () =>
      translateAssistantActionPlan({
        file_ref: FILE_REF,
        actions: [
          {
            type: "jobnimbus.create_note",
            input: actionInput({
              note: "Review this.",
              status: "Hidden extra material"
            })
          }
        ]
      }),
    /must be null/
  );

  assert.throws(
    () =>
      translateAssistantActionPlan({
        file_ref: FILE_REF,
        actions: [
          {
            type: "jobnimbus.update_task",
            input: actionInput({ task_ref: TASK_REF })
          }
        ]
      }),
    /at least one task change/
  );
});
