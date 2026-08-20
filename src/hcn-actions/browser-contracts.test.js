import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HCN_BROWSER_ACTION_TYPES,
  HcnBrowserActionContractError,
  projectHcnBrowserActionDryRun,
  translateHcnBrowserActionsToPrivateEngineRequest,
  validateHcnBrowserActionDetailInput,
  validateHcnBrowserActionExecuteInput,
  validateHcnBrowserActionInvalidateInput,
  validateHcnBrowserActionListInput,
  validateHcnBrowserActionPrepareInput
} from "./browser-contracts.js";

const FILE_REF = `subject_${"a".repeat(32)}`;
const TASK_REF = `ref_${"b".repeat(32)}`;
const EVENT_REF = `ref_${"e".repeat(32)}`;
const DRAFT_REF = `ref_${"f".repeat(32)}`;
const PLAN_ID = `plan_${"c".repeat(32)}`;
const PROVIDER_JOB_ID = "provider-job-private-17";
const PROVIDER_TASK_ID = "provider-task-private-99";
const PROVIDER_EVENT_ID = "provider-event-private-77";
const PROVIDER_DRAFT_ID = "provider-draft-private-55";
const APPROVAL_DIGEST = "d".repeat(64);
const APPROVAL_CHALLENGE =
  "private_challenge_value_that_must_never_reach_the_browser_123";
const APPROVAL_EXPIRES_AT = "2026-07-28T18:30:00.000Z";

function prepareFixture() {
  return {
    fileRef: FILE_REF,
    operations: [
      {
        type: "jobnimbus.create_note",
        input: {
          note: "Andrea needs to reach out for the declaration page or policy."
        }
      },
      {
        type: "jobnimbus.create_task",
        input: {
          title: "Review carrier settlement",
          description: "Tag Richard and ask how he wants to move forward.",
          dueDate: "2026-07-30"
        }
      },
      {
        type: "jobnimbus.update_task",
        input: {
          taskRef: TASK_REF,
          title: "Confirm field inspection",
          description: "Confirm Robert will be present.",
          dueDate: "2026-07-31",
          completed: false
        }
      },
      {
        type: "jobnimbus.update_status",
        input: {
          status: "inspection scheduled"
        }
      },
      {
        type: "jobnimbus.update_contact",
        input: {
          dateOfLoss: "2026-04-25"
        }
      }
    ]
  };
}

async function privateFixture(prepareInput = prepareFixture()) {
  return translateHcnBrowserActionsToPrivateEngineRequest(prepareInput, {
    async resolveProviderJobId({ fileRef }) {
      assert.equal(fileRef, FILE_REF);
      return PROVIDER_JOB_ID;
    },
    async resolveProviderTaskId({
      fileRef,
      taskRef,
      providerJobId
    }) {
      assert.deepEqual(
        { fileRef, taskRef, providerJobId },
        {
          fileRef: FILE_REF,
          taskRef: TASK_REF,
          providerJobId: PROVIDER_JOB_ID
        }
      );
      return PROVIDER_TASK_ID;
    }
  });
}

function engineFixture() {
  const selectedProviderFile = {
    id: PROVIDER_JOB_ID,
    name: "Private provider customer",
    email: "private@example.invalid",
    address: "Private provider address"
  };
  return {
    mode: "dry_run",
    operationCount: 5,
    operations: [
      {
        type: "jobnimbus.create_note",
        plan: {
          mode: "dry_run",
          file: selectedProviderFile,
          plan: {
            endpoint: "/activities",
            body: {
              note:
                "Andrea needs to reach out for the declaration page or policy.",
              date_created: 1785260000,
              record_type_name: "Note",
              primary: { id: PROVIDER_JOB_ID }
            }
          }
        }
      },
      {
        type: "jobnimbus.create_task",
        plan: {
          mode: "dry_run",
          file: selectedProviderFile,
          plan: {
            endpoint: "/tasks",
            body: {
              title: "Review carrier settlement",
              subject: "Review carrier settlement",
              description:
                "Tag Richard and ask how he wants to move forward.",
              note: "Tag Richard and ask how he wants to move forward.",
              date_start: unixNoon("2026-07-30"),
              date_end: unixNoon("2026-07-30"),
              is_completed: false,
              record_type_name: "Task",
              owners: [{ id: "private-owner-id" }],
              primary: { id: PROVIDER_JOB_ID },
              related: [{ id: PROVIDER_JOB_ID }]
            },
            schedule: {
              timeZone: "America/Chicago",
              start: "Jul 30, 2026, 7:00 AM CDT",
              end: "Jul 30, 2026, 7:00 AM CDT"
            }
          }
        }
      },
      {
        type: "jobnimbus.update_task",
        plan: {
          mode: "dry_run",
          plan: {
            endpoint: `/tasks/${PROVIDER_TASK_ID}`,
            body: {
              title: "Confirm field inspection",
              description: "Confirm Robert will be present.",
              date_start: unixNoon("2026-07-31"),
              is_completed: false
            },
            schedule: {
              timeZone: "America/Chicago",
              start: "Jul 31, 2026, 7:00 AM CDT"
            }
          }
        }
      },
      {
        type: "jobnimbus.update_status",
        plan: {
          mode: "dry_run",
          file: selectedProviderFile,
          plan: {
            endpoint: `/contacts/${PROVIDER_JOB_ID}`,
            body: {
              status_name: "Inspection Scheduled"
            },
            requestedStatus: "inspection scheduled",
            resolvedStatus: "Inspection Scheduled"
          }
        }
      },
      {
        type: "jobnimbus.update_contact",
        plan: {
          mode: "dry_run",
          file: selectedProviderFile,
          plan: {
            endpoint: `/contacts/${PROVIDER_JOB_ID}`,
            fields: {
              cf_date_1: unixNoon("2026-04-25")
            }
          }
        }
      }
    ],
    approvalDigest: APPROVAL_DIGEST,
    approvalChallenge: APPROVAL_CHALLENGE,
    approvalExpiresAt: APPROVAL_EXPIRES_AT,
    instruction: "Private engine instruction is not a browser presentation."
  };
}

test("prepare validation accepts the exact HCN action contracts", () => {
  assert.deepEqual(HCN_BROWSER_ACTION_TYPES, [
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
  ]);

  const input = prepareFixture();
  const validated = validateHcnBrowserActionPrepareInput(input);
  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.operations), true);
  assert.equal(Object.isFrozen(validated.operations[0].input), true);
  assert.throws(
    () => {
      validated.operations[0].input.note = "changed";
    },
    TypeError
  );
});

test("prepare validation rejects unsupported, arbitrary, and provider-shaped fields", () => {
  for (const mutate of [
    (value) => {
      value.query = PROVIDER_JOB_ID;
    },
    (value) => {
      value.execute = false;
    },
    (value) => {
      value.approvalDigest = APPROVAL_DIGEST;
    },
    (value) => {
      value.approvalChallenge = APPROVAL_CHALLENGE;
    },
    (value) => {
      value.payload = {};
    },
    (value) => {
      value.operations[0].providerJobId = PROVIDER_JOB_ID;
    },
    (value) => {
      value.operations[0].payload = {};
    },
    (value) => {
      value.operations[0].input.query = PROVIDER_JOB_ID;
    },
    (value) => {
      value.operations[2].input.taskId = PROVIDER_TASK_ID;
    },
    (value) => {
      value.operations[4].input.fields = { dateOfLoss: "2026-04-25" };
    },
    (value) => {
      value.operations[0].type = "gmail.send";
    }
  ]) {
    const input = prepareFixture();
    mutate(input);
    assert.throws(
      () => validateHcnBrowserActionPrepareInput(input),
      contractError(400)
    );
  }
});

test("prepare validation enforces operation count and opaque references", () => {
  for (const operations of [[], Array.from({ length: 13 }, () => ({
    type: "jobnimbus.create_note",
    input: { note: "Exact note" }
  }))]) {
    assert.throws(
      () => validateHcnBrowserActionPrepareInput({
        fileRef: FILE_REF,
        operations
      }),
      contractError(400, "invalid_operations")
    );
  }

  for (const fileRef of [
    "",
    PROVIDER_JOB_ID,
    `subject_${"A".repeat(32)}`,
    `subject_${"a".repeat(31)}`
  ]) {
    const input = prepareFixture();
    input.fileRef = fileRef;
    assert.throws(
      () => validateHcnBrowserActionPrepareInput(input),
      contractError(400, "invalid_opaque_reference")
    );
  }

  for (const taskRef of [
    PROVIDER_TASK_ID,
    `task_${"b".repeat(32)}`,
    `ref_${"B".repeat(32)}`
  ]) {
    const input = prepareFixture();
    input.operations[2].input.taskRef = taskRef;
    assert.throws(
      () => validateHcnBrowserActionPrepareInput(input),
      contractError(400, "invalid_opaque_reference")
    );
  }
});

test("text limits use UTF-8 KiB or Unicode character counts as specified", () => {
  const noteAtLimit = {
    fileRef: FILE_REF,
    operations: [{
      type: "jobnimbus.create_note",
      input: { note: "é".repeat(4096) }
    }]
  };
  assert.doesNotThrow(
    () => validateHcnBrowserActionPrepareInput(noteAtLimit)
  );
  noteAtLimit.operations[0].input.note += "é";
  assert.throws(
    () => validateHcnBrowserActionPrepareInput(noteAtLimit),
    contractError(400, "invalid_action_text")
  );

  const task = {
    fileRef: FILE_REF,
    operations: [{
      type: "jobnimbus.create_task",
      input: {
        title: "😀".repeat(256),
        description: "x".repeat(4096)
      }
    }]
  };
  assert.doesNotThrow(() => validateHcnBrowserActionPrepareInput(task));
  task.operations[0].input.title += "😀";
  assert.throws(
    () => validateHcnBrowserActionPrepareInput(task),
    contractError(400, "invalid_action_text")
  );
  task.operations[0].input.title = "Task";
  task.operations[0].input.description += "x";
  assert.throws(
    () => validateHcnBrowserActionPrepareInput(task),
    contractError(400, "invalid_action_text")
  );

  const status = {
    fileRef: FILE_REF,
    operations: [{
      type: "jobnimbus.update_status",
      input: { status: "s".repeat(128) }
    }]
  };
  assert.doesNotThrow(() => validateHcnBrowserActionPrepareInput(status));
  status.operations[0].input.status += "s";
  assert.throws(
    () => validateHcnBrowserActionPrepareInput(status),
    contractError(400, "invalid_action_text")
  );
});

test("task and contact dates are strict real ISO calendar dates", () => {
  for (const date of [
    "2026-2-03",
    "02/03/2026",
    "2026-02-29",
    "2026-04-31",
    "2026-04-25T12:00:00Z",
    " 2026-04-25"
  ]) {
    const input = prepareFixture();
    input.operations[1].input.dueDate = date;
    assert.throws(
      () => validateHcnBrowserActionPrepareInput(input),
      contractError(400, "invalid_iso_date")
    );
    input.operations[1].input.dueDate = "2026-07-30";
    input.operations[4].input.dateOfLoss = date;
    assert.throws(
      () => validateHcnBrowserActionPrepareInput(input),
      contractError(400, "invalid_iso_date")
    );
  }

  const leap = prepareFixture();
  leap.operations[1].input.dueDate = "2028-02-29";
  leap.operations[4].input.dateOfLoss = "2024-02-29";
  assert.doesNotThrow(
    () => validateHcnBrowserActionPrepareInput(leap)
  );
});

test("task updates require one exact supported change", () => {
  const noChange = {
    fileRef: FILE_REF,
    operations: [{
      type: "jobnimbus.update_task",
      input: { taskRef: TASK_REF }
    }]
  };
  assert.throws(
    () => validateHcnBrowserActionPrepareInput(noChange),
    contractError(400, "missing_task_change")
  );

  noChange.operations[0].input.completed = "true";
  assert.throws(
    () => validateHcnBrowserActionPrepareInput(noChange),
    contractError(400, "invalid_task_change")
  );
  noChange.operations[0].input.completed = false;
  assert.doesNotThrow(
    () => validateHcnBrowserActionPrepareInput(noChange)
  );
});

test("fields normalized by the legacy engine reject surrounding whitespace", () => {
  for (const mutate of [
    (value) => {
      value.operations[0].input.note = " Exact note";
    },
    (value) => {
      value.operations[1].input.title = "Exact title ";
    },
    (value) => {
      value.operations[3].input.status = "\tExact status";
    }
  ]) {
    const input = prepareFixture();
    mutate(input);
    assert.throws(
      () => validateHcnBrowserActionPrepareInput(input),
      contractError(400, "invalid_action_text")
    );
  }
});

test("accessors, symbols, non-enumerable fields, and exotic prototypes fail closed", () => {
  const accessor = prepareFixture();
  Object.defineProperty(accessor.operations[0].input, "note", {
    enumerable: true,
    get() {
      throw new Error("must not run");
    }
  });
  assert.throws(
    () => validateHcnBrowserActionPrepareInput(accessor),
    contractError(400, "invalid_request_shape")
  );

  const symbol = prepareFixture();
  symbol[Symbol("private")] = "hidden";
  assert.throws(
    () => validateHcnBrowserActionPrepareInput(symbol),
    contractError(400, "invalid_request_shape")
  );

  const hidden = prepareFixture();
  Object.defineProperty(hidden, "execute", {
    enumerable: false,
    value: true
  });
  assert.throws(
    () => validateHcnBrowserActionPrepareInput(hidden),
    contractError(400, "invalid_request_shape")
  );

  const exotic = prepareFixture();
  Object.setPrototypeOf(exotic.operations[0].input, {
    query: PROVIDER_JOB_ID
  });
  assert.throws(
    () => validateHcnBrowserActionPrepareInput(exotic),
    contractError(400, "invalid_request_shape")
  );
});

test("execute, invalidate, detail, and list contracts are exact and browser-minimal", () => {
  for (const validate of [
    validateHcnBrowserActionExecuteInput,
    validateHcnBrowserActionInvalidateInput,
    validateHcnBrowserActionDetailInput
  ]) {
    const result = validate({ planId: PLAN_ID });
    assert.deepEqual(result, { planId: PLAN_ID });
    assert.equal(Object.isFrozen(result), true);
    for (const extra of [
      { approvalDigest: APPROVAL_DIGEST },
      { approvalChallenge: APPROVAL_CHALLENGE },
      { execute: true },
      { query: PROVIDER_JOB_ID },
      { arbitrary: true }
    ]) {
      assert.throws(
        () => validate({ planId: PLAN_ID, ...extra }),
        contractError(400, "invalid_request_shape")
      );
    }
    assert.throws(
      () => validate({ planId: PROVIDER_TASK_ID }),
      contractError(400, "invalid_opaque_reference")
    );
  }

  assert.deepEqual(validateHcnBrowserActionListInput({}), {});
  assert.throws(
    () => validateHcnBrowserActionListInput({ offset: 0 }),
    contractError(400, "invalid_request_shape")
  );
  assert.throws(
    () => validateHcnBrowserActionListInput(undefined),
    contractError(400, "invalid_request_shape")
  );
});

test("private translation injects resolved provider IDs only after validation", async () => {
  let jobCalls = 0;
  let taskCalls = 0;
  const input = prepareFixture();
  const translated =
    await translateHcnBrowserActionsToPrivateEngineRequest(input, {
      async resolveProviderJobId(argument) {
        jobCalls += 1;
        assert.deepEqual(argument, { fileRef: FILE_REF });
        assert.equal(Object.isFrozen(argument), true);
        return PROVIDER_JOB_ID;
      },
      async resolveProviderTaskId(argument) {
        taskCalls += 1;
        assert.deepEqual(argument, {
          fileRef: FILE_REF,
          taskRef: TASK_REF,
          providerJobId: PROVIDER_JOB_ID
        });
        assert.equal(Object.isFrozen(argument), true);
        return PROVIDER_TASK_ID;
      }
    });

  assert.equal(jobCalls, 1);
  assert.equal(taskCalls, 1);
  assert.equal(Object.isFrozen(translated), true);
  assert.equal(Object.isFrozen(translated.operations), true);
  assert.deepEqual(translated.operations, [
    {
      type: "jobnimbus.create_note",
      payload: {
        query: PROVIDER_JOB_ID,
        note:
          "Andrea needs to reach out for the declaration page or policy."
      }
    },
    {
      type: "jobnimbus.create_task",
      payload: {
        query: PROVIDER_JOB_ID,
        title: "Review carrier settlement",
        description: "Tag Richard and ask how he wants to move forward.",
        dueDate: "2026-07-30"
      }
    },
    {
      type: "jobnimbus.update_task",
      payload: {
        query: PROVIDER_JOB_ID,
        taskId: PROVIDER_TASK_ID,
        fields: {
          title: "Confirm field inspection",
          description: "Confirm Robert will be present.",
          dueDate: "2026-07-31",
          completed: false
        }
      }
    },
    {
      type: "jobnimbus.update_status",
      payload: {
        query: PROVIDER_JOB_ID,
        status: "inspection scheduled"
      }
    },
    {
      type: "jobnimbus.update_contact",
      payload: {
        query: PROVIDER_JOB_ID,
        fields: {
          dateOfLoss: "2026-04-25"
        }
      }
    }
  ]);
  assert.equal(
    JSON.stringify(input).includes(PROVIDER_JOB_ID),
    false
  );
});

test("translation resolver failures are privacy-safe and cannot reflect provider data", async () => {
  const noteOnly = {
    fileRef: FILE_REF,
    operations: [{
      type: "jobnimbus.create_note",
      input: { note: "Exact note" }
    }]
  };

  await assert.rejects(
    translateHcnBrowserActionsToPrivateEngineRequest(noteOnly, {
      async resolveProviderJobId() {
        throw new Error(`secret ${PROVIDER_JOB_ID}`);
      }
    }),
    (error) => (
      error instanceof HcnBrowserActionContractError
      && error.statusCode === 409
      && error.code === "file_resolution_failed"
      && !error.message.includes(PROVIDER_JOB_ID)
    )
  );
  await assert.rejects(
    translateHcnBrowserActionsToPrivateEngineRequest(noteOnly, {
      async resolveProviderJobId() {
        return ` ${PROVIDER_JOB_ID}`;
      }
    }),
    contractError(409, "file_resolution_failed")
  );
  await assert.rejects(
    translateHcnBrowserActionsToPrivateEngineRequest(prepareFixture(), {
      async resolveProviderJobId() {
        return PROVIDER_JOB_ID;
      },
      async resolveProviderTaskId() {
        return "";
      }
    }),
    contractError(409, "task_resolution_failed")
  );
  await assert.rejects(
    translateHcnBrowserActionsToPrivateEngineRequest(
      {
        ...noteOnly,
        query: PROVIDER_JOB_ID
      },
      {
        async resolveProviderJobId() {
          assert.fail("resolver must not run for an invalid browser request");
        }
      }
    ),
    contractError(400, "invalid_request_shape")
  );
});

test("public dry-run projection exposes exact material and no provider internals", async () => {
  const prepareInput = prepareFixture();
  const privateEngineRequest = await privateFixture(prepareInput);
  const presentation = projectHcnBrowserActionDryRun({
    prepareInput,
    privateEngineRequest,
    engineDryRun: engineFixture(),
    fileDisplayLabel: "Selected homeowner file"
  });

  assert.deepEqual(presentation, {
    schema: "hcn-browser-action-plan/v1",
    file: {
      reference: FILE_REF,
      displayLabel: "Selected homeowner file"
    },
    operationCount: 5,
    approvalExpiresAt: APPROVAL_EXPIRES_AT,
    operations: [
      {
        index: 0,
        type: "jobnimbus.create_note",
        action: "Create JobNimbus note",
        material: {
          note:
            "Andrea needs to reach out for the declaration page or policy."
        }
      },
      {
        index: 1,
        type: "jobnimbus.create_task",
        action: "Create JobNimbus task",
        material: {
          title: "Review carrier settlement",
          description: "Tag Richard and ask how he wants to move forward.",
          dueDate: "2026-07-30"
        }
      },
      {
        index: 2,
        type: "jobnimbus.update_task",
        action: "Update JobNimbus task",
        material: {
          taskRef: TASK_REF,
          title: "Confirm field inspection",
          description: "Confirm Robert will be present.",
          dueDate: "2026-07-31",
          completed: false
        }
      },
      {
        index: 3,
        type: "jobnimbus.update_status",
        action: "Change JobNimbus status",
        material: {
          requestedStatus: "inspection scheduled",
          resolvedStatus: "Inspection Scheduled"
        }
      },
      {
        index: 4,
        type: "jobnimbus.update_contact",
        action: "Update JobNimbus date of loss",
        material: {
          dateOfLoss: "2026-04-25"
        }
      }
    ]
  });
  assert.equal(Object.isFrozen(presentation), true);
  assert.equal(Object.isFrozen(presentation.operations[0].material), true);

  const serialized = JSON.stringify(presentation);
  for (const forbidden of [
    PROVIDER_JOB_ID,
    PROVIDER_TASK_ID,
    "private-owner-id",
    "private@example.invalid",
    "Private provider address",
    "/contacts/",
    "/tasks/",
    "/activities",
    APPROVAL_DIGEST,
    APPROVAL_CHALLENGE,
    "Private engine instruction"
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `public projection leaked ${forbidden}`
    );
  }
  for (const forbiddenKey of [
    "query",
    "payload",
    "endpoint",
    "approvalDigest",
    "approvalChallenge",
    "providerJobId",
    "providerTaskId"
  ]) {
    assert.equal(hasKey(presentation, forbiddenKey), false);
  }
});

test("projection fails closed on unknown dry-run wrapper, plan, and body shapes", async () => {
  const prepareInput = prepareFixture();
  const privateEngineRequest = await privateFixture(prepareInput);
  for (const mutate of [
    (value) => {
      value.secret = "unknown";
    },
    (value) => {
      value.operations[0].secret = "unknown";
    },
    (value) => {
      value.operations[0].plan.secret = "unknown";
    },
    (value) => {
      value.operations[0].plan.plan.secret = "unknown";
    },
    (value) => {
      value.operations[0].plan.plan.body.secret = "unknown";
    },
    (value) => {
      value.operations[1].plan.plan.body.provider_job_id =
        PROVIDER_JOB_ID;
    },
    (value) => {
      value.operations[2].plan.plan.body.note = "unknown";
    },
    (value) => {
      value.operations[3].plan.plan.body.status_id = "private-status";
    },
    (value) => {
      value.operations[4].plan.plan.fields.dateOfLoss = "2026-04-25";
    }
  ]) {
    const engineDryRun = engineFixture();
    mutate(engineDryRun);
    assert.throws(
      () => projectHcnBrowserActionDryRun({
        prepareInput,
        privateEngineRequest,
        engineDryRun,
        fileDisplayLabel: "Selected file"
      }),
      contractError(502, "action_engine_contract_drift")
    );
  }
});

test("projection rejects changed material, scope, dates, order, and canonical status", async () => {
  const prepareInput = prepareFixture();
  const privateEngineRequest = await privateFixture(prepareInput);
  for (const mutate of [
    (value) => {
      value.operations[0].plan.plan.body.note = "Changed note";
    },
    (value) => {
      value.operations[0].plan.plan.body.primary.id = "another-job";
    },
    (value) => {
      value.operations[1].plan.plan.body.description = "Changed description";
    },
    (value) => {
      value.operations[1].plan.plan.body.date_start += 86400;
    },
    (value) => {
      value.operations[2].plan.plan.endpoint = "/tasks/another-task";
    },
    (value) => {
      value.operations[2].plan.plan.body.is_completed = true;
    },
    (value) => {
      value.operations[3].plan.plan.body.status_name = "Other";
    },
    (value) => {
      value.operations[4].plan.plan.fields.cf_date_1 += 86400;
    },
    (value) => {
      value.operations.reverse();
    },
    (value) => {
      value.operationCount = 4;
    },
    (value) => {
      value.mode = "executed";
    }
  ]) {
    const engineDryRun = engineFixture();
    mutate(engineDryRun);
    assert.throws(
      () => projectHcnBrowserActionDryRun({
        prepareInput,
        privateEngineRequest,
        engineDryRun,
        fileDisplayLabel: "Selected file"
      }),
      contractError(502, "action_engine_contract_drift")
    );
  }
});

test("projection rejects malformed approval metadata without exposing it", async () => {
  const prepareInput = prepareFixture();
  const privateEngineRequest = await privateFixture(prepareInput);
  for (const [key, value] of [
    ["approvalDigest", "not-a-digest"],
    ["approvalChallenge", "short"],
    ["approvalExpiresAt", "2026-07-28T18:30:00Z"],
    ["approvalExpiresAt", "not-a-date"]
  ]) {
    const engineDryRun = engineFixture();
    engineDryRun[key] = value;
    assert.throws(
      () => projectHcnBrowserActionDryRun({
        prepareInput,
        privateEngineRequest,
        engineDryRun,
        fileDisplayLabel: "Selected file"
      }),
      (error) => (
        error instanceof HcnBrowserActionContractError
        && error.statusCode === 502
        && !error.message.includes(value)
      )
    );
  }
});

test("projection rejects tampered or mixed-file private engine requests", async () => {
  const prepareInput = prepareFixture();
  const baseline = await privateFixture(prepareInput);
  for (const mutate of [
    (value) => {
      value.execute = false;
    },
    (value) => {
      value.operations[0].payload.approvalDigest = APPROVAL_DIGEST;
    },
    (value) => {
      value.operations[0].payload.query = "another-provider-job";
    },
    (value) => {
      value.operations[1].payload.description = "Changed description";
    },
    (value) => {
      value.operations[2].payload.taskId = "another-provider-task";
    },
    (value) => {
      value.operations[2].payload.fields.arbitrary = true;
    },
    (value) => {
      value.operations[4].payload.fields = {
        cf_date_1: unixNoon("2026-04-25")
      };
    }
  ]) {
    const privateEngineRequest = structuredClone(baseline);
    mutate(privateEngineRequest);
    assert.throws(
      () => projectHcnBrowserActionDryRun({
        prepareInput,
        privateEngineRequest,
        engineDryRun: engineFixture(),
        fileDisplayLabel: "Selected file"
      }),
      contractError(502, "action_engine_contract_drift")
    );
  }
});

test("minimal optional task inputs project without invented material", async () => {
  const prepareInput = {
    fileRef: FILE_REF,
    operations: [
      {
        type: "jobnimbus.create_task",
        input: { title: "Review file" }
      },
      {
        type: "jobnimbus.update_task",
        input: { taskRef: TASK_REF, completed: true }
      }
    ]
  };
  const privateEngineRequest =
    await translateHcnBrowserActionsToPrivateEngineRequest(prepareInput, {
      async resolveProviderJobId() {
        return PROVIDER_JOB_ID;
      },
      async resolveProviderTaskId() {
        return PROVIDER_TASK_ID;
      }
    });
  const engineDryRun = {
    mode: "dry_run",
    operationCount: 2,
    operations: [
      {
        type: "jobnimbus.create_task",
        plan: {
          mode: "dry_run",
          file: { ignored: "provider PII" },
          plan: {
            endpoint: "/tasks",
            body: {
              title: "Review file",
              subject: "Review file",
              is_completed: false,
              record_type_name: "Task",
              owners: [{ id: "private-owner-id" }],
              primary: { id: PROVIDER_JOB_ID },
              related: [{ id: PROVIDER_JOB_ID }]
            },
            schedule: undefined
          }
        }
      },
      {
        type: "jobnimbus.update_task",
        plan: {
          mode: "dry_run",
          plan: {
            endpoint: `/tasks/${PROVIDER_TASK_ID}`,
            body: { is_completed: true },
            schedule: undefined
          }
        }
      }
    ],
    approvalDigest: APPROVAL_DIGEST,
    approvalChallenge: APPROVAL_CHALLENGE,
    approvalExpiresAt: APPROVAL_EXPIRES_AT
  };
  const presentation = projectHcnBrowserActionDryRun({
    prepareInput,
    privateEngineRequest,
    engineDryRun,
    fileDisplayLabel: "Selected file"
  });
  assert.deepEqual(presentation.operations[0].material, {
    title: "Review file"
  });
  assert.deepEqual(presentation.operations[1].material, {
    taskRef: TASK_REF,
    completed: true
  });
  assert.equal(JSON.stringify(presentation).includes("provider PII"), false);
});

test("expanded work-file actions translate opaque references and project exact review material", async () => {
  const startsAt = "2026-08-05T13:00:00.000Z";
  const endsAt = "2026-08-05T14:00:00.000Z";
  const prepareInput = {
    fileRef: FILE_REF,
    operations: [
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
  };
  const privateEngineRequest =
    await translateHcnBrowserActionsToPrivateEngineRequest(
      prepareInput,
      {
        async resolveProviderJobId() {
          return PROVIDER_JOB_ID;
        },
        async resolveProviderEventId({ eventRef }) {
          assert.equal(eventRef, EVENT_REF);
          return PROVIDER_EVENT_ID;
        },
        async resolveProviderDraftId({ draftRef }) {
          assert.equal(draftRef, DRAFT_REF);
          return PROVIDER_DRAFT_ID;
        }
      }
    );
  assert.deepEqual(privateEngineRequest.operations, [
    {
      type: "jobnimbus.create_calendar_event",
      payload: {
        query: PROVIDER_JOB_ID,
        title: "Carrier inspection",
        description: "Homeowner and adjuster inspection.",
        dateStart: startsAt,
        dateEnd: endsAt
      }
    },
    {
      type: "jobnimbus.update_calendar_event",
      payload: {
        query: PROVIDER_JOB_ID,
        eventId: PROVIDER_EVENT_ID,
        fields: {
          title: "Carrier inspection confirmed",
          dateStart: startsAt,
          dateEnd: endsAt
        }
      }
    },
    {
      type: "gmail.create_draft",
      payload: {
        query: PROVIDER_JOB_ID,
        to: "carrier@example.test",
        cc: "manager@example.test",
        subject: "Claim documents",
        body: "Please review the attached claim documents."
      }
    },
    {
      type: "gmail.send",
      payload: {
        query: PROVIDER_JOB_ID,
        draftId: PROVIDER_DRAFT_ID
      }
    },
    {
      type: "quo.send_text",
      payload: {
        query: PROVIDER_JOB_ID,
        to: "+12145550100",
        content: "Please confirm you will be present for the inspection."
      }
    }
  ]);

  const fileScope = {
    id: PROVIDER_JOB_ID,
    number: "private",
    name: "private"
  };
  const compactFileScope = {
    ...fileScope,
    status: "private",
    address: "private",
    phone: "+12145550100",
    email: "private@example.test",
    carrier: "private",
    claimNumber: "private",
    policyNumber: "private",
    typeOfLoss: "private",
    dateOfLoss: "2026-06-01",
    adjusterName: "private",
    adjusterPhone: "+12145550102",
    adjusterEmail: "private-adjuster@example.test"
  };
  const body =
    "This reviewed draft is the immutable message that will be sent.";
  const bodyBytes = Buffer.byteLength(body, "utf8");
  const engineDryRun = {
    mode: "dry_run",
    operationCount: 5,
    operations: [
      {
        type: "jobnimbus.create_calendar_event",
        plan: {
          mode: "dry_run",
          file: fileScope,
          plan: {
            endpoint: "/activities",
            body: {
              title: "Carrier inspection",
              subject: "Carrier inspection",
              description: "Homeowner and adjuster inspection.",
              note: "Homeowner and adjuster inspection.",
              date_start: Date.parse(startsAt) / 1000,
              date_end: Date.parse(endsAt) / 1000,
              record_type_name: "Event",
              owners: [{ id: "private-owner" }],
              primary: { id: PROVIDER_JOB_ID },
              related: [{ id: PROVIDER_JOB_ID }]
            },
            schedule: {
              timeZone: "America/Chicago",
              start: "Aug 5, 2026, 8:00 AM CDT",
              end: "Aug 5, 2026, 9:00 AM CDT"
            }
          }
        }
      },
      {
        type: "jobnimbus.update_calendar_event",
        plan: {
          mode: "dry_run",
          file: fileScope,
          plan: {
            endpoint: `/activities/${PROVIDER_EVENT_ID}`,
            body: {
              title: "Carrier inspection confirmed",
              date_start: Date.parse(startsAt) / 1000,
              date_end: Date.parse(endsAt) / 1000
            },
            schedule: {
              timeZone: "America/Chicago",
              start: "Aug 5, 2026, 8:00 AM CDT",
              end: "Aug 5, 2026, 9:00 AM CDT"
            }
          }
        }
      },
      {
        type: "gmail.create_draft",
        plan: {
          mode: "dry_run",
          plan: {
            endpoint: "/gmail/v1/users/me/drafts",
            fileScope,
            to: "carrier@example.test",
            cc: "manager@example.test",
            bcc: "",
            subject: "Claim documents",
            body: "Please review the attached claim documents.",
            bodyTemplate: "custom",
            threadId: "",
            attemptId: "initial",
            attachments: []
          },
          approvalDigest: "1".repeat(64)
        }
      },
      {
        type: "gmail.send",
        plan: {
          mode: "dry_run",
          plan: {
            endpoint: "/gmail/v1/users/me/messages/send",
            action: "send_existing_draft",
            deliveryMode:
              "immutable_reviewed_snapshot_source_draft_retained",
            fileScope,
            draftId: PROVIDER_DRAFT_ID,
            messageId: "private-message-id",
            threadId: "private-thread-id",
            to: "carrier@example.test",
            cc: "",
            bcc: "",
            subject: "Reviewed claim update",
            deliveryHeaders: {
              from: "Chance <chance@example.test>",
              to: "carrier@example.test",
              subject: "Reviewed claim update"
            },
            body,
            bodyRepresentations: [{
              partId: "0",
              mimeType: "text/plain",
              bytes: bodyBytes,
              sha256: "2".repeat(64),
              content: body
            }],
            attachments: [{
              partId: "1",
              filename: "claim.pdf",
              mimeType: "application/pdf",
              disposition: "attachment",
              bytes: 1200,
              sha256: "3".repeat(64)
            }],
            contentDigest: "4".repeat(64),
            transmittedHeaders: [
              "From",
              "Sender",
              "Reply-To",
              "To",
              "Cc",
              "Bcc",
              "Subject",
              "MIME-Version",
              "Content-Type"
            ],
            omittedOriginalHeaders:
              "Any original draft header not listed in transmittedHeaders is excluded from the immutable send.",
            sourceDraftRetention: "retained_for_separate_cleanup"
          },
          approvalDigest: "5".repeat(64),
          instruction: "Nothing was sent."
        }
      },
      {
        type: "quo.send_text",
        plan: {
          mode: "dry_run",
          file: compactFileScope,
          plan: {
            from: "+12145550101",
            to: "+12145550100",
            content:
              "Please confirm you will be present for the inspection.",
            characterCount: 54,
            attemptId: "initial"
          },
          approvalDigest: "6".repeat(64),
          instruction: "Nothing was sent."
        }
      }
    ],
    approvalDigest: APPROVAL_DIGEST,
    approvalChallenge: APPROVAL_CHALLENGE,
    approvalExpiresAt: APPROVAL_EXPIRES_AT
  };
  const presentation = projectHcnBrowserActionDryRun({
    prepareInput,
    privateEngineRequest,
    engineDryRun,
    fileDisplayLabel: "Selected file"
  });
  assert.equal(presentation.operationCount, 5);
  assert.deepEqual(presentation.operations[2].material, {
    to: "carrier@example.test",
    cc: "manager@example.test",
    subject: "Claim documents",
    body: "Please review the attached claim documents.",
    attachments: []
  });
  assert.deepEqual(presentation.operations[3].material, {
    draftRef: DRAFT_REF,
    to: "carrier@example.test",
    subject: "Reviewed claim update",
    body,
    attachments: [{
      partId: "1",
      filename: "claim.pdf",
      mimeType: "application/pdf",
      disposition: "attachment",
      bytes: 1200,
      sha256: "3".repeat(64)
    }],
    contentDigest: "4".repeat(64),
    sourceDraftRetention: "retained_for_separate_cleanup"
  });
  const serialized = JSON.stringify(presentation);
  for (const privateValue of [
    PROVIDER_JOB_ID,
    PROVIDER_EVENT_ID,
    PROVIDER_DRAFT_ID,
    "private-message-id",
    "private-thread-id",
    "private-owner"
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }

  for (const operationIndex of [2, 3, 4]) {
    const changed = structuredClone(engineDryRun);
    const scopedFile = operationIndex === 4
      ? changed.operations[operationIndex].plan.file
      : changed.operations[operationIndex].plan.plan.fileScope;
    scopedFile.unreviewed = "private";
    assert.throws(
      () => projectHcnBrowserActionDryRun({
        prepareInput,
        privateEngineRequest,
        engineDryRun: changed,
        fileDisplayLabel: "Selected file"
      }),
      contractError(502, "action_engine_contract_drift")
    );
  }
});

test("expanded contracts reject unsafe dates, draft ids, recipients, and oversized material", async () => {
  const cases = [
    {
      type: "jobnimbus.create_calendar_event",
      input: {
        title: "Bad range",
        startsAt: "2026-08-05T14:00:00.000Z",
        endsAt: "2026-08-05T13:00:00.000Z"
      }
    },
    {
      type: "jobnimbus.update_calendar_event",
      input: { eventRef: EVENT_REF }
    },
    {
      type: "jobnimbus.update_calendar_event",
      input: {
        eventRef: EVENT_REF,
        startsAt: "2026-08-05T14:00:00.000Z"
      }
    },
    {
      type: "gmail.send",
      input: { draftRef: PROVIDER_DRAFT_ID }
    },
    {
      type: "gmail.create_draft",
      input: {
        to: "carrier@example.test\r\nBcc: attacker@example.test",
        subject: "Claim",
        body: "Exact body"
      }
    },
    {
      type: "gmail.create_draft",
      input: {
        to: "carrier@example.test",
        subject: "Claim\u0001hidden",
        body: "Exact body"
      }
    },
    {
      type: "quo.send_text",
      input: { to: "214-555-0100", content: "Exact text" }
    },
    {
      type: "quo.send_text",
      input: {
        to: "+12145550100",
        content: "x".repeat(1601)
      }
    },
    {
      type: "quo.send_text",
      input: {
        to: "+12145550100",
        content: "\u{1f642}".repeat(1000)
      }
    }
  ];
  for (const operation of cases) {
    assert.throws(
      () => validateHcnBrowserActionPrepareInput({
        fileRef: FILE_REF,
        operations: [operation]
      }),
      contractError(400)
    );
  }

  await assert.rejects(
    translateHcnBrowserActionsToPrivateEngineRequest({
      fileRef: FILE_REF,
      operations: [{
        type: "gmail.send",
        input: { draftRef: DRAFT_REF }
      }]
    }, {
      async resolveProviderJobId() {
        return PROVIDER_JOB_ID;
      },
      async resolveProviderDraftId() {
        throw new Error(`private ${PROVIDER_DRAFT_ID}`);
      }
    }),
    (error) => (
      error instanceof HcnBrowserActionContractError
      && error.statusCode === 409
      && error.code === "draft_resolution_failed"
      && !error.message.includes(PROVIDER_DRAFT_ID)
    )
  );
});

test("module remains pure and has no provider, persistence, browser-state, or model imports", async () => {
  const source = await readFile(
    new URL("./browser-contracts.js", import.meta.url),
    "utf8"
  );
  const imports = source
    .split(/\r?\n/)
    .filter((line) => /^\s*import\b/.test(line))
    .join("\n");

  assert.equal(imports, "");
  assert.doesNotMatch(
    source,
    /(?:node:fs|fetch\s*\(|axios|playwright|puppeteer|localStorage|sessionStorage|indexedDB|document\.cookie)/i
  );
  assert.doesNotMatch(source, /\b(?:chance brain|jobrolo)\b/i);
});

function unixNoon(value) {
  return Math.floor(Date.parse(`${value}T12:00:00.000Z`) / 1000);
}

function contractError(statusCode, code) {
  return (error) => (
    error instanceof HcnBrowserActionContractError
    && error.statusCode === statusCode
    && (code === undefined || error.code === code)
  );
}

function hasKey(value, key) {
  if (Array.isArray(value)) {
    return value.some((item) => hasKey(item, key));
  }
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((item) => hasKey(item, key));
}
