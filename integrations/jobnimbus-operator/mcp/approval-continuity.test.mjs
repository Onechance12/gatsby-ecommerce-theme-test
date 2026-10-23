import assert from "node:assert/strict";
import { mkdtemp, realpath, readdir, readFile, copyFile, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createEncryptedApprovalStore } from "./approval-store.mjs";

const SECRET = "synthetic-credential-not-a-real-secret";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = 1000000;
const row = (id = ID) => ({ approvalId: id, kind: "action_batch", status: "pending",
  expiresAt: NOW + 60000, challenge: "synthetic-hidden-challenge", operations: "synthetic-private-content" });
async function folder(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "approval-continuity-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const store = (directory, extra = {}) => createEncryptedApprovalStore({ directory,
  secret: SECRET, namespace: "synthetic-v1", now: () => NOW, ...extra });

test("encrypted snapshots reopen independently; only exact revision can atomically claim once", async (t) => {
  const root = await folder(t), a = store(root), b = store(root);
  a.set("digest-a", row()); a.set("digest-b", row("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
  const disk = (await Promise.all((await readdir(root)).map(name => readFile(path.join(root, name), "utf8")))).join("");
  for (const secret of [SECRET, "synthetic-hidden-challenge", "synthetic-private-content", ID]) assert.equal(disk.includes(secret), false);
  assert.deepEqual(b.get("digest-a"), row());
  assert.equal(b.transition("digest-a", "wrong-id", "pending", "executing", "claimed"), false);
  assert.equal(b.transition("digest-a", ID, "pending", "executing", "claimed"), true);
  assert.equal(a.transition("digest-a", ID, "pending", "executing", "claimed"), false);
  assert.equal(a.get("digest-a").challenge, undefined);
  assert.equal(a.get("digest-b").status, "pending");
  assert.throws(() => a.set("digest-a", row()), /receipt_review_required/);
  assert.equal(a.transition("digest-a", ID, "executing", "unknown", "receipt_review_required"), true);
  assert.throws(() => a.set("digest-a", row()), /receipt_review_required/);
});

test("credential/version changes, ciphertext edits, permissions and symlinks fail closed", async (t) => {
  const root = await folder(t), a = store(root);
  a.set("digest", row());
  const rotated = store(root, { secret: "different-synthetic-credential" });
  const upgraded = store(root, { namespace: "synthetic-v2" });
  assert.equal(rotated.get("digest"), undefined);
  assert.equal(upgraded.get("digest"), undefined);
  const filename = path.join(root, (await readdir(root)).find(n => n.endsWith(".json")));
  const original = await readFile(filename, "utf8");
  const altered = JSON.parse(original); altered.data = Buffer.from("tampered").toString("base64");
  await writeFile(filename, JSON.stringify(altered));
  assert.throws(() => a.get("digest"), /integrity/);
  await writeFile(filename, original); await chmod(filename, 0o644);
  assert.throws(() => a.get("digest"), /integrity/);
  await chmod(filename, 0o600); await chmod(root, 0o755);
  assert.throws(() => a.get("digest"), /unsafe_storage/);
  await chmod(root, 0o700);
  rotated.set("digest", row("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
  upgraded.set("digest", row("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
  assert.equal(a.get("digest").approvalId, ID);
  const link = path.join(root, "link"); await symlink(root, link);
  assert.throws(() => store(link).get("digest"), /unsafe_storage/);
});

test("expiry removes payload on access, and an interrupted lock blocks only that plan", async (t) => {
  const root = await folder(t), a = store(root);
  a.set("digest", row());
  const filename = (await readdir(root)).find(n => n.endsWith(".json"));
  const expired = store(root, { now: () => NOW + 60001 }).get("digest");
  assert.equal(expired.reason, "expired"); assert.equal(expired.challenge, undefined);
  await writeFile(path.join(root, `${filename}.lock`), "", { mode: 0o600 });
  assert.throws(() => a.get("digest"), /busy_or_interrupted_lock/);
  a.set("unrelated", row()); assert.equal(a.get("unrelated").status, "pending");
});

async function nativeFixture(t) {
  const root = await folder(t);
  const source = fileURLToPath(new URL("./", import.meta.url));
  for (const name of await readdir(source)) {
    if (name.endsWith(".mjs") && name !== "server.mjs" && !name.endsWith(".test.mjs")) {
      await copyFile(path.join(source, name), path.join(root, name));
    }
  }
  // Reuse the existing complete synthetic attestation/provider fixtures, not
  // the installed entrypoint or any real account, record or network response.
  const fixtures = await readFile(new URL("./operator-coordinator.test.mjs", import.meta.url), "utf8");
  await writeFile(path.join(root, "fixtures.mjs"), fixtures.slice(0, fixtures.indexOf("\ntest("))
    + "\nexport { harness, SEND_OPERATIONS, NOW };\n");
  const connections = [];
  t.after(async () => { for (const client of connections) await client.close(); });
  return async () => {
    const client = new Client({ name: "synthetic-protocol-test", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("./test-support/approval-harness.mjs", import.meta.url)),
        path.join(root, "fixtures.mjs"), path.join(root, "vault")],
      env: { NODE_ENV: "test", PATH: process.env.PATH }, stderr: "pipe" });
    await client.connect(transport); connections.push(client);
    return { close: () => client.close(), async call(name, args = {}) {
      const response = await client.callTool({ name, arguments: args });
      assert.equal(response.isError, undefined, JSON.stringify(response.content));
      return JSON.parse(response.content[0].text);
    } };
  };
}

test("actual coordinator over MCP stdio survives process exit between plan and execute, then rejects replay", async (t) => {
  const connect = await nativeFixture(t);
  const first = await connect(); const plan = await first.call("synthetic_plan");
  assert.equal(JSON.stringify(plan).includes("secret-one-use-challenge"), false);
  assert.ok(plan.approvalId); await first.close();
  const next = await connect();
  const request = { approvalDigest: plan.approvalDigest, approvalId: plan.approvalId };
  assert.deepEqual(await next.call("synthetic_execute", request), { ok: true, mode: "executed", effectPosts: 1 });
  await next.close();
  const again = await connect(); const replay = await again.call("synthetic_execute", request);
  assert.equal(replay.ok, false); assert.equal(replay.effectPosts, 0);
  assert.match(replay.reason, /verified/);
});

test("two independent MCP processes cannot execute one approval twice", async (t) => {
  const connect = await nativeFixture(t), a = await connect(), b = await connect();
  const plan = await a.call("synthetic_plan");
  const request = { approvalDigest: plan.approvalDigest, approvalId: plan.approvalId };
  const results = await Promise.all([a.call("synthetic_execute", request), b.call("synthetic_execute", request)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.reduce((sum, r) => sum + r.effectPosts, 0), 1);
});

test("process death after the claimed mock request stays non-replayable on reconnect", async (t) => {
  const connect = await nativeFixture(t), a = await connect();
  const plan = await a.call("synthetic_plan");
  const request = { approvalDigest: plan.approvalDigest, approvalId: plan.approvalId };
  await assert.rejects(a.call("synthetic_execute", { ...request, scenario: "crash_after_request" }));
  const b = await connect(); const result = await b.call("synthetic_execute", request);
  assert.equal(result.ok, false); assert.equal(result.effectPosts, 0);
  assert.match(result.reason, /effect_request_claimed/);
});

test("MCP requires the unique approval ID and wrong IDs cannot consume the reviewed plan", async (t) => {
  const connect = await nativeFixture(t), a = await connect();
  const plan = await a.call("synthetic_plan");
  await assert.rejects(a.call("synthetic_execute", { approvalDigest: plan.approvalDigest }));
  const wrong = await a.call("synthetic_execute", { approvalDigest: plan.approvalDigest, approvalId: ID });
  assert.equal(wrong.ok, false); assert.equal(wrong.effectPosts, 0);
  assert.match(wrong.reason, /Approval ID/);
  const proper = await a.call("synthetic_execute", { approvalDigest: plan.approvalDigest, approvalId: plan.approvalId });
  assert.equal(proper.ok, true); assert.equal(proper.effectPosts, 1);
});

for (const scenario of ["expired", "boot", "input", "unknown", "preflight_unavailable"]) {
  test(`separate-process ${scenario} has correct no-effect/unknown handling`, async (t) => {
    const connect = await nativeFixture(t), a = await connect();
    const plan = await a.call("synthetic_plan"); await a.close();
    const b = await connect();
    const request = { approvalDigest: plan.approvalDigest, approvalId: plan.approvalId };
    const failed = await b.call("synthetic_execute", { ...request, scenario });
    assert.equal(failed.ok, false); assert.equal(failed.effectPosts, scenario === "unknown" ? 1 : 0);
    await b.close();
    const c = await connect(); const next = await c.call("synthetic_execute", request);
    assert.equal(next.ok, scenario === "preflight_unavailable");
    assert.equal(next.effectPosts, scenario === "preflight_unavailable" ? 1 : 0);
  });
}

test("replanning identical content creates a distinct ID; an old approval cannot authorize its replacement", async (t) => {
  const connect = await nativeFixture(t), a = await connect();
  const old = await a.call("synthetic_plan"); const current = await a.call("synthetic_plan");
  assert.notEqual(old.approvalId, current.approvalId);
  const rejected = await a.call("synthetic_execute", { approvalDigest: old.approvalDigest, approvalId: old.approvalId });
  assert.equal(rejected.ok, false); assert.equal(rejected.effectPosts, 0);
  const result = await a.call("synthetic_execute", { approvalDigest: current.approvalDigest, approvalId: current.approvalId });
  assert.equal(result.ok, true); assert.equal(result.effectPosts, 1);
});
