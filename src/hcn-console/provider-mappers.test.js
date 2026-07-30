import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HCN_PROVIDER_MAPPER_LIMITS,
  HcnProviderMappingError,
  mapJobNimbusFileEnvelope,
  mapJobNimbusIndexEnvelope,
  mapScopedGmailEnvelope,
  mapScopedQuoEnvelope,
} from './provider-mappers.js';

const CHANCE_ID = 'chance-owner-exact-id';
const FILE_ID = 'jobnimbus-file-1';
const FRESHNESS = Object.freeze({
  asOf: '2026-07-28T17:55:00.000Z',
  checkedAt: '2026-07-28T17:56:00.000Z',
  validUntil: '2026-07-28T18:06:00.000Z',
});

function contact(overrides = {}) {
  return {
    jnid: FILE_ID,
    number: 2739,
    record_type_name: 'Insurance',
    owners: [{ id: CHANCE_ID }],
    display_name: 'Fixture Homeowner',
    status_name: 'Ready for Review',
    stage_name: 'Carrier Review',
    is_active: true,
    date_updated: 1785261000,
    email: 'OWNER@EXAMPLE.TEST',
    mobile_phone: '(555) 555-0101',
    address_line1: '100 Private Street',
    city: 'Example',
    state_text: 'TX',
    zip: '75001',
    'Insurance Company': 'Example Carrier',
    'Claim #': 'CLAIM-PRIVATE',
    'Policy #': 'POLICY-PRIVATE',
    ...overrides,
  };
}

function scoped(record) {
  return {
    ...record,
    primary: { id: FILE_ID },
  };
}

function mappingError(code) {
  return (error) => {
    assert.equal(error instanceof HcnProviderMappingError, true);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, 502);
    return true;
  };
}

test('mapper boundary has no persistence, memory, Brain, Jobrolo, or server import', async () => {
  const source = await readFile(
    new URL('./provider-mappers.js', import.meta.url),
    'utf8',
  );
  const imports = [
    ...source.matchAll(
      /(?:import\s+[\s\S]*?\s+from\s+|import\s*)["']([^"']+)["']/g,
    ),
  ].map((match) => match[1].toLowerCase());

  assert.deepEqual(imports, []);
  for (const forbidden of [
    'memory',
    'brain',
    'jobrolo',
    'server',
    'network',
    'fetch',
  ]) {
    assert.equal(
      imports.some((specifier) => specifier.includes(forbidden)),
      false,
    );
  }
});

test('index maps field aliases and keeps only active exact-owner insurance files', () => {
  const eligibleAlias = {
    ID: 'jobnimbus-file-alias',
    jobNumber: 'JN-1002',
    recordTypeName: 'INSURANCE',
    ownerIds: [CHANCE_ID],
    firstName: 'Alias',
    lastName: 'Homeowner',
    statusName: 'Claim Review',
    workflowStageName: 'Desk Adjuster',
    active: true,
    updatedAt: '2026-07-28T12:50:00-05:00',
    rawSecret: 'DO-NOT-LEAK',
  };
  const result = mapJobNimbusIndexEnvelope(
    {
      ...FRESHNESS,
      pagination: { complete: true },
      contacts: [
        contact(),
        eligibleAlias,
        contact({
          jnid: 'wrong-owner',
          owners: [{ id: 'chance-owner-prefix' }],
        }),
        contact({ jnid: 'inactive', is_active: false }),
        contact({ jnid: 'closed', is_closed: true }),
        contact({ jnid: 'not-insurance', record_type_name: 'Retail' }),
      ],
    },
    { chanceOwnerId: CHANCE_ID },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.data.complete, true);
  assert.equal(result.data.files.length, 2);
  assert.deepEqual(Object.keys(result.data.files[0]), [
    'providerFileId',
    'jobNumber',
    'displayName',
    'statusCode',
    'stageCode',
    'fileTypeCode',
    'isInsuranceFile',
    'isActive',
    'assignedToChance',
    'updatedAt',
    'missingFacts',
  ]);
  assert.deepEqual(result.data.files[1], {
    providerFileId: 'jobnimbus-file-alias',
    jobNumber: 'JN-1002',
    displayName: 'Alias Homeowner',
    statusCode: 'claim_review',
    stageCode: 'desk_adjuster',
    fileTypeCode: 'insurance',
    isInsuranceFile: true,
    isActive: true,
    assignedToChance: true,
    updatedAt: '2026-07-28T17:50:00.000Z',
    missingFacts: {
      claimNumber: true,
      policyNumber: true,
      dateOfLoss: true,
      adjuster: true,
    },
  });
  assert.deepEqual(result.data.files[0].missingFacts, {
    claimNumber: false,
    policyNumber: false,
    dateOfLoss: true,
    adjuster: true,
  });
  assert.equal(JSON.stringify(result).includes(CHANCE_ID), false);
  assert.equal(JSON.stringify(result).includes('DO-NOT-LEAK'), false);
  assert.equal(Object.isFrozen(result.data.files), true);
});

test('index fails closed on incomplete pagination, bad freshness, and malformed eligible records', () => {
  assert.throws(
    () =>
      mapJobNimbusIndexEnvelope(
        {
          ...FRESHNESS,
          contactsComplete: false,
          contacts: [contact()],
        },
        { chanceOwnerId: CHANCE_ID },
      ),
    mappingError('incomplete_pagination'),
  );
  assert.throws(
    () =>
      mapJobNimbusIndexEnvelope(
        {
          ...FRESHNESS,
          checkedAt: 'July 28 2026',
          contactsComplete: true,
          contacts: [contact()],
        },
        { chanceOwnerId: CHANCE_ID },
      ),
    mappingError('invalid_freshness'),
  );
  assert.throws(
    () =>
      mapJobNimbusIndexEnvelope(
        {
          ...FRESHNESS,
          contactsComplete: true,
          contacts: [contact({ date_updated: 'not-a-date' })],
        },
        { chanceOwnerId: CHANCE_ID },
      ),
    mappingError('invalid_provider_record'),
  );
});

test('index requires explicit active truth and excludes contradictory lifecycle records', () => {
  const missingActive = contact({
    jnid: 'missing-explicit-active',
    number: 'JN-2001',
  });
  delete missingActive.is_active;

  const result = mapJobNimbusIndexEnvelope(
    {
      ...FRESHNESS,
      contactsComplete: true,
      contacts: [
        contact(),
        missingActive,
        contact({
          jnid: 'contradictory-active-flags',
          number: 'JN-2002',
          active: false,
        }),
        contact({
          jnid: 'archived-despite-active',
          number: 'JN-2003',
          is_archived: true,
        }),
        contact({
          jnid: 'closed-despite-active',
          number: 'JN-2004',
          closed: true,
        }),
      ],
    },
    { chanceOwnerId: CHANCE_ID },
  );

  assert.deepEqual(
    result.data.files.map((file) => file.providerFileId),
    [FILE_ID],
  );
});

test('exact JobNimbus file maps aliases, bounds presentation text, and excludes photo-like documents', () => {
  const longLabel = `Review ${'x'.repeat(300)}`;
  const result = mapJobNimbusFileEnvelope(
    {
      ...FRESHNESS,
      pagination: {
        activities: true,
        tasks: true,
        documents: true,
      },
      contact: contact({
        nextAppointmentAt: '2026-07-29T09:00:00-05:00',
        rawContactSecret: 'RAW-CONTACT-SECRET',
      }),
      activities: [
        scoped({
          activityId: 'activity-provider-id',
          activityType: 'Status Change',
          status: 'Complete',
          occurredAt: '2026-07-28T12:40:00-05:00',
          actorRole: 'Field Team',
          description: longLabel,
          body: 'RAW-ACTIVITY-BODY',
        }),
      ],
      tasks: [
        scoped({
          task_id: 'task-provider-id',
          record_type_name: 'Task',
          subject: 'Review settlement',
          is_completed: false,
          priority_name: 'Critical',
          due_date: 1785340800000,
          owners: [{ id: CHANCE_ID }],
          description: 'RAW-TASK-BODY',
        }),
      ],
      documents: [
        scoped({
          fileId: 'document-provider-id',
          filename: 'Carrier settlement estimate.pdf',
          contentType: 'application/pdf',
          status: 'New',
          uploadedAt: '2026-07-28T17:30:00.000Z',
          downloadUrl: 'https://provider.invalid/raw',
        }),
        scoped({
          fileId: 'photo-provider-id',
          filename: 'roof.jpg',
          contentType: 'image/jpeg',
          uploadedAt: '2026-07-28T17:31:00.000Z',
        }),
        scoped({
          fileId: 'photo-report-provider-id',
          filename: 'Damage Photo Report.pdf',
          contentType: 'application/pdf',
          uploadedAt: '2026-07-28T17:32:00.000Z',
        }),
      ],
    },
    {
      chanceOwnerId: CHANCE_ID,
      expectedProviderFileId: FILE_ID,
    },
  );

  assert.equal(result.data.file.nextAppointmentAt, '2026-07-29T14:00:00.000Z');
  assert.equal(result.data.file.primaryEmail, 'owner@example.test');
  assert.equal(
    result.data.file.propertyAddress,
    '100 Private Street, Example TX 75001',
  );
  assert.equal(result.data.activities[0].kind, 'status_change');
  assert.equal(Array.from(result.data.activities[0].label).length, 160);
  assert.equal(result.data.tasks[0].status, 'open');
  assert.equal(result.data.tasks[0].priority, 'urgent');
  assert.equal(result.data.tasks[0].assignedRole, 'chance');
  assert.equal(result.data.documents.length, 1);
  assert.deepEqual(result.data.documents[0], {
    providerRecordId: 'document-provider-id',
    kind: 'settlement_estimate',
    reviewState: 'needs_review',
    createdAt: '2026-07-28T17:30:00.000Z',
    fileName: 'Carrier settlement estimate.pdf',
  });

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    CHANCE_ID,
    'RAW-CONTACT-SECRET',
    'RAW-ACTIVITY-BODY',
    'RAW-TASK-BODY',
    'provider.invalid',
    'photo-provider-id',
    'photo-report-provider-id',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('exact JobNimbus file fails on reassignment, wrong record scope, incomplete collections, and duplicate IDs', () => {
  const base = {
    ...FRESHNESS,
    activitiesComplete: true,
    tasksComplete: true,
    documentsComplete: true,
    contact: contact(),
    activities: [],
    tasks: [],
    documents: [],
  };
  const options = {
    chanceOwnerId: CHANCE_ID,
    expectedProviderFileId: FILE_ID,
  };

  assert.throws(
    () =>
      mapJobNimbusFileEnvelope(
        {
          ...base,
          contact: contact({ owners: [{ id: 'someone-else' }] }),
        },
        options,
      ),
    mappingError('file_not_eligible'),
  );
  assert.throws(
    () =>
      mapJobNimbusFileEnvelope(
        {
          ...base,
          activities: [
            {
              jnid: 'activity-1',
              primary: { id: 'different-file' },
              date_created: 1785261000,
            },
          ],
        },
        options,
      ),
    mappingError('scope_mismatch'),
  );
  assert.throws(
    () =>
      mapJobNimbusFileEnvelope(
        {
          ...base,
          activities: [
            {
              jnid: 'cross-linked-activity',
              primary: { id: 'different-client-file' },
              related: [{ id: FILE_ID }],
              date_created: 1785261000,
            },
          ],
        },
        options,
      ),
    mappingError('scope_mismatch'),
  );
  assert.throws(
    () =>
      mapJobNimbusFileEnvelope(
        {
          ...base,
          documentsComplete: false,
        },
        options,
      ),
    mappingError('incomplete_pagination'),
  );
  assert.throws(
    () =>
      mapJobNimbusFileEnvelope(
        {
          ...base,
          activities: [
            scoped({ jnid: 'same-id', date_created: 1785261000 }),
            scoped({ jnid: 'same-id', date_created: 1785261001 }),
          ],
        },
        options,
      ),
    mappingError('duplicate_provider_record'),
  );
});

test('Gmail mapper requires an exact complete scope and emits only bounded fresh-read fields', () => {
  const result = mapScopedGmailEnvelope(
    {
      freshness: FRESHNESS,
      scope: {
        provider_file_id: FILE_ID,
        exactFileMatch: true,
      },
      itemsComplete: true,
      items: [
        {
          messageId: 'gmail-provider-id',
          providerFileId: FILE_ID,
          direction: 'incoming',
          internalDate: '1785261000000',
          attachments: [{ id: 'raw-attachment-id' }],
          subject: `Settlement ${'s'.repeat(300)}`,
          plainText: `Please review ${'p'.repeat(400)}`,
          body: 'RAW-GMAIL-BODY',
          accessToken: 'RAW-GMAIL-TOKEN',
        },
      ],
    },
    { expectedProviderFileId: FILE_ID },
  );

  assert.deepEqual(Object.keys(result.data.items[0]), [
    'providerRecordId',
    'direction',
    'occurredAt',
    'hasAttachment',
    'actionState',
    'subject',
    'snippet',
  ]);
  assert.equal(result.data.items[0].direction, 'inbound');
  assert.equal(result.data.items[0].hasAttachment, true);
  assert.equal(result.data.items[0].actionState, 'needs_reply');
  assert.equal(Array.from(result.data.items[0].subject).length, 160);
  assert.equal(Array.from(result.data.items[0].snippet).length, 240);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('RAW-GMAIL-BODY'), false);
  assert.equal(serialized.includes('RAW-GMAIL-TOKEN'), false);
  assert.equal(serialized.includes('raw-attachment-id'), false);

  assert.throws(
    () =>
      mapScopedGmailEnvelope(
        {
          ...FRESHNESS,
          scope: { providerFileId: FILE_ID, exactFileMatch: true },
          itemsComplete: true,
          items: [{ id: 'message', providerFileId: 'another-file' }],
        },
        { expectedProviderFileId: FILE_ID },
      ),
    mappingError('scope_mismatch'),
  );
  assert.throws(
    () =>
      mapScopedGmailEnvelope(
        {
          ...FRESHNESS,
          scope: { providerFileId: FILE_ID, exactFileMatch: false },
          itemsComplete: true,
          items: [],
        },
        { expectedProviderFileId: FILE_ID },
      ),
    mappingError('scope_mismatch'),
  );
});

test('scoped communication mappers preserve bounded evidence while marking pagination partial', () => {
  const result = mapScopedGmailEnvelope(
    {
      ...FRESHNESS,
      scope: {
        providerFileId: FILE_ID,
        exactFileMatch: true,
      },
      itemsComplete: false,
      items: [
        {
          id: 'partial-message',
          direction: 'incoming',
          internalDate: '1785261000000',
          subject: 'Bounded partial evidence',
        },
      ],
    },
    { expectedProviderFileId: FILE_ID },
  );

  assert.equal(result.data.complete, false);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].providerRecordId, 'partial-message');
});

test('Quo mapper normalizes call/text aliases without exposing participants, lines, or transcripts', () => {
  const result = mapScopedQuoEnvelope(
    {
      ...FRESHNESS,
      scope: {
        providerFileId: FILE_ID,
        exactFileMatch: true,
      },
      pagination: { collection: 'items', complete: true },
      items: [
        {
          callId: 'quo-call-provider-id',
          type: 'missed_call',
          direction: 'incoming',
          atUtc: '2026-07-28T17:40:00Z',
          status: 'missed',
          voicemail: `Call me ${'v'.repeat(400)}`,
          participant: '+15555550101',
          lineNumber: '+15555550102',
          transcript: 'RAW-QUO-TRANSCRIPT',
        },
        {
          id: 'quo-text-provider-id',
          type: 'sms',
          direction: 'outgoing',
          createdAt: 1785261000,
          status: 'delivered',
          text: 'Following up',
          conversationId: 'raw-conversation-id',
        },
      ],
    },
    { expectedProviderFileId: FILE_ID },
  );

  assert.equal(result.data.items[0].channel, 'call');
  assert.equal(result.data.items[0].direction, 'inbound');
  assert.equal(result.data.items[0].actionState, 'needs_reply');
  assert.equal(Array.from(result.data.items[0].preview).length, 240);
  assert.equal(result.data.items[1].channel, 'text');
  assert.equal(result.data.items[1].direction, 'outbound');
  assert.equal(result.data.items[1].actionState, 'awaiting_response');

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    '+15555550101',
    '+15555550102',
    'RAW-QUO-TRANSCRIPT',
    'raw-conversation-id',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('collection bounds and duplicate communication IDs fail closed', () => {
  assert.throws(
    () =>
      mapScopedQuoEnvelope(
        {
          ...FRESHNESS,
          scope: { providerFileId: FILE_ID, exactFileMatch: true },
          itemsComplete: true,
          items: Array.from(
            { length: HCN_PROVIDER_MAPPER_LIMITS.maximumCollectionItems + 1 },
            (_, index) => ({ id: `item-${index}` }),
          ),
        },
        { expectedProviderFileId: FILE_ID },
      ),
    mappingError('provider_bounds_exceeded'),
  );

  assert.throws(
    () =>
      mapScopedGmailEnvelope(
        {
          ...FRESHNESS,
          scope: { providerFileId: FILE_ID, exactFileMatch: true },
          itemsComplete: true,
          items: [
            {
              id: 'duplicate',
              direction: 'incoming',
              date: '2026-07-28T17:00:00Z',
            },
            {
              id: 'duplicate',
              direction: 'outgoing',
              date: '2026-07-28T17:01:00Z',
            },
          ],
        },
        { expectedProviderFileId: FILE_ID },
      ),
    mappingError('duplicate_provider_record'),
  );
});

test('complete scoped envelopes reject malformed JobNimbus, Gmail, and Quo records', () => {
  const exactFileBase = {
    ...FRESHNESS,
    activitiesComplete: true,
    tasksComplete: true,
    documentsComplete: true,
    contact: contact(),
    activities: [],
    tasks: [],
    documents: [],
  };

  assert.throws(
    () =>
      mapJobNimbusFileEnvelope(
        {
          ...exactFileBase,
          tasks: [
            scoped({
              task_id: 'invalid provider id',
              date_start: '2026-07-28T17:00:00.000Z',
            }),
          ],
        },
        {
          chanceOwnerId: CHANCE_ID,
          expectedProviderFileId: FILE_ID,
        },
      ),
    mappingError('invalid_provider_record'),
  );

  for (const [mapper, malformed] of [
    [
      mapScopedGmailEnvelope,
      {
        providerFileId: FILE_ID,
        id: 'gmail-missing-occurred-at',
        direction: 'incoming',
      },
    ],
    [
      mapScopedQuoEnvelope,
      {
        providerFileId: FILE_ID,
        id: 'quo-missing-occurred-at',
        direction: 'incoming',
        type: 'sms',
      },
    ],
  ]) {
    assert.throws(
      () =>
        mapper(
          {
            ...FRESHNESS,
            scope: {
              providerFileId: FILE_ID,
              exactFileMatch: true,
            },
            itemsComplete: true,
            items: [malformed],
          },
          { expectedProviderFileId: FILE_ID },
        ),
      mappingError('invalid_provider_record'),
    );
  }
});
