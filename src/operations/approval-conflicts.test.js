import assert from "node:assert/strict";
import test from "node:test";
import { approvalConflictKeys, approvalScopesConflict } from "./approval-conflicts.js";

const scope = (id, type = "synthetic.note") => ({ runPolicyId: "synthetic-policy",
  runPolicySha256: "a".repeat(64), files: [{ id, operationTypes: [type] }] });
test("only overlapping server-resolved file/action keys supersede each other", () => {
  const a = approvalConflictKeys(scope("synthetic-a"), "action_batch");
  assert.equal(approvalScopesConflict(a, approvalConflictKeys(scope("synthetic-b"), "action_batch")), false);
  assert.equal(approvalScopesConflict(a, approvalConflictKeys(scope("synthetic-a", "synthetic.send"), "action_batch")), false);
  assert.equal(approvalScopesConflict(a, approvalConflictKeys(scope("synthetic-a"), "action_batch")), true);
  assert.equal(approvalScopesConflict(a, [...approvalConflictKeys(scope("synthetic-b"), "action_batch"), ...a]), true);
  assert.equal(JSON.stringify(a).includes("synthetic-a"), false);
});
test("unknown or legacy scopes retain conservative supersession", () => {
  for (const invalid of [null, {}, { files: [] }, scope(""), { ...scope("x"), runPolicyId: "" }]) {
    assert.equal(approvalConflictKeys(invalid, "action_batch"), null);
  }
  assert.equal(approvalScopesConflict(null, ["a"]), true);
  assert.equal(approvalScopesConflict(["a"], []), true);
});
