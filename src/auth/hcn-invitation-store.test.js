import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHcnInvitationStore,
  hcnInvitationPublicRecord
} from "./hcn-invitation-store.js";

const KEY = "k".repeat(64);
const ACTOR = `principal_${"a".repeat(64)}`;
const START = Date.parse("2026-07-30T12:00:00.000Z");

test("invitation store encrypts employee admission data and returns token only once", async (t) => {
  const fixture = await createFixture(t);
  const created = await fixture.store.createInvitation(
    invitation({
      email: "richard@example.com",
      displayName: "Richard",
      owner: "jn-owner-richard"
    })
  );

  assert.match(created.invitationRef, /^invite_[a-f0-9]{32}$/);
  assert.match(created.inviteToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.keys(created).includes("inviteToken"), false);
  assert.equal(JSON.stringify(created).includes(created.inviteToken), false);
  const raw = await readFile(fixture.filePath, "utf8");
  assert.doesNotMatch(raw, /richard@example\.com/i);
  assert.doesNotMatch(raw, /Richard/);
  assert.doesNotMatch(raw, /jn-owner-richard/);
  assert.doesNotMatch(raw, new RegExp(created.inviteToken));

  const listed = await fixture.store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].state, "pending");
  assert.equal(Object.hasOwn(listed[0], "inviteToken"), false);
  assert.deepEqual(
    hcnInvitationPublicRecord(listed[0]),
    {
      invitationRef: created.invitationRef,
      email: "richard@example.com",
      displayName: "Richard",
      role: "employee",
      jobNimbusScope: "assigned",
      state: "pending",
      invitedAt: "2026-07-30T12:00:00.000Z",
      expiresAt: "2026-08-02T12:00:00.000Z",
      acceptedAt: "",
      revokedAt: ""
    }
  );
});

test("exact token and email atomically consume an invitation once", async (t) => {
  const fixture = await createFixture(t);
  const created = await fixture.store.createInvitation(
    invitation({
      email: "adjuster@other-domain.example",
      displayName: "Adjuster",
      owner: "jn-owner-adjuster"
    })
  );
  assert.equal(
    (await fixture.store.validateInviteToken({
      invitationRef: created.invitationRef,
      inviteToken: created.inviteToken
    }))?.email,
    "adjuster@other-domain.example"
  );
  assert.equal(
    await fixture.store.validateInviteToken({
      invitationRef: created.invitationRef,
      inviteToken: "A".repeat(43)
    }),
    null
  );

  const accepted = await fixture.store.acceptInvitation({
    invitationRef: created.invitationRef,
    email: "adjuster@other-domain.example",
    googleSubject: "google-subject-adjuster",
    inviteToken: created.inviteToken
  });
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.googleSubject, "google-subject-adjuster");
  assert.equal(
    await fixture.store.validateInviteToken({
      invitationRef: created.invitationRef,
      inviteToken: created.inviteToken
    }),
    null
  );
  await assert.rejects(
    fixture.store.acceptInvitation({
      invitationRef: created.invitationRef,
      email: "adjuster@other-domain.example",
      googleSubject: "google-subject-adjuster",
      inviteToken: created.inviteToken
    }),
    (error) =>
      error.code === "invitation_already_consumed"
      && error.statusCode === 409
  );
});

test("wrong email, wrong token, expiry, and non-assigned authority fail closed", async (t) => {
  const fixture = await createFixture(t);
  const created = await fixture.store.createInvitation(
    invitation({
      email: "employee@example.com",
      displayName: "Employee",
      owner: "jn-owner-employee"
    })
  );
  await assert.rejects(
    fixture.store.acceptInvitation({
      invitationRef: created.invitationRef,
      email: "wrong@example.com",
      googleSubject: "google-subject",
      inviteToken: created.inviteToken
    }),
    (error) => error.code === "invitation_not_found"
  );
  await assert.rejects(
    fixture.store.acceptInvitation({
      invitationRef: created.invitationRef,
      email: "employee@example.com",
      googleSubject: "google-subject",
      inviteToken: "B".repeat(43)
    }),
    (error) => error.code === "invalid_invitation_token"
  );
  fixture.advance(72 * 60 * 60_000);
  assert.equal((await fixture.store.list())[0].state, "expired");
  await assert.rejects(
    fixture.store.acceptInvitation({
      invitationRef: created.invitationRef,
      email: "employee@example.com",
      googleSubject: "google-subject",
      inviteToken: created.inviteToken
    }),
    (error) => error.code === "invitation_not_active"
  );
  await assert.rejects(
    fixture.store.createInvitation({
      ...invitation({
        email: "other@example.com",
        displayName: "Other",
        owner: "jn-owner-other"
      }),
      jobNimbusScope: "company"
    }),
    (error) => error.code === "invalid_invitation"
  );
});

test("active email, JobNimbus owner, and Google subject are globally unique", async (t) => {
  const fixture = await createFixture(t);
  const first = await fixture.store.createInvitation(
    invitation({
      email: "one@example.com",
      displayName: "One",
      owner: "jn-owner-one"
    })
  );
  await assert.rejects(
    fixture.store.createInvitation(
      invitation({
        email: "two@example.com",
        displayName: "Two",
        owner: "jn-owner-one"
      })
    ),
    (error) => error.code === "jobnimbus_owner_already_authorized"
  );
  await fixture.store.acceptInvitation({
    invitationRef: first.invitationRef,
    email: "one@example.com",
    googleSubject: "shared-google-subject",
    inviteToken: first.inviteToken
  });
  const second = await fixture.store.createInvitation(
    invitation({
      email: "two@example.com",
      displayName: "Two",
      owner: "jn-owner-two"
    })
  );
  await assert.rejects(
    fixture.store.acceptInvitation({
      invitationRef: second.invitationRef,
      email: "two@example.com",
      googleSubject: "shared-google-subject",
      inviteToken: second.inviteToken
    }),
    (error) => error.code === "employee_authorization_conflict"
  );
});

test("revocation is durable and authenticated ciphertext tampering fails closed", async (t) => {
  const fixture = await createFixture(t);
  const created = await fixture.store.createInvitation(
    invitation({
      email: "manager@example.com",
      displayName: "Manager",
      owner: "jn-owner-manager",
      role: "manager"
    })
  );
  const revoked = await fixture.store.revokeInvitation({
    invitationRef: created.invitationRef,
    revokedByRef: ACTOR
  });
  assert.equal(revoked.state, "revoked");
  assert.equal(
    await fixture.store.getAuthorizationByEmail(
      "manager@example.com"
    ),
    null
  );

  const envelope = JSON.parse(
    await readFile(fixture.filePath, "utf8")
  );
  envelope.ciphertext =
    `${envelope.ciphertext.slice(0, -1)}${
      envelope.ciphertext.endsWith("A") ? "B" : "A"
    }`;
  await writeFile(
    fixture.filePath,
    `${JSON.stringify(envelope)}\n`,
    "utf8"
  );
  await assert.rejects(
    fixture.store.list(),
    (error) =>
      error.code === "invitation_store_corrupt"
      && error.statusCode === 503
  );
});

test("invitation lifetime is capped at 72 hours and unsupported roles are denied", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    fixture.store.createInvitation({
      ...invitation({
        email: "chance@example.com",
        displayName: "Chance",
        owner: "jn-owner-chance",
        role: "employee"
      }),
      expiresAt: new Date(
        START + 72 * 60 * 60_000 + 1
      ).toISOString()
    }),
    (error) => error.code === "invalid_invitation"
  );
  await assert.rejects(
    fixture.store.createInvitation(
      invitation({
        email: "admin@example.com",
        displayName: "Admin",
        owner: "jn-owner-admin",
        role: "administrator"
      })
    ),
    (error) => error.code === "invalid_invitation"
  );
});

function invitation({
  email,
  displayName,
  owner,
  role = "employee"
}) {
  return {
    email,
    displayName,
    role,
    jobNimbusOwnerId: owner,
    jobNimbusScope: "assigned",
    invitedByRef: ACTOR,
    expiresAt: new Date(
      START + 72 * 60 * 60_000
    ).toISOString()
  };
}

async function createFixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "hcn-invitations-")
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = START;
  const filePath = path.join(root, "invitations.enc.json");
  const store = createHcnInvitationStore({
    filePath,
    key: KEY,
    allowedDomain: "",
    now: () => now
  });
  return {
    filePath,
    store,
    advance(milliseconds) {
      now += milliseconds;
    }
  };
}
