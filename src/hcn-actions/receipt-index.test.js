import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HcnActionReceiptIndexError,
  createHcnActionReceiptIndex
} from "./receipt-index.js";

const PRINCIPAL_A = `principal_${"a".repeat(64)}`;
const PRINCIPAL_B = `principal_${"b".repeat(64)}`;
const FILE_A = `subject_${"1".repeat(32)}`;
const FILE_B = `subject_${"2".repeat(32)}`;
const PLAN_A = `plan_${"3".repeat(32)}`;
const PLAN_B = `plan_${"4".repeat(32)}`;
const PLAN_C = `plan_${"5".repeat(32)}`;
const DIGEST_A = "d".repeat(64);
const DIGEST_B = "e".repeat(64);
const BATCH_A = `batch_${"6".repeat(32)}`;
const BATCH_B = `batch_${"7".repeat(32)}`;
const BATCH_C = `batch_${"8".repeat(32)}`;
const BATCH_D = `batch_${"9".repeat(32)}`;
const START = Date.parse("2026-07-28T12:00:00.000Z");

async function withFixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), "hcn-receipts-"));
  try {
    await callback({
      directory,
      filePath: join(directory, "receipt-index.json")
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function makeIndex(filePath, options = {}) {
  let timestamp = options.timestamp ?? START;
  const batchRefs = [...(options.batchRefs ?? [
    BATCH_A,
    BATCH_B,
    BATCH_C,
    BATCH_D
  ])];
  const index = createHcnActionReceiptIndex({
    filePath,
    now: () => timestamp,
    randomBatchRef: () => {
      const value = batchRefs.shift();
      if (!value) throw new Error("fixture exhausted");
      return value;
    },
    ...options.index
  });
  return {
    index,
    advance(milliseconds) {
      timestamp += milliseconds;
    },
    setTime(value) {
      timestamp = value;
    }
  };
}

function appendInput({
  sessionPrincipalRef = PRINCIPAL_A,
  fileRef = FILE_A,
  planId = PLAN_A,
  digest = DIGEST_A,
  operationCount = 2
} = {}) {
  return {
    sessionPrincipalRef,
    fileRef,
    planId,
    digest,
    operationCount
  };
}

function transitionInput(receipt, {
  sessionPrincipalRef = PRINCIPAL_A,
  status = "executed",
  succeededCount = receipt.operationCount,
  failedCount = 0,
  blockedCount = 0,
  unknownCount = 0
} = {}) {
  return {
    sessionPrincipalRef,
    fileRef: receipt.fileRef,
    planId: receipt.planId,
    digest: receipt.digest,
    batchRef: receipt.batchRef,
    status,
    succeededCount,
    failedCount,
    blockedCount,
    unknownCount
  };
}

function expectReceiptError(code, statusCode) {
  return (error) => (
    error instanceof HcnActionReceiptIndexError
    && error.code === code
    && error.statusCode === statusCode
  );
}

test("append durably records executing before returning and projects metadata only", async () => {
  await withFixture(async ({ filePath }) => {
    const { index } = makeIndex(filePath);
    const receipt = index.appendExecuting(appendInput());

    assert.deepEqual(Object.keys(receipt), [
      "fileRef",
      "planId",
      "digest",
      "batchRef",
      "status",
      "operationCount",
      "succeededCount",
      "failedCount",
      "blockedCount",
      "unknownCount",
      "createdAt",
      "updatedAt",
      "executingAt"
    ]);
    assert.equal(receipt.status, "executing");
    assert.equal(receipt.batchRef, BATCH_A);
    assert.equal(receipt.unknownCount, 2);
    assert.equal(Object.isFrozen(receipt), true);

    const document = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(document.schemaVersion, 1);
    assert.deepEqual(document.records, [{
      sessionPrincipalRef: PRINCIPAL_A,
      ...receipt
    }]);
    assert.equal(
      (await readdir(join(filePath, "..")))
        .some((name) => name.includes(".tmp-")),
      false
    );
  });
});

test("restart atomically converts unresolved executions to reconciliation required", async () => {
  await withFixture(async ({ filePath }) => {
    const first = makeIndex(filePath);
    const executing = first.index.appendExecuting(appendInput());
    first.advance(5_000);

    const restarted = createHcnActionReceiptIndex({
      filePath,
      now: () => START + 5_000,
      randomBatchRef: () => BATCH_B
    });
    const recovered = restarted.get({
      sessionPrincipalRef: PRINCIPAL_A,
      planId: PLAN_A
    });
    assert.equal(recovered.status, "reconciliation_required");
    assert.equal(recovered.succeededCount, 0);
    assert.equal(recovered.failedCount, 0);
    assert.equal(recovered.blockedCount, 0);
    assert.equal(recovered.unknownCount, executing.operationCount);
    assert.equal(recovered.updatedAt, "2026-07-28T12:00:05.000Z");
    assert.equal(recovered.terminalAt, recovered.updatedAt);

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(persisted.records, [{
      sessionPrincipalRef: PRINCIPAL_A,
      ...recovered
    }]);
    const secondRestart = createHcnActionReceiptIndex({
      filePath,
      now: () => START + 10_000
    });
    assert.deepEqual(
      secondRestart.get({
        sessionPrincipalRef: PRINCIPAL_A,
        planId: PLAN_A
      }),
      recovered
    );
  });
});

test("corruption fails closed without renaming, deleting, or rewriting bytes", async () => {
  await withFixture(async ({ directory, filePath }) => {
    const { index } = makeIndex(filePath);
    index.appendExecuting(appendInput());
    const document = JSON.parse(await readFile(filePath, "utf8"));
    document.records[0].approvalChallenge = "private";
    const corrupt = Buffer.from(`${JSON.stringify(document)}\n`);
    await writeFile(filePath, corrupt);
    const before = await stat(filePath);
    const namesBefore = await readdir(directory);

    assert.throws(
      () => createHcnActionReceiptIndex({ filePath }),
      expectReceiptError("receipt_index_corrupt", 500)
    );

    const after = await stat(filePath);
    assert.deepEqual(await readFile(filePath), corrupt);
    assert.deepEqual(await readdir(directory), namesBefore);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  });
});

test("strict inputs and persisted schema reject all sensitive or descriptive data", async () => {
  await withFixture(async ({ filePath }) => {
    const { index } = makeIndex(filePath);
    for (const [key, value] of [
      ["approvalChallenge", "challenge-secret"],
      ["sessionId", "raw-session-secret"],
      ["token", "bearer-secret"],
      ["providerId", "provider-123"],
      ["note", "homeowner body"],
      ["clientName", "Private Person"]
    ]) {
      assert.throws(
        () => index.appendExecuting({
          ...appendInput(),
          [key]: value
        }),
        expectReceiptError("invalid_receipt_request", 400)
      );
    }

    const receipt = index.appendExecuting(appendInput());
    index.transition(transitionInput(receipt));
    const serialized = await readFile(filePath, "utf8");
    for (const forbidden of [
      "approvalChallenge",
      "sessionId",
      "token",
      "providerId",
      "homeowner",
      "clientName",
      "raw-session-secret"
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    const record = JSON.parse(serialized).records[0];
    assert.deepEqual(Object.keys(record), [
      "sessionPrincipalRef",
      "fileRef",
      "planId",
      "digest",
      "batchRef",
      "status",
      "operationCount",
      "succeededCount",
      "failedCount",
      "blockedCount",
      "unknownCount",
      "createdAt",
      "updatedAt",
      "executingAt",
      "terminalAt"
    ]);
  });
});

test("state machine allows one valid terminal transition and rejects invalid counts or reuse", async () => {
  await withFixture(async ({ filePath }) => {
    const clock = makeIndex(filePath);
    const receipt = clock.index.appendExecuting(appendInput({
      operationCount: 3
    }));

    assert.throws(
      () => clock.index.transition(transitionInput(receipt, {
        status: "partial_failure",
        succeededCount: 1,
        failedCount: 1,
        unknownCount: 1
      })),
      expectReceiptError("invalid_operation_counts", 400)
    );
    assert.equal(
      clock.index.get({
        sessionPrincipalRef: PRINCIPAL_A,
        planId: PLAN_A
      }).status,
      "executing"
    );

    clock.advance(1_000);
    const terminal = clock.index.transition(transitionInput(receipt, {
      status: "partial_failure",
      succeededCount: 2,
      failedCount: 1
    }));
    assert.equal(terminal.status, "partial_failure");
    assert.equal(terminal.terminalAt, "2026-07-28T12:00:01.000Z");
    assert.throws(
      () => clock.index.transition(transitionInput(receipt, {
        status: "failed",
        succeededCount: 0,
        failedCount: 3
      })),
      expectReceiptError("receipt_already_terminal", 409)
    );
    assert.throws(
      () => clock.index.appendExecuting(appendInput()),
      expectReceiptError("receipt_already_exists", 409)
    );
  });
});

test("supported terminal states enforce deterministic count semantics", async () => {
  await withFixture(async ({ filePath }) => {
    const clock = makeIndex(filePath);
    const executed = clock.index.appendExecuting(appendInput({
      planId: PLAN_A,
      operationCount: 2
    }));
    clock.index.transition(transitionInput(executed));

    const blocked = clock.index.appendExecuting(appendInput({
      planId: PLAN_B,
      fileRef: FILE_B,
      digest: DIGEST_B,
      operationCount: 2
    }));
    clock.index.transition(transitionInput(blocked, {
      status: "blocked_duplicate",
      succeededCount: 0,
      blockedCount: 2
    }));

    const failed = clock.index.appendExecuting(appendInput({
      planId: PLAN_C,
      operationCount: 2
    }));
    clock.index.transition(transitionInput(failed, {
      status: "failed",
      succeededCount: 0,
      failedCount: 2
    }));

    const verification = clock.index.appendExecuting(appendInput({
      planId: `plan_${"9".repeat(32)}`,
      operationCount: 2
    }));
    clock.index.transition(transitionInput(verification, {
      status: "completed_pending_verification"
    }));

    assert.deepEqual(
      clock.index.list({ sessionPrincipalRef: PRINCIPAL_A })
        .map((receipt) => receipt.status),
      [
        "executed",
        "blocked_duplicate",
        "failed",
        "completed_pending_verification"
      ]
    );
    assert.equal(
      clock.index.stats().byStatus.reconciliation_required,
      0
    );
  });
});

test("lookups are principal-isolated and mismatched transition metadata fails as not found", async () => {
  await withFixture(async ({ filePath }) => {
    const { index } = makeIndex(filePath);
    const receipt = index.appendExecuting(appendInput());
    assert.deepEqual(
      index.list({ sessionPrincipalRef: PRINCIPAL_B }),
      []
    );
    assert.throws(
      () => index.get({
        sessionPrincipalRef: PRINCIPAL_B,
        planId: PLAN_A
      }),
      expectReceiptError("receipt_not_found", 404)
    );
    assert.throws(
      () => index.transition({
        ...transitionInput(receipt),
        digest: DIGEST_B
      }),
      expectReceiptError("receipt_not_found", 404)
    );
    assert.equal(
      index.get({
        sessionPrincipalRef: PRINCIPAL_A,
        planId: PLAN_A
      }).status,
      "executing"
    );
  });
});

test("retention and capacity are bounded without evicting active executions", async () => {
  await withFixture(async ({ filePath }) => {
    const clock = makeIndex(filePath, {
      index: {
        maxRecords: 2,
        retentionMs: 1_000
      }
    });
    const old = clock.index.appendExecuting(appendInput({
      planId: PLAN_A
    }));
    clock.index.transition(transitionInput(old));
    clock.advance(1_000);

    const activeOne = clock.index.appendExecuting(appendInput({
      planId: PLAN_B,
      fileRef: FILE_B,
      digest: DIGEST_B
    }));
    assert.equal(activeOne.status, "executing");
    assert.throws(
      () => clock.index.get({
        sessionPrincipalRef: PRINCIPAL_A,
        planId: PLAN_A
      }),
      expectReceiptError("receipt_not_found", 404)
    );
    clock.index.appendExecuting(appendInput({ planId: PLAN_C }));
    assert.throws(
      () => clock.index.appendExecuting(appendInput({
        planId: `plan_${"9".repeat(32)}`
      })),
      expectReceiptError("receipt_capacity_exhausted", 429)
    );

    const normalized = createHcnActionReceiptIndex({
      filePath,
      now: () => START + 1_000,
      maxRecords: 1
    });
    assert.equal(normalized.stats().records, 1);
    assert.equal(
      JSON.parse(await readFile(filePath, "utf8")).records.length,
      1
    );
  });
});

test("oversized or structurally extended persisted files fail closed", async () => {
  await withFixture(async ({ filePath }) => {
    const bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        records: [],
        chanceBrain: "must never be accepted"
      })
    );
    await writeFile(filePath, bytes);
    assert.throws(
      () => createHcnActionReceiptIndex({ filePath }),
      expectReceiptError("receipt_index_corrupt", 500)
    );
    assert.deepEqual(await readFile(filePath), bytes);

    assert.throws(
      () => createHcnActionReceiptIndex({
        filePath,
        maxFileBytes: 16
      }),
      expectReceiptError("receipt_index_corrupt", 500)
    );
  });

  await withFixture(async ({ directory, filePath }) => {
    const { index } = makeIndex(filePath, {
      index: { maxFileBytes: 800 }
    });
    index.appendExecuting(appendInput());
    const committed = await readFile(filePath);

    assert.throws(
      () => index.appendExecuting(appendInput({
        planId: PLAN_B,
        fileRef: FILE_B,
        digest: DIGEST_B
      })),
      expectReceiptError("receipt_index_full", 507)
    );
    assert.deepEqual(await readFile(filePath), committed);
    assert.equal((await readdir(directory)).length, 1);
    assert.equal(
      index.list({ sessionPrincipalRef: PRINCIPAL_A }).length,
      1
    );
  });
});

test("module boundary contains no Chance Brain, Jobrolo, provider, browser, or network dependency", async () => {
  const source = await readFile(
    new URL("./receipt-index.js", import.meta.url),
    "utf8"
  );
  const imports = source
    .split(/\r?\n/)
    .filter((line) => /^\s*import\b/.test(line))
    .join("\n");

  assert.doesNotMatch(
    imports,
    /(?:brain|jobrolo|provider|fetch|http|gmail|quo|jobnimbus|playwright|puppeteer)/i
  );
  assert.doesNotMatch(
    source,
    /\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/
  );
});
