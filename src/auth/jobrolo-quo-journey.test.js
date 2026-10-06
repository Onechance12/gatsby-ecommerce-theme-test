import assert from "node:assert/strict";
import test from "node:test";
import { HCN_JOBROLO_QUO_START, HCN_JOBROLO_QUO_CONSOLE, jobroloQuoLoginPath,
  jobroloQuoDestination, parseJobroloQuoStart } from "./jobrolo-quo-journey.js";
import { validateHcnReturnTo } from "./hcn-console-http.js";

test("personal Quo entry preserves only a bounded work-email hint through identity sign-in", () => {
  const base = "https://bridge.example";
  const login = new URL(jobroloQuoLoginPath("person+work@example.com"), base);
  assert.equal(login.pathname, "/hcn/auth/login");
  const returnTo = validateHcnReturnTo(login.searchParams.get("returnTo"));
  assert.deepEqual(parseJobroloQuoStart(new URL(returnTo, base)), {
    email: "person+work@example.com", afterLogin: true
  });
  for (const search of ["", "?email=a@b.com&email=peer@b.com", "?email=a@b.com&returnTo=https://evil.test",
    "?email=a@b.com&afterLogin=2", "?email=a@b.com&phone=+12145550199", "?email=a%0Ab@b.com"]) {
    assert.throws(() => parseJobroloQuoStart(new URL(`${HCN_JOBROLO_QUO_START}${search}`, base)));
  }
  assert.equal(validateHcnReturnTo(HCN_JOBROLO_QUO_CONSOLE), "/hcn/?quoSetup=1#connections");
});

test("Quo return is fixed navigation, never a connected claim or authority token", () => {
  for (const outcome of ["returned", "failed", "account_mismatch", "connected", "https://evil.test", undefined]) {
    const target = new URL(jobroloQuoDestination(outcome));
    assert.equal(target.origin, "https://jobrolo.com");
    assert.equal(target.pathname, "/app/home");
    assert.deepEqual([...target.searchParams.keys()], ["quo"]);
    assert.ok(["returned", "failed", "account_mismatch"].includes(target.searchParams.get("quo")));
  }
});
