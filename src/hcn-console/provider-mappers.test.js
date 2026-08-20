import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HCN_PROVIDER_MAPPER_LIMITS,
  HcnProviderMappingError,
  mapJobNimbusDocumentCollection,
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
    'Date of Loss': '2026-05-17',
    'Damage Summary': 'Roof and interior damage documented',
    'Carrier DA': 'Taylor Adjuster',
    'Carrier DA Contact #': '(555) 555-0130',
    'Carrier DA Email': 'ADJUSTER@CARRIER.EXAMPLE',
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
    dateOfLoss: false,
    adjuster: false,
  });
  assert.equal(JSON.stringify(result).includes(CHANCE_ID), false);
  assert.equal(JSON.stringify(result).includes('DO-NOT-LEAK'), false);
  assert.equal(Object.isFrozen(result.data.files), true);
});

test('assigned index preserves the shared 120-character import display name bound', () => {
  const displayName = 'A'.repeat(120);
  const result = mapJobNimbusIndexEnvelope({
    ...FRESHNESS,
    contactsComplete: true,
    contacts: [contact({ display_name: displayName })],
  }, {
    assignedOwnerId: CHANCE_ID,
  });
  assert.equal(result.data.files[0].displayName, displayName);
  assert.equal(Array.from(result.data.files[0].displayName).length, 120);
  assert.equal(result.data.files[0].assignedToCurrentUser, true);
});

test('document transfer mapper requires a complete exact-file non-photo collection', () => {
  const result = mapJobNimbusDocumentCollection({
    documentsComplete: true,
    documents: [{
      jnid: 'document-one',
      filename: 'Carrier estimate.pdf',
      content_type: 'application/pdf',
      status_name: 'New',
      created_at: '2026-07-28T17:50:00.000Z',
      related: { id: FILE_ID },
    }, {
      jnid: 'photo-one',
      filename: 'Roof photo.jpg',
      content_type: 'image/jpeg',
      status_name: 'New',
      created_at: '2026-07-28T17:51:00.000Z',
      related: { id: FILE_ID },
    }],
  }, {
    expectedProviderFileId: FILE_ID,
    knownProviderFileIds: [FILE_ID],
    requireExactContactReferences: true,
  });
  assert.deepEqual(result.documents, [{
    providerRecordId: 'document-one',
    kind: 'estimate',
    reviewState: 'needs_review',
    createdAt: '2026-07-28T17:50:00.000Z',
    fileName: 'Carrier estimate.pdf',
  }]);
  assert.equal(result.collectionCoverage.completeness, 'complete');
  const withPhotos = mapJobNimbusDocumentCollection({
    documentsComplete: true,
    documents: [{
      jnid: 'document-one',
      filename: 'Carrier estimate.pdf',
      content_type: 'application/pdf',
      status_name: 'New',
      created_at: '2026-07-28T17:50:00.000Z',
      related: { id: FILE_ID },
    }, {
      jnid: 'photo-one',
      filename: 'Roof photo.jpg',
      content_type: 'image/jpeg',
      status_name: 'New',
      created_at: '2026-07-28T17:51:00.000Z',
      related: { id: FILE_ID },
    }],
  }, {
    expectedProviderFileId: FILE_ID,
    knownProviderFileIds: [FILE_ID],
    requireExactContactReferences: true,
    includePhotoDocuments: true,
  });
  assert.deepEqual(withPhotos.documents.map(document => document.providerRecordId), [
    'document-one',
    'photo-one',
  ]);
  assert.equal(withPhotos.documents[1].kind, 'document');
  assert.throws(() => mapJobNimbusDocumentCollection({
    documentsComplete: false,
    documents: [],
  }, {
    expectedProviderFileId: FILE_ID,
    knownProviderFileIds: [FILE_ID],
  }), mappingError('incomplete_pagination'));
  assert.throws(() => mapJobNimbusDocumentCollection({
    documentsComplete: true,
    documents: [{
      jnid: 'foreign-document',
      filename: 'Foreign.pdf',
      created_at: '2026-07-28T17:50:00.000Z',
      related: { id: 'unassigned-foreign-contact' },
    }],
  }, {
    expectedProviderFileId: FILE_ID,
    knownProviderFileIds: [FILE_ID],
    requireExactContactReferences: true,
  }), mappingError('scope_mismatch'));
  assert.throws(() => mapJobNimbusDocumentCollection({
    documentsComplete: true,
    documents: [{
      jnid: 'ambiguous-document',
      filename: 'Carrier estimate.pdf',
      content_type: 'application/pdf',
      created_at: '2026-07-28T17:50:00.000Z',
      related: { id: FILE_ID },
    }, {
      jnid: 'ambiguous-document',
      filename: 'Roof photo.jpg',
      content_type: 'image/jpeg',
      created_at: '2026-07-28T17:51:00.000Z',
      related: { id: FILE_ID },
    }],
  }, {
    expectedProviderFileId: FILE_ID,
    knownProviderFileIds: [FILE_ID],
    requireExactContactReferences: true,
  }), mappingError('duplicate_provider_record'));
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
  assert.equal(result.data.file.dateOfLoss, '2026-05-17');
  assert.equal(result.data.file.damageFactsPresent, true);
  assert.equal(result.data.file.adjusterName, 'Taylor Adjuster');
  assert.equal(result.data.file.adjusterPhone, '(555) 555-0130');
  assert.equal(
    result.data.file.adjusterEmail,
    'adjuster@carrier.example',
  );
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

test('exact JobNimbus import opt-in includes scoped photo manifests without bytes', () => {
  const result = mapJobNimbusFileEnvelope({
    ...FRESHNESS,
    activitiesComplete: true,
    tasksComplete: true,
    documentsComplete: true,
    contact: contact(),
    activities: [],
    tasks: [],
    documents: [scoped({
      fileId: 'photo-provider-id',
      filename: 'roof.jpg',
      contentType: 'image/jpeg',
      type: 'Photo',
      uploadedAt: '2026-07-28T17:31:00.000Z',
      bytes: 'DO-NOT-EMIT',
      downloadUrl: 'https://provider.invalid/photo',
    })],
  }, {
    chanceOwnerId: CHANCE_ID,
    expectedProviderFileId: FILE_ID,
    includePhotoDocuments: true,
  });

  assert.equal(result.data.documents.length, 1);
  assert.equal(result.data.documents[0].providerRecordId, 'photo-provider-id');
  assert.equal(result.data.documents[0].fileName, 'roof.jpg');
  assert.equal(result.data.documents[0].kind, 'photo');
  assert.equal(JSON.stringify(result).includes('DO-NOT-EMIT'), false);
  assert.equal(JSON.stringify(result).includes('provider.invalid'), false);
});

test('exact JobNimbus file preserves bounded activity/task history but fails closed on document pagination and conflicting IDs', () => {
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

  const boundedHistory = mapJobNimbusFileEnvelope(
    {
      ...base,
      activitiesComplete: false,
      tasksComplete: false,
      activities: [
        scoped({ jnid: 'bounded-activity', date_created: 1785261000 }),
      ],
      tasks: [
        scoped({
          jnid: 'bounded-task',
          date_created: 1785261000,
          status_name: 'Open',
        }),
      ],
    },
    options,
  );
  assert.equal(boundedHistory.data.file.providerFileId, FILE_ID);
  assert.deepEqual(boundedHistory.data.collectionCoverage.activities, {
    completeness: 'partial',
    returnedItems: 1,
    duplicateItemsRemoved: 0,
    limitationCode: 'incomplete_pagination',
  });
  assert.equal(
    boundedHistory.data.collectionCoverage.tasks.completeness,
    'partial',
  );

  const duplicateActivities = mapJobNimbusFileEnvelope(
    {
      ...base,
      activities: [
        scoped({ jnid: 'same-id', date_created: 1785261000 }),
        scoped({ jnid: 'same-id', date_created: 1785261000 }),
      ],
    },
    options,
  );
  assert.equal(duplicateActivities.data.activities.length, 1);
  assert.equal(
    duplicateActivities.data.collectionCoverage.activities
      .duplicateItemsRemoved,
    1,
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
  assert.throws(
    () =>
      mapJobNimbusFileEnvelope(
        {
          ...base,
          activities: [
            scoped({
              jnid: 'same-normalized-id',
              date_created: 1785261000,
              rawBody: 'first provider body',
            }),
            scoped({
              jnid: 'same-normalized-id',
              date_created: 1785261000,
              rawBody: 'different provider body',
            }),
          ],
        },
        options,
      ),
    mappingError('duplicate_provider_record'),
  );
});

test('exact JobNimbus import activities require typed references and reject every foreign contact', () => {
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
    knownProviderFileIds: [FILE_ID, 'another-known-client-file'],
    requireExactContactReferences: true,
  };

  const result = mapJobNimbusFileEnvelope(
    {
      ...base,
      activities: [
        {
          jnid: 'related-file-activity',
          primary: { id: 'jobnimbus-task-id', record_type_name: 'Task' },
          related: [{ id: FILE_ID }],
          date_created: 1785261000,
        },
        {
          jnid: 'primary-file-activity',
          primary: { id: FILE_ID },
          related: [{ id: 'jobnimbus-task-id', record_type_name: 'Task' }],
          date_created: 1785261001,
        },
      ],
    },
    options,
  );
  assert.equal(result.data.activities.length, 2);

  const tenantBound = mapJobNimbusFileEnvelope(
    {
      ...base,
      contact: contact({ customer: 'jobnimbus-tenant-account' }),
      activities: [
        {
          jnid: 'tenant-bound-activity',
          primary: { id: FILE_ID },
          related: [{ id: FILE_ID }],
          customer: 'jobnimbus-tenant-account',
          date_created: 1785261000,
        },
      ],
    },
    options,
  );
  assert.equal(tenantBound.data.activities.length, 1);
  assert.equal(
    JSON.stringify(tenantBound).includes('jobnimbus-tenant-account'),
    false,
  );

  const verifiedUserBound = mapJobNimbusFileEnvelope(
    {
      ...base,
      contact: contact({ customer: 'jobnimbus-tenant-account' }),
      activities: [
        {
          jnid: 'verified-user-status-activity',
          primary: {
            id: 'verified-jobnimbus-user',
            type: 'Contact',
            old_status: 'Ready',
            new_status: 'Review',
          },
          related: [
            { id: FILE_ID, type: 'Contact' },
            { id: 'verified-jobnimbus-user', type: 'Contact' },
          ],
          customer: 'jobnimbus-tenant-account',
          date_created: 1785261000,
        },
      ],
    },
    {
      ...options,
      knownProviderUserIds: ['verified-jobnimbus-user'],
    },
  );
  assert.equal(verifiedUserBound.data.activities.length, 1);
  assert.equal(
    JSON.stringify(verifiedUserBound).includes('verified-jobnimbus-user'),
    false,
  );

  assert.throws(
    () => mapJobNimbusFileEnvelope(
      {
        ...base,
        contact: contact({ customer: 'jobnimbus-tenant-account' }),
        activities: [
          {
            jnid: 'verified-user-customer-activity',
            primary: { id: FILE_ID },
            related: [{ id: FILE_ID }],
            customer: {
              id: 'verified-jobnimbus-user',
              type: 'Contact',
            },
            date_created: 1785261000,
          },
        ],
      },
      {
        ...options,
        knownProviderUserIds: ['verified-jobnimbus-user'],
      },
    ),
    mappingError('scope_mismatch'),
  );

  for (const knownProviderUserIds of [
    undefined,
    ['different-jobnimbus-user'],
  ]) {
    assert.throws(
      () => mapJobNimbusFileEnvelope(
        {
          ...base,
          activities: [
            {
              jnid: 'unverified-user-activity',
              primary: { id: FILE_ID },
              related: [
                { id: FILE_ID },
                { id: 'unverified-contact', type: 'Contact' },
              ],
              date_created: 1785261000,
            },
          ],
        },
        {
          ...options,
          ...(knownProviderUserIds ? { knownProviderUserIds } : {}),
        },
      ),
      mappingError('scope_mismatch'),
    );
  }

  for (const knownProviderUserIds of [
    [FILE_ID],
    ['verified-jobnimbus-user', 'verified-jobnimbus-user'],
  ]) {
    assert.throws(
      () => mapJobNimbusFileEnvelope(base, {
        ...options,
        knownProviderUserIds,
      }),
      mappingError('invalid_configuration'),
    );
  }

  assert.throws(
    () => mapJobNimbusFileEnvelope(base, {
      chanceOwnerId: CHANCE_ID,
      expectedProviderFileId: FILE_ID,
      knownProviderUserIds: [FILE_ID],
      requireExactContactReferences: true,
    }),
    mappingError('invalid_configuration'),
  );

  for (const customer of [
    'another-jobnimbus-tenant',
    'unassigned-foreign-client',
    { id: 'unassigned-foreign-client', record_type_name: 'Contact' },
    [{ id: 'unassigned-foreign-client', record_type_name: 'Contact' }],
  ]) {
    assert.throws(
      () => mapJobNimbusFileEnvelope(
        {
          ...base,
          contact: contact({ customer: 'jobnimbus-tenant-account' }),
          activities: [
            {
              jnid: 'tenant-mismatch-activity',
              primary: { id: FILE_ID },
              related: [{ id: FILE_ID }],
              customer,
              date_created: 1785261000,
            },
          ],
        },
        options,
      ),
      mappingError('scope_mismatch'),
    );
  }

  assert.throws(
    () => mapJobNimbusFileEnvelope(
      {
        ...base,
        activities: [
          {
            jnid: 'unbound-tenant-activity',
            primary: { id: FILE_ID },
            related: [{ id: FILE_ID }],
            customer: 'jobnimbus-tenant-account',
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
              jnid: 'cross-client-activity',
              primary: { id: 'another-known-client-file' },
              related: [{ id: FILE_ID }],
              date_created: 1785261000,
            },
          ],
        },
        options,
      ),
    mappingError('scope_mismatch'),
  );

  let overDeepReference = { id: FILE_ID };
  for (let depth = 0; depth < 8; depth += 1) {
    overDeepReference = { parent: overDeepReference };
  }
  for (const reference of [
    { id: 'unassigned-foreign-client', record_type_name: 'Contact' },
    { id: 'unassigned-foreign-client' },
    {
      id: 'unassigned-foreign-client',
      record_type_name: 'Task',
      type: 'Contact',
    },
    {
      id: 'jobnimbus-task-id',
      contact_id: 'unassigned-foreign-client',
      record_type_name: 'Task',
    },
    {
      id: 'jobnimbus-task-id',
      jnid: 'different-jobnimbus-task-id',
      record_type_name: 'Task',
    },
    {
      id: 'jobnimbus-task-id',
      record_type_name: 'Task',
      contact: {
        id: 'unassigned-foreign-client',
        record_type_name: 'Contact',
      },
    },
    {
      wrapper: {
        id: 'unassigned-foreign-client',
        record_type_name: 'Contact',
      },
    },
    overDeepReference,
    Array.from({ length: 129 }, () => ({ id: FILE_ID })),
  ]) {
    assert.throws(
      () =>
        mapJobNimbusFileEnvelope(
          {
            ...base,
            activities: [
              {
                jnid: 'private-cross-client-activity',
                primary: reference,
                related: [{ id: FILE_ID }],
                date_created: 1785261000,
                label: 'Private foreign client label',
              },
            ],
          },
          options,
        ),
      mappingError('scope_mismatch'),
    );
  }

});

test('exact JobNimbus import treats empty relation arrays as neutral without weakening exact scope', () => {
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
    knownProviderFileIds: [FILE_ID, 'another-known-client-file'],
    requireExactContactReferences: true,
  };

  const result = mapJobNimbusFileEnvelope(
    {
      ...base,
      activities: [{
        jnid: 'empty-related-activity',
        primary: { id: FILE_ID },
        related: [],
        contact: [],
        date_created: 1785261000,
      }],
      tasks: [{
        jnid: 'empty-primary-task',
        primary: [],
        related: [{ id: FILE_ID }],
        parent: [],
      }],
      documents: [{
        jnid: 'empty-primary-document',
        primary: [],
        related: [{ id: FILE_ID }],
        filename: 'Exact file document.pdf',
        created_at: 1785261000,
      }],
    },
    options,
  );
  assert.equal(result.data.activities.length, 1);
  assert.equal(result.data.tasks.length, 1);
  assert.equal(result.data.documents.length, 1);

  assert.throws(
    () => mapJobNimbusFileEnvelope(
      {
        ...base,
        activities: [{
          jnid: 'unbound-empty-activity',
          primary: [],
          related: [],
          date_created: 1785261000,
        }],
      },
      options,
    ),
    mappingError('scope_mismatch'),
  );

  assert.throws(
    () => mapJobNimbusFileEnvelope(
      {
        ...base,
        activities: [{
          jnid: 'foreign-contact-with-empty-relation',
          primary: [],
          related: [
            { id: FILE_ID },
            {
              id: 'unassigned-foreign-client',
              record_type_name: 'Contact',
            },
          ],
          date_created: 1785261000,
        }],
      },
      options,
    ),
    mappingError('scope_mismatch'),
  );
});

test('exact JobNimbus import accepts an explicit email relation only beside the exact contact', () => {
  const tenantCustomerId = 'jobnimbus-tenant-account';
  const emailRecordId = 'jobnimbus-email-record';
  const base = {
    ...FRESHNESS,
    activitiesComplete: true,
    tasksComplete: true,
    documentsComplete: true,
    contact: contact({ customer: tenantCustomerId }),
    activities: [],
    tasks: [],
    documents: [],
  };
  const options = {
    chanceOwnerId: CHANCE_ID,
    expectedProviderFileId: FILE_ID,
    knownProviderFileIds: [FILE_ID, 'another-known-client-file'],
    requireExactContactReferences: true,
  };
  const exactContact = {
    id: FILE_ID,
    type: 'contact',
    name: 'Fixture Homeowner',
    number: '2739',
    email: 'owner@example.test',
    subject: 'fixture',
  };
  const emailReference = {
    id: emailRecordId,
    type: 'email',
    name: 'Provider email',
    email: 'carrier@example.test',
    subject: 'Provider message',
  };
  const productionShapedActivity = {
    jnid: 'email-activity',
    primary: {
      id: emailRecordId,
      type: 'email',
      name: 'Provider email',
      old_status: null,
      new_status: 'sent',
    },
    related: [exactContact, emailReference],
    customer: tenantCustomerId,
    record_type_name: 'email',
    date_created: 1785261000,
    note: 'Bounded activity label',
  };

  const result = mapJobNimbusFileEnvelope({
    ...base,
    activities: [productionShapedActivity],
  }, options);
  assert.equal(result.data.activities.length, 1);
  assert.equal(JSON.stringify(result).includes(emailRecordId), false);
  assert.equal(JSON.stringify(result).includes(tenantCustomerId), false);

  for (const related of [
    [emailReference],
    [
      exactContact,
      { id: 'unassigned-foreign-client', type: 'contact' },
    ],
    [
      exactContact,
      { id: 'another-known-client-file', type: 'email' },
    ],
    [
      exactContact,
      { id: 'unsupported-email-record', type: 'email_message' },
    ],
    [
      exactContact,
      {
        ...emailReference,
        contact: { id: 'unassigned-foreign-client', type: 'contact' },
      },
    ],
  ]) {
    assert.throws(
      () => mapJobNimbusFileEnvelope({
        ...base,
        activities: [{
          ...productionShapedActivity,
          related,
        }],
      }, options),
      mappingError('scope_mismatch'),
    );
  }
});

test('exact JobNimbus import reference enforcement also covers tasks and documents', () => {
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
    knownProviderFileIds: [FILE_ID],
    requireExactContactReferences: true,
  };
  for (const [collectionName, record] of [
    ['tasks', {
      jnid: 'private-cross-client-task',
      related: [
        { id: FILE_ID },
        { id: 'unassigned-foreign-client', record_type_name: 'Contact' },
      ],
      label: 'Private foreign task label',
    }],
    ['documents', {
      jnid: 'private-cross-client-document',
      related: [
        { id: FILE_ID },
        { id: 'unassigned-foreign-client', record_type_name: 'Contact' },
      ],
      filename: 'Private foreign document.pdf',
      created_at: 1785261000,
    }],
  ]) {
    assert.throws(
      () => mapJobNimbusFileEnvelope(
        { ...base, [collectionName]: [record] },
        options,
      ),
      mappingError('scope_mismatch'),
    );
  }
});

test('JobNimbus zero and positive finite numeric dates remain missing without UTC shifts', () => {
  for (const dateOfLoss of [
    0,
    1785261000,
    1785261000000,
    1,
    1.5,
    Number.MAX_VALUE,
  ]) {
    const index = mapJobNimbusIndexEnvelope(
      {
        ...FRESHNESS,
        contactsComplete: true,
        contacts: [contact({ 'Date of Loss': dateOfLoss })],
      },
      { chanceOwnerId: CHANCE_ID },
    );
    assert.equal(index.data.files[0].missingFacts.dateOfLoss, true);

    const result = mapJobNimbusFileEnvelope(
      {
        ...FRESHNESS,
        activitiesComplete: true,
        tasksComplete: true,
        documentsComplete: true,
        contact: contact({ 'Date of Loss': dateOfLoss }),
        activities: [],
        tasks: [],
        documents: [],
      },
      {
        chanceOwnerId: CHANCE_ID,
        expectedProviderFileId: FILE_ID,
      },
    );
    assert.equal(result.data.file.dateOfLoss, null);
    assert.equal(result.data.file.missingFacts.dateOfLoss, true);
  }
});

test('JobNimbus textual zero date sentinels remain missing', () => {
  for (const dateOfLoss of ['0', '0000']) {
    const result = mapJobNimbusFileEnvelope(
      {
        ...FRESHNESS,
        activitiesComplete: true,
        tasksComplete: true,
        documentsComplete: true,
        contact: contact({ 'Date of Loss': dateOfLoss }),
        activities: [],
        tasks: [],
        documents: [],
      },
      {
        chanceOwnerId: CHANCE_ID,
        expectedProviderFileId: FILE_ID,
      },
    );
    assert.equal(result.data.file.dateOfLoss, null);
    assert.equal(result.data.file.missingFacts.dateOfLoss, true);
  }
});

test('JobNimbus date of loss preserves supported civil calendar forms', () => {
  for (const [dateOfLoss, expected] of [
    ['2026-05-17', '2026-05-17'],
    ['5/7/2026', '2026-05-07'],
    ['05/07/2026', '2026-05-07'],
    ['2/29/2024', '2024-02-29'],
  ]) {
    const result = mapJobNimbusFileEnvelope(
      {
        ...FRESHNESS,
        activitiesComplete: true,
        tasksComplete: true,
        documentsComplete: true,
        contact: contact({ 'Date of Loss': dateOfLoss }),
        activities: [],
        tasks: [],
        documents: [],
      },
      {
        chanceOwnerId: CHANCE_ID,
        expectedProviderFileId: FILE_ID,
      },
    );
    assert.equal(result.data.file.dateOfLoss, expected);
  }
});

test('JobNimbus date of loss rejects timestamp strings, Date objects, non-finite numbers, and impossible dates', () => {
  for (const dateOfLoss of [
    '2026-05-17T23:00:00-05:00',
    '2026-05-17T00:00:00.000Z',
    new Date('2026-05-17T00:00:00.000Z'),
    '1785261000',
    '1785261000000',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    -1785261000,
    '2026-02-30',
    '2/29/2026',
    '13/1/2026',
  ]) {
    assert.throws(
      () => mapJobNimbusFileEnvelope(
        {
          ...FRESHNESS,
          activitiesComplete: true,
          tasksComplete: true,
          documentsComplete: true,
          contact: contact({ 'Date of Loss': dateOfLoss }),
          activities: [],
          tasks: [],
          documents: [],
        },
        {
          chanceOwnerId: CHANCE_ID,
          expectedProviderFileId: FILE_ID,
        },
      ),
      mappingError('invalid_provider_record'),
    );
  }
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
    'deliveryState',
    'actionState',
    'subject',
    'snippet',
  ]);
  assert.equal(result.data.items[0].direction, 'inbound');
  assert.equal(result.data.items[0].hasAttachment, true);
  assert.equal(result.data.items[0].deliveryState, 'received');
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

test('Gmail delivery proof and per-thread ordering prevent drafts and answered messages from becoming response due', () => {
  const result = mapScopedGmailEnvelope(
    {
      ...FRESHNESS,
      scope: {
        providerFileId: FILE_ID,
        exactFileMatch: true,
      },
      itemsComplete: true,
      items: [
        {
          id: 'older-inbound',
          threadId: 'thread-one',
          direction: 'incoming',
          internalDate: '1785260000000',
          subject: 'Older inbound',
        },
        {
          id: 'later-sent',
          threadId: 'thread-one',
          direction: 'outgoing',
          internalDate: '1785261000000',
          actionState: 'sent_verified',
          subject: 'Verified reply',
        },
        {
          id: 'draft-only',
          threadId: 'thread-two',
          direction: 'outgoing',
          internalDate: '1785262000000',
          actionState: 'draft',
          subject: 'Unsent draft',
        },
      ],
    },
    { expectedProviderFileId: FILE_ID },
  );

  const byId = new Map(
    result.data.items.map((item) => [item.providerRecordId, item]),
  );
  assert.equal(byId.get('older-inbound').actionState, 'no_action');
  assert.equal(byId.get('later-sent').deliveryState, 'sent_verified');
  assert.equal(byId.get('later-sent').actionState, 'awaiting_response');
  assert.equal(byId.get('draft-only').deliveryState, 'draft');
  assert.equal(byId.get('draft-only').actionState, 'draft');
  assert.equal(
    result.data.items.some(
      (item) =>
        item.providerRecordId === 'draft-only'
        && item.deliveryState === 'sent_verified',
    ),
    false,
  );
});

test('automated JobNimbus task reminders remain evidence but never become response due', () => {
  const result = mapScopedGmailEnvelope(
    {
      ...FRESHNESS,
      scope: {
        providerFileId: FILE_ID,
        exactFileMatch: true,
      },
      itemsComplete: true,
      items: [
        {
          id: 'jobnimbus-task-reminder',
          threadId: 'automated-reminder-thread',
          direction: 'incoming',
          internalDate: '1785261000000',
          subject: 'JobNimbus Task Reminders',
          plainText: 'Tasks are due.',
        },
        {
          id: 'human-inbound',
          threadId: 'human-thread',
          direction: 'incoming',
          internalDate: '1785262000000',
          subject: 'Question about the inspection',
        },
      ],
    },
    { expectedProviderFileId: FILE_ID },
  );

  const byId = new Map(
    result.data.items.map((item) => [item.providerRecordId, item]),
  );
  assert.equal(
    byId.get('jobnimbus-task-reminder').deliveryState,
    'received',
  );
  assert.equal(
    byId.get('jobnimbus-task-reminder').actionState,
    'no_action',
  );
  assert.equal(byId.get('human-inbound').actionState, 'needs_reply');
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

test('only delivered Quo replies suppress an earlier inbound response due', () => {
  for (const disposition of ['undelivered', 'sent', 'completed']) {
    const result = mapScopedQuoEnvelope(
      {
        ...FRESHNESS,
        scope: {
          providerFileId: FILE_ID,
          exactFileMatch: true,
        },
        itemsComplete: true,
        items: [
          {
            id: `inbound-before-${disposition}`,
            type: 'sms',
            direction: 'incoming',
            createdAt: '2026-07-28T17:00:00Z',
            status: 'delivered',
            conversationId: `conversation-${disposition}`,
          },
          {
            id: `outbound-${disposition}`,
            type: 'sms',
            direction: 'outgoing',
            createdAt: '2026-07-28T17:05:00Z',
            status: disposition,
            conversationId: `conversation-${disposition}`,
          },
        ],
      },
      { expectedProviderFileId: FILE_ID },
    );

    const byId = new Map(
      result.data.items.map((item) => [item.providerRecordId, item]),
    );
    assert.equal(
      byId.get(`inbound-before-${disposition}`).actionState,
      'needs_reply',
    );
    assert.notEqual(
      byId.get(`outbound-${disposition}`).actionState,
      'awaiting_response',
    );
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
