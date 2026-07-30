import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANAGEMENT_SWEEP_SCHEMA_VERSION,
  ManagementSweepContractError,
  buildManagementSweep,
} from './core.js';

const NOW = '2026-07-29T18:00:00.000Z';
const DAY = 86_400_000;
const ADJUSTER_A = `adjuster_${'a'.repeat(16)}`;
const ADJUSTER_B = `adjuster_${'b'.repeat(16)}`;
const ADJUSTER_C = `adjuster_${'c'.repeat(16)}`;
const ADJUSTER_OUTSIDE = `adjuster_${'d'.repeat(16)}`;

function isoDaysAgo(days, hours = 0) {
  return new Date(
    Date.parse(NOW) - days * DAY - hours * 3_600_000,
  ).toISOString();
}

function fileRef(number) {
  return `subject_${number.toString(16).padStart(32, '0')}`;
}

function evidenceRef(number) {
  return `ref_${number.toString(16).padStart(32, '0')}`;
}

function source(
  name,
  {
    status = 'fresh',
    completeness = 'complete',
    asOf = isoDaysAgo(0, 1),
    checkedAt = isoDaysAgo(0, 0.5),
    validUntil = new Date(Date.parse(NOW) + 3_600_000).toISOString(),
  } = {},
) {
  if (status === 'unavailable' || status === 'unknown') {
    return {
      source: name,
      status,
      completeness: 'none',
      asOf: null,
      checkedAt,
      validUntil: null,
    };
  }
  return {
    source: name,
    status,
    completeness,
    asOf,
    checkedAt,
    validUntil,
  };
}

function event(
  number,
  eventCode,
  occurredAt,
  { source: eventSource = 'jobnimbus', actorRef = null } = {},
) {
  return {
    reference: evidenceRef(number),
    source: eventSource,
    eventCode,
    occurredAt,
    actorRef,
  };
}

function exactFile(
  number,
  {
    status = 'active',
    assignedAdjusterRef = ADJUSTER_A,
    activeSince = isoDaysAgo(60),
    sources = [source('jobnimbus'), source('gmail'), source('quo')],
    events = [],
  } = {},
) {
  return {
    fileRef: fileRef(number),
    status,
    assignedAdjusterRef,
    activeSince,
    sources,
    events,
  };
}

function input(files, overrides = {}) {
  return {
    generatedAt: NOW,
    adjusters: [
      { adjusterRef: ADJUSTER_A },
      { adjusterRef: ADJUSTER_B },
      { adjusterRef: ADJUSTER_C },
    ],
    requiredSources: ['jobnimbus', 'gmail', 'quo'],
    files,
    limitPerAdjuster: 10,
    rankingMode: 'full_management',
    ...overrides,
  };
}

function findItem(result, ref) {
  return result.adjusters
    .flatMap((group) => group.items)
    .find((item) => item.fileRef === ref);
}

test('classifies verified communication, attempts, operations, adjuster work, and noise separately', () => {
  const file = exactFile(1, {
    activeSince: isoDaysAgo(40),
    events: [
      event(1, 'email_sent_verified', isoDaysAgo(12), {
        source: 'gmail',
        actorRef: ADJUSTER_A,
      }),
      event(2, 'call_no_answer', isoDaysAgo(8), {
        source: 'quo',
        actorRef: ADJUSTER_A,
      }),
      event(3, 'document_reviewed', isoDaysAgo(5), {
        actorRef: `actor_${'e'.repeat(16)}`,
      }),
      event(4, 'task_completed', isoDaysAgo(4), {
        actorRef: ADJUSTER_A,
      }),
      event(5, 'email_draft', isoDaysAgo(1), {
        source: 'gmail',
        actorRef: ADJUSTER_A,
      }),
      event(6, 'note_cosmetic', isoDaysAgo(0, 3), {
        actorRef: ADJUSTER_A,
      }),
      event(7, 'system_sync', isoDaysAgo(0, 1)),
    ],
  });

  const result = buildManagementSweep(input([file]));
  const item = findItem(result, file.fileRef);

  assert.equal(item.gaps.successfulCommunication.days, 12);
  assert.equal(
    item.gaps.successfulCommunication.lastEvidenceRef,
    evidenceRef(1),
  );
  assert.equal(item.gaps.contactAttempt.days, 8);
  assert.equal(item.gaps.operationalActivity.days, 4);
  assert.equal(item.gaps.assignedAdjusterActivity.days, 4);
  assert.equal(item.gaps.anyMeaningfulTouch.days, 4);
  assert.equal(item.eventSummary.successfulCommunicationCount, 1);
  assert.equal(item.eventSummary.contactAttemptCount, 2);
  assert.equal(item.eventSummary.operationalActivityCount, 2);
  assert.equal(item.eventSummary.assignedAdjusterActivityCount, 3);
  assert.equal(item.eventSummary.noiseCount, 3);
  assert.deepEqual(item.attention.reasonCodes, ['communication_gap']);
});

test('drafts, unverified outbound email, cosmetic changes, and system events never reset gaps', () => {
  const file = exactFile(2, {
    activeSince: isoDaysAgo(30),
    events: [
      event(10, 'email_draft', isoDaysAgo(1), {
        source: 'gmail',
        actorRef: ADJUSTER_A,
      }),
      event(11, 'email_outbound_unverified', isoDaysAgo(2), {
        source: 'gmail',
        actorRef: ADJUSTER_A,
      }),
      event(12, 'status_cosmetic', isoDaysAgo(1), {
        actorRef: ADJUSTER_A,
      }),
      event(13, 'task_reassigned', isoDaysAgo(1), {
        actorRef: ADJUSTER_A,
      }),
      event(14, 'note_automated', isoDaysAgo(0, 1)),
      event(15, 'file_opened', isoDaysAgo(0, 1), {
        actorRef: ADJUSTER_A,
      }),
    ],
  });

  const item = findItem(buildManagementSweep(input([file])), file.fileRef);

  assert.equal(item.gaps.successfulCommunication.days, 30);
  assert.equal(item.gaps.successfulCommunication.basis, 'active_since');
  assert.equal(item.gaps.contactAttempt.days, 30);
  assert.equal(item.gaps.operationalActivity.days, 30);
  assert.equal(item.gaps.assignedAdjusterActivity.days, 30);
  assert.equal(item.eventSummary.noiseCount, 6);
});

test('company and per-adjuster rankings return ten with deterministic tie breaks', () => {
  const files = [];
  let number = 100;
  for (const adjusterRef of [ADJUSTER_A, ADJUSTER_B, ADJUSTER_C]) {
    for (let age = 1; age <= 12; age += 1) {
      files.push(
        exactFile(number, {
          assignedAdjusterRef: adjusterRef,
          activeSince: isoDaysAgo(90),
          events: [
            event(number, 'note_substantive', isoDaysAgo(age), {
              actorRef: adjusterRef,
            }),
            event(number + 1_000, 'email_received', isoDaysAgo(age), {
              source: 'gmail',
            }),
          ],
        }),
      );
      number += 1;
    }
  }

  const result = buildManagementSweep(input(files));

  assert.equal(result.adjusters.length, 3);
  for (const group of result.adjusters) {
    assert.equal(group.eligibleCount, 12);
    assert.equal(group.returnedCount, 10);
    assert.equal(group.shortage.isShort, false);
    assert.deepEqual(
      group.items.map((item) => item.attention.unresolvedGapDays),
      [12, 11, 10, 9, 8, 7, 6, 5, 4, 3],
    );
  }
  assert.equal(result.companyWorst.length, 10);
  assert.deepEqual(
    result.companyWorst.slice(0, 3).map((item) => item.assignedAdjusterRef),
    [ADJUSTER_A, ADJUSTER_B, ADJUSTER_C],
  );
  assert.deepEqual(
    result.companyWorst.slice(0, 3).map((item) => item.companyRank),
    [1, 2, 3],
  );
});

test('input file and event order do not affect output', () => {
  const first = exactFile(300, {
    assignedAdjusterRef: ADJUSTER_B,
    events: [
      event(300, 'task_completed', isoDaysAgo(5), {
        actorRef: ADJUSTER_B,
      }),
      event(301, 'call_answered', isoDaysAgo(8), {
        source: 'quo',
        actorRef: ADJUSTER_B,
      }),
    ],
  });
  const second = exactFile(301, {
    assignedAdjusterRef: ADJUSTER_A,
    events: [
      event(302, 'email_received', isoDaysAgo(20), {
        source: 'gmail',
      }),
      event(303, 'note_substantive', isoDaysAgo(4), {
        actorRef: ADJUSTER_A,
      }),
    ],
  });
  const ordered = buildManagementSweep(input([first, second]));
  const reversedFiles = buildManagementSweep(
    input([
      { ...second, events: [...second.events].reverse() },
      { ...first, events: [...first.events].reverse() },
    ]),
  );

  assert.deepEqual(reversedFiles, ordered);
});

test('excludes inactive and unconfigured-owner files and explains shortages', () => {
  const eligible = exactFile(400, {
    assignedAdjusterRef: ADJUSTER_A,
  });
  const inactive = exactFile(401, {
    status: 'inactive',
    assignedAdjusterRef: ADJUSTER_A,
  });
  const outside = exactFile(402, {
    assignedAdjusterRef: ADJUSTER_OUTSIDE,
  });

  const result = buildManagementSweep(input([outside, eligible, inactive]));

  assert.equal(result.summary.inputFileCount, 3);
  assert.equal(result.summary.eligibleFileCount, 1);
  assert.equal(result.summary.exclusionCount, 2);
  assert.deepEqual(
    result.exclusions.map((entry) => entry.reasonCode),
    ['inactive_file', 'unconfigured_adjuster'],
  );
  assert.deepEqual(result.adjusters[0].shortage, {
    isShort: true,
    missingCount: 9,
    reasonCode: 'fewer_eligible_files',
  });
  assert.deepEqual(result.adjusters[1].shortage, {
    isShort: true,
    missingCount: 10,
    reasonCode: 'fewer_eligible_files',
  });
});

test('stale and unavailable evidence cannot reset a gap and health is explicit', () => {
  const staleFile = exactFile(500, {
    sources: [
      source('jobnimbus'),
      source('gmail', {
        status: 'fresh',
        validUntil: isoDaysAgo(0, 0.25),
      }),
      source('quo', { status: 'unavailable' }),
    ],
    events: [
      event(500, 'note_substantive', isoDaysAgo(9), {
        actorRef: ADJUSTER_A,
      }),
      event(501, 'email_received', isoDaysAgo(1), {
        source: 'gmail',
      }),
    ],
  });
  const unavailableFile = exactFile(501, {
    sources: [
      source('jobnimbus', { status: 'unavailable' }),
      source('gmail', { status: 'unknown' }),
      source('quo', { status: 'unavailable' }),
    ],
    events: [],
  });

  const result = buildManagementSweep(input([staleFile, unavailableFile]));
  const staleItem = findItem(result, staleFile.fileRef);
  const unavailableItem = findItem(result, unavailableFile.fileRef);

  assert.equal(staleItem.gaps.successfulCommunication.days, 60);
  assert.equal(staleItem.eventSummary.ignoredUnfreshEventCount, 1);
  assert.equal(staleItem.evidenceHealth.status, 'partial');
  assert.equal(staleItem.evidenceHealth.freshness, 'mixed');
  assert.deepEqual(staleItem.evidenceHealth.staleSources, ['gmail']);
  assert.deepEqual(staleItem.evidenceHealth.unavailableSources, ['quo']);

  assert.equal(unavailableItem.evidenceHealth.status, 'insufficient');
  assert.equal(unavailableItem.evidenceHealth.completeness, 'none');
  assert.equal(result.summary.evidence.partialFiles, 1);
  assert.equal(result.summary.evidence.insufficientFiles, 1);
  assert.equal(
    staleItem.attention.reasonCodes.includes('evidence_incomplete'),
    true,
  );
});

test('partial-but-fresh evidence contributes events without claiming completeness', () => {
  const file = exactFile(600, {
    sources: [
      source('jobnimbus'),
      source('gmail', { completeness: 'partial' }),
      source('quo'),
    ],
    events: [
      event(600, 'email_received', isoDaysAgo(2), {
        source: 'gmail',
      }),
    ],
  });

  const item = findItem(buildManagementSweep(input([file])), file.fileRef);

  assert.equal(item.gaps.successfulCommunication.days, 2);
  assert.equal(item.evidenceHealth.status, 'partial');
  assert.deepEqual(item.evidenceHealth.partialSources, ['gmail']);
});

test('a team touch does not conceal assigned-adjuster inactivity', () => {
  const file = exactFile(700, {
    activeSince: isoDaysAgo(50),
    events: [
      event(700, 'call_completed', isoDaysAgo(1), {
        source: 'quo',
        actorRef: `actor_${'f'.repeat(16)}`,
      }),
      event(701, 'note_substantive', isoDaysAgo(20), {
        actorRef: ADJUSTER_A,
      }),
    ],
  });

  const item = findItem(buildManagementSweep(input([file])), file.fileRef);

  assert.equal(item.gaps.successfulCommunication.days, 1);
  assert.equal(item.gaps.anyMeaningfulTouch.days, 1);
  assert.equal(item.gaps.assignedAdjusterActivity.days, 20);
  assert.equal(item.attention.unresolvedGapDays, 20);
  assert.deepEqual(item.attention.reasonCodes, [
    'assigned_adjuster_gap',
    'operational_gap',
  ]);
});

test('activity-only v1 ranks verified JobNimbus progress and marks unsupported metrics unavailable', () => {
  const olderActivity = exactFile(750, {
    activeSince: isoDaysAgo(60),
    sources: [source('jobnimbus')],
    events: [
      event(750, 'note_substantive', isoDaysAgo(20), {
        actorRef: ADJUSTER_A,
      }),
      event(751, 'task_completed', isoDaysAgo(1), {
        actorRef: ADJUSTER_A,
      }),
    ],
  });
  const newerActivity = exactFile(751, {
    activeSince: isoDaysAgo(60),
    sources: [source('jobnimbus')],
    events: [
      event(752, 'document_received', isoDaysAgo(5), {
        actorRef: `actor_${'9'.repeat(16)}`,
      }),
    ],
  });

  const result = buildManagementSweep(
    input([newerActivity, olderActivity], {
      requiredSources: ['jobnimbus'],
      rankingMode: 'activity_only',
    }),
  );

  assert.equal(result.criteria.rankingMode, 'activity_only');
  assert.deepEqual(
    result.adjusters[0].items.slice(0, 2).map((item) => item.fileRef),
    [olderActivity.fileRef, newerActivity.fileRef],
  );
  const item = findItem(result, olderActivity.fileRef);
  assert.equal(item.gaps.operationalActivity.days, 20);
  assert.equal(item.gaps.successfulCommunication.availability, 'not_evaluated');
  assert.equal(item.gaps.successfulCommunication.days, null);
  assert.equal(
    item.gaps.assignedAdjusterActivity.availability,
    'not_evaluated',
  );
  assert.equal(item.eventSummary.noiseCount, 1);
  assert.deepEqual(item.attention.reasonCodes, ['operational_gap']);
});

test('output is minimized, read-only, versioned, and deeply immutable', () => {
  const result = buildManagementSweep(input([exactFile(800)]));

  assert.equal(result.schemaVersion, MANAGEMENT_SWEEP_SCHEMA_VERSION);
  assert.deepEqual(result.authority, {
    mode: 'read_only',
    canWrite: false,
    canSend: false,
    canCall: false,
    canApprove: false,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.adjusters[0].items[0].gaps), true);
  assert.doesNotMatch(JSON.stringify(result), /jobNimbusFileId|provider/i);
});

test('rejects ambiguous or malformed normalized inputs', () => {
  const duplicate = exactFile(900);
  assert.throws(
    () => buildManagementSweep(input([duplicate, duplicate])),
    /duplicate file references/,
  );

  const duplicateEvent = event(901, 'note_substantive', isoDaysAgo(1));
  assert.throws(
    () =>
      buildManagementSweep(
        input([
          exactFile(901, {
            events: [duplicateEvent, duplicateEvent],
          }),
        ]),
      ),
    /duplicate references/,
  );

  assert.throws(
    () =>
      buildManagementSweep(
        input([
          exactFile(902, {
            events: [
              event(902, 'email_received', isoDaysAgo(1), {
                source: 'google_calendar',
              }),
            ],
          }),
        ]),
      ),
    /matching source state/,
  );

  assert.throws(
    () =>
      buildManagementSweep({
        ...input([]),
        requiredSources: ['gmail', 'gmail'],
      }),
    /cannot contain duplicates/,
  );

  assert.throws(
    () =>
      buildManagementSweep({
        ...input([]),
        adjusters: [{ adjusterRef: ADJUSTER_A }, { adjusterRef: ADJUSTER_A }],
      }),
    /duplicate identities/,
  );

  assert.throws(
    () =>
      buildManagementSweep(
        input([
          {
            ...exactFile(903),
            unexpectedField: true,
          },
        ]),
      ),
    ManagementSweepContractError,
  );
});
