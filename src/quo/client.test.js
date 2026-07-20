import test from "node:test";
import assert from "node:assert/strict";
import { readQuoHistory, readQuoInbox, sendQuoText } from "./client.js";

test("Quo history reads matching communication across every team line", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    requests.push(value);
    if (value.endsWith("/phone-numbers")) {
      return jsonResponse(200, { data: [
        { id: "PN_chance", name: "Chance Pearson", number: "+19725731730" },
        { id: "PN_andrea", name: "Andrea Ramirez", number: "+12145550101" }
      ] });
    }
    if (value.includes("/messages?") && value.includes("PN_chance")) {
      return jsonResponse(200, { data: [{ id: "MSG_chance", createdAt: "2026-07-15T14:00:00Z", direction: "outgoing", content: "Chance line update" }] });
    }
    if (value.includes("/messages?") && value.includes("PN_andrea")) {
      return jsonResponse(200, { data: [{ id: "MSG_andrea", createdAt: "2026-07-15T15:00:00Z", direction: "outgoing", content: "Andrea line update" }] });
    }
    if (value.includes("/calls?")) return jsonResponse(200, { data: [] });
    return jsonResponse(404, { message: "not found" });
  };
  try {
    const result = await readQuoHistory({
      apiKey: "fixture",
      baseUrl: "https://api.quo.test/v1",
      defaultFrom: "+19725731730",
      allowSend: false
    }, { phone: "+12145550199" });
    assert.equal(result.messageCount, 2);
    assert.deepEqual(result.timeline.map((item) => item.line), ["Chance Pearson", "Andrea Ramirez"]);
    assert.equal(requests.filter((url) => url.includes("/messages?")).length, 2);
    assert.equal(requests.filter((url) => url.includes("/calls?")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

test("Quo inbox discovers recent conversations before reading incoming calls and texts", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    requests.push(value);
    if (value.endsWith("/phone-numbers")) {
      return jsonResponse(200, { data: [
        { id: "PN_chance", name: "Chance Pearson", number: "+19725731730" },
        { id: "PN_andrea", name: "Andrea Ramirez", number: "+12145550101" }
      ] });
    }
    if (value.includes("/conversations?")) {
      return jsonResponse(200, { data: [{
        id: "CN_1",
        phoneNumberId: "PN_andrea",
        participants: ["+12145550199"],
        lastActivityAt: new Date().toISOString()
      }] });
    }
    if (value.includes("/messages?")) {
      return jsonResponse(200, { data: [{
        id: "MSG_incoming",
        createdAt: new Date().toISOString(),
        direction: "incoming",
        from: "+12145550199",
        to: ["+12145550101"],
        text: "Please call me to schedule the inspection."
      }] });
    }
    if (value.includes("/calls?")) return jsonResponse(200, { data: [] });
    return jsonResponse(404, { message: "not found" });
  };
  try {
    const result = await readQuoInbox({
      apiKey: "fixture",
      baseUrl: "https://api.quo.test/v1"
    }, { days: 21, maxResults: 50, transcriptLimit: 0 });
    assert.equal(result.count, 1);
    assert.equal(result.conversationCount, 1);
    assert.equal(result.items[0].line, "Andrea Ramirez");
    assert.equal(result.items[0].participant, "+12145550199");
    assert.equal(result.partial, false);
    assert.match(requests.find((url) => url.includes("/conversations?")), /phoneNumbers%5B%5D=PN_chance/);
    assert.match(requests.find((url) => url.includes("/messages?")), /participants%5B%5D=%2B12145550199/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Quo inbox reports partial results instead of silently hiding line failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/phone-numbers")) {
      return jsonResponse(200, { data: [{ id: "PN_chance", name: "Chance Pearson", number: "+19725731730" }] });
    }
    if (value.includes("/conversations?")) {
      return jsonResponse(200, { data: [{ id: "CN_1", phoneNumberId: "PN_chance", participants: ["+12145550199"] }] });
    }
    if (value.includes("/messages?")) return jsonResponse(403, { message: "restricted" });
    if (value.includes("/calls?")) return jsonResponse(200, { data: [] });
    return jsonResponse(404, { message: "not found" });
  };
  try {
    const result = await readQuoInbox({ apiKey: "fixture", baseUrl: "https://api.quo.test/v1" }, { transcriptLimit: 0 });
    assert.equal(result.count, 0);
    assert.equal(result.partial, true);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].kind, "messages");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Quo inbox follows activity pagination so recent messages are not stranded", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/phone-numbers")) {
      return jsonResponse(200, { data: [{ id: "PN_chance", name: "Chance Pearson", number: "+19725731730" }] });
    }
    if (value.includes("/conversations?")) {
      return jsonResponse(200, { data: [{ id: "CN_long", phoneNumberId: "PN_chance", participants: ["+12145550199"] }] });
    }
    if (value.includes("/messages?") && !value.includes("pageToken=")) {
      return jsonResponse(200, { data: [], nextPageToken: "page-2" });
    }
    if (value.includes("/messages?") && value.includes("pageToken=page-2")) {
      return jsonResponse(200, { data: [{
        id: "MSG_latest",
        createdAt: new Date().toISOString(),
        direction: "incoming",
        from: "+12145550199",
        to: ["+19725731730"],
        text: "The inspector changed the ETA to 10 AM."
      }], nextPageToken: null });
    }
    if (value.includes("/calls?")) return jsonResponse(200, { data: [], nextPageToken: null });
    return jsonResponse(404, { message: "not found" });
  };
  try {
    const result = await readQuoInbox({ apiKey: "fixture", baseUrl: "https://api.quo.test/v1" }, { transcriptLimit: 0 });
    assert.equal(result.count, 1);
    assert.equal(result.items[0].text, "The inspector changed the ETA to 10 AM.");
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
