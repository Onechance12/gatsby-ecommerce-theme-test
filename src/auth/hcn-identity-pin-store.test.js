import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHcnIdentityPinStore } from "./hcn-identity-pin-store.js";

async function fixture(t, options = {}) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "hcn-identity-pins-")
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const filePath = path.join(root, "pins.json");
  const key = options.key || randomBytes(48);
  return {
    filePath,
    key,
    store: createHcnIdentityPinStore({
      filePath,
      key,
      allowedDomain:
        Object.hasOwn(options, "allowedDomain")
          ? options.allowedDomain
          : "wavepa.com",
      now: options.now || (() => Date.parse("2026-07-29T12:00:00.000Z"))
    })
  };
}

function chance(overrides = {}) {
  return {
    email: "cpearson@wavepa.com",
    displayName: "Chance Pearson",
    googleSubject: "google-subject-chance",
    jobNimbusOwnerId: "fc95a213f70e4c9daddc5fa366be9941",
    jobNimbusScope: "assigned",
    role: "chance",
    source: "explicit_first_use",
    ...overrides
  };
}

test("pins and reloads one authenticated immutable identity", async (t) => {
  const { store, filePath, key } = await fixture(t);
  const pinned = await store.pin(chance());
  assert.equal(pinned.pinnedAt, "2026-07-29T12:00:00.000Z");
  assert.deepEqual(await store.get("cpearson@wavepa.com"), pinned);

  const reloaded = createHcnIdentityPinStore({ filePath, key });
  assert.deepEqual(await reloaded.list(), [pinned]);
  assert.deepEqual(reloaded.status(), {
    configured: true,
    schemaVersion: "hcn.identity-pins.v1"
  });
});

test("the exact same binding is idempotent", async (t) => {
  const { store } = await fixture(t);
  const first = await store.pin(chance());
  const second = await store.pin(chance({
    displayName: "Chance P."
  }));
  assert.deepEqual(second, first);
  assert.equal((await store.list()).length, 1);
});

test("subject, role, owner, scope, and source rebinding are denied", async (t) => {
  const { store } = await fixture(t);
  await store.pin(chance());
  for (const override of [
    { googleSubject: "different-subject" },
    { role: "manager" },
    { jobNimbusOwnerId: "different-owner" },
    { jobNimbusScope: "company" },
    { source: "employee_auto_enroll", role: "employee" }
  ]) {
    await assert.rejects(
      () => store.pin(chance(override)),
      (error) =>
        ["identity_rebinding_denied", "invalid_identity_pin"]
          .includes(error.code)
    );
  }
});

test("auto-enrollment can only create assigned employees", async (t) => {
  const { store } = await fixture(t);
  const employee = await store.pin(chance({
    email: "worker@wavepa.com",
    displayName: "Worker",
    googleSubject: "worker-subject",
    jobNimbusOwnerId: "worker-owner",
    role: "employee",
    source: "employee_auto_enroll"
  }));
  assert.equal(employee.role, "employee");
  await assert.rejects(
    () => store.pin(chance({
      email: "manager@wavepa.com",
      displayName: "Manager",
      googleSubject: "manager-subject",
      jobNimbusOwnerId: "manager-owner",
      role: "manager",
      source: "employee_auto_enroll"
    })),
    { code: "invalid_identity_pin" }
  );
});

test("wrong-domain and noncanonical email are rejected", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(
    () => store.pin(chance({ email: "chance@example.com" })),
    { code: "invalid_identity_pin" }
  );
  await assert.rejects(
    () => store.pin(chance({ email: " Chance@wavepa.com " })),
    { code: "invalid_identity_pin" }
  );
});

test("an unrestricted store pins another active JobNimbus email domain", async (t) => {
  const { store } = await fixture(t, { allowedDomain: "" });
  const pinned = await store.pin(chance({
    email: "richard@titanrecon.com",
    displayName: "Richard",
    googleSubject: "richard-subject",
    jobNimbusOwnerId: "richard-owner",
    role: "manager"
  }));
  assert.equal(pinned.email, "richard@titanrecon.com");
});

test("tampering and a wrong key fail closed", async (t) => {
  const { store, filePath } = await fixture(t);
  await store.pin(chance());
  const envelope = JSON.parse(await readFile(filePath, "utf8"));
  envelope.records[0].role = "manager";
  await writeFile(filePath, JSON.stringify(envelope), "utf8");
  await assert.rejects(
    () => store.list(),
    { code: "identity_store_corrupt" }
  );

  const wrongKeyStore = createHcnIdentityPinStore({
    filePath,
    key: randomBytes(48)
  });
  await assert.rejects(
    () => wrongKeyStore.list(),
    { code: "identity_store_corrupt" }
  );
});

test("concurrent first-use pins serialize without dropping records", async (t) => {
  const { store } = await fixture(t);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.pin({
        email: `employee${index}@wavepa.com`,
        displayName: `Employee ${index}`,
        googleSubject: `subject-${index}`,
        jobNimbusOwnerId: `owner-${index}`,
        jobNimbusScope: "assigned",
        role: "employee",
        source: "employee_auto_enroll"
      })
    )
  );
  const rows = await store.list();
  assert.equal(rows.length, 20);
  assert.deepEqual(
    rows.map((row) => row.email),
    [...rows.map((row) => row.email)].sort((left, right) =>
      left.localeCompare(right)
    )
  );
});
