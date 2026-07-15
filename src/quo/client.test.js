import test from "node:test";
import assert from "node:assert/strict";
import { sendQuoText } from "./client.js";

test("Quo dry run never calls the API", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("dry run must not call Quo");
  };
  try {
    const result = await sendQuoText({
      apiKey: "fixture",
      baseUrl: "https://api.quo.test/v1",
      defaultFrom: "+19725731730",
      allowSend: true
    }, {
      to: "+12145550100",
      content: "Approved fixture text.",
      execute: false
    });
    assert.equal(result.mode, "dry_run");
    assert.equal(result.plan.from, "+19725731730");
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Quo live send resolves the configured number to its PN line id", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/phone-numbers")) {
      return jsonResponse(200, { data: [{ id: "PN_chance", name: "Chance Pearson", number: "+19725731730" }] });
    }
    if (String(url).endsWith("/messages")) {
      return jsonResponse(202, { data: { id: "AC_message", phoneNumberId: "PN_chance", status: "queued" } });
    }
    return jsonResponse(404, { message: "not found" });
  };
  try {
    const result = await sendQuoText({
      apiKey: "fixture",
      baseUrl: "https://api.quo.test/v1",
      defaultFrom: "+19725731730",
      allowSend: true
    }, {
      to: "+12145550100",
      content: "Approved fixture text.",
      execute: true
    });
    assert.equal(result.mode, "executed");
    assert.equal(result.message.phoneNumberId, "PN_chance");
    assert.equal(requests.length, 2);
    assert.equal(JSON.parse(requests[1].options.body).from, "PN_chance");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
