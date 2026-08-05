/**
 * Provider-to-HCN fresh-read adapters.
 *
 * These mappers are intentionally pure. They accept already-fetched provider
 * data and emit only the narrow, ephemeral envelopes consumed by
 * fresh-read.js. They do not load configuration, make network requests, or
 * import any persistence, memory, Brain, or Jobrolo module.
 */

export const HCN_PROVIDER_MAPPER_LIMITS = Object.freeze({
  maximumIndexContacts: 5000,
  maximumCollectionItems: 500,
  maximumProviderIdCharacters: 512,
});

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_PROVIDER_ID = /^[^\s\x00-\x1f\x7f]{1,512}$/;
const SAFE_JOB_NUMBER = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;
const SAFE_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;

const ACTIVITY_FIELDS = Object.freeze({
  id: ['jnid', 'id', 'activity_id', 'activityId'],
  kind: [
    'record_type_name',
    'recordTypeName',
    'activity_type',
    'activityType',
    'type',
  ],
  state: ['status_name', 'statusName', 'state', 'status'],
  at: [
    'date_created',
    'created_at',
    'createdAt',
    'occurred_at',
    'occurredAt',
    'date_updated',
  ],
  actorRole: ['actor_role', 'actorRole'],
  label: ['label', 'title', 'subject', 'note', 'description'],
});

const TASK_FIELDS = Object.freeze({
  id: ['jnid', 'id', 'task_id', 'taskId'],
  kind: ['record_type_name', 'recordTypeName', 'task_type', 'taskType', 'type'],
  status: ['status_name', 'statusName', 'state', 'status'],
  priority: ['priority_name', 'priorityName', 'priority'],
  dueAt: ['date_start', 'date_end', 'due_at', 'dueAt', 'due_date', 'dueDate'],
  assignedRole: ['assigned_role', 'assignedRole'],
  label: ['label', 'title', 'subject', 'name'],
});

const DOCUMENT_FIELDS = Object.freeze({
  id: ['jnid', 'id', 'file_id', 'fileId', 'document_id', 'documentId'],
  name: ['name', 'filename', 'file_name', 'fileName'],
  type: [
    'record_type_name',
    'recordTypeName',
    'document_type',
    'documentType',
    'type',
  ],
  contentType: ['content_type', 'contentType', 'mime_type', 'mimeType'],
  reviewState: [
    'review_state',
    'reviewState',
    'status_name',
    'statusName',
    'status',
  ],
  createdAt: [
    'date_created',
    'created_at',
    'createdAt',
    'uploaded_at',
    'uploadedAt',
    'date_updated',
  ],
});

const CONTACT_FIELDS = Object.freeze({
  id: ['jnid', 'id', 'contact_id', 'contactId'],
  number: [
    'number',
    'recid',
    'job_number',
    'jobNumber',
    'file_number',
    'fileNumber',
  ],
  displayName: ['display_name', 'displayName', 'name'],
  firstName: ['first_name', 'firstName'],
  lastName: ['last_name', 'lastName'],
  status: ['status_name', 'statusName', 'status'],
  stage: [
    'stage_name',
    'stageName',
    'workflow_stage_name',
    'workflowStageName',
  ],
  recordType: [
    'record_type_name',
    'recordTypeName',
    'file_type_name',
    'fileTypeName',
  ],
  updatedAt: ['date_updated', 'updated_at', 'updatedAt'],
  nextAppointmentAt: [
    'next_appointment_at',
    'nextAppointmentAt',
    'appointment_at',
    'appointmentAt',
  ],
  email: ['email', 'primary_email', 'primaryEmail'],
  phone: [
    'mobile_phone',
    'mobilePhone',
    'home_phone',
    'homePhone',
    'work_phone',
    'workPhone',
    'phone',
  ],
  propertyAddress: [
    'property_address',
    'propertyAddress',
    'full_address',
    'fullAddress',
  ],
  address1: [
    'address_line1',
    'addressLine1',
    'street_address',
    'streetAddress',
  ],
  address2: ['address_line2', 'addressLine2'],
  city: ['city'],
  state: ['state_text', 'stateText', 'state'],
  zip: ['zip', 'postal_code', 'postalCode'],
  carrier: [
    'Insurance Company',
    'Carrier',
    'insurance_company',
    'carrier_name',
    'carrierName',
    'cf_string_1',
  ],
  claimNumber: [
    'Claim #',
    'Claim Number',
    'claim_number',
    'claimNumber',
    'cf_string_10',
    'cf_string_2',
  ],
  policyNumber: [
    'Policy #',
    'Policy Number',
    'policy_number',
    'policyNumber',
    'cf_string_4',
    'cf_string_3',
  ],
  dateOfLoss: [
    'Date of Loss',
    'DOL',
    'date_of_loss',
    'dateOfLoss',
    'cf_date_1',
  ],
  damageFacts: [
    'Damage Details',
    'Damage Summary',
    'Description of Loss',
    'Loss Description',
    'damage_details',
    'damageDetails',
    'damage_summary',
    'damageSummary',
    'description_of_loss',
    'descriptionOfLoss',
  ],
  adjusterName: [
    'Carrier DA',
    'Carrier Adjuster',
    'Adjuster',
    'adjuster_name',
    'adjusterName',
    'cf_string_7',
  ],
  adjusterPhone: [
    'Carrier DA Contact #',
    'Adjuster Phone',
    'adjuster_phone',
    'adjusterPhone',
    'cf_string_8',
  ],
  adjusterEmail: [
    'Carrier DA Email',
    'Adjuster Email',
    'adjuster_email',
    'adjusterEmail',
    'cf_string_9',
  ],
});

export class HcnProviderMappingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HcnProviderMappingError';
    this.code = code;
    this.statusCode = 502;
  }
}

/**
 * Map a completely paginated JobNimbus contact index.
 */
export function mapJobNimbusIndexEnvelope(input, options = {}) {
  const assignedOwnerId = assignedOwnerIdFromOptions(options);
  const legacyChanceField = !options.assignedOwnerId
    && Boolean(options.chanceOwnerId);
  const freshness = normalizeFreshness(input);
  requireCompletePagination(input, 'contacts');
  const contacts = requireArray(input?.contacts, 'contacts');
  if (contacts.length > HCN_PROVIDER_MAPPER_LIMITS.maximumIndexContacts) {
    fail(
      'provider_bounds_exceeded',
      'JobNimbus contact index exceeds its bound.',
    );
  }

  const files = [];
  const seen = new Set();
  for (const contact of contacts) {
    if (!isPlainObject(contact)) {
      fail(
        'invalid_provider_record',
        'JobNimbus contact index contains an invalid record.',
      );
    }
    if (!isEligibleContact(contact, assignedOwnerId)) continue;
    const file = mapEligibleContact(contact, assignedOwnerId, {
      detail: false,
      legacyChanceField,
    });
    if (seen.has(file.providerFileId)) {
      fail(
        'duplicate_provider_record',
        'JobNimbus contact index contains a duplicate file.',
      );
    }
    seen.add(file.providerFileId);
    files.push(file);
  }

  return immutableCopy({
    status: 'ok',
    ...freshness,
    data: {
      complete: true,
      files,
    },
  });
}

/**
 * Map one exact, completely paginated JobNimbus file read.
 */
export function mapJobNimbusFileEnvelope(input, options = {}) {
  const assignedOwnerId = assignedOwnerIdFromOptions(options);
  const legacyChanceField = !options.assignedOwnerId
    && Boolean(options.chanceOwnerId);
  const expectedProviderFileId = requireProviderId(
    options.expectedProviderFileId,
    'expectedProviderFileId',
  );
  const knownProviderFileIds = normalizeKnownProviderFileIds(
    options.knownProviderFileIds,
    expectedProviderFileId,
  );
  const freshness = normalizeFreshness(input);
  const collectionCompleteness = {
    activities: readCollectionPaginationState(input, 'activities'),
    tasks: readCollectionPaginationState(input, 'tasks'),
    documents: readCollectionPaginationState(input, 'documents'),
  };
  if (!collectionCompleteness.documents) {
    fail(
      'incomplete_pagination',
      'documents pagination is not verified complete.',
    );
  }

  const contact = requirePlainObject(input?.contact, 'contact');
  const file = mapEligibleContact(contact, assignedOwnerId, {
    detail: true,
    legacyChanceField,
  });
  if (file.providerFileId !== expectedProviderFileId) {
    fail(
      'scope_mismatch',
      'JobNimbus detail does not match the exact file scope.',
    );
  }

  const activityResult = mapScopedCollection({
    value: input.activities,
    label: 'activities',
    expectedProviderFileId,
    knownProviderFileIds,
    mapper: (record) =>
      mapActivity(record, assignedOwnerId, legacyChanceField),
    allowedExactReferenceFields: ['primary', 'related'],
    dedupeIdenticalProviderIds: true,
  });
  const taskResult = mapScopedCollection({
    value: input.tasks,
    label: 'tasks',
    expectedProviderFileId,
    knownProviderFileIds,
    mapper: (record) =>
      mapTask(record, assignedOwnerId, legacyChanceField),
  });
  const documentResult = mapScopedCollection({
    value: input.documents,
    label: 'documents',
    expectedProviderFileId,
    knownProviderFileIds,
    mapper: mapDocument,
    filter: (record) => !isPhotoLikeDocument(record),
  });
  const activities = activityResult.items;
  const tasks = taskResult.items;
  const documents = documentResult.items;

  assertUniqueRecordIds([...activities, ...tasks, ...documents], 'jobnimbus');

  return immutableCopy({
    status: 'ok',
    ...freshness,
    data: {
      file,
      activities,
      tasks,
      documents,
      collectionCoverage: {
        activities: collectionCoverage(
          collectionCompleteness.activities,
          activities.length,
          activityResult.duplicateItemsRemoved,
        ),
        tasks: collectionCoverage(
          collectionCompleteness.tasks,
          tasks.length,
          taskResult.duplicateItemsRemoved,
        ),
        documents: collectionCoverage(
          collectionCompleteness.documents,
          documents.length,
          documentResult.duplicateItemsRemoved,
        ),
      },
    },
  });
}

/**
 * Map Gmail messages that were already correlated to one exact HCN file.
 */
export function mapScopedGmailEnvelope(input, options = {}) {
  return mapScopedCommunicationEnvelope({
    input,
    options,
    source: 'gmail',
    mapper: mapGmailItem,
  });
}

/**
 * Map Quo timeline entries that were already correlated to one exact HCN file.
 */
export function mapScopedQuoEnvelope(input, options = {}) {
  return mapScopedCommunicationEnvelope({
    input,
    options,
    source: 'quo',
    mapper: mapQuoItem,
  });
}

function mapScopedCommunicationEnvelope({ input, options, source, mapper }) {
  const expectedProviderFileId = requireProviderId(
    options.expectedProviderFileId,
    'expectedProviderFileId',
  );
  const freshness = normalizeFreshness(input);
  const scope = requirePlainObject(input?.scope, 'scope');
  const scopeProviderFileId = requireProviderId(
    field(scope, ['providerFileId', 'provider_file_id']),
    'scope.providerFileId',
  );
  if (
    scopeProviderFileId !== expectedProviderFileId ||
    scope.exactFileMatch !== true
  ) {
    fail('scope_mismatch', `${source} evidence is not exact-file scoped.`);
  }
  const itemsComplete = readCommunicationPaginationState(input);
  const rawItems = requireArray(input?.items, 'items');
  if (rawItems.length > HCN_PROVIDER_MAPPER_LIMITS.maximumCollectionItems) {
    fail('provider_bounds_exceeded', `${source} evidence exceeds its bound.`);
  }

  const items = [];
  for (const rawItem of rawItems) {
    const explicitFileId = field(rawItem, [
      'providerFileId',
      'provider_file_id',
      'jobNimbusFileId',
      'job_nimbus_file_id',
    ]);
    if (
      explicitFileId !== undefined &&
      String(explicitFileId) !== expectedProviderFileId
    ) {
      fail('scope_mismatch', `${source} item escaped the exact file scope.`);
    }
    const mapped = mapper(rawItem);
    if (!mapped) {
      fail(
        'invalid_provider_record',
        `${source} evidence contains an invalid record.`,
      );
    }
    items.push(mapped);
  }
  assertUniqueRecordIds(items, source);
  const resolvedItems = resolveCommunicationActionStates(
    source,
    items,
    itemsComplete,
  );

  return immutableCopy({
    status: 'ok',
    ...freshness,
    data: {
      providerFileId: expectedProviderFileId,
      complete: itemsComplete,
      items: resolvedItems,
    },
  });
}

function mapEligibleContact(
  contact,
  assignedOwnerId,
  { detail, legacyChanceField = false },
) {
  if (!isEligibleContact(contact, assignedOwnerId)) {
    fail(
      'file_not_eligible',
      'JobNimbus file is not an active file assigned to the authenticated employee.',
    );
  }
  const providerFileId = requireProviderId(
    field(contact, CONTACT_FIELDS.id),
    'contact provider id',
  );
  const rawJobNumber = field(contact, CONTACT_FIELDS.number);
  const jobNumber =
    rawJobNumber === undefined ? null : boundedText(String(rawJobNumber), 64);
  if (!jobNumber || !SAFE_JOB_NUMBER.test(jobNumber)) {
    fail('invalid_provider_record', 'JobNimbus file number is invalid.');
  }
  const updatedAt = normalizeProviderTimestamp(
    field(contact, CONTACT_FIELDS.updatedAt),
  );
  if (!updatedAt) {
    fail('invalid_provider_record', 'JobNimbus file update time is invalid.');
  }
  const claimNumber = boundedText(
    field(contact, CONTACT_FIELDS.claimNumber),
    80,
  );
  const policyNumber = boundedText(
    field(contact, CONTACT_FIELDS.policyNumber),
    80,
  );
  const dateOfLoss = normalizeProviderDate(
    field(contact, CONTACT_FIELDS.dateOfLoss),
  );
  const adjusterName = boundedText(
    field(contact, CONTACT_FIELDS.adjusterName),
    120,
  );
  const adjusterPhone = normalizePhone(
    field(contact, CONTACT_FIELDS.adjusterPhone),
  );
  const adjusterEmail = normalizeEmail(
    field(contact, CONTACT_FIELDS.adjusterEmail),
  );
  const damageFactsPresent = Boolean(
    boundedText(field(contact, CONTACT_FIELDS.damageFacts), 1000),
  );

  const base = {
    providerFileId,
    jobNumber,
    displayName: contactDisplayName(contact, detail ? 120 : 80),
    statusCode: toCode(field(contact, CONTACT_FIELDS.status)),
    stageCode: toCode(field(contact, CONTACT_FIELDS.stage)),
    fileTypeCode: 'insurance',
    isInsuranceFile: true,
    isActive: true,
    ...(legacyChanceField
      ? { assignedToChance: true }
      : { assignedToCurrentUser: true }),
    updatedAt,
    missingFacts: {
      claimNumber: !claimNumber,
      policyNumber: !policyNumber,
      dateOfLoss: !dateOfLoss,
      adjuster: ![adjusterPhone, adjusterEmail].some(Boolean),
    },
  };
  if (!detail) return base;

  return {
    ...base,
    nextAppointmentAt: normalizeNullableProviderTimestamp(
      field(contact, CONTACT_FIELDS.nextAppointmentAt),
    ),
    primaryEmail: normalizeEmail(field(contact, CONTACT_FIELDS.email)),
    primaryPhone: normalizePhone(field(contact, CONTACT_FIELDS.phone)),
    propertyAddress: contactAddress(contact),
    carrierName: boundedText(field(contact, CONTACT_FIELDS.carrier), 120),
    claimNumber,
    policyNumber,
    dateOfLoss,
    damageFactsPresent,
    adjusterName,
    adjusterPhone,
    adjusterEmail,
  };
}

function isEligibleContact(contact, assignedOwnerId) {
  if (!isPlainObject(contact)) return false;
  const recordType = normalizedLabel(field(contact, CONTACT_FIELDS.recordType));
  if (recordType !== 'insurance') return false;
  if (!contactIsActive(contact)) return false;
  return ownerIds(contact).includes(assignedOwnerId);
}

function contactIsActive(contact) {
  const hasExplicitActive = ['is_active', 'isActive', 'active'].some(
    (key) =>
      Object.prototype.hasOwnProperty.call(contact, key)
      && contact[key] === true,
  );
  if (!hasExplicitActive) return false;
  for (const key of ['is_active', 'isActive', 'active']) {
    if (
      Object.prototype.hasOwnProperty.call(contact, key) &&
      contact[key] === false
    ) {
      return false;
    }
  }
  for (const key of [
    'is_archived',
    'isArchived',
    'archived',
    'is_closed',
    'isClosed',
    'closed',
  ]) {
    if (contact[key] === true) return false;
  }
  return true;
}

function ownerIds(contact) {
  const values = [];
  for (const key of [
    'owners',
    'owner_ids',
    'ownerIds',
    'assigned_to',
    'assignedTo',
    'assignees',
  ]) {
    const value = contact[key];
    if (Array.isArray(value)) values.push(...value);
    else if (value !== undefined && value !== null) values.push(value);
  }
  const ids = [];
  for (const value of values) {
    if (typeof value === 'string' || typeof value === 'number') {
      ids.push(String(value));
      continue;
    }
    if (!isPlainObject(value)) continue;
    const id = field(value, [
      'id',
      'jnid',
      'user_id',
      'userId',
      'owner_id',
      'ownerId',
    ]);
    if (id !== undefined && id !== null) ids.push(String(id));
  }
  return ids;
}

function mapScopedCollection({
  value,
  label,
  expectedProviderFileId,
  knownProviderFileIds,
  mapper,
  filter = () => true,
  allowedExactReferenceFields = ['related'],
  dedupeIdenticalProviderIds = false,
}) {
  const rows = requireArray(value, label);
  if (rows.length > HCN_PROVIDER_MAPPER_LIMITS.maximumCollectionItems) {
    fail('provider_bounds_exceeded', `JobNimbus ${label} exceed their bound.`);
  }
  const mapped = [];
  const byProviderRecordId = new Map();
  let duplicateItemsRemoved = 0;
  for (const row of rows) {
    if (!recordReferencesFile(
      row,
      expectedProviderFileId,
      knownProviderFileIds,
      allowedExactReferenceFields,
    )) {
      fail(
        'scope_mismatch',
        `JobNimbus ${label} escaped the exact file scope.`,
      );
    }
    if (!filter(row)) continue;
    const item = mapper(row);
    if (!item) {
      fail(
        'invalid_provider_record',
        `JobNimbus ${label} contain an invalid record.`,
      );
    }
    if (dedupeIdenticalProviderIds) {
      const existing = byProviderRecordId.get(item.providerRecordId);
      const fingerprint = stableProviderRecord(row);
      if (existing) {
        if (
          existing.fingerprint !== fingerprint
          || JSON.stringify(existing.item) !== JSON.stringify(item)
        ) {
          fail(
            'duplicate_provider_record',
            `JobNimbus ${label} contain conflicting duplicate ids.`,
          );
        }
        duplicateItemsRemoved += 1;
        continue;
      }
      byProviderRecordId.set(item.providerRecordId, { item, fingerprint });
    }
    mapped.push(item);
  }
  return { items: mapped, duplicateItemsRemoved };
}

function normalizeKnownProviderFileIds(value, expectedProviderFileId) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 5000) {
    fail(
      'invalid_configuration',
      'Known JobNimbus file scope is unavailable.',
    );
  }
  const ids = new Set();
  for (const valueId of value) {
    ids.add(requireProviderId(valueId, 'knownProviderFileIds'));
  }
  if (!ids.has(expectedProviderFileId)) {
    fail(
      'scope_mismatch',
      'Known JobNimbus file scope does not contain the exact file.',
    );
  }
  return ids;
}

function recordReferencesFile(
  record,
  expectedProviderFileId,
  knownProviderFileIds,
  allowedExactReferenceFields = ['related'],
) {
  if (!isPlainObject(record)) return false;
  if (knownProviderFileIds) {
    const exactReferenceIds = [];
    for (const fieldName of allowedExactReferenceFields) {
      if (!['primary', 'related'].includes(fieldName)) return false;
      collectReferenceIds(record[fieldName], exactReferenceIds);
    }
    if (!exactReferenceIds.includes(expectedProviderFileId)) return false;

    const allIds = [];
    for (const value of [
      record.primary,
      record.related,
      record.customer,
      record.contact,
      record.parent,
    ]) {
      collectReferenceIds(value, allIds);
    }
    return !allIds.some(
      (id) =>
        id !== expectedProviderFileId
        && knownProviderFileIds.has(id),
    );
  }
  const containers = [
    record.primary,
    record.related,
    record.customer,
    record.contact,
    record.parent,
  ];
  const ids = [];
  for (const value of containers) collectReferenceIds(value, ids);
  return (
    ids.length > 0
    && ids.every((id) => id === expectedProviderFileId)
  );
}

function collectionCoverage(complete, returnedItems, duplicateItemsRemoved) {
  return {
    completeness: complete ? 'complete' : 'partial',
    returnedItems,
    duplicateItemsRemoved,
    limitationCode: complete ? null : 'incomplete_pagination',
  };
}

function stableProviderRecord(value) {
  if (Array.isArray(value)) {
    return JSON.stringify(
      value.map(stableProviderRecord).sort((left, right) =>
        left.localeCompare(right)
      ),
    );
  }
  if (!isPlainObject(value)) return JSON.stringify(value);
  return JSON.stringify(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableProviderRecord(entry)]),
  );
}

function collectReferenceIds(value, ids) {
  if (typeof value === 'string' || typeof value === 'number') {
    ids.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferenceIds(item, ids);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of ['id', 'jnid', 'contact_id', 'contactId']) {
    if (value[key] !== undefined && value[key] !== null) {
      ids.push(String(value[key]));
    }
  }
}

function mapActivity(record, assignedOwnerId, legacyChanceField = false) {
  if (!isPlainObject(record)) return null;
  const providerRecordId = normalizeProviderId(
    field(record, ACTIVITY_FIELDS.id),
  );
  const occurredAt = normalizeProviderTimestamp(
    field(record, ACTIVITY_FIELDS.at),
  );
  if (!providerRecordId || !occurredAt) return null;
  return {
    providerRecordId,
    kind: toCode(field(record, ACTIVITY_FIELDS.kind)) ?? 'activity',
    state: toCode(field(record, ACTIVITY_FIELDS.state)) ?? 'recorded',
    occurredAt,
    actorRole:
      toCode(field(record, ACTIVITY_FIELDS.actorRole)) ??
      (ownerIds(record).includes(assignedOwnerId)
        ? legacyChanceField ? 'chance' : 'employee'
        : 'team'),
    label: boundedText(field(record, ACTIVITY_FIELDS.label), 160),
  };
}

function mapTask(record, assignedOwnerId, legacyChanceField = false) {
  if (!isPlainObject(record)) return null;
  const providerRecordId = normalizeProviderId(field(record, TASK_FIELDS.id));
  if (!providerRecordId) return null;
  const rawDueAt = field(record, TASK_FIELDS.dueAt);
  const dueAt = normalizeNullableProviderTimestamp(rawDueAt);
  if (
    rawDueAt !== undefined &&
    rawDueAt !== null &&
    rawDueAt !== '' &&
    !dueAt
  ) {
    return null;
  }
  return {
    providerRecordId,
    kind: toCode(field(record, TASK_FIELDS.kind)) ?? 'task',
    status: taskStatus(record),
    priority: taskPriority(field(record, TASK_FIELDS.priority)),
    dueAt,
    assignedRole:
      toCode(field(record, TASK_FIELDS.assignedRole)) ??
      (ownerIds(record).includes(assignedOwnerId)
        ? legacyChanceField ? 'chance' : 'employee'
        : 'team'),
    label: boundedText(field(record, TASK_FIELDS.label), 160),
  };
}

function mapDocument(record) {
  if (!isPlainObject(record)) return null;
  const providerRecordId = normalizeProviderId(
    field(record, DOCUMENT_FIELDS.id),
  );
  const createdAt = normalizeProviderTimestamp(
    field(record, DOCUMENT_FIELDS.createdAt),
  );
  if (!providerRecordId || !createdAt) return null;
  const fileName = boundedText(field(record, DOCUMENT_FIELDS.name), 160);
  return {
    providerRecordId,
    kind: documentKind(fileName, field(record, DOCUMENT_FIELDS.type)),
    reviewState: documentReviewState(
      field(record, DOCUMENT_FIELDS.reviewState),
    ),
    createdAt,
    fileName,
  };
}

function mapGmailItem(record) {
  if (!isPlainObject(record)) return null;
  const providerRecordId = normalizeProviderId(
    field(record, [
      'providerRecordId',
      'provider_record_id',
      'id',
      'messageId',
      'message_id',
    ]),
  );
  const occurredAt = normalizeProviderTimestamp(
    field(record, [
      'occurredAt',
      'occurred_at',
      'internalDate',
      'internal_date',
      'date',
    ]),
  );
  if (!providerRecordId || !occurredAt) return null;
  const direction = normalizeDirection(
    field(record, ['direction', 'messageDirection', 'message_direction']),
  );
  const requestedActionState = normalizeCommunicationActionState(
    field(record, ['actionState', 'action_state']),
  );
  const deliveryState = gmailDeliveryState(
    requestedActionState,
    direction,
  );
  const hasAttachment =
    typeof record.hasAttachment === 'boolean'
      ? record.hasAttachment
      : typeof record.has_attachment === 'boolean'
        ? record.has_attachment
        : Array.isArray(record.attachments) && record.attachments.length > 0;
  return {
    providerRecordId,
    direction,
    occurredAt,
    hasAttachment,
    deliveryState,
    actionState: deliveryState === 'draft'
      ? 'draft'
      : deliveryState === 'failed'
        ? 'failed'
        : deliveryState === 'unverified'
          ? 'unverified'
          : 'no_action',
    subject: boundedText(field(record, ['subject']), 160),
    snippet: boundedText(
      field(record, ['snippet', 'preview', 'plainText', 'plain_text', 'text']),
      240,
    ),
    conversationKey: normalizeProviderId(
      field(record, ['threadId', 'thread_id', 'conversationId']),
    ) ?? providerRecordId,
  };
}

function mapQuoItem(record) {
  if (!isPlainObject(record)) return null;
  const providerRecordId = normalizeProviderId(
    field(record, [
      'providerRecordId',
      'provider_record_id',
      'id',
      'messageId',
      'message_id',
      'callId',
      'call_id',
    ]),
  );
  const occurredAt = normalizeProviderTimestamp(
    field(record, [
      'occurredAt',
      'occurred_at',
      'atUtc',
      'at_utc',
      'createdAt',
      'created_at',
    ]),
  );
  if (!providerRecordId || !occurredAt) return null;
  const direction = normalizeDirection(field(record, ['direction']));
  const channel = quoChannel(field(record, ['channel', 'type']));
  const disposition =
    toCode(field(record, ['disposition', 'status'])) ?? 'unknown';
  const requestedActionState = normalizeCommunicationActionState(
    field(record, ['actionState', 'action_state']),
  );
  let actionState = requestedActionState;
  if (/failed|undelivered/.test(disposition)) actionState = 'failed';
  if (
    channel === 'call'
    && direction === 'inbound'
    && /missed|voicemail/.test(disposition)
  ) {
    actionState = 'needs_reply';
  }
  return {
    providerRecordId,
    channel,
    direction,
    occurredAt,
    disposition,
    actionState,
    preview: boundedText(field(record, ['preview', 'text', 'voicemail']), 240),
    conversationKey: normalizeProviderId(
      field(record, ['conversationId', 'conversation_id', 'threadId']),
    ) ?? 'quo_file_stream',
  };
}

function taskStatus(record) {
  if (
    record.is_completed === true ||
    record.isCompleted === true ||
    record.completed === true
  ) {
    return 'completed';
  }
  if (
    record.is_cancelled === true ||
    record.isCancelled === true ||
    record.cancelled === true
  ) {
    return 'cancelled';
  }
  const status = toCode(field(record, TASK_FIELDS.status));
  return status ?? 'open';
}

function taskPriority(value) {
  const code = toCode(value);
  if (['low', 'normal', 'high', 'urgent'].includes(code)) return code;
  if (code === 'medium') return 'normal';
  if (code === 'critical') return 'urgent';
  return 'normal';
}

function documentReviewState(value) {
  const code = toCode(value);
  if (!code) return 'unreviewed';
  if (['needs_review', 'review_required', 'new', 'unreviewed'].includes(code)) {
    return 'needs_review';
  }
  if (['in_review', 'reviewing'].includes(code)) return 'in_review';
  if (['reviewed', 'complete', 'completed'].includes(code)) return 'reviewed';
  return code;
}

function documentKind(fileName, type) {
  const name = normalizedLabel(fileName);
  if (/\bsettlement\b/.test(name) && /\b(?:estimate|scope)\b/.test(name)) {
    return 'settlement_estimate';
  }
  if (/\bdeclaration(?:s)?\b|\bdec page\b/.test(name))
    return 'declaration_page';
  if (/\bpolicy\b/.test(name)) return 'policy';
  if (/\bproof of loss\b/.test(name)) return 'proof_of_loss';
  if (/\bestimate\b/.test(name)) return 'estimate';
  if (/\bscope\b/.test(name)) return 'scope';
  return toCode(type) ?? 'document';
}

function isPhotoLikeDocument(record) {
  if (!isPlainObject(record)) return true;
  const name = String(field(record, DOCUMENT_FIELDS.name) ?? '').trim();
  const contentType = String(
    field(record, DOCUMENT_FIELDS.contentType) ?? '',
  ).toLowerCase();
  if (contentType.startsWith('image/')) return true;
  if (/\.(?:jpe?g|png|gif|heic|webp|tiff?)$/i.test(name)) return true;
  return /\b(?:photo report|photo file|roof photos?|site photos?|damage photos?|image report)\b/i.test(
    name,
  );
}

function normalizeDirection(value) {
  const code = toCode(value);
  if (['incoming', 'inbound', 'received'].includes(code)) return 'inbound';
  if (['outgoing', 'outbound', 'sent'].includes(code)) return 'outbound';
  return 'unknown';
}

function quoChannel(value) {
  const code = toCode(value);
  if (code === 'text' || code === 'message' || code === 'sms') return 'text';
  if (['call', 'missed_call', 'voicemail', 'voice'].includes(code)) {
    return 'call';
  }
  return 'unknown';
}

function normalizeCommunicationActionState(value) {
  const code = toCode(value);
  if (
    [
      'draft',
      'failed',
      'sent_verified',
      'unverified',
      'needs_reply',
      'awaiting_response',
      'responded',
      'no_action',
    ].includes(code)
  ) {
    return code;
  }
  return 'no_action';
}

function gmailDeliveryState(actionState, direction) {
  if (actionState === 'draft') return 'draft';
  if (actionState === 'failed') return 'failed';
  if (direction === 'inbound') return 'received';
  if (direction === 'outbound' && actionState === 'sent_verified') {
    return 'sent_verified';
  }
  if (direction === 'outbound') return 'unverified';
  return 'unknown';
}

function resolveCommunicationActionStates(source, items, complete) {
  const grouped = new Map();
  const resolved = items.map((item) => {
    const copy = { ...item };
    const key = copy.conversationKey;
    delete copy.conversationKey;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(copy);
    return copy;
  });
  if (!complete) return resolved;

  for (const group of grouped.values()) {
    const candidates = group
      .filter((item) => responseCandidate(source, item))
      .sort(
        (left, right) =>
          Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
          || left.providerRecordId.localeCompare(right.providerRecordId),
      );
    if (candidates.length === 0) continue;
    const latest = candidates[0];
    if (latest.direction === 'inbound') {
      latest.actionState = 'needs_reply';
    } else {
      latest.actionState = 'awaiting_response';
    }
  }
  return resolved;
}

function responseCandidate(source, item) {
  if (source === 'gmail') {
    if (isAutomatedJobNimbusTaskReminder(item)) return false;
    return item.deliveryState === 'received'
      || item.deliveryState === 'sent_verified';
  }
  if (source === 'quo' && item.channel === 'text') {
    return item.direction === 'inbound'
      || (
        item.direction === 'outbound'
        && item.disposition === 'delivered'
      );
  }
  return false;
}

function isAutomatedJobNimbusTaskReminder(item) {
  const subject = String(item?.subject || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return /^jobnimbus task reminders?(?:\b|$)/.test(subject);
}

function normalizeFreshness(input) {
  const source = requirePlainObject(input, 'provider envelope');
  const freshness = isPlainObject(source.freshness) ? source.freshness : source;
  const asOf = requireIsoTimestamp(freshness.asOf, 'asOf');
  const checkedAt = requireIsoTimestamp(freshness.checkedAt, 'checkedAt');
  const validUntil = requireIsoTimestamp(freshness.validUntil, 'validUntil');
  if (
    Date.parse(asOf) > Date.parse(checkedAt) ||
    Date.parse(checkedAt) > Date.parse(validUntil)
  ) {
    fail(
      'invalid_freshness',
      'Provider freshness timestamps are inconsistent.',
    );
  }
  return { asOf, checkedAt, validUntil };
}

function requireCompletePagination(input, collection) {
  if (!readCollectionPaginationState(input, collection)) {
    fail(
      'incomplete_pagination',
      `${collection} pagination is not verified complete.`,
    );
  }
}

function readCollectionPaginationState(input, collection) {
  const pagination = isPlainObject(input?.pagination) ? input.pagination : {};
  const singular = collection.endsWith('ies')
    ? `${collection.slice(0, -3)}y`
    : collection.endsWith('s')
      ? collection.slice(0, -1)
      : collection;
  const pascal = singular[0].toUpperCase() + singular.slice(1);
  const candidates = [
    input?.[`${collection}Complete`],
    input?.[`${singular}Complete`],
    pagination[`${collection}Complete`],
    pagination[`${singular}Complete`],
    pagination[collection],
    pagination.collection === collection ? pagination.complete : undefined,
    collection === 'contacts' ? pagination.complete : undefined,
    collection === 'items' ? pagination.complete : undefined,
    input?.[`is${pascal}Complete`],
  ].filter((value) => typeof value === 'boolean');
  if (candidates.length === 0) {
    fail(
      'incomplete_pagination',
      `${collection} pagination state is not verified.`,
    );
  }
  if (candidates.some((value) => value !== candidates[0])) {
    fail(
      'incomplete_pagination',
      `${collection} pagination state is inconsistent.`,
    );
  }
  return candidates[0];
}

function readCommunicationPaginationState(input) {
  const pagination = isPlainObject(input?.pagination) ? input.pagination : {};
  for (const value of [
    input?.itemsComplete,
    pagination.itemsComplete,
    pagination.items,
    pagination.collection === 'items' ? pagination.complete : undefined,
  ]) {
    if (value === true) return true;
    if (value === false) return false;
  }
  fail(
    'incomplete_pagination',
    'items pagination state is not verified.',
  );
}

function contactDisplayName(contact, maximumCharacters) {
  const direct = boundedText(
    field(contact, CONTACT_FIELDS.displayName),
    maximumCharacters,
  );
  if (direct) return direct;
  return boundedText(
    [
      field(contact, CONTACT_FIELDS.firstName),
      field(contact, CONTACT_FIELDS.lastName),
    ]
      .filter((value) => value !== undefined && value !== null)
      .join(' '),
    maximumCharacters,
  );
}

function contactAddress(contact) {
  const direct = boundedText(
    field(contact, CONTACT_FIELDS.propertyAddress),
    180,
  );
  if (direct) return direct;
  const street = [
    field(contact, CONTACT_FIELDS.address1),
    field(contact, CONTACT_FIELDS.address2),
  ]
    .map((value) => boundedText(value, 100))
    .filter(Boolean)
    .join(' ');
  const locality = [
    field(contact, CONTACT_FIELDS.city),
    field(contact, CONTACT_FIELDS.state),
    field(contact, CONTACT_FIELDS.zip),
  ]
    .map((value) => boundedText(value, 40))
    .filter(Boolean)
    .join(' ');
  return boundedText([street, locality].filter(Boolean).join(', '), 180);
}

function assertUniqueRecordIds(items, source) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.providerRecordId)) {
      fail(
        'duplicate_provider_record',
        `${source} evidence contains a duplicate provider record.`,
      );
    }
    seen.add(item.providerRecordId);
  }
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    fail('invalid_provider_payload', `${label} must be an array.`);
  }
  return value;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) {
    fail('invalid_provider_payload', `${label} must be a plain object.`);
  }
  return value;
}

function assignedOwnerIdFromOptions(options) {
  const value = options.assignedOwnerId ?? options.chanceOwnerId;
  return requireProviderId(value, 'assignedOwnerId');
}

function requireProviderId(value, label) {
  const normalized = normalizeProviderId(value);
  if (!normalized) {
    fail('invalid_configuration', `${label} is invalid.`);
  }
  return normalized;
}

function normalizeProviderId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value);
  return SAFE_PROVIDER_ID.test(normalized) ? normalized : null;
}

function requireIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) {
    fail('invalid_freshness', `${label} must be an ISO-8601 UTC timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail('invalid_freshness', `${label} must be an ISO-8601 UTC timestamp.`);
  }
  return value;
}

function normalizeProviderTimestamp(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 100000000000 ? value * 1000 : value;
    const parsed = new Date(milliseconds);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    return normalizeProviderTimestamp(Number(text));
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeNullableProviderTimestamp(value) {
  return value === undefined || value === null || value === ''
    ? null
    : normalizeProviderTimestamp(value);
}

function normalizeProviderDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    const timestamp = normalizeProviderTimestamp(value);
    return timestamp ? timestamp.slice(0, 10) : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^0+(?:\.0+)?$/.test(text)) return null;
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const usDate = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  let year;
  let month;
  let day;
  if (isoDate) {
    [, year, month, day] = isoDate;
  } else if (usDate) {
    [, month, day, year] = usDate;
    month = month.padStart(2, '0');
    day = day.padStart(2, '0');
  } else {
    const timestamp = normalizeProviderTimestamp(text);
    return timestamp ? timestamp.slice(0, 10) : null;
  }
  const candidate = `${year}-${month}-${day}`;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

function normalizeEmail(value) {
  const normalized = boundedText(value, 254);
  return normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

function normalizePhone(value) {
  const normalized = boundedText(value, 32);
  return normalized && /^[+()\d.\-\s]{7,32}$/.test(normalized)
    ? normalized
    : null;
}

function toCode(value) {
  const label = normalizedLabel(value);
  if (!label) return null;
  let code = label
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\-.]+|[_\-.]+$/g, '');
  if (!code) return null;
  if (!/^[a-z]/.test(code)) code = `value_${code}`;
  code = Array.from(code)
    .slice(0, 64)
    .join('')
    .replace(/[_\-.]+$/g, '');
  return SAFE_CODE.test(code) ? code : null;
}

function normalizedLabel(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function boundedText(value, maximumCharacters) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, maximumCharacters).join('');
}

function hasValue(value) {
  return (
    (typeof value === 'string' || typeof value === 'number') &&
    String(value).trim().length > 0
  );
}

function field(record, aliases) {
  if (!isPlainObject(record)) return undefined;
  for (const alias of aliases) {
    if (
      Object.prototype.hasOwnProperty.call(record, alias) &&
      record[alias] !== undefined &&
      record[alias] !== null &&
      record[alias] !== ''
    ) {
      return record[alias];
    }
  }
  const byLower = new Map(
    Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const alias of aliases) {
    const value = byLower.get(String(alias).toLowerCase());
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function immutableCopy(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableCopy(item)));
  }
  if (isPlainObject(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, immutableCopy(item)]),
      ),
    );
  }
  return value;
}

function fail(code, message) {
  throw new HcnProviderMappingError(code, message);
}
