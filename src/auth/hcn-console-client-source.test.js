import assert from "node:assert/strict";
import test from "node:test";

import { hcnLoginSourceFromRequest } from "./hcn-console-client-source.js";

test("direct deployments use only the validated socket peer", () => {
  assert.equal(
    hcnLoginSourceFromRequest({
      headers: { "x-forwarded-for": "203.0.113.8" },
      socket: { remoteAddress: "::ffff:127.0.0.1" }
    }),
    "direct:127.0.0.1"
  );
  assert.equal(
    hcnLoginSourceFromRequest({
      headers: {},
      socket: { remoteAddress: "2001:db8::4" }
    }),
    "direct:2001:db8::4"
  );
});

test("Render deployments require a strict first forwarded client IP", () => {
  assert.equal(
    hcnLoginSourceFromRequest({
      headers: {
        "x-forwarded-for": "203.0.113.8, 198.51.100.2"
      },
      socket: { remoteAddress: "10.0.0.4" }
    }, { renderProxy: true }),
    "render:203.0.113.8"
  );
  for (const header of [
    "",
    "attacker.example",
    "203.0.113.8:443",
    "203.0.113.8\n198.51.100.2",
    Array.from({ length: 17 }, () => "203.0.113.8").join(","),
    "x".repeat(2049)
  ]) {
    assert.equal(
      hcnLoginSourceFromRequest({
        headers: { "x-forwarded-for": header },
        socket: { remoteAddress: "10.0.0.4" }
      }, { renderProxy: true }),
      ""
    );
  }
});

test("missing or malformed request state fails closed", () => {
  assert.equal(hcnLoginSourceFromRequest(null), "");
  assert.equal(hcnLoginSourceFromRequest({ headers: {}, socket: {} }), "");
  assert.equal(
    hcnLoginSourceFromRequest(
      { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
      { renderProxy: "yes" }
    ),
    ""
  );
});
