import assert from "node:assert/strict";
import test from "node:test";
import { HCN_JOBROLO_GOOGLE_START, jobroloGoogleDestination, jobroloGoogleCookie,
  parseJobroloGoogleStart, jobroloGoogleLoginPath } from "./jobrolo-google-journey.js";

test("Google setup accepts only an email hint and one bounded continuation", () => {
  const url = new URL(HCN_JOBROLO_GOOGLE_START, "https://bridge.example");
  url.searchParams.set("email", "Person+work@example.com");
  assert.deepEqual(parseJobroloGoogleStart(url), { email: "person+work@example.com", afterLogin: false });
  for (const search of ["", "?email=a@b.com&email=peer@b.com", "?email=a@b.com&returnTo=https://evil.test",
    "?email=a@b.com&afterLogin=2", "?email=%3Cscript%3E@b.com", "?email=a%0Ab@b.com"]) {
    assert.throws(() => parseJobroloGoogleStart(new URL(`${HCN_JOBROLO_GOOGLE_START}${search}`, url)));
  }
  const login = new URL(jobroloGoogleLoginPath("person+work@example.com"), url);
  assert.equal(login.pathname, "/hcn/auth/login");
  assert.deepEqual(parseJobroloGoogleStart(new URL(login.searchParams.get("returnTo"), url)),
    { email: "person+work@example.com", afterLogin: true });
});

test("return target is fixed and carries no authorization assertion or token", () => {
  for (const value of ["returned", "cancelled", "failed", "account_mismatch", "https://evil.test", "connected", undefined]) {
    const url = new URL(jobroloGoogleDestination(value));
    assert.equal(url.origin, "https://jobrolo.com");
    assert.equal(url.pathname, "/app/home");
    assert.deepEqual([...url.searchParams.keys()], ["gmail"]);
    assert.notEqual(url.searchParams.get("gmail"), "connected");
  }
  assert.match(jobroloGoogleCookie(), /Max-Age=900; Secure; HttpOnly; SameSite=Lax$/);
  assert.match(jobroloGoogleCookie(true), /=; Path=\/; Max-Age=0;/);
});
