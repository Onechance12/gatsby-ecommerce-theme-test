import assert from "node:assert/strict";
import test from "node:test";

import {
  JobNimbusUserDirectoryError,
  loadCompleteJobNimbusUsers,
  resolveUniqueActiveJobNimbusUser
} from "./user-directory.js";

test("short pages continue by actual offset until an empty page proves completion", async () => {
  const offsets = [];
  const users = await loadCompleteJobNimbusUsers({
    pageSize: 1000,
    fetchPage: async ({ offset }) => {
      offsets.push(offset);
      if (offset === 0) {
        return {
          users: [
            { jnid: "user-1", email: "one@wavepa.com" },
            { jnid: "user-2", email: "two@wavepa.com" }
          ]
        };
      }
      return { users: [] };
    }
  });
  assert.deepEqual(offsets, [0, 2]);
  assert.equal(users.length, 2);
});

test("a clamped provider page cannot hide a duplicate active employee", async () => {
  const pages = new Map([
    [0, {
      users: [{
        jnid: "employee-first",
        email: "adjuster@wavepa.com",
        is_active: true
      }]
    }],
    [1, {
      users: [{
        jnid: "employee-duplicate",
        email: "adjuster@wavepa.com",
        is_active: true
      }]
    }],
    [2, { users: [] }]
  ]);
  const users = await loadCompleteJobNimbusUsers({
    pageSize: 1000,
    fetchPage: async ({ offset }) => pages.get(offset)
  });
  assert.equal(users.length, 2);
  assert.equal(
    resolveUniqueActiveJobNimbusUser(
      users,
      "adjuster@wavepa.com"
    ),
    null
  );
  assert.equal(
    resolveUniqueActiveJobNimbusUser(
      [{
        jnid: "missing-active-truth",
        email: "adjuster@wavepa.com"
      }],
      "adjuster@wavepa.com"
    ),
    null
  );
  assert.equal(
    resolveUniqueActiveJobNimbusUser(
      [{
        jnid: "inactive-label",
        email: "adjuster@wavepa.com",
        enabled: true,
        status: "Inactive"
      }],
      "adjuster@wavepa.com"
    ),
    null
  );
});

test("an authoritative total may prove completion without an extra empty page", async () => {
  const offsets = [];
  const users = await loadCompleteJobNimbusUsers({
    fetchPage: async ({ offset }) => {
      offsets.push(offset);
      return {
        total: 2,
        users: [
          { jnid: "user-1", email: "one@wavepa.com" },
          { jnid: "user-2", email: "two@wavepa.com" }
        ]
      };
    }
  });
  assert.deepEqual(offsets, [0]);
  assert.equal(users.length, 2);
});

test("repeated ids, changing totals, and unproven bounds fail closed", async () => {
  await assert.rejects(
    loadCompleteJobNimbusUsers({
      pageSize: 1,
      fetchPage: async () => ({
        users: [{ jnid: "same-user", email: "one@wavepa.com" }]
      })
    }),
    JobNimbusUserDirectoryError
  );
  await assert.rejects(
    loadCompleteJobNimbusUsers({
      pageSize: 1,
      fetchPage: async ({ offset }) =>
        offset === 0
          ? {
              total: 3,
              users: [{ jnid: "user-1", email: "one@wavepa.com" }]
            }
          : {
              total: 2,
              users: [{ jnid: "user-2", email: "two@wavepa.com" }]
            }
    }),
    /total changed/
  );
  await assert.rejects(
    loadCompleteJobNimbusUsers({
      pageSize: 1,
      maxPages: 1,
      fetchPage: async () => ({
        users: [{ jnid: "user-1", email: "one@wavepa.com" }]
      })
    }),
    /completeness could not be proven/
  );
});

test("only one active exact-email account resolves", () => {
  assert.deepEqual(
    resolveUniqueActiveJobNimbusUser(
      [{
        jnid: "active-user",
        email: "ADJUSTER@WAVEPA.COM",
        display_name: "Adjuster",
        is_active: true
      }],
      "adjuster@wavepa.com"
    ),
    { id: "active-user", name: "Adjuster" }
  );
  assert.equal(
    resolveUniqueActiveJobNimbusUser(
      [{
        jnid: "inactive-user",
        email: "adjuster@wavepa.com",
        is_active: false
      }],
      "adjuster@wavepa.com"
    ),
    null
  );
});
