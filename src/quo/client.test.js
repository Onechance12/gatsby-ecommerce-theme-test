import test from "node:test";
import assert from "node:assert/strict";
import {
  readQuoHistory,
  readQuoHistoryStrict,
  readQuoInbox,
  sendQuoText
} from "./client.js";

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

test("strict Quo history completely paginates messages and calls across every team line", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    requests.push(value);
    if (value.endsWith("/phone-numbers")) {
      return jsonResponse(200, { data: [
        { id: "PN_one", name: "Line One", number: "+19725550101" },
        { id: "PN_two", name: "Line Two", number: "+19725550102" }
      ] });
    }
    const parsed = new URL(value);
    const line = parsed.searchParams.get("phoneNumberId");
    const page = parsed.searchParams.get("pageToken");
    if (parsed.pathname.endsWith("/messages") && line === "PN_one" && !page) {
      return jsonResponse(200, {
        data: [scopedMessage("PN_one", "+19725550101", {
          id: "MSG_1",
          createdAt: "2026-07-15T14:00:00Z",
          content: "First"
        })],
        nextPageToken: "message-page-2"
      });
    }
    if (parsed.pathname.endsWith("/messages") && line === "PN_one" && page === "message-page-2") {
      return jsonResponse(200, {
        data: [scopedMessage("PN_one", "+19725550101", {
          id: "MSG_2",
          createdAt: "2026-07-15T15:00:00Z",
          content: "Second"
        })]
      });
    }
    if (parsed.pathname.endsWith("/calls") && line === "PN_two" && !page) {
      return jsonResponse(200, {
        data: [scopedCall("PN_two", {
          id: "CALL_1",
          createdAt: "2026-07-15T16:00:00Z",
          duration: 45
        })],
        nextPageToken: "call-page-2"
      });
    }
    if (parsed.pathname.endsWith("/calls") && line === "PN_two" && page === "call-page-2") {
      return jsonResponse(200, {
        data: [scopedCall("PN_two", {
          id: "CALL_2",
          createdAt: "2026-07-15T17:00:00Z",
          duration: 60
        })],
        nextPageToken: null
      });
    }
    return jsonResponse(200, { data: [], nextPageToken: null });
  };
  try {
    const result = await readQuoHistoryStrict(
      { apiKey: "fixture", baseUrl: "https://api.quo.test/v1" },
      { phone: "+12145550199", maxResults: 10, maxPages: 3 }
    );
    assert.equal(result.completeness.complete, true);
    assert.deepEqual(result.completeness.reasons, []);
    assert.equal(result.completeness.lineCount, 2);
    assert.equal(result.completeness.pagesScanned, 6);
    assert.deepEqual(result.timeline.map((item) => item.id), ["MSG_1", "MSG_2", "CALL_1", "CALL_2"]);
    assert.equal(requests.filter((url) => url.includes("pageToken=")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict Quo history can be confined to one exact employee line", async () => {
  const originalFetch = globalThis.fetch;
  const requestedLines = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/phone-numbers")) {
      return jsonResponse(200, { data: [
        { id: "PN_one", name: "Line One", number: "+19725550101" },
        { id: "PN_two", name: "Line Two", number: "+19725550102" }
      ] });
    }
    requestedLines.push(parsed.searchParams.get("phoneNumberId"));
    if (
      parsed.pathname.endsWith("/messages")
      && parsed.searchParams.get("phoneNumberId") === "PN_two"
    ) {
      return jsonResponse(200, {
        data: [scopedMessage("PN_two", "+19725550102", {
          id: "MSG_employee",
          createdAt: "2026-07-15T15:00:00Z",
          content: "Employee line only"
        })]
      });
    }
    return jsonResponse(200, { data: [] });
  };
  try {
    const result = await readQuoHistoryStrict(
      { apiKey: "fixture", baseUrl: "https://api.quo.test/v1" },
      {
        phone: "+12145550199",
        lineId: "PN_two",
        lineNumber: "+19725550102",
        maxResults: 10
      }
    );
    assert.equal(result.completeness.complete, true);
    assert.equal(result.completeness.lineCount, 1);
    assert.deepEqual(result.timeline.map((item) => item.id), [
      "MSG_employee"
    ]);
    assert.deepEqual(requestedLines, ["PN_two", "PN_two"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict Quo history returns privacy-safe partial metadata for restricted line streams", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/phone-numbers")) {
      return jsonResponse(200, { data: [{ id: "PN_one", name: "Line One", number: "+19725550101" }] });
    }
    if (value.includes("/messages?")) {
      return jsonResponse(403, { message: "restricted SECRET-PROVIDER-DETAIL" });
    }
    if (value.includes("/calls?")) {
      return jsonResponse(200, {
        data: [scopedCall("PN_one", {
          id: "CALL_visible",
          createdAt: "2026-07-15T16:00:00Z",
          duration: 45
        })]
      });
    }
    return jsonResponse(404, { message: "not found" });
  };
  try {
    const result = await readQuoHistoryStrict(
      { apiKey: "fixture", baseUrl: "https://api.quo.test/v1" },
      { phone: "+12145550199" }
    );
    assert.equal(result.completeness.complete, false);
    assert.deepEqual(result.completeness.reasons, ["restricted_line"]);
    assert.equal(result.completeness.restrictedStreamCount, 1);
    assert.deepEqual(result.timeline.map((item) => item.id), ["CALL_visible"]);
    assert.equal(JSON.stringify(result.completeness).includes("SECRET-PROVIDER-DETAIL"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict Quo history marks pagination ceilings instead of claiming completeness", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/phone-numbers")) {
      return jsonResponse(200, { data: [{ id: "PN_one", name: "Line One", number: "+19725550101" }] });
    }
    const parsed = new URL(value);
    if (parsed.pathname.endsWith("/messages")) {
      const page = parsed.searchParams.get("pageToken");
      return jsonResponse(200, {
        data: [scopedMessage("PN_one", "+19725550101", {
          id: page ? "MSG_2" : "MSG_1",
          createdAt: page ? "2026-07-15T15:00:00Z" : "2026-07-15T14:00:00Z"
        })],
        nextPageToken: page ? "message-page-3" : "message-page-2"
      });
    }
    return jsonResponse(200, { data: [] });
  };
  try {
    const result = await readQuoHistoryStrict(
      { apiKey: "fixture", baseUrl: "https://api.quo.test/v1" },
      { phone: "+12145550199", maxResults: 10, maxPages: 2 }
    );
    assert.equal(result.completeness.complete, false);
    assert.deepEqual(result.completeness.reasons, ["pagination_ceiling"]);
    assert.equal(result.completeness.pagesScanned, 3);
    assert.deepEqual(result.timeline.map((item) => item.id), ["MSG_1", "MSG_2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict Quo history deduplicates records and reports bounded result truncation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/phone-numbers")) {
      return jsonResponse(200, { data: [{ id: "PN_one", name: "Line One", number: "+19725550101" }] });
    }
    if (value.includes("/messages?")) {
      return jsonResponse(200, { data: [
        scopedMessage("PN_one", "+19725550101", {
          id: "MSG_duplicate",
          createdAt: "2026-07-15T13:00:00Z"
        }),
        scopedMessage("PN_one", "+19725550101", {
          id: "MSG_duplicate",
          createdAt: "2026-07-15T13:00:00Z"
        }),
        scopedMessage("PN_one", "+19725550101", {
          id: "MSG_recent",
          createdAt: "2026-07-15T15:00:00Z"
        })
      ] });
    }
    if (value.includes("/calls?")) {
      return jsonResponse(200, {
        data: [scopedCall("PN_one", {
          id: "CALL_latest",
          createdAt: "2026-07-15T16:00:00Z"
        })]
      });
    }
    return jsonResponse(404, { message: "not found" });
  };
  try {
    const result = await readQuoHistoryStrict(
      { apiKey: "fixture", baseUrl: "https://api.quo.test/v1" },
      { phone: "+12145550199", maxResults: 2 }
    );
    assert.equal(result.completeness.complete, false);
    assert.deepEqual(result.completeness.reasons, ["result_truncated"]);
    assert.equal(result.completeness.matchedCount, 3);
    assert.equal(result.completeness.returnedCount, 2);
    assert.equal(result.completeness.duplicatesDropped, 1);
    assert.deepEqual(result.timeline.map((item) => item.id), ["MSG_recent", "CALL_latest"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict Quo history marks malformed pagination tokens and redacts fatal provider failures", async () => {
  const originalFetch = globalThis.fetch;
  let mode = "malformed";
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/phone-numbers")) {
      return jsonResponse(200, { data: [{ id: "PN_one", name: "Line One", number: "+19725550101" }] });
    }
    if (mode === "malformed" && value.includes("/messages?")) {
      return jsonResponse(200, { data: [], nextPageToken: { invalid: true } });
    }
    if (mode === "malformed" && value.includes("/calls?")) {
      return jsonResponse(200, { data: [] });
    }
    return jsonResponse(500, { message: "SECRET-FATAL-PROVIDER-DETAIL" });
  };
  try {
    const malformed = await readQuoHistoryStrict(
      { apiKey: "fixture", baseUrl: "https://api.quo.test/v1" },
      { phone: "+12145550199" }
    );
    assert.equal(malformed.completeness.complete, false);
    assert.deepEqual(malformed.completeness.reasons, ["malformed_pagination"]);

    mode = "fatal";
    await assert.rejects(
      readQuoHistoryStrict(
        { apiKey: "fixture", baseUrl: "https://api.quo.test/v1" },
        { phone: "+12145550199" }
      ),
      (error) => {
        assert.equal(error.message, "Quo history provider request failed");
        assert.equal(error.code, "QUO_HISTORY_PROVIDER_FAILURE");
        assert.equal(String(error).includes("SECRET-FATAL-PROVIDER-DETAIL"), false);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict Quo history rejects malformed, empty, and duplicate line inventories", async () => {
  const originalFetch = globalThis.fetch;
  const invalidInventories = [
    {},
    { data: {} },
    { data: [] },
    {
      data: [
        { id: "PN_duplicate", number: "+19725550101" },
        { id: "PN_duplicate", number: "+19725550102" }
      ]
    }
  ];
  try {
    for (const inventory of invalidInventories) {
      globalThis.fetch = async (url) => {
        if (new URL(String(url)).pathname.endsWith("/phone-numbers")) {
          return jsonResponse(200, inventory);
        }
        throw new Error("history streams must not be read after a bad inventory");
      };
      await assert.rejects(
        readQuoHistoryStrict(
          { apiKey: "fixture", baseUrl: "https://api.quo.test/v1" },
          { phone: "+12145550199" }
        ),
        strictProviderFailure
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict Quo history follows every page of the line inventory", async () => {
  const originalFetch = globalThis.fetch;
  const inventoryRequests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/phone-numbers")) {
      inventoryRequests.push(parsed.search);
      if (!parsed.searchParams.get("pageToken")) {
        return jsonResponse(200, {
          data: [{ id: "PN_page_one", number: "+19725550101" }],
          nextPageToken: "inventory-page-2"
        });
      }
      assert.equal(parsed.searchParams.get("pageToken"), "inventory-page-2");
      return jsonResponse(200, {
        data: [{ id: "PN_page_two", number: "+19725550102" }]
      });
    }
    return jsonResponse(200, { data: [] });
  };
  try {
    const result = await readQuoHistoryStrict(
      { apiKey: "fixture", baseUrl: "https://api.quo.test/v1" },
      { phone: "+12145550199", maxPages: 3 }
    );

    assert.equal(result.completeness.complete, true);
    assert.equal(result.completeness.lineCount, 2);
    assert.equal(result.completeness.lineInventoryPagesScanned, 2);
    assert.deepEqual(inventoryRequests, ["", "?pageToken=inventory-page-2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict Quo history reports repeated, malformed, and ceiling-limited line pagination", async () => {
  const originalFetch = globalThis.fetch;
  const scenarios = [
    {
      name: "repeated",
      maxPages: 3,
      response(pageToken) {
        return {
          data: [{
            id: pageToken ? "PN_repeated_two" : "PN_repeated_one",
            number: pageToken ? "+19725550102" : "+19725550101"
          }],
          nextPageToken: "repeat-token"
        };
      },
      reason: "malformed_line_pagination"
    },
    {
      name: "malformed",
      maxPages: 3,
      response() {
        return {
          data: [{ id: "PN_malformed", number: "+19725550101" }],
          nextPageToken: { unsafe: true }
        };
      },
      reason: "malformed_line_pagination"
    },
    {
      name: "ceiling",
      maxPages: 1,
      response() {
        return {
          data: [{ id: "PN_ceiling", number: "+19725550101" }],
          nextPageToken: "unread-inventory-page"
        };
      },
      reason: "line_inventory_ceiling"
    }
  ];

  try {
    for (const scenario of scenarios) {
      globalThis.fetch = async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith("/phone-numbers")) {
          return jsonResponse(
            200,
            scenario.response(parsed.searchParams.get("pageToken"))
          );
        }
        return jsonResponse(200, { data: [] });
      };
      const result = await readQuoHistoryStrict(
        { apiKey: "fixture", baseUrl: "https://api.quo.test/v1" },
        { phone: "+12145550199", maxPages: scenario.maxPages }
      );
      assert.equal(
        result.completeness.complete,
        false,
        `${scenario.name} must not claim completeness`
      );
      assert.deepEqual(result.completeness.reasons, [scenario.reason]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict Quo history treats 400 and 404 as generic failures, not restricted lines", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [400, 404]) {
      globalThis.fetch = async (url) => {
        const value = String(url);
        if (value.endsWith("/phone-numbers")) {
          return jsonResponse(200, {
            data: [{ id: "PN_one", number: "+19725550101" }]
          });
        }
        return jsonResponse(status, {
          message: `SECRET-${status}-PROVIDER-DETAIL`
        });
      };
      await assert.rejects(
        readQuoHistoryStrict(
          { apiKey: "fixture", baseUrl: "https://api.quo.test/v1" },
          { phone: "+12145550199" }
        ),
        (error) => {
          assert.equal(strictProviderFailure(error), true);
          assert.equal(String(error).includes(`SECRET-${status}`), false);
          return true;
        }
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict Quo history rejects cross-line and cross-participant provider rows", async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    {
      kind: "messages",
      row: {
        id: "SECRET-MISSING-SCOPE",
        createdAt: "2026-07-15T14:00:00Z",
        text: "SECRET-CROSS-CLIENT-TEXT"
      }
    },
    {
      kind: "messages",
      row: scopedMessage("PN_other", "+19725550101", {
        id: "SECRET-WRONG-LINE",
        createdAt: "2026-07-15T14:00:00Z"
      })
    },
    {
      kind: "messages",
      row: {
        ...scopedMessage("PN_one", "+19725550101", {
          id: "SECRET-WRONG-PARTICIPANT",
          createdAt: "2026-07-15T14:00:00Z"
        }),
        from: "+12145550000"
      }
    },
    {
      kind: "calls",
      row: scopedCall("PN_other", {
        id: "SECRET-WRONG-CALL-LINE",
        createdAt: "2026-07-15T14:00:00Z"
      })
    },
    {
      kind: "calls",
      row: {
        ...scopedCall("PN_one", {
          id: "SECRET-WRONG-CALL-PARTICIPANT",
          createdAt: "2026-07-15T14:00:00Z"
        }),
        participants: ["+12145550000"]
      }
    }
  ];
  try {
    for (const scenario of cases) {
      globalThis.fetch = async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith("/phone-numbers")) {
          return jsonResponse(200, {
            data: [{
              id: "PN_one",
              number: "+19725550101"
            }]
          });
        }
        if (parsed.pathname.endsWith(`/${scenario.kind}`)) {
          return jsonResponse(200, { data: [scenario.row] });
        }
        return jsonResponse(200, { data: [] });
      };
      await assert.rejects(
        readQuoHistoryStrict(
          { apiKey: "fixture", baseUrl: "https://api.quo.test/v1" },
          { phone: "+12145550199" }
        ),
        strictProviderFailure
      );
    }
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

test("Quo inbox follows conversation pagination before selecting recent activity", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/phone-numbers")) {
      return jsonResponse(200, { data: [{ id: "PN_chance", name: "Chance Pearson", number: "+19725731730" }] });
    }
    if (value.includes("/conversations?") && !value.includes("pageToken=")) {
      return jsonResponse(200, { data: [{
        id: "CN_old",
        phoneNumberId: "PN_chance",
        participants: ["+12145550110"],
        lastActivityAt: "2026-07-01T12:00:00Z"
      }], nextPageToken: "conversation-page-2" });
    }
    if (value.includes("/conversations?") && value.includes("pageToken=conversation-page-2")) {
      return jsonResponse(200, { data: [{
        id: "CN_latest",
        phoneNumberId: "PN_chance",
        participants: ["+12145550199"],
        lastActivityAt: new Date().toISOString()
      }], nextPageToken: null });
    }
    if (value.includes("/messages?") && value.includes("%2B12145550199")) {
      return jsonResponse(200, { data: [{
        id: "MSG_latest",
        createdAt: new Date().toISOString(),
        direction: "incoming",
        from: "+12145550199",
        to: ["+19725731730"],
        text: "Morning ETA update."
      }] });
    }
    if (value.includes("/calls?")) return jsonResponse(200, { data: [] });
    return jsonResponse(200, { data: [] });
  };
  try {
    const result = await readQuoInbox({ apiKey: "fixture", baseUrl: "https://api.quo.test/v1" }, {
      maxResults: 1,
      transcriptLimit: 0
    });
    assert.equal(result.conversationCount, 1);
    assert.equal(result.count, 1);
    assert.equal(result.items[0].participant, "+12145550199");
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

function scopedMessage(phoneNumberId, lineNumber, values = {}) {
  return {
    phoneNumberId,
    from: "+12145550199",
    to: [lineNumber],
    ...values
  };
}

function scopedCall(phoneNumberId, values = {}) {
  return {
    phoneNumberId,
    participants: ["+12145550199"],
    ...values
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function strictProviderFailure(error) {
  assert.equal(error.message, "Quo history provider request failed");
  assert.equal(error.code, "QUO_HISTORY_PROVIDER_FAILURE");
  assert.doesNotMatch(String(error), /SECRET|provider detail/i);
  return true;
}
