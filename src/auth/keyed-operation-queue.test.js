import assert from "node:assert/strict";
import test from "node:test";

import {
  KeyedOperationQueueError,
  createKeyedOperationQueue
} from "./keyed-operation-queue.js";

test("same-principal refresh and disconnect transactions cannot interleave", async () => {
  const queue = createKeyedOperationQueue();
  const state = { grant: "active", access: "" };
  let releaseRefresh;
  const refreshMayFinish = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  let refreshRead = false;

  const refresh = queue.run("principal_a", async () => {
    assert.equal(state.grant, "active");
    refreshRead = true;
    await refreshMayFinish;
    state.access = "fresh";
    state.grant = "active";
  });
  while (!refreshRead) await new Promise((resolve) => setImmediate(resolve));
  const disconnect = queue.run("principal_a", async () => {
    state.grant = "revoked";
    state.access = "";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.grant, "active");
  releaseRefresh();
  await Promise.all([refresh, disconnect]);
  assert.deepEqual(state, { grant: "revoked", access: "" });
});

test("a refresh queued after disconnect observes the tombstone", async () => {
  const queue = createKeyedOperationQueue();
  const state = { grant: "active", access: "" };
  const disconnect = queue.run("principal_a", async () => {
    state.grant = "revoked";
  });
  const refresh = queue.run("principal_a", async () => {
    assert.equal(state.grant, "revoked");
    return "relink_required";
  });
  await disconnect;
  assert.equal(await refresh, "relink_required");
  assert.equal(state.grant, "revoked");
});

test("unrelated principals run independently and key capacity is bounded", async () => {
  const queue = createKeyedOperationQueue({ maxKeys: 1 });
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const first = queue.run("principal_a", () => wait);
  await assert.rejects(
    queue.run("principal_b", async () => undefined),
    KeyedOperationQueueError
  );
  release();
  await first;
  await queue.run("principal_b", async () => undefined);
});
