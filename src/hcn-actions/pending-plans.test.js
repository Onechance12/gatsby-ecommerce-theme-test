import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HcnPendingActionPlanError,
  createHcnPendingActionPlanStore
} from "./pending-plans.js";

const SESSION_A = "a".repeat(64);
const SESSION_B = "b".repeat(64);
const SCOPE_A = "8".repeat(64);
const SCOPE_B = "9".repeat(64);
const FILE_A = `subject_${"1".repeat(32)}`;
const FILE_B = `subject_${"2".repeat(32)}`;
const FILE_C = `subject_${"3".repeat(32)}`;
const DIGEST_A = "d".repeat(64);
const DIGEST_B = "e".repeat(64);
const CHALLENGE_A = "A".repeat(43);
const CHALLENGE_B = "B".repeat(43);
const START = Date.parse("2026-07-28T12:00:00.000Z");

function fixture(options = {}) {
  let timestamp = options.timestamp ?? START;
  let sequence = 0;
  const store = createHcnPendingActionPlanStore({
    now: () => timestamp,
    randomId: () => {
      sequence += 1;
      return `plan_${sequence.toString(16).padStart(32, "0")}`;
    },
    ...options.store
  });
  return {
    store,
    now: () => timestamp,
    advance(milliseconds) {
      timestamp += milliseconds;
    }
  };
}

function pendingInput({
  sessionBinding = SESSION_A,
  fileRef = FILE_A,
  fileScopeBinding = SCOPE_A,
  approvalDigest = DIGEST_A,
  approvalChallenge = CHALLENGE_A,
  expiresAt = START + 60_000,
  operations,
  presentationOperations
} = {}) {
  const exactOperations = operations ?? [
    {
      type: "jobnimbus.note",
      input: {
        note: "Exact approved note",
        subjectRef: fileRef
      }
    }
  ];
  const exactPresentation = presentationOperations ?? [
    {
      type: "jobnimbus.note",
      plan: {
        action: "Create one note",
        note: "Exact approved note",
        subjectRef: fileRef
      }
    }
  ];
  return {
    sessionBinding,
    fileRef,
    fileScopeBinding,
    operations: exactOperations,
    dryRun: {
      mode: "dry_run",
      operationCount: exactOperations.length,
      operations: exactPresentation,
      approvalDigest,
      approvalChallenge,
      approvalExpiresAt: new Date(expiresAt).toISOString(),
      instruction: "This arbitrary dry-run field must not enter the projection."
    },
    arbitraryInternal: "must not enter the projection"
  };
}

function expectPlanError(code, statusCode) {
  return (error) => (
    error instanceof HcnPendingActionPlanError
    && error.code === code
    && error.statusCode === statusCode
  );
}

test("public projections are exact, immutable, and never leak bindings or challenges", () => {
  const { store } = fixture();
  const input = pendingInput();
  const created = store.create(input);

  assert.deepEqual(Object.keys(created), [
    "planId",
    "fileRef",
    "approvalDigest",
    "approvalExpiresAt",
    "status",
    "operationCount",
    "operations",
    "createdAt",
    "updatedAt"
  ]);
  assert.equal(created.status, "pending");
  assert.equal(created.fileRef, FILE_A);
  assert.equal(created.approvalDigest, DIGEST_A);
  assert.equal(created.operationCount, 1);
  assert.deepEqual(created.operations, input.dryRun.operations);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.operations), true);
  assert.equal(Object.isFrozen(created.operations[0].plan), true);

  const serialized = JSON.stringify({
    created,
    listed: store.list({ sessionBinding: SESSION_A }),
    fetched: store.get({
      sessionBinding: SESSION_A,
      planId: created.planId
    })
  });
  assert.equal(serialized.includes(CHALLENGE_A), false);
  assert.equal(serialized.includes(SESSION_A), false);
  assert.equal(serialized.includes(SCOPE_A), false);
  assert.equal(serialized.includes("arbitraryInternal"), false);
  assert.equal(serialized.includes("instruction"), false);
  assert.equal(serialized.includes("approvalChallenge"), false);
  assert.equal(serialized.includes("sessionBinding"), false);
  assert.equal(serialized.includes("fileScopeBinding"), false);
});

test("summary listing omits operation bodies while exact detail retains them", () => {
  const { store } = fixture();
  const plan = store.create(pendingInput());

  const summary = store.list({
    sessionBinding: SESSION_A,
    summary: true
  });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].planId, plan.planId);
  assert.equal(summary[0].operationCount, 1);
  assert.equal(Object.hasOwn(summary[0], "operations"), false);
  assert.equal(JSON.stringify(summary).includes("Exact approved note"), false);

  const detail = store.get({
    sessionBinding: SESSION_A,
    planId: plan.planId
  });
  assert.equal(detail.operations[0].plan.note, "Exact approved note");
  assert.equal(
    store.list({ sessionBinding: SESSION_A })[0]
      .operations[0].plan.note,
    "Exact approved note"
  );
  assert.throws(
    () => store.list({ sessionBinding: SESSION_A, summary: "yes" }),
    expectPlanError("invalid_request", 400)
  );
});

test("an optional bounded display label remains process-local and public", () => {
  const { store } = fixture();
  const plan = store.create({
    ...pendingInput(),
    fileDisplayLabel: "HCN-1001 Fixture Homeowner"
  });

  assert.deepEqual(plan.file, {
    reference: FILE_A,
    displayLabel: "HCN-1001 Fixture Homeowner"
  });
  assert.deepEqual(
    store.list({ sessionBinding: SESSION_A, summary: true })[0].file,
    plan.file
  );
  assert.throws(
    () => store.create({
      ...pendingInput({
        approvalDigest: DIGEST_B,
        approvalChallenge: CHALLENGE_B
      }),
      fileDisplayLabel: "bad\nlabel"
    }),
    expectPlanError("invalid_file_display_label", 400)
  );
});

test("list and get isolate sessions and fail closed as not found", () => {
  const { store } = fixture();
  const plan = store.create(pendingInput());

  assert.deepEqual(store.list({ sessionBinding: SESSION_B }), []);
  assert.throws(
    () => store.get({
      sessionBinding: SESSION_B,
      planId: plan.planId
    }),
    expectPlanError("plan_not_found", 404)
  );
  assert.throws(
    () => store.beginExecution({
      sessionBinding: SESSION_B,
      planId: plan.planId,
      fileScopeBinding: SCOPE_A,
      approvalDigest: DIGEST_A
    }),
    expectPlanError("plan_not_found", 404)
  );
  assert.equal(
    store.get({
      sessionBinding: SESSION_A,
      planId: plan.planId
    }).status,
    "pending"
  );
});

test("expiry is enforced and cannot make a stale plan reusable", () => {
  const clock = fixture();
  const plan = clock.store.create(pendingInput({ expiresAt: START + 1_000 }));
  clock.advance(1_000);

  assert.equal(
    clock.store.get({
      sessionBinding: SESSION_A,
      planId: plan.planId
    }).status,
    "expired"
  );
  assert.throws(
    () => clock.store.beginExecution({
      sessionBinding: SESSION_A,
      planId: plan.planId,
      fileScopeBinding: SCOPE_A,
      approvalDigest: DIGEST_A
    }),
    expectPlanError("approval_expired", 409)
  );
  assert.throws(
    () => clock.store.expire({
      sessionBinding: SESSION_A,
      planId: plan.planId
    }),
    expectPlanError("plan_not_pending", 409)
  );
});

test("creation supersedes every older pending plan for the same session", () => {
  const { store } = fixture();
  const first = store.create(pendingInput());
  const second = store.create(pendingInput({
    fileRef: FILE_B,
    fileScopeBinding: SCOPE_B,
    approvalDigest: DIGEST_B,
    approvalChallenge: CHALLENGE_B
  }));

  assert.notEqual(first.planId, second.planId);
  assert.equal(
    store.get({
      sessionBinding: SESSION_A,
      planId: first.planId
    }).status,
    "superseded"
  );
  assert.equal(second.status, "pending");
  assert.throws(
    () => store.beginExecution({
      sessionBinding: SESSION_A,
      planId: first.planId,
      fileScopeBinding: SCOPE_A,
      approvalDigest: DIGEST_A
    }),
    expectPlanError("plan_superseded", 409)
  );
});

test("new plans supersede only their own session pending plan", () => {
  const { store } = fixture();
  const sessionAFirst = store.create(pendingInput());
  const sessionBPlan = store.create(pendingInput({
    sessionBinding: SESSION_B,
    approvalDigest: DIGEST_B,
    approvalChallenge: CHALLENGE_B
  }));
  const sessionASecond = store.create(pendingInput({
    fileRef: FILE_B,
    fileScopeBinding: SCOPE_B,
    approvalDigest: "f".repeat(64),
    approvalChallenge: "C".repeat(43)
  }));

  assert.equal(
    store.get({
      sessionBinding: SESSION_A,
      planId: sessionAFirst.planId
    }).status,
    "superseded"
  );
  assert.equal(sessionASecond.status, "pending");
  assert.equal(
    store.get({
      sessionBinding: SESSION_B,
      planId: sessionBPlan.planId
    }).status,
    "pending"
  );
  assert.equal(
    store.list({ sessionBinding: SESSION_A })
      .filter((plan) => plan.status === "pending").length,
    1
  );
});

test("file-scope comparison is required, atomic, and permanently fail closed", () => {
  const { store } = fixture();
  const plan = store.create(pendingInput());

  assert.throws(
    () => store.beginExecution({
      sessionBinding: SESSION_A,
      planId: plan.planId,
      approvalDigest: DIGEST_A
    }),
    expectPlanError("invalid_file_scope_binding", 400)
  );
  assert.equal(
    store.get({
      sessionBinding: SESSION_A,
      planId: plan.planId
    }).status,
    "pending"
  );

  let mismatch;
  try {
    store.beginExecution({
      sessionBinding: SESSION_A,
      planId: plan.planId,
      fileScopeBinding: SCOPE_B,
      approvalDigest: DIGEST_A
    });
  } catch (error) {
    mismatch = error;
  }
  assert.equal(mismatch?.code, "file_scope_changed");
  assert.equal(mismatch?.statusCode, 409);
  assert.equal(mismatch?.message.includes(SCOPE_A), false);
  assert.equal(mismatch?.message.includes(SCOPE_B), false);
  assert.equal(
    store.get({
      sessionBinding: SESSION_A,
      planId: plan.planId
    }).status,
    "invalidated"
  );
  assert.throws(
    () => store.beginExecution({
      sessionBinding: SESSION_A,
      planId: plan.planId,
      fileScopeBinding: SCOPE_A,
      approvalDigest: DIGEST_A
    }),
    expectPlanError("plan_invalidated", 409)
  );
});

test("private bindings or challenges cannot enter public operation projections", () => {
  assert.throws(
    () => fixture().store.create(pendingInput({
      fileScopeBinding: "8".repeat(63)
    })),
    expectPlanError("invalid_file_scope_binding", 400)
  );
  for (const privateValue of [SESSION_A, SCOPE_A, CHALLENGE_A]) {
    assert.throws(
      () => fixture().store.create(pendingInput({
        presentationOperations: [{
          type: "jobnimbus.note",
          plan: {
            note: `embedded-${privateValue}-value`,
            subjectRef: FILE_A
          }
        }]
      })),
      expectPlanError("sensitive_private_value", 400)
    );
  }
  assert.throws(
    () => fixture().store.create(pendingInput({
      operations: [{
        type: "jobnimbus.note",
        input: {
          note: `must-not-carry-${SCOPE_A}`,
          subjectRef: FILE_A
        }
      }]
    })),
    expectPlanError("sensitive_private_value", 400)
  );
  assert.throws(
    () => fixture().store.create(pendingInput({
      presentationOperations: [{
        type: "jobnimbus.note",
        plan: {
          fileScopeBinding: "not-even-the-real-binding",
          subjectRef: FILE_A
        }
      }]
    })),
    expectPlanError("sensitive_presentation_field", 400)
  );
});

test("a changed digest invalidates the plan permanently", () => {
  const { store } = fixture();
  const plan = store.create(pendingInput());

  assert.throws(
    () => store.beginExecution({
      sessionBinding: SESSION_A,
      planId: plan.planId,
      fileScopeBinding: SCOPE_A,
      approvalDigest: DIGEST_B
    }),
    expectPlanError("approval_digest_mismatch", 409)
  );
  assert.equal(
    store.get({
      sessionBinding: SESSION_A,
      planId: plan.planId
    }).status,
    "invalidated"
  );
  assert.throws(
    () => store.beginExecution({
      sessionBinding: SESSION_A,
      planId: plan.planId,
      fileScopeBinding: SCOPE_A,
      approvalDigest: DIGEST_A
    }),
    expectPlanError("plan_invalidated", 409)
  );
});

test("beginExecution is atomic and single-use under concurrent callers", async () => {
  const { store } = fixture();
  const plan = store.create(pendingInput());
  const request = {
    sessionBinding: SESSION_A,
    planId: plan.planId,
    fileScopeBinding: SCOPE_A,
    approvalDigest: DIGEST_A
  };

  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => store.beginExecution(request)),
    Promise.resolve().then(() => store.beginExecution(request))
  ]);
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "rejected").length,
    1
  );
  const execution = attempts.find(
    (attempt) => attempt.status === "fulfilled"
  ).value;
  assert.equal(execution.approvalChallenge, CHALLENGE_A);
  assert.deepEqual(execution.operations, pendingInput().operations);
  assert.equal(Object.isFrozen(execution.operations), true);
  assert.equal(JSON.stringify(execution).includes(CHALLENGE_A), false);
  assert.equal(JSON.stringify(execution).includes(SESSION_A), false);
  assert.equal(JSON.stringify(execution).includes(SCOPE_A), false);
  assert.equal(Object.hasOwn(execution, "fileScopeBinding"), false);
  assert.equal(
    attempts.find((attempt) => attempt.status === "rejected").reason.code,
    "execution_already_running"
  );
});

test("input, public, and private result mutations cannot alter stored payloads", () => {
  const { store } = fixture();
  const input = pendingInput();
  const plan = store.create(input);
  input.operations[0].input.note = "changed after create";
  input.dryRun.operations[0].plan.note = "changed after create";

  assert.throws(() => {
    plan.operations[0].plan.note = "public mutation";
  }, TypeError);
  const execution = store.beginExecution({
    sessionBinding: SESSION_A,
    planId: plan.planId,
    fileScopeBinding: SCOPE_A,
    approvalDigest: DIGEST_A
  });
  assert.equal(execution.operations[0].input.note, "Exact approved note");
  assert.throws(() => {
    execution.operations[0].input.note = "private mutation";
  }, TypeError);
});

test("serialized size and per-session/global capacities are bounded", () => {
  const small = fixture({
    store: {
      maxPlanBytes: 1_024,
      maxPlansPerSession: 2,
      maxPlans: 3
    }
  });
  assert.throws(
    () => small.store.create(pendingInput({
      operations: [{
        type: "jobnimbus.note",
        input: { note: "x".repeat(1_000), subjectRef: FILE_A }
      }],
      presentationOperations: [{
        type: "jobnimbus.note",
        plan: { note: "x".repeat(1_000), subjectRef: FILE_A }
      }]
    })),
    expectPlanError("plan_too_large", 413)
  );

  const firstRunning = small.store.create(pendingInput({
    fileRef: FILE_A
  }));
  small.store.beginExecution({
    sessionBinding: SESSION_A,
    planId: firstRunning.planId,
    fileScopeBinding: SCOPE_A,
    approvalDigest: DIGEST_A
  });
  const secondRunning = small.store.create(pendingInput({
    fileRef: FILE_B,
    fileScopeBinding: SCOPE_B,
    approvalDigest: DIGEST_B,
    approvalChallenge: CHALLENGE_B
  }));
  small.store.beginExecution({
    sessionBinding: SESSION_A,
    planId: secondRunning.planId,
    fileScopeBinding: SCOPE_B,
    approvalDigest: DIGEST_B
  });
  assert.throws(
    () => small.store.create(pendingInput({
      fileRef: FILE_C,
      approvalDigest: "f".repeat(64),
      approvalChallenge: "C".repeat(43)
    })),
    expectPlanError("session_capacity_exhausted", 429)
  );

  const thirdRunning = small.store.create(pendingInput({
    sessionBinding: SESSION_B,
    fileRef: FILE_C,
    fileScopeBinding: SCOPE_B,
    approvalDigest: "f".repeat(64),
    approvalChallenge: "C".repeat(43)
  }));
  small.store.beginExecution({
    sessionBinding: SESSION_B,
    planId: thirdRunning.planId,
    fileScopeBinding: SCOPE_B,
    approvalDigest: "f".repeat(64)
  });
  assert.throws(
    () => small.store.create(pendingInput({
      sessionBinding: SESSION_B,
      fileRef: `subject_${"4".repeat(32)}`,
      approvalDigest: "1".repeat(64),
      approvalChallenge: "D".repeat(43)
    })),
    expectPlanError("global_capacity_exhausted", 429)
  );
});

test("finishExecution maps terminal results once and retains only safe bounded receipts", () => {
  const { store } = fixture();
  const plan = store.create(pendingInput());
  store.beginExecution({
    sessionBinding: SESSION_A,
    planId: plan.planId,
    fileScopeBinding: SCOPE_A,
    approvalDigest: DIGEST_A
  });
  const finished = store.finishExecution({
    sessionBinding: SESSION_A,
    planId: plan.planId,
    result: {
      mode: "executed",
      arbitraryInternal: "drop this",
      approvalChallenge: CHALLENGE_A,
      batch: {
        id: "batch-safe-id",
        approvalId: "private-approval-id",
        approvalDigest: DIGEST_A,
        status: "completed",
        operationCount: 1,
        completedAt: "2026-07-28T12:00:01.000Z",
        completed: [{
          index: 0,
          type: "jobnimbus.note",
          status: "executed",
          receipt: {
            externalId: "receipt-1",
            approvalChallenge: CHALLENGE_A,
            credential: "private",
            detail: `safe ${CHALLENGE_A} Bearer abcdefghijklmnop`
          }
        }]
      }
    }
  });

  assert.equal(finished.status, "executed");
  assert.equal(finished.result.mode, "executed");
  assert.equal(finished.result.batch.batchId, "batch-safe-id");
  assert.equal(
    finished.result.batch.completed[0].receipt.externalId,
    "receipt-1"
  );
  const serialized = JSON.stringify(finished);
  assert.equal(serialized.includes(CHALLENGE_A), false);
  assert.equal(serialized.includes("private-approval-id"), false);
  assert.equal(serialized.includes("credential"), false);
  assert.equal(serialized.includes("arbitraryInternal"), false);
  assert.equal(serialized.includes("Bearer abcdefghijklmnop"), false);
  assert.throws(
    () => store.finishExecution({
      sessionBinding: SESSION_A,
      planId: plan.planId,
      result: { mode: "executed" }
    }),
    expectPlanError("execution_not_running", 409)
  );
});

test("completed_pending_verification remains a distinct terminal outcome", () => {
  const { store } = fixture();
  const plan = store.create(pendingInput());
  store.beginExecution({
    sessionBinding: SESSION_A,
    planId: plan.planId,
    fileScopeBinding: SCOPE_A,
    approvalDigest: DIGEST_A
  });
  const finished = store.finishExecution({
    sessionBinding: SESSION_A,
    planId: plan.planId,
    result: {
      mode: "executed",
      batch: {
        id: "batch-awaiting-readback",
        status: "completed_pending_verification",
        operationCount: 1
      }
    }
  });

  assert.equal(finished.status, "completed_pending_verification");
  assert.equal(finished.result.mode, "completed_pending_verification");
  assert.equal(
    finished.result.batch.status,
    "completed_pending_verification"
  );
  assert.equal(store.stats().terminal, 1);
  assert.throws(
    () => store.beginExecution({
      sessionBinding: SESSION_A,
      planId: plan.planId,
      fileScopeBinding: SCOPE_A,
      approvalDigest: DIGEST_A
    }),
    expectPlanError("plan_already_terminal", 409)
  );
});

test("explicit recovery atomically terminalizes an uncertain execution", () => {
  const { store } = fixture();
  const plan = store.create(pendingInput());
  store.beginExecution({
    sessionBinding: SESSION_A,
    planId: plan.planId,
    fileScopeBinding: SCOPE_A,
    approvalDigest: DIGEST_A
  });

  assert.throws(
    () => store.recoverExecution({
      sessionBinding: SESSION_B,
      planId: plan.planId,
      reason: "wrong session"
    }),
    expectPlanError("plan_not_found", 404)
  );
  const recovered = store.recoverExecution({
    sessionBinding: SESSION_A,
    planId: plan.planId,
    reason:
      `handler failed ${SESSION_A} ${SCOPE_A} ${CHALLENGE_A} Bearer abcdefghijklmnop`
  });
  assert.equal(recovered.status, "reconciliation_required");
  assert.equal(recovered.result.mode, "reconciliation_required");
  const serialized = JSON.stringify(recovered);
  assert.equal(serialized.includes(SESSION_A), false);
  assert.equal(serialized.includes(SCOPE_A), false);
  assert.equal(serialized.includes(CHALLENGE_A), false);
  assert.equal(serialized.includes("Bearer abcdefghijklmnop"), false);
  assert.throws(
    () => store.finishExecution({
      sessionBinding: SESSION_A,
      planId: plan.planId,
      result: { mode: "executed" }
    }),
    expectPlanError("execution_not_running", 409)
  );
  assert.throws(
    () => store.recoverExecution({
      sessionBinding: SESSION_A,
      planId: plan.planId,
      reason: "second recovery"
    }),
    expectPlanError("execution_not_running", 409)
  );
});

test("logout invalidates pending work and reconciles only that session's execution", () => {
  const { store } = fixture();
  const running = store.create(pendingInput());
  store.beginExecution({
    sessionBinding: SESSION_A,
    planId: running.planId,
    fileScopeBinding: SCOPE_A,
    approvalDigest: DIGEST_A
  });
  const pending = store.create(pendingInput({
    fileRef: FILE_B,
    fileScopeBinding: SCOPE_B,
    approvalDigest: DIGEST_B,
    approvalChallenge: CHALLENGE_B
  }));
  const otherSession = store.create(pendingInput({
    sessionBinding: SESSION_B,
    fileRef: FILE_C,
    fileScopeBinding: SCOPE_B,
    approvalDigest: "f".repeat(64),
    approvalChallenge: "C".repeat(43)
  }));

  assert.deepEqual(
    store.invalidateSession({ sessionBinding: SESSION_A }),
    { invalidated: 1, reconciliationRequired: 1 }
  );
  assert.equal(
    store.get({
      sessionBinding: SESSION_A,
      planId: running.planId
    }).status,
    "reconciliation_required"
  );
  assert.equal(
    store.get({
      sessionBinding: SESSION_A,
      planId: pending.planId
    }).status,
    "invalidated"
  );
  assert.equal(
    store.get({
      sessionBinding: SESSION_B,
      planId: otherSession.planId
    }).status,
    "pending"
  );
  assert.deepEqual(
    store.invalidateSession(SESSION_A),
    { invalidated: 0, reconciliationRequired: 0 }
  );
  assert.equal(
    JSON.stringify(store.list({ sessionBinding: SESSION_A }))
      .includes(SESSION_A),
    false
  );
});

test("all supported terminal modes and uncertain/oversized results reconcile", () => {
  for (const mode of [
    "partial_failure",
    "blocked_duplicate",
    "failed",
    "reconciliation_required"
  ]) {
    const { store } = fixture();
    const plan = store.create(pendingInput());
    store.beginExecution({
      sessionBinding: SESSION_A,
      planId: plan.planId,
      fileScopeBinding: SCOPE_A,
      approvalDigest: DIGEST_A
    });
    assert.equal(
      store.finishExecution({
        sessionBinding: SESSION_A,
        planId: plan.planId,
        result: { mode, reason: "bounded result" }
      }).status,
      mode
    );
  }

  const uncertain = fixture({ store: { maxResultBytes: 256 } });
  const plan = uncertain.store.create(pendingInput());
  uncertain.store.beginExecution({
    sessionBinding: SESSION_A,
    planId: plan.planId,
    fileScopeBinding: SCOPE_A,
    approvalDigest: DIGEST_A
  });
  const finished = uncertain.store.finishExecution({
    sessionBinding: SESSION_A,
    planId: plan.planId,
    result: {
      mode: "unexpected_provider_state",
      reason: "x".repeat(10_000)
    }
  });
  assert.equal(finished.status, "reconciliation_required");
  assert.equal(finished.result.mode, "reconciliation_required");
  assert.ok(JSON.stringify(finished.result).length < 256);
});

test("explicit invalidation and expiration make pending plans non-reusable", () => {
  const { store } = fixture();
  const invalidated = store.create(pendingInput());
  assert.equal(
    store.invalidate({
      sessionBinding: SESSION_A,
      planId: invalidated.planId
    }).status,
    "invalidated"
  );

  const expired = store.create(pendingInput({
    fileRef: FILE_B,
    approvalDigest: DIGEST_B,
    approvalChallenge: CHALLENGE_B
  }));
  assert.equal(
    store.expire({
      sessionBinding: SESSION_A,
      planId: expired.planId
    }).status,
    "expired"
  );
  for (const plan of [invalidated, expired]) {
    assert.throws(
      () => store.beginExecution({
        sessionBinding: SESSION_A,
        planId: plan.planId,
        fileScopeBinding: SCOPE_A,
        approvalDigest: plan.approvalDigest
      }),
      (error) => error.statusCode === 409
    );
  }
});

test("module import boundary remains pure and process-local", async () => {
  const source = await readFile(
    new URL("./pending-plans.js", import.meta.url),
    "utf8"
  );
  const imports = source
    .split(/\r?\n/)
    .filter((line) => /^\s*import\b/.test(line))
    .join("\n");

  assert.match(imports, /from "node:crypto"/);
  assert.doesNotMatch(
    imports,
    /(?:node:fs|memory|brain|jobrolo|provider|playwright|puppeteer)/i
  );
  assert.doesNotMatch(
    source,
    /\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/
  );
});
