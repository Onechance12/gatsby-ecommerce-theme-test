import assert from "node:assert/strict";
import test from "node:test";

import {
  HCN_LOGIN_COOKIE_NAME,
  HCN_SESSION_COOKIE_NAME,
  HcnConsoleHttpError,
  clearHcnLoginCookie,
  clearHcnSessionCookie,
  createHcnLoginCookie,
  createHcnSessionCookie,
  hcnNoStoreSecurityHeaders,
  parseHcnCookieHeader,
  readHcnCookie,
  validateExactHcnOrigin,
  validateHcnCsrfToken,
  validateHcnReturnTo
} from "./hcn-console-http.js";

const ID_A = Buffer.alloc(32, 0x11).toString("base64url");
const ID_B = Buffer.alloc(32, 0x22).toString("base64url");

test("strict cookie parser accepts bounded RFC cookie-octets", () => {
  const parsed = parseHcnCookieHeader(
    `${HCN_LOGIN_COOKIE_NAME}=${ID_A}; theme=plain; token=a=b`
  );
  assert.equal(parsed[HCN_LOGIN_COOKIE_NAME], ID_A);
  assert.equal(parsed.theme, "plain");
  assert.equal(parsed.token, "a=b");
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(readHcnCookie(`a=1; ${HCN_SESSION_COOKIE_NAME}=${ID_B}`, HCN_SESSION_COOKIE_NAME), ID_B);
  assert.equal(readHcnCookie("a=1", HCN_SESSION_COOKIE_NAME), null);
});

test("empty cookie header produces a safe empty result", () => {
  for (const value of [undefined, null, ""]) {
    const parsed = parseHcnCookieHeader(value);
    assert.deepEqual(Object.keys(parsed), []);
    assert.equal(Object.getPrototypeOf(parsed), null);
  }
});

test("cookie parser rejects duplicate names and malformed segments", () => {
  const invalidHeaders = [
    "a=1; a=2",
    "a=1;",
    ";a=1",
    "a",
    "=value",
    "bad name=value",
    'quoted="value"',
    "a=value with space",
    "a=1\t",
    "a=1\r\nInjected: yes",
    ["a=1", "b=2"]
  ];
  for (const header of invalidHeaders) {
    assert.throws(
      () => parseHcnCookieHeader(header),
      HcnConsoleHttpError,
      String(header)
    );
  }
});

test("cookie parser rejects oversized headers, values, and cookie counts", () => {
  assert.throws(
    () => parseHcnCookieHeader("a=12345", { maxHeaderBytes: 4 }),
    /exceeds/
  );
  assert.throws(
    () => parseHcnCookieHeader("a=12345", { maxValueBytes: 4 }),
    /invalid cookie value/
  );
  assert.throws(
    () => parseHcnCookieHeader("a=1; b=2", { maxCookies: 1 }),
    /too many/
  );
});

test("__Host cookies always carry the required host-only protections", () => {
  assert.equal(
    createHcnLoginCookie(ID_A),
    `${HCN_LOGIN_COOKIE_NAME}=${ID_A}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`
  );
  assert.equal(
    createHcnSessionCookie(ID_B),
    `${HCN_SESSION_COOKIE_NAME}=${ID_B}; Path=/; Max-Age=43200; Secure; HttpOnly; SameSite=Lax`
  );
  assert.match(
    clearHcnLoginCookie(),
    new RegExp(
      `^${HCN_LOGIN_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax$`
    )
  );
  assert.match(
    clearHcnSessionCookie(),
    new RegExp(
      `^${HCN_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax$`
    )
  );
  for (const header of [
    createHcnLoginCookie(ID_A),
    createHcnSessionCookie(ID_B),
    clearHcnLoginCookie(),
    clearHcnSessionCookie()
  ]) {
    assert.doesNotMatch(header, /Domain=/i);
  }
});

test("cookie serializers accept only 256-bit base64url values", () => {
  for (const value of ["", "short", `${ID_A}=`, "x".repeat(44), null]) {
    assert.throws(() => createHcnSessionCookie(value), /256-bit/);
  }
  assert.throws(
    () => createHcnLoginCookie(ID_A, { maxAgeSeconds: -1 }),
    /non-negative/
  );
});

test("returnTo accepts only the HCN path boundary on the same origin", () => {
  const accepted = [
    "/hcn",
    "/hcn/",
    "/hcn/work-center",
    "/hcn?view=readiness",
    "/hcn/work?next=%2Fhcn",
    "/hcn#status"
  ];
  for (const value of accepted) {
    assert.equal(validateHcnReturnTo(value), value);
  }
});

test("returnTo rejects origins, schemes, sibling prefixes, and parser tricks", () => {
  const rejected = [
    "",
    "hcn",
    "https://example.com/hcn",
    "//example.com/hcn",
    "/hcnevil",
    "/HCN",
    "/hcn\\@example.com",
    "/hcn/%5c@example.com",
    "/hcn/%0d%0aLocation:%20https://evil.test",
    "/hcn/\nnext",
    "/hcn/%",
    "/hcn/%2e%2e/outside",
    `/hcn/${"x".repeat(2100)}`
  ];
  for (const value of rejected) {
    assert.throws(
      () => validateHcnReturnTo(value),
      HcnConsoleHttpError,
      String(value)
    );
  }
});

test("Origin validation is exact and fails closed", () => {
  assert.equal(
    validateExactHcnOrigin(
      "https://bridge.example",
      "https://bridge.example"
    ),
    true
  );
  for (const [actual, expected] of [
    [undefined, "https://bridge.example"],
    ["null", "https://bridge.example"],
    ["https://bridge.example/", "https://bridge.example"],
    ["https://BRIDGE.example", "https://bridge.example"],
    ["https://bridge.example:443", "https://bridge.example"],
    ["https://bridge.example", "https://bridge.example/"],
    ["https://bridge.example, https://evil.test", "https://bridge.example"],
    ["https://bridge.example", "https://bridge.example/path"],
    ["https://bridge.example\r\n", "https://bridge.example"]
  ]) {
    assert.equal(validateExactHcnOrigin(actual, expected), false);
  }
});

test("CSRF validation compares exact bounded values", () => {
  assert.equal(validateHcnCsrfToken(ID_A, ID_A), true);
  assert.equal(validateHcnCsrfToken(ID_A, ID_B), false);
  assert.equal(validateHcnCsrfToken(ID_A, `${ID_A}x`), false);
  assert.equal(validateHcnCsrfToken("", ""), false);
  assert.equal(validateHcnCsrfToken(undefined, ID_A), false);
  assert.equal(validateHcnCsrfToken("x".repeat(513), ID_A), false);
  assert.equal(validateHcnCsrfToken(`${ID_A}\n`, `${ID_A}\n`), false);
});

test("security headers disable storage, embedding, sniffing, and ambient powers", () => {
  const api = hcnNoStoreSecurityHeaders();
  assert.equal(Object.isFrozen(api), true);
  assert.equal(api["cache-control"], "no-store, max-age=0");
  assert.match(api["content-security-policy"], /default-src 'none'/);
  assert.match(api["content-security-policy"], /form-action 'none'/);
  assert.equal(api["x-frame-options"], "DENY");
  assert.equal(api["x-content-type-options"], "nosniff");
  assert.equal(api["referrer-policy"], "no-referrer");
  assert.match(api["permissions-policy"], /microphone=\(\)/);

  const document = hcnNoStoreSecurityHeaders({ document: true });
  assert.match(document["content-security-policy"], /script-src 'self'/);
  assert.match(document["content-security-policy"], /connect-src 'self'/);
  assert.match(document["content-security-policy"], /frame-ancestors 'none'/);
  assert.throws(
    () => hcnNoStoreSecurityHeaders({ document: "yes" }),
    /boolean/
  );
});
