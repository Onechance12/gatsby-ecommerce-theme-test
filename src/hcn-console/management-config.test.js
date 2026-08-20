import assert from "node:assert/strict";
import test from "node:test";

import {
  HCN_MANAGEMENT_ADJUSTER_SCHEMA,
  loadHcnManagementAdjusterConfiguration
} from "./management-config.js";

const VALID = [
  { ownerId: "owner_chance", displayName: "Chance Pearson" },
  { ownerId: "owner_second", displayName: "Second Adjuster" },
  { ownerId: "owner_third", displayName: "Third Adjuster" }
];

test("management sweep stays unavailable until the exact allowlist is configured", () => {
  const result = loadHcnManagementAdjusterConfiguration("");
  assert.deepEqual(result, {
    schema: HCN_MANAGEMENT_ADJUSTER_SCHEMA,
    ready: false,
    reason: "not_configured",
    adjusters: []
  });
  assert(Object.isFrozen(result));
});

test("management adjuster configuration accepts exactly three unique owners", () => {
  const result = loadHcnManagementAdjusterConfiguration(JSON.stringify(VALID));
  assert.equal(result.ready, true);
  assert.deepEqual(result.adjusters, VALID);
  assert(Object.isFrozen(result.adjusters));
  assert(Object.isFrozen(result.adjusters[0]));
});

test("management adjuster configuration trims safe employee display metadata", () => {
  const input = structuredClone(VALID);
  input[0].ownerId = "  owner_chance  ";
  input[0].displayName = "  Chance   Pearson  ";
  const result = loadHcnManagementAdjusterConfiguration(JSON.stringify(input));
  assert.equal(result.adjusters[0].ownerId, "owner_chance");
  assert.equal(result.adjusters[0].displayName, "Chance Pearson");
});

for (const [label, input] of [
  ["malformed JSON", "{"],
  ["wrong adjuster count", JSON.stringify(VALID.slice(0, 2))],
  [
    "duplicate owners",
    JSON.stringify([VALID[0], VALID[0], VALID[2]])
  ],
  [
    "duplicate names",
    JSON.stringify([
      VALID[0],
      { ...VALID[1], displayName: "chance pearson" },
      VALID[2]
    ])
  ],
  [
    "unknown fields",
    JSON.stringify([
      { ...VALID[0], token: "forbidden" },
      VALID[1],
      VALID[2]
    ])
  ],
  [
    "unsafe owner id",
    JSON.stringify([
      { ...VALID[0], ownerId: "owner id" },
      VALID[1],
      VALID[2]
    ])
  ],
  [
    "control characters",
    JSON.stringify([
      { ...VALID[0], displayName: "Chance\nPearson" },
      VALID[1],
      VALID[2]
    ])
  ]
]) {
  test(`management adjuster configuration rejects ${label}`, () => {
    assert.throws(
      () => loadHcnManagementAdjusterConfiguration(input),
      /HCN.management|management adjuster|HCN_MANAGEMENT_ADJUSTERS_JSON/i
    );
  });
}
