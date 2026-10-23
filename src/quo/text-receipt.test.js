import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readQuoTextReceipt } from "./client.js";

const CONTENT = "Synthetic receipt proof.\nExact spaces  and punctuation.";
const INPUT = Object.freeze({
  id: "AC_synthetic",
  from: "+12025550101",
  to: "+12025550102",
  contentSha256: createHash("sha256").update(CONTENT).digest("hex"),
  characterCount: CONTENT.length
});
const MESSAGE = Object.freeze({
  id: INPUT.id, phoneNumberId: "PN_synthetic", conversationId: "CN_synthetic",
  from: INPUT.from, to: [INPUT.to], direction: "outgoing", status: "delivered",
  text: CONTENT, createdAt: "2026-10-23T12:00:00Z"
});
const LINE = Object.freeze({ id: "PN_synthetic", number: INPUT.from, name: "Synthetic sender" });
const CONFIG = Object.freeze({ apiKey: "synthetic-secret", baseUrl: "https://quo.test/v1" });

async function withProvider(options, action) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, request) => {
    const parsed = new URL(String(url));
    requests.push({ path: parsed.pathname, method: request.method });
    assert.equal(request.method, "GET", "Receipt verification must never send or mutate");
    let body;
    if (parsed.pathname === "/v1/phone-numbers") {
      body = options.inventory || { data: [LINE] };
    } else if (parsed.pathname === `/v1/messages/${encodeURIComponent(INPUT.id)}`) {
      if (options.messageStatus) {
        return new Response(JSON.stringify({ secret: "provider-secret-body", url: "https://private.test" }),
          { status: options.messageStatus, headers: { "content-type": "application/json" } });
      }
      body = Object.hasOwn(options, "payload") ? options.payload : { data: MESSAGE };
    } else {
      assert.fail(`Receipt verification requested unrelated history: ${parsed.pathname}`);
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try { await action(requests); }
  finally { globalThis.fetch = originalFetch; }
}

test("exact SMS receipt does not request call history or conversation streams", async () => {
  await withProvider({}, async (requests) => {
    const receipt = await readQuoTextReceipt(CONFIG, INPUT);
    assert.equal(receipt.externalId, INPUT.id);
    assert.equal(receipt.contentSha256, INPUT.contentSha256);
    assert.equal(receipt.status, "delivered");
    assert.equal(receipt.verifiedByReadback, true);
    assert.deepEqual(requests, [
      { path: "/v1/phone-numbers", method: "GET" },
      { path: "/v1/messages/AC_synthetic", method: "GET" }
    ]);
  });
});

test("exact SMS receipt rejects changed identity, participants and content", async (t) => {
  const cases = [
    ["provider ID", { id: "AC_other" }],
    ["sending line", { phoneNumberId: "PN_other" }],
    ["sender", { from: "+12025550199" }],
    ["recipient", { to: ["+12025550199"] }],
    ["group recipient", { to: [INPUT.to, "+12025550199"] }],
    ["direction", { direction: "incoming" }],
    ["text bytes", { text: CONTENT.replace("  ", " ") }],
    ["conflicting text aliases", { content: "different" }],
    ["nonstring content", { text: 123 }]
  ];
  for (const [name, patch] of cases) {
    await t.test(name, async () => {
      await withProvider({ payload: { data: { ...MESSAGE, ...patch } } }, async () => {
        await assert.rejects(readQuoTextReceipt(CONFIG, INPUT));
      });
    });
  }
  await t.test("character count", async () => {
    await withProvider({}, async () => {
      await assert.rejects(readQuoTextReceipt(CONFIG, { ...INPUT, characterCount: INPUT.characterCount + 1 }));
    });
  });
});

test("exact SMS receipt requires complete, unique sender-line proof", async (t) => {
  for (const [name, inventory] of [
    ["incomplete inventory", { data: [LINE], nextPageToken: 123 }],
    ["ambiguous sender", { data: [LINE, { ...LINE, id: "PN_duplicate" }] }],
    ["sender unavailable", { data: [{ ...LINE, number: "+12025550199" }] }]
  ]) {
    await t.test(name, async () => {
      await withProvider({ inventory }, async (requests) => {
        await assert.rejects(readQuoTextReceipt(CONFIG, INPUT), /incomplete/i);
        assert.deepEqual(requests, [{ path: "/v1/phone-numbers", method: "GET" }]);
      });
    });
  }
});

test("exact SMS provider failures reveal only fixed diagnostics and never fall back", async (t) => {
  for (const status of [401, 403, 404, 500]) {
    await t.test(String(status), async () => {
      await withProvider({ messageStatus: status }, async (requests) => {
        await assert.rejects(readQuoTextReceipt(CONFIG, INPUT), (error) => {
          assert.equal(error.statusCode, 503);
          assert.match(error.message, /stage=messages; reason=provider_read/);
          assert.doesNotMatch(error.message, /provider-secret-body|private\.test|synthetic-secret|AC_synthetic/);
          return true;
        });
        assert.equal(requests.length, 2);
      });
    });
  }
  for (const payload of [{ data: [] }, { data: null }, {}]) {
    await withProvider({ payload }, async () => {
      await assert.rejects(readQuoTextReceipt(CONFIG, INPUT), /stage=messages; reason=invalid_response/);
    });
  }
});
