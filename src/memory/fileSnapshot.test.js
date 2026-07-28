import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { renderBrain } from "./brain.js";
import {
  appendActionReceiptToFileSnapshot,
  fileSnapshotPath,
  readFileSnapshot,
  refreshFileSnapshot,
  summarizeFileSnapshot
} from "./fileSnapshot.js";

test("client snapshots retain useful evidence, track changes, and never grant approval", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "wave-client-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { projectRoot: root, memoryRoot: root };
  const subjectKey = "contact-fixture";

  const first = refreshFileSnapshot(config, {
    subjectKey,
    file: {
      id: subjectKey,
      number: 2739,
      name: "Fixture Homeowner",
      status: "Ready for PA Review",
      carrier: "Fixture Insurance",
      policyNumber: "POLICY-1"
    },
    liveJobNimbus: {
      recentActivities: [{ id: "activity-1", dateCreated: "2026-07-16T12:00:00Z", type: "Note", note: "Claim filing research completed." }],
      openTasks: [{ id: "task-1", title: "File claim", dueDate: "2026-07-17T14:00:00Z" }],
      operationalDocuments: [{ id: "document-1", name: "Policy.pdf", type: "Document" }],
      excludedPhotoLikeDocumentCount: 120,
      assistantRead: { missingInfo: ["claim number"] }
    },
    gmail: {
      status: "fresh",
      query: "fixture query",
      messages: [{ id: "gmail-1", date: "2026-07-16", from: "carrier@example.test", subject: "Claim status", snippet: "Adjuster assignment pending." }],
      threads: []
    },
    quo: {
      status: "fresh",
      timeline: [{ id: "quo-1", at: "2026-07-16T13:00:00Z", direction: "incoming", text: "Please call about the inspection." }],
      transcripts: []
    },
    sourceStatus: {
      jobNimbus: { status: "fresh", at: "2026-07-16T14:00:00Z" },
      gmail: { status: "fresh", at: "2026-07-16T14:00:00Z" },
      quo: { status: "fresh", at: "2026-07-16T14:00:00Z" }
    },
    factualSignals: { openTaskCount: 1 },
    actionReceipts: []
  });

  assert.equal(first.authority.doesNotAuthorizeActions, true);
  assert.equal(first.communications.gmail.evidence.messages[0].id, "gmail-1");
  assert.equal(first.communications.quo.evidence.timeline[0].id, "quo-1");

  const second = refreshFileSnapshot(config, {
    subjectKey,
    file: { ...first.file, status: "Submitted Awaiting Confirmation", claimNumber: "CLAIM-1" },
    liveJobNimbus: {
      recentActivities: [{ id: "activity-2", dateCreated: "2026-07-16T15:00:00Z", type: "Status", note: "Claim filed." }],
      openTasks: [],
      operationalDocuments: first.jobNimbus.operationalDocuments,
      excludedPhotoLikeDocumentCount: 120,
      assistantRead: { missingInfo: ["adjuster contact"] }
    },
    gmail: { status: "not_requested", messages: [], threads: [] },
    quo: { status: "unavailable", error: "fixture outage", timeline: [], transcripts: [] },
    sourceStatus: {
      jobNimbus: { status: "fresh", at: "2026-07-16T15:00:00Z" },
      gmail: { status: "not_requested", at: "2026-07-16T15:00:00Z" },
      quo: { status: "unavailable", at: "2026-07-16T15:00:00Z" }
    },
    factualSignals: { openTaskCount: 0 },
    actionReceipts: []
  });

  assert.equal(second.communications.gmail.retainedFromPriorSuccessfulReview, true);
  assert.equal(second.communications.gmail.evidence.messages[0].id, "gmail-1");
  assert.equal(second.communications.quo.retainedFromPriorSuccessfulReview, true);
  assert.equal(second.communications.quo.evidence.timeline[0].id, "quo-1");
  assert.equal(second.continuity.changesSincePrevious.some((change) => change.field === "status"), true);
  assert.equal(second.continuity.changesSincePrevious.some((change) => change.field === "claimNumber"), true);

  const receipt = {
    id: "act-1",
    at: "2026-07-16T15:05:00Z",
    channel: "jobnimbus",
    action: "update_contact",
    status: "executed",
    subjectKey,
    summary: "Updated the approved claim number.",
    followUps: ["Confirm carrier adjuster assignment."]
  };
  appendActionReceiptToFileSnapshot(config, receipt);
  appendActionReceiptToFileSnapshot(config, receipt);
  const persisted = readFileSnapshot(config, subjectKey);
  assert.equal(persisted.actionReceipts.filter((item) => item.id === "act-1").length, 1);
  assert.deepEqual(persisted.continuity.openFollowUps, ["Confirm carrier adjuster assignment."]);

  const summary = summarizeFileSnapshot(persisted);
  assert.equal(summary.file.claimNumber, "CLAIM-1");
  assert.equal(summary.communications.gmail.latestItems[0].subject, "Claim status");
  assert.equal(summary.authority.explicitApprovalStillRequired, true);

  const subjectBrain = renderBrain(config, { clientLane: "subject", subjectKey, includeEpisodes: true });
  assert.match(subjectBrain, /CURRENT CLIENT SNAPSHOT/);
  assert.match(subjectBrain, /CLAIM-1/);
  assert.match(subjectBrain, /never authorize/i);
  const companyBrain = renderBrain(config, { clientLane: "none" });
  assert.doesNotMatch(companyBrain, /CURRENT CLIENT SNAPSHOT/);
});

test("read-only snapshot inspection never renames corrupt legacy data", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "wave-client-snapshot-read-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { projectRoot: root, memoryRoot: root };
  const subjectKey = "corrupt-fixture";
  const file = fileSnapshotPath(config, subjectKey);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{not-valid-json", { encoding: "utf8", mode: 0o600 });

  assert.equal(
    readFileSnapshot(config, subjectKey, { quarantineCorrupt: false }),
    null
  );
  const names = await readdir(path.dirname(file));
  assert.equal(names.includes(path.basename(file)), true);
  assert.equal(names.some((name) => name.startsWith(`${path.basename(file)}.corrupt-`)), false);
});
