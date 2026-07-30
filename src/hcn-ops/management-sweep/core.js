/**
 * Pure, read-only HCN management-sweep engine.
 *
 * The caller is responsible for resolving exact JobNimbus files and mapping
 * provider records into the minimized, normalized input contract below. This
 * module performs no I/O and has no write, send, call, memory, Chance Brain, or
 * approval capability.
 *
 * Only opaque file, adjuster, actor, and evidence references are accepted.
 * Provider identifiers and raw client content do not belong in this contract.
 */

export const MANAGEMENT_SWEEP_SCHEMA_VERSION =
  'hcn.console.management-sweep.v1';

export const MANAGEMENT_SWEEP_SOURCE_NAMES = Object.freeze([
  'jobnimbus',
  'gmail',
  'quo',
  'google_calendar',
  'retell',
]);

export const MANAGEMENT_SWEEP_EVENT_CODES = Object.freeze([
  // Verified successful communication.
  'email_received',
  'email_sent_verified',
  'text_received',
  'text_delivered',
  'call_answered',
  'call_completed',

  // A real attempt occurred, but successful communication is not proved.
  'email_send_failed',
  'text_sent_unconfirmed',
  'text_failed',
  'call_no_answer',
  'call_missed',
  'voicemail_left',
  'outbound_call_failed',

  // Meaningful file progress that is not itself communication.
  'note_substantive',
  'task_completed',
  'claim_filed',
  'claim_result_recorded',
  'appointment_scheduled',
  'appointment_rescheduled',
  'appointment_completed',
  'document_received',
  'document_uploaded',
  'document_reviewed',
  'status_progressed',
  'estimate_created',
  'estimate_revised',
  'supplement_submitted',
  'settlement_received',
  'settlement_reviewed',
  'payment_received',
  'payment_follow_up',

  // Explicit noise or unverified delivery. These never reset a gap.
  'email_draft',
  'email_outbound_unverified',
  'text_draft',
  'note_cosmetic',
  'note_automated',
  'task_created',
  'task_reassigned',
  'reminder_generated',
  'file_opened',
  'status_cosmetic',
  'duplicate',
  'system_sync',
  'unknown',
]);

export const MANAGEMENT_SWEEP_EXCLUSION_CODES = Object.freeze([
  'inactive_file',
  'unconfigured_adjuster',
]);

const SUCCESSFUL_COMMUNICATION_CODES = new Set([
  'email_received',
  'email_sent_verified',
  'text_received',
  'text_delivered',
  'call_answered',
  'call_completed',
]);

const CONTACT_ATTEMPT_ONLY_CODES = new Set([
  'email_send_failed',
  'text_sent_unconfirmed',
  'text_failed',
  'call_no_answer',
  'call_missed',
  'voicemail_left',
  'outbound_call_failed',
]);

const OPERATIONAL_ACTIVITY_CODES = new Set([
  'note_substantive',
  'task_completed',
  'claim_filed',
  'claim_result_recorded',
  'appointment_scheduled',
  'appointment_rescheduled',
  'appointment_completed',
  'document_received',
  'document_uploaded',
  'document_reviewed',
  'status_progressed',
  'estimate_created',
  'estimate_revised',
  'supplement_submitted',
  'settlement_received',
  'settlement_reviewed',
  'payment_received',
  'payment_follow_up',
]);

const NOISE_CODES = new Set(
  MANAGEMENT_SWEEP_EVENT_CODES.filter(
    (code) =>
      !SUCCESSFUL_COMMUNICATION_CODES.has(code) &&
      !CONTACT_ATTEMPT_ONLY_CODES.has(code) &&
      !OPERATIONAL_ACTIVITY_CODES.has(code),
  ),
);

const SOURCE_STATUSES = new Set(['fresh', 'stale', 'unavailable', 'unknown']);
const SOURCE_COMPLETENESS = new Set(['complete', 'partial', 'none']);
const FILE_STATUSES = new Set(['active', 'inactive']);
const RANKING_MODES = new Set(['activity_only', 'full_management']);
const SOURCE_NAMES = new Set(MANAGEMENT_SWEEP_SOURCE_NAMES);
const EVENT_CODES = new Set(MANAGEMENT_SWEEP_EVENT_CODES);
const FILE_REF = /^subject_[a-f0-9]{32}$/;
const ADJUSTER_REF = /^adjuster_[a-f0-9]{16,64}$/;
const ACTOR_REF = /^(?:adjuster|actor)_[a-f0-9]{16,64}$/;
const EVIDENCE_REF = /^ref_[a-f0-9]{16,64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MILLISECONDS_PER_DAY = 86_400_000;
const MAX_FILES = 10_000;
const MAX_EVENTS_PER_FILE = 10_000;
const MAX_LIMIT_PER_ADJUSTER = 100;

const TOP_LEVEL_FIELDS = Object.freeze([
  'generatedAt',
  'adjusters',
  'requiredSources',
  'files',
  'limitPerAdjuster',
  'rankingMode',
]);
const ADJUSTER_FIELDS = Object.freeze(['adjusterRef']);
const FILE_FIELDS = Object.freeze([
  'fileRef',
  'status',
  'assignedAdjusterRef',
  'activeSince',
  'sources',
  'events',
]);
const SOURCE_FIELDS = Object.freeze([
  'source',
  'status',
  'completeness',
  'asOf',
  'checkedAt',
  'validUntil',
]);
const EVENT_FIELDS = Object.freeze([
  'reference',
  'source',
  'eventCode',
  'occurredAt',
  'actorRef',
]);

/**
 * Build a deterministic management sweep over already-normalized exact files.
 *
 * Input order has no effect on ranking or output order, except that the
 * explicit adjuster configuration order is preserved as the requested report
 * grouping order.
 */
export function buildManagementSweep(input) {
  assertExactObject(input, TOP_LEVEL_FIELDS, 'managementSweep');
  const generatedAt = normalizeTimestamp(
    input.generatedAt,
    'managementSweep.generatedAt',
  );
  const generatedAtMs = Date.parse(generatedAt);
  const limitPerAdjuster = normalizeLimit(input.limitPerAdjuster);
  const rankingMode = normalizeRankingMode(input.rankingMode);
  const adjusters = normalizeAdjusters(input.adjusters);
  const adjusterRefs = new Set(
    adjusters.map((adjuster) => adjuster.adjusterRef),
  );
  const requiredSources = normalizeRequiredSources(input.requiredSources);
  const files = normalizeFiles(input.files, generatedAtMs);

  const exclusions = [];
  const eligible = [];

  for (const file of files) {
    if (file.status !== 'active') {
      exclusions.push({
        fileRef: file.fileRef,
        assignedAdjusterRef: file.assignedAdjusterRef,
        reasonCode: 'inactive_file',
      });
      continue;
    }
    if (!adjusterRefs.has(file.assignedAdjusterRef)) {
      exclusions.push({
        fileRef: file.fileRef,
        assignedAdjusterRef: file.assignedAdjusterRef,
        reasonCode: 'unconfigured_adjuster',
      });
      continue;
    }
    eligible.push(
      evaluateFile({
        file,
        requiredSources,
        rankingMode,
        generatedAt,
        generatedAtMs,
      }),
    );
  }

  eligible.sort(compareRankedFiles);
  exclusions.sort(compareExclusions);

  const adjusterGroups = adjusters.map(({ adjusterRef }) => {
    const assigned = eligible
      .filter((file) => file.assignedAdjusterRef === adjusterRef)
      .sort(compareRankedFiles);
    const selected = assigned.slice(0, limitPerAdjuster);
    return {
      adjusterRef,
      eligibleCount: assigned.length,
      returnedCount: selected.length,
      requestedCount: limitPerAdjuster,
      shortage:
        selected.length < limitPerAdjuster
          ? {
              isShort: true,
              missingCount: limitPerAdjuster - selected.length,
              reasonCode: 'fewer_eligible_files',
            }
          : {
              isShort: false,
              missingCount: 0,
              reasonCode: null,
            },
      items: selected.map((file, index) =>
        presentRankedFile(file, {
          adjusterRank: index + 1,
          companyRank: null,
        }),
      ),
    };
  });

  const companyWorst = eligible.slice(0, 10).map((file, index) => {
    const adjusterFiles = eligible
      .filter(
        (candidate) =>
          candidate.assignedAdjusterRef === file.assignedAdjusterRef,
      )
      .sort(compareRankedFiles);
    const adjusterRank =
      adjusterFiles.findIndex(
        (candidate) => candidate.fileRef === file.fileRef,
      ) + 1;
    return presentRankedFile(file, {
      adjusterRank,
      companyRank: index + 1,
    });
  });

  const evidenceSummary = {
    completeFiles: eligible.filter(
      (file) => file.evidenceHealth.status === 'complete',
    ).length,
    partialFiles: eligible.filter(
      (file) => file.evidenceHealth.status === 'partial',
    ).length,
    insufficientFiles: eligible.filter(
      (file) => file.evidenceHealth.status === 'insufficient',
    ).length,
  };

  return immutableCopy({
    schemaVersion: MANAGEMENT_SWEEP_SCHEMA_VERSION,
    generatedAt,
    authority: {
      mode: 'read_only',
      canWrite: false,
      canSend: false,
      canCall: false,
      canApprove: false,
    },
    criteria: {
      limitPerAdjuster,
      companyLimit: 10,
      requiredSources,
      rankingMode,
      ranking:
        rankingMode === 'activity_only'
          ? 'greatest_verified_operational_activity_gap_then_file_ref'
          : 'greatest_unresolved_gap_then_communication_then_operational_then_adjuster_then_file_ref',
    },
    summary: {
      configuredAdjusterCount: adjusters.length,
      inputFileCount: files.length,
      eligibleFileCount: eligible.length,
      returnedAcrossAdjusters: adjusterGroups.reduce(
        (total, group) => total + group.returnedCount,
        0,
      ),
      exclusionCount: exclusions.length,
      evidence: evidenceSummary,
    },
    adjusters: adjusterGroups,
    companyWorst,
    exclusions,
  });
}

export class ManagementSweepContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManagementSweepContractError';
  }
}

function normalizeLimit(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_LIMIT_PER_ADJUSTER
  ) {
    fail(
      `managementSweep.limitPerAdjuster must be an integer from 1 to ${MAX_LIMIT_PER_ADJUSTER}`,
    );
  }
  return value;
}

function normalizeRankingMode(value) {
  if (!RANKING_MODES.has(value)) {
    fail(
      'managementSweep.rankingMode must be activity_only or full_management',
    );
  }
  return value;
}

function normalizeAdjusters(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('managementSweep.adjusters must contain at least one identity');
  }
  const seen = new Set();
  return value.map((candidate, index) => {
    const path = `managementSweep.adjusters[${index}]`;
    assertExactObject(candidate, ADJUSTER_FIELDS, path);
    if (!ADJUSTER_REF.test(candidate.adjusterRef)) {
      fail(`${path}.adjusterRef must be an opaque adjuster reference`);
    }
    if (seen.has(candidate.adjusterRef)) {
      fail('managementSweep.adjusters cannot contain duplicate identities');
    }
    seen.add(candidate.adjusterRef);
    return { adjusterRef: candidate.adjusterRef };
  });
}

function normalizeRequiredSources(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('managementSweep.requiredSources must not be empty');
  }
  const unique = new Set();
  for (const [index, source] of value.entries()) {
    if (!SOURCE_NAMES.has(source)) {
      fail(
        `managementSweep.requiredSources[${index}] is not an allowlisted source`,
      );
    }
    if (unique.has(source)) {
      fail('managementSweep.requiredSources cannot contain duplicates');
    }
    unique.add(source);
  }
  return [...unique].sort();
}

function normalizeFiles(value, generatedAtMs) {
  if (!Array.isArray(value) || value.length > MAX_FILES) {
    fail(
      `managementSweep.files must be an array with at most ${MAX_FILES} files`,
    );
  }
  const seenFiles = new Set();
  const normalized = value.map((candidate, index) => {
    const path = `managementSweep.files[${index}]`;
    assertExactObject(candidate, FILE_FIELDS, path);
    if (!FILE_REF.test(candidate.fileRef)) {
      fail(`${path}.fileRef must be an opaque HCN file reference`);
    }
    if (seenFiles.has(candidate.fileRef)) {
      fail('managementSweep.files cannot contain duplicate file references');
    }
    seenFiles.add(candidate.fileRef);
    if (!FILE_STATUSES.has(candidate.status)) {
      fail(`${path}.status must be active or inactive`);
    }
    if (!ADJUSTER_REF.test(candidate.assignedAdjusterRef)) {
      fail(`${path}.assignedAdjusterRef must be an opaque adjuster reference`);
    }
    const activeSince = normalizeTimestamp(
      candidate.activeSince,
      `${path}.activeSince`,
    );
    if (Date.parse(activeSince) > generatedAtMs) {
      fail(`${path}.activeSince cannot be in the future`);
    }
    const sources = normalizeSources(candidate.sources, generatedAtMs, path);
    const events = normalizeEvents(
      candidate.events,
      sources,
      activeSince,
      generatedAtMs,
      path,
    );
    return {
      fileRef: candidate.fileRef,
      status: candidate.status,
      assignedAdjusterRef: candidate.assignedAdjusterRef,
      activeSince,
      sources,
      events,
    };
  });
  return normalized.sort((left, right) =>
    left.fileRef.localeCompare(right.fileRef),
  );
}

function normalizeSources(value, generatedAtMs, filePath) {
  if (!Array.isArray(value) || value.length > SOURCE_NAMES.size) {
    fail(
      `${filePath}.sources must be an array with at most ${SOURCE_NAMES.size} source states`,
    );
  }
  const seen = new Set();
  return value
    .map((candidate, index) => {
      const path = `${filePath}.sources[${index}]`;
      assertExactObject(candidate, SOURCE_FIELDS, path);
      if (!SOURCE_NAMES.has(candidate.source)) {
        fail(`${path}.source is not allowlisted`);
      }
      if (seen.has(candidate.source)) {
        fail(`${filePath}.sources cannot contain duplicate sources`);
      }
      seen.add(candidate.source);
      if (!SOURCE_STATUSES.has(candidate.status)) {
        fail(`${path}.status is not supported`);
      }
      if (!SOURCE_COMPLETENESS.has(candidate.completeness)) {
        fail(`${path}.completeness is not supported`);
      }
      const checkedAt = normalizeTimestamp(
        candidate.checkedAt,
        `${path}.checkedAt`,
      );
      if (Date.parse(checkedAt) > generatedAtMs) {
        fail(`${path}.checkedAt cannot be in the future`);
      }
      const asOf = normalizeNullableTimestamp(candidate.asOf, `${path}.asOf`);
      const validUntil = normalizeNullableTimestamp(
        candidate.validUntil,
        `${path}.validUntil`,
      );

      if (
        candidate.status === 'unavailable' ||
        candidate.status === 'unknown'
      ) {
        if (
          candidate.completeness !== 'none' ||
          asOf !== null ||
          validUntil !== null
        ) {
          fail(
            `${path} unavailable/unknown sources require none completeness and null evidence times`,
          );
        }
      } else {
        if (asOf === null || validUntil === null) {
          fail(`${path} fresh/stale sources require asOf and validUntil`);
        }
        if (Date.parse(asOf) > Date.parse(checkedAt)) {
          fail(`${path}.asOf cannot follow checkedAt`);
        }
        if (Date.parse(validUntil) < Date.parse(checkedAt)) {
          fail(`${path}.validUntil cannot precede checkedAt`);
        }
        if (candidate.completeness === 'none') {
          fail(`${path} fresh/stale sources cannot have none completeness`);
        }
      }

      const effectiveStatus =
        candidate.status === 'fresh' &&
        validUntil !== null &&
        Date.parse(validUntil) < generatedAtMs
          ? 'stale'
          : candidate.status;

      return {
        source: candidate.source,
        status: effectiveStatus,
        completeness: candidate.completeness,
        asOf,
        checkedAt,
        validUntil,
      };
    })
    .sort((left, right) => left.source.localeCompare(right.source));
}

function normalizeEvents(value, sources, activeSince, generatedAtMs, filePath) {
  if (!Array.isArray(value) || value.length > MAX_EVENTS_PER_FILE) {
    fail(
      `${filePath}.events must be an array with at most ${MAX_EVENTS_PER_FILE} events`,
    );
  }
  const sourceNames = new Set(sources.map((source) => source.source));
  const seen = new Set();
  return value
    .map((candidate, index) => {
      const path = `${filePath}.events[${index}]`;
      assertExactObject(candidate, EVENT_FIELDS, path);
      if (!EVIDENCE_REF.test(candidate.reference)) {
        fail(`${path}.reference must be an opaque evidence reference`);
      }
      if (seen.has(candidate.reference)) {
        fail(`${filePath}.events cannot contain duplicate references`);
      }
      seen.add(candidate.reference);
      if (!SOURCE_NAMES.has(candidate.source)) {
        fail(`${path}.source is not allowlisted`);
      }
      if (!sourceNames.has(candidate.source)) {
        fail(`${path}.source requires a matching source state`);
      }
      if (!EVENT_CODES.has(candidate.eventCode)) {
        fail(`${path}.eventCode is not supported`);
      }
      const occurredAt = normalizeTimestamp(
        candidate.occurredAt,
        `${path}.occurredAt`,
      );
      if (Date.parse(occurredAt) > generatedAtMs) {
        fail(`${path}.occurredAt cannot be in the future`);
      }
      if (Date.parse(occurredAt) < Date.parse(activeSince)) {
        fail(`${path}.occurredAt cannot precede the active file period`);
      }
      const actorRef = candidate.actorRef === null ? null : candidate.actorRef;
      if (actorRef !== null && !ACTOR_REF.test(actorRef)) {
        fail(`${path}.actorRef must be null or an opaque actor reference`);
      }
      return {
        reference: candidate.reference,
        source: candidate.source,
        eventCode: candidate.eventCode,
        occurredAt,
        actorRef,
      };
    })
    .sort(compareEvents);
}

function evaluateFile({
  file,
  requiredSources,
  rankingMode,
  generatedAt,
  generatedAtMs,
}) {
  const sourceByName = new Map(
    file.sources.map((source) => [source.source, source]),
  );
  const evidenceHealth = evaluateEvidenceHealth(requiredSources, sourceByName);
  const usableSources = new Set(
    file.sources
      .filter((source) => source.status === 'fresh')
      .map((source) => source.source),
  );

  const acceptedEvents = [];
  const ignoredEvents = [];
  for (const event of file.events) {
    if (!usableSources.has(event.source)) {
      ignoredEvents.push(event);
      continue;
    }
    acceptedEvents.push({
      ...event,
      classification: classifyEvent(
        event,
        file.assignedAdjusterRef,
        rankingMode,
      ),
    });
  }

  const successful = acceptedEvents.filter(
    (event) => event.classification.successfulCommunication,
  );
  const contactAttempts = acceptedEvents.filter(
    (event) => event.classification.contactAttempt,
  );
  const operational = acceptedEvents.filter(
    (event) => event.classification.meaningfulOperationalActivity,
  );
  const assignedAdjuster = acceptedEvents.filter(
    (event) => event.classification.assignedAdjusterActivity,
  );
  const meaningful = acceptedEvents.filter(
    (event) => !event.classification.noise,
  );
  const noiseCount = acceptedEvents.filter(
    (event) => event.classification.noise,
  ).length;

  const gaps = {
    successfulCommunication:
      rankingMode === 'activity_only'
        ? buildUnavailableGap()
        : buildGap(latestEvent(successful), file.activeSince, generatedAtMs),
    contactAttempt:
      rankingMode === 'activity_only'
        ? buildUnavailableGap()
        : buildGap(
            latestEvent(contactAttempts),
            file.activeSince,
            generatedAtMs,
          ),
    operationalActivity: buildGap(
      latestEvent(operational),
      file.activeSince,
      generatedAtMs,
    ),
    assignedAdjusterActivity:
      rankingMode === 'activity_only'
        ? buildUnavailableGap()
        : buildGap(
            latestEvent(assignedAdjuster),
            file.activeSince,
            generatedAtMs,
          ),
    anyMeaningfulTouch: buildGap(
      latestEvent(meaningful),
      file.activeSince,
      generatedAtMs,
    ),
  };

  const rankedMetrics =
    rankingMode === 'activity_only'
      ? [['operational_gap', gaps.operationalActivity]]
      : [
          ['communication_gap', gaps.successfulCommunication],
          ['operational_gap', gaps.operationalActivity],
          ['assigned_adjuster_gap', gaps.assignedAdjusterActivity],
        ];
  const unresolvedGapMilliseconds = Math.max(
    ...rankedMetrics.map(([, gap]) => gap.milliseconds),
  );
  const attentionReasons = rankedMetrics
    .filter(([, gap]) => gap.milliseconds === unresolvedGapMilliseconds)
    .map(([reason]) => reason)
    .sort();
  if (evidenceHealth.status !== 'complete') {
    attentionReasons.push('evidence_incomplete');
  }

  return {
    fileRef: file.fileRef,
    status: 'active',
    assignedAdjusterRef: file.assignedAdjusterRef,
    activeSince: file.activeSince,
    generatedAt,
    gaps,
    attention: {
      unresolvedGapDays: wholeDays(unresolvedGapMilliseconds),
      unresolvedGapMilliseconds,
      reasonCodes: attentionReasons,
    },
    evidenceHealth,
    eventSummary: {
      acceptedEventCount: acceptedEvents.length,
      ignoredUnfreshEventCount: ignoredEvents.length,
      successfulCommunicationCount: successful.length,
      contactAttemptCount: contactAttempts.length,
      operationalActivityCount: operational.length,
      assignedAdjusterActivityCount: assignedAdjuster.length,
      noiseCount,
    },
  };
}

function classifyEvent(event, assignedAdjusterRef, rankingMode) {
  const successfulCommunication = SUCCESSFUL_COMMUNICATION_CODES.has(
    event.eventCode,
  );
  const contactAttempt =
    successfulCommunication || CONTACT_ATTEMPT_ONLY_CODES.has(event.eventCode);
  const taskTimestampUnsupported =
    rankingMode === 'activity_only' && event.eventCode === 'task_completed';
  const meaningfulOperationalActivity =
    OPERATIONAL_ACTIVITY_CODES.has(event.eventCode) &&
    !taskTimestampUnsupported;
  const noise = NOISE_CODES.has(event.eventCode) || taskTimestampUnsupported;
  const assignedAdjusterActivity =
    event.actorRef === assignedAdjusterRef &&
    (contactAttempt || meaningfulOperationalActivity);
  return {
    successfulCommunication,
    contactAttempt,
    meaningfulOperationalActivity,
    assignedAdjusterActivity,
    noise,
  };
}

function evaluateEvidenceHealth(requiredSources, sourceByName) {
  const sourceStates = requiredSources.map((source) => {
    const state = sourceByName.get(source);
    if (!state) {
      return {
        source,
        status: 'unavailable',
        completeness: 'none',
      };
    }
    return {
      source,
      status: state.status,
      completeness: state.completeness,
    };
  });
  const freshSources = sourceStates
    .filter((source) => source.status === 'fresh')
    .map((source) => source.source);
  const partialSources = sourceStates
    .filter(
      (source) =>
        source.status === 'fresh' && source.completeness === 'partial',
    )
    .map((source) => source.source);
  const staleSources = sourceStates
    .filter((source) => source.status === 'stale')
    .map((source) => source.source);
  const unavailableSources = sourceStates
    .filter(
      (source) =>
        source.status === 'unavailable' || source.status === 'unknown',
    )
    .map((source) => source.source);
  const allComplete =
    sourceStates.length > 0 &&
    sourceStates.every(
      (source) =>
        source.status === 'fresh' && source.completeness === 'complete',
    );
  const usableCount = freshSources.length;
  const status = allComplete
    ? 'complete'
    : usableCount === 0
      ? 'insufficient'
      : 'partial';
  const freshness = allComplete
    ? 'fresh'
    : usableCount > 0
      ? 'mixed'
      : staleSources.length > 0
        ? 'stale'
        : 'unavailable';
  const completeness = allComplete
    ? 'complete'
    : usableCount > 0
      ? 'partial'
      : 'none';

  return {
    status,
    freshness,
    completeness,
    freshSources,
    partialSources,
    staleSources,
    unavailableSources,
    requiredSources: [...requiredSources],
  };
}

function buildGap(latest, activeSince, generatedAtMs) {
  const sinceAt = latest?.occurredAt ?? activeSince;
  const milliseconds = generatedAtMs - Date.parse(sinceAt);
  return {
    availability: 'evaluated',
    lastAt: latest?.occurredAt ?? null,
    lastEvidenceRef: latest?.reference ?? null,
    lastSource: latest?.source ?? null,
    sinceAt,
    basis: latest ? 'verified_event' : 'active_since',
    days: wholeDays(milliseconds),
    milliseconds,
  };
}

function buildUnavailableGap() {
  return {
    availability: 'not_evaluated',
    lastAt: null,
    lastEvidenceRef: null,
    lastSource: null,
    sinceAt: null,
    basis: 'not_evaluated',
    days: null,
    milliseconds: null,
  };
}

function latestEvent(events) {
  if (events.length === 0) return null;
  return events.reduce((latest, event) => {
    if (!latest) return event;
    return compareEvents(event, latest) < 0 ? event : latest;
  }, null);
}

function compareEvents(left, right) {
  const time = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
  if (time !== 0) return time;
  return left.reference.localeCompare(right.reference);
}

function compareRankedFiles(left, right) {
  const unresolved =
    right.attention.unresolvedGapMilliseconds -
    left.attention.unresolvedGapMilliseconds;
  if (unresolved !== 0) return unresolved;
  const communication =
    right.gaps.successfulCommunication.milliseconds -
    left.gaps.successfulCommunication.milliseconds;
  if (communication !== 0) return communication;
  const operational =
    right.gaps.operationalActivity.milliseconds -
    left.gaps.operationalActivity.milliseconds;
  if (operational !== 0) return operational;
  const adjuster =
    right.gaps.assignedAdjusterActivity.milliseconds -
    left.gaps.assignedAdjusterActivity.milliseconds;
  if (adjuster !== 0) return adjuster;
  return left.fileRef.localeCompare(right.fileRef);
}

function compareExclusions(left, right) {
  const file = left.fileRef.localeCompare(right.fileRef);
  return file !== 0 ? file : left.reasonCode.localeCompare(right.reasonCode);
}

function presentRankedFile(file, { adjusterRank, companyRank }) {
  return {
    fileRef: file.fileRef,
    status: file.status,
    assignedAdjusterRef: file.assignedAdjusterRef,
    activeSince: file.activeSince,
    adjusterRank,
    companyRank,
    attention: file.attention,
    gaps: file.gaps,
    evidenceHealth: file.evidenceHealth,
    eventSummary: file.eventSummary,
  };
}

function wholeDays(milliseconds) {
  return Math.floor(milliseconds / MILLISECONDS_PER_DAY);
}

function normalizeTimestamp(value, path) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) {
    fail(`${path} must be an ISO-8601 UTC timestamp with milliseconds`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${path} must be a canonical ISO-8601 UTC timestamp`);
  }
  return value;
}

function normalizeNullableTimestamp(value, path) {
  return value === null ? null : normalizeTimestamp(value, path);
}

function assertExactObject(value, allowedFields, path) {
  if (!isPlainObject(value)) fail(`${path} must be a plain object`);
  const actualFields = Object.keys(value);
  for (const field of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      fail(`${path}.${field} is required`);
    }
  }
  for (const field of actualFields) {
    if (!allowedFields.includes(field)) {
      fail(`${path}.${field} is not allowed`);
    }
  }
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

function fail(message) {
  throw new ManagementSweepContractError(message);
}
