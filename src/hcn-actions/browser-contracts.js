/**
 * HCN browser action contracts.
 *
 * This module is deliberately pure. Browser inputs contain only opaque HCN
 * references and exact human-authored action material. Provider identifiers
 * are introduced by injected server-side resolvers and are accepted only by
 * the private action-engine request. Public review projections are rebuilt
 * from an allowlist after the engine dry run is checked against that request.
 */

const FILE_REF_PATTERN = /^subject_[a-f0-9]{32}$/;
const TASK_REF_PATTERN = /^ref_[a-f0-9]{32}$/;
const EVENT_REF_PATTERN = /^ref_[a-f0-9]{32}$/;
const DOCUMENT_REF_PATTERN = /^ref_[a-f0-9]{32}$/;
const DRAFT_REF_PATTERN = /^ref_[a-f0-9]{32}$/;
const PLAN_ID_PATTERN = /^plan_[a-f0-9]{32}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{40,100}$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const MIME_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MIN_OPERATIONS = 1;
const MAX_OPERATIONS = 12;
const MAX_NOTE_BYTES = 8 * 1024;
const MAX_DESCRIPTION_BYTES = 4 * 1024;
const MAX_TITLE_CHARACTERS = 256;
const MAX_STATUS_CHARACTERS = 128;
const MAX_DISPLAY_LABEL_CHARACTERS = 256;
const MAX_PROVIDER_ID_BYTES = 1024;
const MAX_EMAIL_ADDRESS_LIST_BYTES = 2 * 1024;
const MAX_EMAIL_SUBJECT_CHARACTERS = 998;
const MAX_EMAIL_BODY_BYTES = 48 * 1024;
const MAX_QUO_MESSAGE_CHARACTERS = 1600;
const MAX_GMAIL_ATTACHMENTS = 25;
const MAX_GMAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const HCN_BROWSER_ACTION_TYPES = Object.freeze([
  "jobnimbus.create_note",
  "jobnimbus.create_task",
  "jobnimbus.update_task",
  "jobnimbus.update_status",
  "jobnimbus.update_contact",
  "jobnimbus.create_calendar_event",
  "jobnimbus.update_calendar_event",
  "gmail.create_draft",
  "gmail.send",
  "quo.send_text"
]);

const ACTION_TYPES = new Set([
  ...HCN_BROWSER_ACTION_TYPES,
  "gmail.send_existing_draft"
]);

/**
 * Validate and immutably copy an HCN action-prepare browser request.
 */
export function validateHcnBrowserActionPrepareInput(value) {
  exactRecord(value, ["fileRef", "operations"], [], "prepare request");
  const fileRef = opaqueReference(
    value.fileRef,
    FILE_REF_PATTERN,
    "fileRef"
  );
  if (
    !Array.isArray(value.operations)
    || value.operations.length < MIN_OPERATIONS
    || value.operations.length > MAX_OPERATIONS
  ) {
    invalid(
      "invalid_operations",
      "operations must contain 1-12 exact actions"
    );
  }

  const operations = value.operations.map((operation, index) =>
    validateBrowserOperation(operation, `operations[${index}]`)
  );
  const carrierEmailOperation = operations.some((operation) => (
    operation.type === "gmail.send_existing_draft"
    || (
      operation.type === "gmail.create_draft"
      && operation.input.insuranceClaimEmail === true
    )
  ));
  if (carrierEmailOperation && operations.length !== 1) {
    invalid(
      "invalid_gmail_batch",
      "A Gmail draft or existing-draft send must be the only action in its approval plan"
    );
  }
  return immutableCopy({ fileRef, operations });
}

/**
 * Execution is an action-time approval of one already reviewed server plan.
 * The digest and challenge never make a browser round trip.
 */
export function validateHcnBrowserActionExecuteInput(value) {
  return validatePlanRequest(value, "execute request");
}

export function validateHcnBrowserActionInvalidateInput(value) {
  return validatePlanRequest(value, "invalidate request");
}

export function validateHcnBrowserActionDetailInput(value) {
  return validatePlanRequest(value, "detail request");
}

export function validateHcnBrowserActionListInput(value) {
  exactRecord(value, [], [], "list request");
  return Object.freeze({});
}

/**
 * Translate a validated browser request to the existing action-engine shape.
 *
 * The returned value is private server data. It intentionally contains the
 * resolved JobNimbus identifiers and must never be serialized to the browser.
 * Resolver failures and malformed resolver output are replaced by a bounded,
 * privacy-safe error.
 */
export async function translateHcnBrowserActionsToPrivateEngineRequest(
  value,
  {
    resolveProviderJobId,
    resolveProviderTaskId,
    resolveProviderEventId,
    resolveProviderDocumentId,
    resolveProviderDraftId
  } = {}
) {
  const request = validateHcnBrowserActionPrepareInput(value);
  if (typeof resolveProviderJobId !== "function") {
    throw new TypeError("resolveProviderJobId must be a function");
  }
  if (
    request.operations.some(
      (operation) => operation.type === "jobnimbus.update_task"
    )
    && typeof resolveProviderTaskId !== "function"
  ) {
    throw new TypeError(
      "resolveProviderTaskId must be a function for task updates"
    );
  }
  if (
    request.operations.some(
      (operation) => operation.type === "jobnimbus.update_calendar_event"
    )
    && typeof resolveProviderEventId !== "function"
  ) {
    throw new TypeError(
      "resolveProviderEventId must be a function for calendar-event updates"
    );
  }
  if (
    request.operations.some((operation) => (
      operation.type === "gmail.create_draft"
      && operation.input.insuranceClaimEmail === true
    ))
    && typeof resolveProviderDocumentId !== "function"
  ) {
    throw new TypeError(
      "resolveProviderDocumentId must be a function for Gmail attachments"
    );
  }
  if (
    request.operations.some((operation) => (
      operation.type === "gmail.send"
      || operation.type === "gmail.send_existing_draft"
    ))
    && typeof resolveProviderDraftId !== "function"
  ) {
    throw new TypeError(
      "resolveProviderDraftId must be a function for reviewed-draft sends"
    );
  }

  const providerJobId = await resolvePrivateIdentifier(
    resolveProviderJobId,
    Object.freeze({ fileRef: request.fileRef }),
    "file"
  );
  const operations = [];

  for (const operation of request.operations) {
    let providerTaskId = "";
    let providerEventId = "";
    let providerDraftId = "";
    const providerDocumentIds = [];
    if (operation.type === "jobnimbus.update_task") {
      providerTaskId = await resolvePrivateIdentifier(
        resolveProviderTaskId,
        Object.freeze({
          fileRef: request.fileRef,
          taskRef: operation.input.taskRef,
          providerJobId
        }),
        "task"
      );
    }
    if (operation.type === "jobnimbus.update_calendar_event") {
      providerEventId = await resolvePrivateIdentifier(
        resolveProviderEventId,
        Object.freeze({
          fileRef: request.fileRef,
          eventRef: operation.input.eventRef,
          providerJobId
        }),
        "event"
      );
    }
    if (
      operation.type === "gmail.create_draft"
      && operation.input.insuranceClaimEmail === true
    ) {
      for (const attachment of operation.input.attachments) {
        providerDocumentIds.push(await resolvePrivateIdentifier(
          resolveProviderDocumentId,
          Object.freeze({
            fileRef: request.fileRef,
            documentRef: attachment.documentRef,
            providerJobId
          }),
          "document"
        ));
      }
    }
    if (
      operation.type === "gmail.send"
      || operation.type === "gmail.send_existing_draft"
    ) {
      providerDraftId = await resolvePrivateIdentifier(
        resolveProviderDraftId,
        Object.freeze({
          fileRef: request.fileRef,
          draftRef: operation.input.draftRef,
          providerJobId
        }),
        "draft"
      );
    }
    operations.push(
      privateEngineOperation(
        operation,
        providerJobId,
        providerTaskId,
        providerEventId,
        providerDocumentIds,
        providerDraftId
      )
    );
  }

  return immutableCopy({ operations });
}

/**
 * Build the only browser-safe review projection of an action-engine dry run.
 *
 * The private engine request is required so provider scope and canonical
 * engine output can be cross-checked before any human-facing plan is emitted.
 * Unknown wrapper, plan, body, or field shapes fail closed.
 */
export function projectHcnBrowserActionDryRun({
  prepareInput,
  privateEngineRequest,
  engineDryRun,
  fileDisplayLabel
} = {}) {
  const request = validateHcnBrowserActionPrepareInput(prepareInput);
  const label = boundedString(fileDisplayLabel, {
    label: "fileDisplayLabel",
    maxCharacters: MAX_DISPLAY_LABEL_CHARACTERS,
    allowEmpty: false,
    allowMultiline: false
  });
  const privateContext = validatePrivateEngineRequest(
    privateEngineRequest,
    request
  );
  const dryRun = validateEngineDryRun(engineDryRun, request.operations.length);
  const operations = dryRun.operations.map((engineOperation, index) =>
    projectEngineOperation({
      browserOperation: request.operations[index],
      engineOperation,
      privateOperation: privateContext.operations[index],
      index
    })
  );

  return immutableCopy({
    schema: "hcn-browser-action-plan/v1",
    file: {
      reference: request.fileRef,
      displayLabel: label
    },
    operationCount: operations.length,
    approvalExpiresAt: dryRun.approvalExpiresAt,
    operations
  });
}

export class HcnBrowserActionContractError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.name = "HcnBrowserActionContractError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validatePlanRequest(value, label) {
  exactRecord(value, ["planId"], [], label);
  return Object.freeze({
    planId: opaqueReference(value.planId, PLAN_ID_PATTERN, "planId")
  });
}

function validateBrowserOperation(value, label) {
  exactRecord(value, ["type", "input"], [], label);
  if (typeof value.type !== "string" || !ACTION_TYPES.has(value.type)) {
    invalid("unsupported_action_type", "Action type is not enabled for HCN v1");
  }
  const input = validateBrowserOperationInput(value.type, value.input, label);
  return immutableCopy({ type: value.type, input });
}

function validateBrowserOperationInput(type, value, label) {
  switch (type) {
    case "jobnimbus.create_note": {
      exactRecord(value, ["note"], [], `${label}.input`);
      return {
        note: boundedString(value.note, {
          label: "note",
          maxBytes: MAX_NOTE_BYTES,
          allowEmpty: false,
          allowMultiline: true,
          exactTrimmed: true
        })
      };
    }

    case "jobnimbus.create_task": {
      exactRecord(
        value,
        ["title"],
        ["description", "dueDate"],
        `${label}.input`
      );
      const result = {
        title: taskTitle(value.title)
      };
      if (Object.hasOwn(value, "description")) {
        result.description = taskDescription(value.description);
      }
      if (Object.hasOwn(value, "dueDate")) {
        result.dueDate = isoDate(value.dueDate, "dueDate");
      }
      return result;
    }

    case "jobnimbus.update_task": {
      exactRecord(
        value,
        ["taskRef"],
        ["title", "description", "dueDate", "completed"],
        `${label}.input`
      );
      const result = {
        taskRef: opaqueReference(
          value.taskRef,
          TASK_REF_PATTERN,
          "taskRef"
        )
      };
      let changeCount = 0;
      if (Object.hasOwn(value, "title")) {
        result.title = taskTitle(value.title);
        changeCount += 1;
      }
      if (Object.hasOwn(value, "description")) {
        result.description = taskDescription(value.description);
        changeCount += 1;
      }
      if (Object.hasOwn(value, "dueDate")) {
        result.dueDate = isoDate(value.dueDate, "dueDate");
        changeCount += 1;
      }
      if (Object.hasOwn(value, "completed")) {
        if (typeof value.completed !== "boolean") {
          invalid("invalid_task_change", "completed must be a boolean");
        }
        result.completed = value.completed;
        changeCount += 1;
      }
      if (changeCount === 0) {
        invalid(
          "missing_task_change",
          "A task update must contain at least one exact change"
        );
      }
      return result;
    }

    case "jobnimbus.update_status": {
      exactRecord(value, ["status"], [], `${label}.input`);
      return {
        status: boundedString(value.status, {
          label: "status",
          maxCharacters: MAX_STATUS_CHARACTERS,
          allowEmpty: false,
          allowMultiline: false,
          exactTrimmed: true
        })
      };
    }

    case "jobnimbus.update_contact": {
      exactRecord(value, ["dateOfLoss"], [], `${label}.input`);
      return {
        dateOfLoss: isoDate(value.dateOfLoss, "dateOfLoss")
      };
    }

    case "jobnimbus.create_calendar_event": {
      exactRecord(
        value,
        ["title", "startsAt", "endsAt"],
        ["description"],
        `${label}.input`
      );
      const startsAt = isoBrowserInstant(value.startsAt, "startsAt");
      const endsAt = isoBrowserInstant(value.endsAt, "endsAt");
      if (Date.parse(endsAt) < Date.parse(startsAt)) {
        invalid(
          "invalid_date_range",
          "endsAt must be at or after startsAt"
        );
      }
      const result = {
        title: taskTitle(value.title),
        startsAt,
        endsAt
      };
      if (Object.hasOwn(value, "description")) {
        result.description = taskDescription(value.description);
      }
      return result;
    }

    case "jobnimbus.update_calendar_event": {
      exactRecord(
        value,
        ["eventRef"],
        ["title", "description", "startsAt", "endsAt"],
        `${label}.input`
      );
      const result = {
        eventRef: opaqueReference(
          value.eventRef,
          EVENT_REF_PATTERN,
          "eventRef"
        )
      };
      let changeCount = 0;
      if (Object.hasOwn(value, "title")) {
        result.title = taskTitle(value.title);
        changeCount += 1;
      }
      if (Object.hasOwn(value, "description")) {
        result.description = taskDescription(value.description);
        changeCount += 1;
      }
      if (Object.hasOwn(value, "startsAt")) {
        result.startsAt = isoBrowserInstant(value.startsAt, "startsAt");
        changeCount += 1;
      }
      if (Object.hasOwn(value, "endsAt")) {
        result.endsAt = isoBrowserInstant(value.endsAt, "endsAt");
        changeCount += 1;
      }
      if (changeCount === 0) {
        invalid(
          "missing_calendar_change",
          "A calendar-event update must contain at least one exact change"
        );
      }
      if (
        Object.hasOwn(result, "startsAt")
        !== Object.hasOwn(result, "endsAt")
      ) {
        invalid(
          "incomplete_calendar_range",
          "Calendar-event time changes require both startsAt and endsAt"
        );
      }
      if (
        result.startsAt
        && result.endsAt
        && Date.parse(result.endsAt) < Date.parse(result.startsAt)
      ) {
        invalid(
          "invalid_date_range",
          "endsAt must be at or after startsAt"
        );
      }
      return result;
    }

    case "gmail.create_draft": {
      const carrierEmail = Object.hasOwn(value, "insuranceClaimEmail");
      if (carrierEmail) {
        exactRecord(
          value,
          ["insuranceClaimEmail", "to", "subject", "body", "attachments"],
          ["cc", "bcc"],
          `${label}.input`
        );
        if (value.insuranceClaimEmail !== true) {
          invalid(
            "invalid_insurance_claim_email",
            "insuranceClaimEmail must be true for an HCN carrier draft"
          );
        }
      } else {
        exactRecord(
          value,
          ["to", "subject", "body"],
          ["cc", "bcc"],
          `${label}.input`
        );
      }
      const result = {
        to: emailAddressList(value.to, "to", true),
        subject: emailSubject(value.subject),
        body: emailBody(value.body)
      };
      if (carrierEmail) {
        result.insuranceClaimEmail = true;
        result.attachments = gmailJobNimbusAttachments(
          value.attachments,
          label
        );
      }
      if (Object.hasOwn(value, "cc")) {
        result.cc = emailAddressList(value.cc, "cc", false);
      }
      if (Object.hasOwn(value, "bcc")) {
        result.bcc = emailAddressList(value.bcc, "bcc", false);
      }
      return result;
    }

    case "gmail.send":
    case "gmail.send_existing_draft": {
      exactRecord(value, ["draftRef"], [], `${label}.input`);
      return {
        draftRef: opaqueReference(
          value.draftRef,
          DRAFT_REF_PATTERN,
          "draftRef"
        )
      };
    }

    case "quo.send_text": {
      exactRecord(value, ["to", "content"], [], `${label}.input`);
      if (
        typeof value.to !== "string"
        || !E164_PATTERN.test(value.to)
      ) {
        invalid(
          "invalid_phone_number",
          "to must be one exact E.164 recipient"
        );
      }
      const content = boundedString(value.content, {
        label: "content",
        maxCharacters: MAX_QUO_MESSAGE_CHARACTERS,
        allowEmpty: false,
        allowMultiline: true,
        exactTrimmed: true
      });
      if (content.length > MAX_QUO_MESSAGE_CHARACTERS) {
        invalid(
          "message_too_long",
          "content exceeds the exact Quo character-count bound"
        );
      }
      return {
        to: value.to,
        content
      };
    }

    default:
      invalid("unsupported_action_type", "Action type is not enabled for HCN v1");
  }
}

function privateEngineOperation(
  operation,
  providerJobId,
  providerTaskId,
  providerEventId,
  providerDocumentIds,
  providerDraftId
) {
  const input = operation.input;
  switch (operation.type) {
    case "jobnimbus.create_note":
      return {
        type: operation.type,
        payload: {
          query: providerJobId,
          note: input.note
        }
      };
    case "jobnimbus.create_task":
      return {
        type: operation.type,
        payload: compactDefined({
          query: providerJobId,
          title: input.title,
          description: input.description,
          dueDate: input.dueDate
        })
      };
    case "jobnimbus.update_task":
      return {
        type: operation.type,
        payload: {
          query: providerJobId,
          taskId: providerTaskId,
          fields: compactDefined({
            title: input.title,
            description: input.description,
            dueDate: input.dueDate,
            completed: input.completed
          })
        }
      };
    case "jobnimbus.update_status":
      return {
        type: operation.type,
        payload: {
          query: providerJobId,
          status: input.status
        }
      };
    case "jobnimbus.update_contact":
      return {
        type: operation.type,
        payload: {
          query: providerJobId,
          fields: {
            dateOfLoss: input.dateOfLoss
          }
        }
      };
    case "jobnimbus.create_calendar_event":
      return {
        type: operation.type,
        payload: compactDefined({
          query: providerJobId,
          title: input.title,
          description: input.description,
          dateStart: input.startsAt,
          dateEnd: input.endsAt
        })
      };
    case "jobnimbus.update_calendar_event":
      return {
        type: operation.type,
        payload: {
          query: providerJobId,
          eventId: providerEventId,
          fields: compactDefined({
            title: input.title,
            description: input.description,
            dateStart: input.startsAt,
            dateEnd: input.endsAt
          })
        }
      };
    case "gmail.create_draft": {
      const payload = compactDefined({
        query: providerJobId,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        body: input.body
      });
      if (input.insuranceClaimEmail === true) {
        payload.insuranceClaimEmail = true;
        payload.attachments = input.attachments.map((_attachment, index) => ({
          source: "jobnimbus",
          documentQuery: providerDocumentIds[index]
        }));
      }
      return { type: operation.type, payload };
    }
    case "gmail.send":
    case "gmail.send_existing_draft":
      return {
        type: operation.type,
        payload: {
          query: providerJobId,
          draftId: providerDraftId
        }
      };
    case "quo.send_text":
      return {
        type: operation.type,
        payload: {
          query: providerJobId,
          to: input.to,
          content: input.content
        }
      };
    default:
      invalid("unsupported_action_type", "Action type is not enabled for HCN v1");
  }
}

function validatePrivateEngineRequest(value, request) {
  driftRecord(value, ["operations"], [], "private engine request");
  if (
    !Array.isArray(value.operations)
    || value.operations.length !== request.operations.length
  ) {
    drift("Private engine operation count does not match the browser request");
  }

  let providerJobId = "";
  const operations = value.operations.map((operation, index) => {
    const browserOperation = request.operations[index];
    driftRecord(
      operation,
      ["type", "payload"],
      [],
      `private operations[${index}]`
    );
    if (operation.type !== browserOperation.type) {
      drift("Private engine operation type does not match the browser request");
    }
    const validated = validatePrivatePayload(
      operation.payload,
      browserOperation
    );
    if (!providerJobId) providerJobId = validated.providerJobId;
    if (validated.providerJobId !== providerJobId) {
      drift("Private engine request is not scoped to one exact file");
    }
    return validated;
  });
  return { providerJobId, operations };
}

function validatePrivatePayload(value, browserOperation) {
  const input = browserOperation.input;
  switch (browserOperation.type) {
    case "jobnimbus.create_note":
      driftRecord(value, ["query", "note"], [], "private note payload");
      equalMaterial(value.note, input.note);
      return {
        providerJobId: providerIdentifier(value.query)
      };

    case "jobnimbus.create_task": {
      driftRecord(
        value,
        ["query", "title"],
        ["description", "dueDate"],
        "private create-task payload"
      );
      equalMaterial(value.title, input.title);
      equalOptionalMaterial(value, input, "description");
      equalOptionalMaterial(value, input, "dueDate");
      return {
        providerJobId: providerIdentifier(value.query)
      };
    }

    case "jobnimbus.update_task": {
      driftRecord(
        value,
        ["query", "taskId", "fields"],
        [],
        "private update-task payload"
      );
      const expectedFields = Object.keys(input).filter(
        (key) => key !== "taskRef"
      );
      driftRecord(
        value.fields,
        expectedFields,
        [],
        "private task fields"
      );
      for (const key of expectedFields) {
        equalMaterial(value.fields[key], input[key]);
      }
      return {
        providerJobId: providerIdentifier(value.query),
        providerTaskId: providerIdentifier(value.taskId)
      };
    }

    case "jobnimbus.update_status":
      driftRecord(
        value,
        ["query", "status"],
        [],
        "private status payload"
      );
      equalMaterial(value.status, input.status);
      return {
        providerJobId: providerIdentifier(value.query)
      };

    case "jobnimbus.update_contact":
      driftRecord(
        value,
        ["query", "fields"],
        [],
        "private contact payload"
      );
      driftRecord(
        value.fields,
        ["dateOfLoss"],
        [],
        "private contact fields"
      );
      equalMaterial(value.fields.dateOfLoss, input.dateOfLoss);
      return {
        providerJobId: providerIdentifier(value.query)
      };

    case "jobnimbus.create_calendar_event": {
      driftRecord(
        value,
        ["query", "title", "dateStart", "dateEnd"],
        ["description"],
        "private create-calendar payload"
      );
      equalMaterial(value.title, input.title);
      equalMaterial(value.dateStart, input.startsAt);
      equalMaterial(value.dateEnd, input.endsAt);
      equalOptionalMaterial(value, input, "description");
      return {
        providerJobId: providerIdentifier(value.query)
      };
    }

    case "jobnimbus.update_calendar_event": {
      driftRecord(
        value,
        ["query", "eventId", "fields"],
        [],
        "private update-calendar payload"
      );
      const expectedFields = [];
      const fieldMap = {
        title: "title",
        description: "description",
        startsAt: "dateStart",
        endsAt: "dateEnd"
      };
      for (const [inputKey, fieldKey] of Object.entries(fieldMap)) {
        if (Object.hasOwn(input, inputKey)) expectedFields.push(fieldKey);
      }
      driftRecord(
        value.fields,
        expectedFields,
        [],
        "private calendar fields"
      );
      for (const [inputKey, fieldKey] of Object.entries(fieldMap)) {
        if (Object.hasOwn(input, inputKey)) {
          equalMaterial(value.fields[fieldKey], input[inputKey]);
        }
      }
      return {
        providerJobId: providerIdentifier(value.query),
        providerEventId: providerIdentifier(value.eventId)
      };
    }

    case "gmail.create_draft": {
      if (input.insuranceClaimEmail !== true) {
        driftRecord(
          value,
          ["query", "to", "subject", "body"],
          ["cc", "bcc"],
          "private Gmail draft payload"
        );
        equalMaterial(value.to, input.to);
        equalMaterial(value.subject, input.subject);
        equalMaterial(value.body, input.body);
        equalOptionalMaterial(value, input, "cc");
        equalOptionalMaterial(value, input, "bcc");
        return {
          providerJobId: providerIdentifier(value.query)
        };
      }
      driftRecord(
        value,
        [
          "query",
          "insuranceClaimEmail",
          "to",
          "subject",
          "body",
          "attachments"
        ],
        ["cc", "bcc"],
        "private Gmail draft payload"
      );
      if (value.insuranceClaimEmail !== true) {
        drift("Private Gmail draft is not an insurance-claim email");
      }
      equalMaterial(value.to, input.to);
      equalMaterial(value.subject, input.subject);
      equalMaterial(value.body, input.body);
      equalOptionalMaterial(value, input, "cc");
      equalOptionalMaterial(value, input, "bcc");
      if (
        !Array.isArray(value.attachments)
        || value.attachments.length !== input.attachments.length
      ) {
        drift("Private Gmail attachments differ from the browser request");
      }
      const providerDocumentIds = value.attachments.map(
        (attachment, index) => {
          driftRecord(
            attachment,
            ["source", "documentQuery"],
            [],
            `private Gmail attachment ${index}`
          );
          if (attachment.source !== "jobnimbus") {
            drift("Private Gmail attachment source is not allowlisted");
          }
          return providerIdentifier(attachment.documentQuery);
        }
      );
      return {
        providerJobId: providerIdentifier(value.query),
        providerDocumentIds
      };
    }

    case "gmail.send":
    case "gmail.send_existing_draft":
      driftRecord(
        value,
        ["query", "draftId"],
        [],
        "private Gmail send payload"
      );
      return {
        providerJobId: providerIdentifier(value.query),
        providerDraftId: providerIdentifier(value.draftId)
      };

    case "quo.send_text":
      driftRecord(
        value,
        ["query", "to", "content"],
        [],
        "private Quo send payload"
      );
      equalMaterial(value.to, input.to);
      equalMaterial(value.content, input.content);
      return {
        providerJobId: providerIdentifier(value.query)
      };

    default:
      drift("Private engine action type is not allowlisted");
  }
}

function validateEngineDryRun(value, operationCount) {
  driftRecord(
    value,
    [
      "mode",
      "operationCount",
      "operations",
      "approvalDigest",
      "approvalChallenge",
      "approvalExpiresAt"
    ],
    ["instruction"],
    "engine dry run"
  );
  if (value.mode !== "dry_run" || value.operationCount !== operationCount) {
    drift("Engine dry run does not match the exact operation count");
  }
  if (
    typeof value.approvalDigest !== "string"
    || !DIGEST_PATTERN.test(value.approvalDigest)
  ) {
    drift("Engine dry run has an invalid approval digest");
  }
  if (
    typeof value.approvalChallenge !== "string"
    || !CHALLENGE_PATTERN.test(value.approvalChallenge)
  ) {
    drift("Engine dry run has an invalid approval challenge");
  }
  const approvalExpiresAt = isoInstant(
    value.approvalExpiresAt,
    "approvalExpiresAt"
  );
  if (
    Object.hasOwn(value, "instruction")
    && (
      typeof value.instruction !== "string"
      || Buffer.byteLength(value.instruction, "utf8") > 4096
    )
  ) {
    drift("Engine dry-run instruction is malformed");
  }
  if (
    !Array.isArray(value.operations)
    || value.operations.length !== operationCount
  ) {
    drift("Engine dry-run operations do not match the exact operation count");
  }
  return {
    operations: value.operations,
    approvalExpiresAt
  };
}

function projectEngineOperation({
  browserOperation,
  engineOperation,
  privateOperation,
  index
}) {
  driftRecord(
    engineOperation,
    ["type", "plan"],
    [],
    `engine operations[${index}]`
  );
  if (engineOperation.type !== browserOperation.type) {
    drift("Engine operation type does not match the browser request");
  }

  switch (browserOperation.type) {
    case "jobnimbus.create_note":
      validateEngineNotePlan(
        engineOperation.plan,
        browserOperation.input,
        privateOperation
      );
      return {
        index,
        type: browserOperation.type,
        action: "Create JobNimbus note",
        material: {
          note: browserOperation.input.note
        }
      };

    case "jobnimbus.create_task":
      validateEngineCreateTaskPlan(
        engineOperation.plan,
        browserOperation.input,
        privateOperation
      );
      return {
        index,
        type: browserOperation.type,
        action: "Create JobNimbus task",
        material: compactDefined({
          title: browserOperation.input.title,
          description: browserOperation.input.description,
          dueDate: browserOperation.input.dueDate
        })
      };

    case "jobnimbus.update_task":
      validateEngineUpdateTaskPlan(
        engineOperation.plan,
        browserOperation.input,
        privateOperation
      );
      return {
        index,
        type: browserOperation.type,
        action: "Update JobNimbus task",
        material: compactDefined({
          taskRef: browserOperation.input.taskRef,
          title: browserOperation.input.title,
          description: browserOperation.input.description,
          dueDate: browserOperation.input.dueDate,
          completed: browserOperation.input.completed
        })
      };

    case "jobnimbus.update_status": {
      const resolvedStatus = validateEngineStatusPlan(
        engineOperation.plan,
        browserOperation.input,
        privateOperation
      );
      return {
        index,
        type: browserOperation.type,
        action: "Change JobNimbus status",
        material: {
          requestedStatus: browserOperation.input.status,
          resolvedStatus
        }
      };
    }

    case "jobnimbus.update_contact":
      validateEngineDateOfLossPlan(
        engineOperation.plan,
        browserOperation.input,
        privateOperation
      );
      return {
        index,
        type: browserOperation.type,
        action: "Update JobNimbus date of loss",
        material: {
          dateOfLoss: browserOperation.input.dateOfLoss
        }
      };

    case "jobnimbus.create_calendar_event": {
      const schedule = validateEngineCreateCalendarPlan(
        engineOperation.plan,
        browserOperation.input,
        privateOperation
      );
      return {
        index,
        type: browserOperation.type,
        action: "Create JobNimbus calendar event",
        material: compactDefined({
          title: browserOperation.input.title,
          description: browserOperation.input.description,
          startsAt: browserOperation.input.startsAt,
          endsAt: browserOperation.input.endsAt,
          timeZone: schedule.timeZone
        })
      };
    }

    case "jobnimbus.update_calendar_event": {
      const schedule = validateEngineUpdateCalendarPlan(
        engineOperation.plan,
        browserOperation.input,
        privateOperation
      );
      return {
        index,
        type: browserOperation.type,
        action: "Update JobNimbus calendar event",
        material: compactDefined({
          eventRef: browserOperation.input.eventRef,
          title: browserOperation.input.title,
          description: browserOperation.input.description,
          startsAt: browserOperation.input.startsAt,
          endsAt: browserOperation.input.endsAt,
          timeZone: schedule?.timeZone
        })
      };
    }

    case "gmail.create_draft": {
      const material = validateEngineGmailDraftPlan(
        engineOperation.plan,
        browserOperation.input,
        privateOperation
      );
      const carrierEmail = browserOperation.input.insuranceClaimEmail === true;
      return {
        index,
        type: browserOperation.type,
        action: carrierEmail
          ? "Create Gmail carrier draft (nothing sent)"
          : "Create Gmail draft (nothing sent)",
        material: carrierEmail
          ? material
          : compactDefined({
            to: browserOperation.input.to,
            cc: browserOperation.input.cc,
            bcc: browserOperation.input.bcc,
            subject: browserOperation.input.subject,
            body: browserOperation.input.body,
            attachments: []
          })
      };
    }

    case "gmail.send":
    case "gmail.send_existing_draft": {
      const material = validateEngineGmailSendPlan(
        engineOperation.plan,
        browserOperation.input,
        privateOperation,
        browserOperation.type === "gmail.send_existing_draft"
      );
      return {
        index,
        type: browserOperation.type,
        action: "Send reviewed Gmail draft",
        material
      };
    }

    case "quo.send_text": {
      const material = validateEngineQuoSendPlan(
        engineOperation.plan,
        browserOperation.input,
        privateOperation
      );
      return {
        index,
        type: browserOperation.type,
        action: "Send Quo text",
        material
      };
    }

    default:
      drift("Engine action type is not allowlisted");
  }
}

function validateEngineNotePlan(value, input, privateOperation) {
  enginePlanWrapper(value, true);
  driftRecord(value.plan, ["endpoint", "body"], [], "note plan");
  if (value.plan.endpoint !== "/activities") {
    drift("JobNimbus note endpoint does not match the allowlisted shape");
  }
  driftRecord(
    value.plan.body,
    ["note", "date_created", "record_type_name", "primary"],
    [],
    "note body"
  );
  equalMaterial(value.plan.body.note, input.note);
  if (
    value.plan.body.record_type_name !== "Note"
    || !Number.isSafeInteger(value.plan.body.date_created)
    || value.plan.body.date_created <= 0
  ) {
    drift("JobNimbus note body does not match the allowlisted shape");
  }
  const primary = engineProviderReference(value.plan.body.primary);
  if (primary !== privateOperation.providerJobId) {
    drift("JobNimbus note scope does not match the selected file");
  }
}

function validateEngineCreateTaskPlan(value, input, privateOperation) {
  enginePlanWrapper(value, true);
  driftRecord(
    value.plan,
    ["endpoint", "body"],
    ["schedule"],
    "create-task plan"
  );
  if (value.plan.endpoint !== "/tasks") {
    drift("JobNimbus create-task endpoint does not match the allowlisted shape");
  }
  const optional = ["description", "note", "date_start", "date_end"];
  driftRecord(
    value.plan.body,
    [
      "title",
      "subject",
      "is_completed",
      "record_type_name",
      "owners",
      "primary",
      "related"
    ],
    optional,
    "create-task body"
  );
  equalMaterial(value.plan.body.title, input.title);
  equalMaterial(value.plan.body.subject, input.title);
  if (
    value.plan.body.is_completed !== false
    || value.plan.body.record_type_name !== "Task"
  ) {
    drift("JobNimbus create-task body does not match the allowlisted shape");
  }

  const hasDescription = Object.hasOwn(input, "description");
  if (hasDescription) {
    equalMaterial(value.plan.body.description, input.description);
    equalMaterial(value.plan.body.note, input.description);
  } else if (
    Object.hasOwn(value.plan.body, "description")
    || Object.hasOwn(value.plan.body, "note")
  ) {
    drift("JobNimbus create-task description differs from the browser request");
  }

  const primary = engineProviderReference(value.plan.body.primary);
  if (
    primary !== privateOperation.providerJobId
    || !Array.isArray(value.plan.body.related)
    || value.plan.body.related.length !== 1
    || engineProviderReference(value.plan.body.related[0]) !== primary
    || !Array.isArray(value.plan.body.owners)
    || value.plan.body.owners.length !== 1
  ) {
    drift("JobNimbus create-task scope does not match the selected file");
  }
  engineProviderReference(value.plan.body.owners[0]);

  if (Object.hasOwn(input, "dueDate")) {
    const seconds = unixNoon(input.dueDate);
    if (
      value.plan.body.date_start !== seconds
      || value.plan.body.date_end !== seconds
    ) {
      drift("JobNimbus create-task due date differs from the browser request");
    }
    validateEngineSchedule(value.plan.schedule, {
      hasEnd: true
    });
  } else {
    assertNoEngineDatesOrSchedule(value.plan);
  }
}

function validateEngineUpdateTaskPlan(value, input, privateOperation) {
  enginePlanWrapper(value, false);
  driftRecord(
    value.plan,
    ["endpoint", "body"],
    ["schedule"],
    "update-task plan"
  );
  const expectedEndpoint = `/tasks/${privateOperation.providerTaskId}`;
  if (value.plan.endpoint !== expectedEndpoint) {
    drift("JobNimbus update-task scope does not match the opaque task");
  }

  const expectedKeys = [];
  if (Object.hasOwn(input, "title")) expectedKeys.push("title");
  if (Object.hasOwn(input, "description")) expectedKeys.push("description");
  if (Object.hasOwn(input, "dueDate")) expectedKeys.push("date_start");
  if (Object.hasOwn(input, "completed")) expectedKeys.push("is_completed");
  driftRecord(value.plan.body, expectedKeys, [], "update-task body");
  if (Object.hasOwn(input, "title")) {
    equalMaterial(value.plan.body.title, input.title);
  }
  if (Object.hasOwn(input, "description")) {
    equalMaterial(value.plan.body.description, input.description);
  }
  if (Object.hasOwn(input, "completed")) {
    equalMaterial(value.plan.body.is_completed, input.completed);
  }
  if (Object.hasOwn(input, "dueDate")) {
    if (value.plan.body.date_start !== unixNoon(input.dueDate)) {
      drift("JobNimbus update-task due date differs from the browser request");
    }
    validateEngineSchedule(value.plan.schedule, {
      hasEnd: false
    });
  } else {
    assertNoEngineDatesOrSchedule(value.plan);
  }
}

function validateEngineStatusPlan(value, input, privateOperation) {
  enginePlanWrapper(value, true);
  driftRecord(
    value.plan,
    ["endpoint", "body", "requestedStatus", "resolvedStatus"],
    [],
    "status plan"
  );
  if (
    value.plan.endpoint !== `/contacts/${privateOperation.providerJobId}`
    || value.plan.requestedStatus !== input.status
  ) {
    drift("JobNimbus status plan does not match the selected file and request");
  }
  driftRecord(value.plan.body, ["status_name"], [], "status body");
  if (value.plan.body.status_name !== value.plan.resolvedStatus) {
    drift("JobNimbus resolved status does not match the canonical body");
  }
  return boundedEngineString(
    value.plan.resolvedStatus,
    MAX_STATUS_CHARACTERS,
    "resolved status"
  );
}

function validateEngineDateOfLossPlan(value, input, privateOperation) {
  enginePlanWrapper(value, true);
  driftRecord(
    value.plan,
    ["endpoint", "fields"],
    [],
    "date-of-loss plan"
  );
  if (value.plan.endpoint !== `/contacts/${privateOperation.providerJobId}`) {
    drift("JobNimbus date-of-loss plan does not match the selected file");
  }
  driftRecord(value.plan.fields, ["cf_date_1"], [], "date-of-loss fields");
  if (value.plan.fields.cf_date_1 !== unixNoon(input.dateOfLoss)) {
    drift("JobNimbus date of loss differs from the browser request");
  }
}

function validateEngineCreateCalendarPlan(value, input, privateOperation) {
  enginePlanWrapper(value, true);
  driftRecord(
    value.plan,
    ["endpoint", "body", "schedule"],
    [],
    "create-calendar plan"
  );
  if (value.plan.endpoint !== "/activities") {
    drift("JobNimbus calendar-create endpoint is not allowlisted");
  }
  const optional = ["description", "note"];
  driftRecord(
    value.plan.body,
    [
      "title",
      "subject",
      "date_start",
      "date_end",
      "record_type_name",
      "owners",
      "primary",
      "related"
    ],
    optional,
    "create-calendar body"
  );
  equalMaterial(value.plan.body.title, input.title);
  equalMaterial(value.plan.body.subject, input.title);
  equalMaterial(value.plan.body.date_start, unixSeconds(input.startsAt));
  equalMaterial(value.plan.body.date_end, unixSeconds(input.endsAt));
  if (value.plan.body.record_type_name !== "Event") {
    drift("JobNimbus calendar-create record type is not allowlisted");
  }
  if (Object.hasOwn(input, "description")) {
    equalMaterial(value.plan.body.description, input.description);
    equalMaterial(value.plan.body.note, input.description);
  } else if (
    Object.hasOwn(value.plan.body, "description")
    || Object.hasOwn(value.plan.body, "note")
  ) {
    drift("JobNimbus calendar description differs from the browser request");
  }
  const primary = engineProviderReference(value.plan.body.primary);
  if (
    primary !== privateOperation.providerJobId
    || !Array.isArray(value.plan.body.related)
    || value.plan.body.related.length !== 1
    || engineProviderReference(value.plan.body.related[0]) !== primary
    || !Array.isArray(value.plan.body.owners)
    || value.plan.body.owners.length !== 1
  ) {
    drift("JobNimbus calendar-create scope does not match the selected file");
  }
  engineProviderReference(value.plan.body.owners[0]);
  return validateEngineCalendarSchedule(value.plan.schedule, {
    hasStart: true,
    hasEnd: true
  });
}

function validateEngineUpdateCalendarPlan(value, input, privateOperation) {
  enginePlanWrapper(value, true);
  driftRecord(
    value.plan,
    ["endpoint", "body"],
    ["schedule"],
    "update-calendar plan"
  );
  if (
    value.plan.endpoint
      !== `/activities/${privateOperation.providerEventId}`
  ) {
    drift("JobNimbus calendar-update scope does not match the opaque event");
  }
  const expectedKeys = [];
  if (Object.hasOwn(input, "title")) expectedKeys.push("title");
  if (Object.hasOwn(input, "description")) {
    expectedKeys.push("description");
  }
  if (Object.hasOwn(input, "startsAt")) expectedKeys.push("date_start");
  if (Object.hasOwn(input, "endsAt")) expectedKeys.push("date_end");
  driftRecord(value.plan.body, expectedKeys, [], "update-calendar body");
  if (Object.hasOwn(input, "title")) {
    equalMaterial(value.plan.body.title, input.title);
  }
  if (Object.hasOwn(input, "description")) {
    equalMaterial(value.plan.body.description, input.description);
  }
  if (Object.hasOwn(input, "startsAt")) {
    equalMaterial(value.plan.body.date_start, unixSeconds(input.startsAt));
  }
  if (Object.hasOwn(input, "endsAt")) {
    equalMaterial(value.plan.body.date_end, unixSeconds(input.endsAt));
  }
  const hasDates =
    Object.hasOwn(input, "startsAt")
    || Object.hasOwn(input, "endsAt");
  if (!hasDates) {
    if (
      Object.hasOwn(value.plan, "schedule")
      && value.plan.schedule !== undefined
    ) {
      drift("JobNimbus calendar schedule differs from the browser request");
    }
    return null;
  }
  return validateEngineCalendarSchedule(value.plan.schedule, {
    hasStart: Object.hasOwn(input, "startsAt"),
    hasEnd: Object.hasOwn(input, "endsAt")
  });
}

function validateEngineCalendarSchedule(value, { hasStart, hasEnd }) {
  const required = ["timeZone"];
  if (hasStart) required.push("start");
  if (hasEnd) required.push("end");
  driftRecord(value, required, [], "calendar schedule");
  if (value.timeZone !== "America/Chicago") {
    drift("Calendar schedule timezone is not allowlisted");
  }
  for (const field of ["start", "end"]) {
    if (
      Object.hasOwn(value, field)
      && (
        typeof value[field] !== "string"
        || value[field].length < 1
        || value[field].length > 128
        || /[\r\n\x00-\x1f\x7f]/.test(value[field])
      )
    ) {
      drift("Calendar schedule preview is malformed");
    }
  }
  return { timeZone: value.timeZone };
}

function validateEngineGmailDraftPlan(value, input, privateOperation) {
  const carrierEmail = input.insuranceClaimEmail === true;
  driftRecord(
    value,
    ["mode", "plan", "approvalDigest"],
    [],
    "Gmail draft plan"
  );
  if (
    value.mode !== "dry_run"
    || typeof value.approvalDigest !== "string"
    || !DIGEST_PATTERN.test(value.approvalDigest)
  ) {
    drift("Gmail draft engine wrapper is not an exact dry run");
  }
  driftRecord(
    value.plan,
    [
      "endpoint",
      "fileScope",
      "to",
      "cc",
      "bcc",
      "subject",
      "body",
      "bodyTemplate",
      "threadId",
      "attemptId",
      "attachments"
    ],
    [],
    "Gmail draft material"
  );
  if (
    value.plan.endpoint !== "/gmail/v1/users/me/drafts"
    || value.plan.bodyTemplate !== "custom"
    || value.plan.threadId !== ""
    || value.plan.attemptId !== "initial"
    || (
      !carrierEmail
      && (
        !Array.isArray(value.plan.attachments)
        || value.plan.attachments.length !== 0
      )
    )
  ) {
    drift(
      carrierEmail
        ? "Gmail draft plan is not the allowlisted carrier-email shape"
        : "Gmail draft plan is not the allowlisted no-attachment shape"
    );
  }
  validateEngineGmailFileScope(
    value.plan.fileScope,
    privateOperation.providerJobId
  );
  equalMaterial(value.plan.to, input.to);
  equalMaterial(value.plan.cc, input.cc || "");
  equalMaterial(value.plan.bcc, input.bcc || "");
  equalMaterial(value.plan.subject, input.subject);
  equalMaterial(value.plan.body, input.body);
  if (!carrierEmail) return null;
  const attachments = validateEngineJobNimbusAttachments(
    value.plan.attachments,
    input.attachments,
    privateOperation
  );
  return compactDefined({
    insuranceClaimEmail: true,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body: input.body,
    attachments
  });
}

function validateEngineJobNimbusAttachments(
  value,
  browserAttachments,
  privateOperation
) {
  if (
    !Array.isArray(value)
    || value.length !== 1
    || browserAttachments.length !== 1
    || privateOperation.providerDocumentIds.length !== 1
  ) {
    drift("A carrier Gmail draft must contain exactly one chosen attachment");
  }
  return value.map((attachment, index) => {
    driftRecord(
      attachment,
      [
        "filename",
        "contentType",
        "bytes",
        "sha256",
        "source",
        "sourceId",
        "sourceFileId",
        "sourceFile"
      ],
      [],
      `Gmail attachment descriptor ${index}`
    );
    if (
      attachment.source !== "jobnimbus"
      || providerIdentifier(attachment.sourceId)
        !== privateOperation.providerDocumentIds[index]
      || providerIdentifier(attachment.sourceFileId)
        !== privateOperation.providerJobId
    ) {
      drift("Gmail attachment is not bound to the selected JobNimbus file");
    }
    validateEngineGmailFileScope(
      attachment.sourceFile,
      privateOperation.providerJobId
    );
    const safe = validateSafeAttachmentMaterial(attachment, "contentType");
    return {
      source: "jobnimbus",
      documentRef: browserAttachments[index].documentRef,
      ...safe
    };
  });
}

function validateEngineGmailSendPlan(
  value,
  input,
  privateOperation,
  carrierEmail = false
) {
  driftRecord(
    value,
    ["mode", "plan", "approvalDigest", "instruction"],
    [],
    "Gmail send plan"
  );
  if (
    value.mode !== "dry_run"
    || typeof value.approvalDigest !== "string"
    || !DIGEST_PATTERN.test(value.approvalDigest)
    || typeof value.instruction !== "string"
    || Buffer.byteLength(value.instruction, "utf8") > 4096
  ) {
    drift("Gmail send engine wrapper is not an exact dry run");
  }
  driftRecord(
    value.plan,
    [
      "endpoint",
      "action",
      "deliveryMode",
      "fileScope",
      "draftId",
      "messageId",
      "threadId",
      "to",
      "cc",
      "bcc",
      "subject",
      "deliveryHeaders",
      "body",
      "bodyRepresentations",
      "attachments",
      "contentDigest",
      "transmittedHeaders",
      "omittedOriginalHeaders",
      "sourceDraftRetention"
    ],
    [],
    "Gmail send material"
  );
  if (
    value.plan.endpoint !== "/gmail/v1/users/me/messages/send"
    || value.plan.action !== "send_existing_draft"
    || value.plan.deliveryMode
      !== "immutable_reviewed_snapshot_source_draft_retained"
    || value.plan.sourceDraftRetention !== "retained_for_separate_cleanup"
    || value.plan.omittedOriginalHeaders
      !== "Any original draft header not listed in transmittedHeaders is excluded from the immutable send."
    || value.plan.draftId !== privateOperation.providerDraftId
    || typeof value.plan.contentDigest !== "string"
    || !DIGEST_PATTERN.test(value.plan.contentDigest)
  ) {
    drift("Gmail send plan does not match the reviewed immutable draft");
  }
  validateEngineGmailFileScope(
    value.plan.fileScope,
    privateOperation.providerJobId
  );
  boundedEngineProviderText(value.plan.messageId, "Gmail message id", {
    allowEmpty: true
  });
  boundedEngineProviderText(value.plan.threadId, "Gmail thread id", {
    allowEmpty: true
  });
  const to = engineEmailMaterial(value.plan.to, "to", true);
  const cc = engineEmailMaterial(value.plan.cc, "cc", false);
  const bcc = engineEmailMaterial(value.plan.bcc, "bcc", false);
  const subject = engineEmailSubject(value.plan.subject);
  const body = engineEmailBody(value.plan.body);
  validateGmailDeliveryHeaders(value.plan.deliveryHeaders, {
    to,
    cc,
    bcc,
    subject
  });
  validateGmailBodyRepresentations(value.plan.bodyRepresentations, body);
  const attachments = validateGmailAttachmentDescriptors(
    value.plan.attachments,
    { includeProviderPartId: !carrierEmail }
  );
  if (carrierEmail && attachments.length !== 1) {
    drift("A carrier Gmail draft snapshot must retain exactly one attachment");
  }
  const transmittedHeaders = [
    "From",
    "Sender",
    "Reply-To",
    "To",
    "Cc",
    "Bcc",
    "Subject",
    "MIME-Version",
    "Content-Type"
  ];
  if (
    !Array.isArray(value.plan.transmittedHeaders)
    || value.plan.transmittedHeaders.length !== transmittedHeaders.length
    || value.plan.transmittedHeaders.some(
      (header, index) => header !== transmittedHeaders[index]
    )
  ) {
    drift("Gmail transmitted-header allowlist changed");
  }
  const material = compactDefined({
    draftRef: input.draftRef,
    to,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject,
    body,
    attachments,
    contentDigest: value.plan.contentDigest,
    sourceDraftRetention: value.plan.sourceDraftRetention
  });
  if (carrierEmail) material.providerSnapshotVerified = true;
  return material;
}

function validateEngineQuoSendPlan(value, input, privateOperation) {
  driftRecord(
    value,
    ["mode", "file", "plan", "approvalDigest", "instruction"],
    [],
    "Quo send plan"
  );
  if (
    value.mode !== "dry_run"
    || typeof value.approvalDigest !== "string"
    || !DIGEST_PATTERN.test(value.approvalDigest)
    || typeof value.instruction !== "string"
    || Buffer.byteLength(value.instruction, "utf8") > 4096
  ) {
    drift("Quo send engine wrapper is not an exact dry run");
  }
  validateEngineCompactContactScope(
    value.file,
    privateOperation.providerJobId
  );
  driftRecord(
    value.plan,
    ["from", "to", "content", "characterCount", "attemptId"],
    [],
    "Quo send material"
  );
  if (
    typeof value.plan.from !== "string"
    || !E164_PATTERN.test(value.plan.from)
    || value.plan.to !== input.to
    || value.plan.content !== input.content
    || value.plan.characterCount !== input.content.length
    || value.plan.attemptId !== "initial"
  ) {
    drift("Quo send plan differs from the exact browser request");
  }
  return {
    from: value.plan.from,
    to: input.to,
    content: input.content,
    characterCount: input.content.length
  };
}

function validateEngineGmailFileScope(value, providerJobId) {
  driftRecord(
    value,
    ["id", "number", "name"],
    [],
    "Gmail file scope"
  );
  if (providerIdentifier(value.id) !== providerJobId) {
    drift("Engine file scope does not match the selected file");
  }
  boundedEngineProviderText(value.number, "JobNimbus file number", {
    allowEmpty: true
  });
  boundedEngineProviderText(value.name, "JobNimbus file name", {
    allowEmpty: true
  });
}

function validateEngineCompactContactScope(value, providerJobId) {
  driftRecord(
    value,
    [
      "id",
      "number",
      "name",
      "status",
      "address",
      "phone",
      "email",
      "carrier",
      "claimNumber",
      "policyNumber",
      "typeOfLoss",
      "dateOfLoss",
      "adjusterName",
      "adjusterPhone",
      "adjusterEmail"
    ],
    [],
    "JobNimbus file scope"
  );
  if (providerIdentifier(value.id) !== providerJobId) {
    drift("Engine file scope does not match the selected file");
  }
}

function validateGmailDeliveryHeaders(value, expected) {
  const keys = safeRecord(value, "Gmail delivery headers", true);
  const allowed = new Set([
    "from",
    "sender",
    "replyTo",
    "to",
    "cc",
    "bcc",
    "subject"
  ]);
  if (keys.some((key) => !allowed.has(key))) {
    drift("Gmail delivery headers contain unsupported fields");
  }
  for (const field of ["to", "cc", "bcc", "subject"]) {
    const actual = Object.hasOwn(value, field) ? value[field] : "";
    if (actual !== expected[field]) {
      drift("Gmail delivery headers differ from the immutable draft");
    }
  }
  for (const field of ["from", "sender", "replyTo"]) {
    if (Object.hasOwn(value, field)) {
      engineEmailMaterial(value[field], field, false);
    }
  }
}

function validateGmailBodyRepresentations(value, body) {
  if (!Array.isArray(value) || value.length !== 1) {
    drift("Gmail draft must have exactly one reviewed body representation");
  }
  driftRecord(
    value[0],
    ["partId", "mimeType", "bytes", "sha256", "content"],
    ["disposition"],
    "Gmail body representation"
  );
  if (
    value[0].mimeType !== "text/plain"
    || value[0].content !== body
    || value[0].bytes !== Buffer.byteLength(body, "utf8")
    || typeof value[0].sha256 !== "string"
    || !DIGEST_PATTERN.test(value[0].sha256)
  ) {
    drift("Gmail body representation differs from the reviewed body");
  }
  boundedEngineProviderText(value[0].partId, "Gmail MIME part id");
  if (Object.hasOwn(value[0], "disposition")) {
    boundedEngineProviderText(
      value[0].disposition,
      "Gmail MIME disposition",
      { allowEmpty: true }
    );
  }
}

function validateGmailAttachmentDescriptors(
  value,
  { includeProviderPartId = true } = {}
) {
  if (
    !Array.isArray(value)
    || value.length > MAX_GMAIL_ATTACHMENTS
  ) {
    drift("Gmail attachment descriptors exceed the allowlisted bound");
  }
  let totalBytes = 0;
  return value.map((descriptor) => {
    driftRecord(
      descriptor,
      ["partId", "filename", "mimeType", "bytes", "sha256"],
      ["disposition"],
      "Gmail attachment descriptor"
    );
    const partId = boundedEngineProviderText(
      descriptor.partId,
      "Gmail MIME part id"
    );
    const filename = boundedEngineText(
      descriptor.filename,
      512,
      "Gmail attachment filename"
    );
    if (
      typeof descriptor.mimeType !== "string"
      || !MIME_TYPE_PATTERN.test(descriptor.mimeType)
      || !Number.isSafeInteger(descriptor.bytes)
      || descriptor.bytes < 1
      || typeof descriptor.sha256 !== "string"
      || !DIGEST_PATTERN.test(descriptor.sha256)
    ) {
      drift("Gmail attachment descriptor is malformed");
    }
    totalBytes += descriptor.bytes;
    if (totalBytes > MAX_GMAIL_ATTACHMENT_BYTES) {
      drift("Gmail attachments exceed the exact-review byte limit");
    }
    let disposition;
    if (Object.hasOwn(descriptor, "disposition")) {
      disposition = boundedEngineProviderText(
        descriptor.disposition,
        "Gmail attachment disposition",
        { allowEmpty: true }
      );
    }
    return compactDefined({
      partId: includeProviderPartId ? partId : undefined,
      filename,
      mimeType: descriptor.mimeType,
      disposition: disposition || undefined,
      bytes: descriptor.bytes,
      sha256: descriptor.sha256
    });
  });
}

function validateSafeAttachmentMaterial(value, contentTypeKey) {
  const filename = boundedEngineText(
    value.filename,
    512,
    "Gmail attachment filename"
  );
  const contentType = value[contentTypeKey];
  if (
    typeof contentType !== "string"
    || !MIME_TYPE_PATTERN.test(contentType)
    || !Number.isSafeInteger(value.bytes)
    || value.bytes < 1
    || value.bytes > MAX_GMAIL_ATTACHMENT_BYTES
    || typeof value.sha256 !== "string"
    || !DIGEST_PATTERN.test(value.sha256)
  ) {
    drift("Gmail attachment descriptor is malformed");
  }
  return {
    filename,
    contentType,
    bytes: value.bytes,
    sha256: value.sha256
  };
}

function enginePlanWrapper(value, fileRequired) {
  driftRecord(
    value,
    fileRequired ? ["mode", "file", "plan"] : ["mode", "plan"],
    fileRequired ? [] : ["file"],
    "engine operation plan"
  );
  if (value.mode !== "dry_run") {
    drift("Engine operation is not a dry run");
  }
  if (Object.hasOwn(value, "file")) {
    safeRecord(value.file, "engine file");
  }
}

function validateEngineSchedule(value, { hasEnd }) {
  driftRecord(
    value,
    hasEnd ? ["timeZone", "start", "end"] : ["timeZone", "start"],
    [],
    "task schedule"
  );
  if (
    value.timeZone !== "America/Chicago"
    || typeof value.start !== "string"
    || value.start.length === 0
    || value.start.length > 128
    || (
      hasEnd
      && (
        typeof value.end !== "string"
        || value.end !== value.start
      )
    )
  ) {
    drift("Task schedule does not match the allowlisted shape");
  }
}

function assertNoEngineDatesOrSchedule(plan) {
  if (
    Object.hasOwn(plan.body, "date_start")
    || Object.hasOwn(plan.body, "date_end")
    || (
      Object.hasOwn(plan, "schedule")
      && plan.schedule !== undefined
    )
  ) {
    drift("Task schedule differs from the browser request");
  }
}

function engineProviderReference(value) {
  driftRecord(value, ["id"], [], "provider reference");
  return providerIdentifier(value.id);
}

async function resolvePrivateIdentifier(callback, input, kind) {
  let value;
  try {
    value = await callback(input);
  } catch {
    throw new HcnBrowserActionContractError(
      `${kind}_resolution_failed`,
      409,
      `The selected ${kind} reference could not be resolved from fresh evidence`
    );
  }
  try {
    return providerIdentifier(value);
  } catch {
    throw new HcnBrowserActionContractError(
      `${kind}_resolution_failed`,
      409,
      `The selected ${kind} reference could not be resolved from fresh evidence`
    );
  }
}

function providerIdentifier(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > MAX_PROVIDER_ID_BYTES
    || /[\u0000-\u001f\u007f]/.test(value)
    || !wellFormed(value)
  ) {
    drift("A private provider reference is malformed");
  }
  return value;
}

function gmailJobNimbusAttachments(value, label) {
  if (!Array.isArray(value) || value.length !== 1) {
    invalid(
      "invalid_gmail_attachments",
      "attachments must contain exactly one chosen JobNimbus document reference"
    );
  }
  const attachment = value[0];
  exactRecord(
    attachment,
    ["source", "documentRef"],
    [],
    `${label}.input.attachments[0]`
  );
  if (attachment.source !== "jobnimbus") {
    invalid(
      "invalid_gmail_attachment_source",
      "HCN Gmail drafts accept only a verified JobNimbus attachment"
    );
  }
  return [{
    source: "jobnimbus",
    documentRef: opaqueReference(
      attachment.documentRef,
      DOCUMENT_REF_PATTERN,
      "documentRef"
    )
  }];
}

function taskTitle(value) {
  return boundedString(value, {
    label: "title",
    maxCharacters: MAX_TITLE_CHARACTERS,
    allowEmpty: false,
    allowMultiline: false,
    exactTrimmed: true
  });
}

function taskDescription(value) {
  return boundedString(value, {
    label: "description",
    maxBytes: MAX_DESCRIPTION_BYTES,
    allowEmpty: false,
    allowMultiline: true
  });
}

function emailAddressList(value, label, required) {
  const text = boundedString(value, {
    label,
    maxBytes: MAX_EMAIL_ADDRESS_LIST_BYTES,
    allowEmpty: !required,
    allowMultiline: false,
    exactTrimmed: true
  });
  if (
    (required && !text)
    || /[\u0000-\u001f\u007f]/.test(text)
  ) {
    invalid(
      "invalid_email_material",
      `${label} must be exact single-line email recipient material`
    );
  }
  return text;
}

function emailSubject(value) {
  const subject = boundedString(value, {
    label: "subject",
    maxCharacters: MAX_EMAIL_SUBJECT_CHARACTERS,
    allowEmpty: false,
    allowMultiline: false,
    exactTrimmed: true
  });
  if (/[\u0000-\u001f\u007f]/.test(subject)) {
    invalid(
      "invalid_email_material",
      "subject must be exact single-line email header material"
    );
  }
  return subject;
}

function emailBody(value) {
  return boundedString(value, {
    label: "body",
    maxBytes: MAX_EMAIL_BODY_BYTES,
    allowEmpty: false,
    allowMultiline: true
  });
}

function engineEmailMaterial(value, label, required) {
  if (
    typeof value !== "string"
    || (required && !value)
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > MAX_EMAIL_ADDRESS_LIST_BYTES
    || /[\r\n\u0000-\u001f\u007f]/.test(value)
    || !wellFormed(value)
  ) {
    drift(`Engine Gmail ${label} material is malformed`);
  }
  return value;
}

function engineEmailSubject(value) {
  return boundedEngineText(
    value,
    MAX_EMAIL_SUBJECT_CHARACTERS,
    "Gmail subject"
  );
}

function engineEmailBody(value) {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || !wellFormed(value)
    || Buffer.byteLength(value, "utf8") > 100 * 1024
    || /[\u0000\u0008\u000b\u000c\u007f]/.test(value)
  ) {
    drift("Engine Gmail body is malformed");
  }
  return value;
}

function boundedEngineText(value, maxCharacters, label) {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || !wellFormed(value)
    || Array.from(value).length > maxCharacters
    || /[\r\n\u2028\u2029\u0000-\u001f\u007f]/.test(value)
  ) {
    drift(`Engine ${label} does not match the allowlisted shape`);
  }
  return value;
}

function boundedEngineProviderText(
  value,
  label,
  { allowEmpty = false } = {}
) {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value !== value.trim()
    || !wellFormed(value)
    || Buffer.byteLength(value, "utf8") > MAX_PROVIDER_ID_BYTES
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    drift(`Engine ${label} is malformed`);
  }
  return value;
}

function boundedString(value, {
  label,
  maxBytes,
  maxCharacters,
  allowEmpty,
  allowMultiline,
  exactTrimmed = false
}) {
  if (
    typeof value !== "string"
    || !wellFormed(value)
    || (!allowEmpty && value.trim().length === 0)
    || (exactTrimmed && value !== value.trim())
    || (
      Number.isSafeInteger(maxBytes)
      && Buffer.byteLength(value, "utf8") > maxBytes
    )
    || (
      Number.isSafeInteger(maxCharacters)
      && Array.from(value).length > maxCharacters
    )
    || (!allowMultiline && /[\r\n\u2028\u2029]/.test(value))
    || /[\u0000\u0008\u000b\u000c\u007f]/.test(value)
  ) {
    invalid("invalid_action_text", `${label} is not valid bounded text`);
  }
  return value;
}

function boundedEngineString(value, maxCharacters, label) {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || !wellFormed(value)
    || Array.from(value).length > maxCharacters
    || /[\r\n\u2028\u2029\u0000-\u001f\u007f]/.test(value)
  ) {
    drift(`Engine ${label} does not match the allowlisted shape`);
  }
  return value;
}

function opaqueReference(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    invalid("invalid_opaque_reference", `${label} must be an opaque HCN reference`);
  }
  return value;
}

function isoDate(value, label) {
  if (
    typeof value !== "string"
    || !ISO_DATE_PATTERN.test(value)
    || !canonicalDate(value)
  ) {
    invalid("invalid_iso_date", `${label} must be a real YYYY-MM-DD date`);
  }
  return value;
}

function isoInstant(value, label) {
  if (
    typeof value !== "string"
    || !ISO_INSTANT_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    drift(`Engine ${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function isoBrowserInstant(value, label) {
  if (
    typeof value !== "string"
    || !ISO_INSTANT_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    invalid(
      "invalid_iso_instant",
      `${label} must be a canonical UTC timestamp with milliseconds`
    );
  }
  return value;
}

function canonicalDate(value) {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed)
    && new Date(parsed).toISOString().slice(0, 10) === value
  );
}

function unixNoon(value) {
  return Math.floor(Date.parse(`${value}T12:00:00.000Z`) / 1000);
}

function unixSeconds(value) {
  return Math.floor(Date.parse(value) / 1000);
}

function exactRecord(value, requiredKeys, optionalKeys, label) {
  const keys = safeRecord(value, label);
  const required = new Set(requiredKeys);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !keys.includes(key))
    || keys.some((key) => !allowed.has(key))
  ) {
    invalid(
      "invalid_request_shape",
      `${label} must contain only the documented exact fields`
    );
  }
  return required;
}

function driftRecord(value, requiredKeys, optionalKeys, label) {
  let keys;
  try {
    keys = safeRecord(value, label, true);
  } catch (error) {
    if (error instanceof HcnBrowserActionContractError) throw error;
    drift(`${label} does not match the allowlisted shape`);
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !keys.includes(key))
    || keys.some((key) => !allowed.has(key))
  ) {
    drift(`${label} does not match the allowlisted shape`);
  }
}

function safeRecord(value, label, engine = false) {
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    if (engine) drift(`${label} does not match the allowlisted shape`);
    invalid("invalid_request_shape", `${label} must be a plain object`);
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string")
  ) {
    if (engine) drift(`${label} does not match the allowlisted shape`);
    invalid("invalid_request_shape", `${label} must be a plain object`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, "value")
    ) {
      if (engine) drift(`${label} does not match the allowlisted shape`);
      invalid(
        "invalid_request_shape",
        `${label} must contain plain enumerable data fields`
      );
    }
  }
  return keys;
}

function equalOptionalMaterial(actual, expected, key) {
  const expectedHas = Object.hasOwn(expected, key);
  if (Object.hasOwn(actual, key) !== expectedHas) {
    drift("Private engine material differs from the browser request");
  }
  if (expectedHas) equalMaterial(actual[key], expected[key]);
}

function equalMaterial(actual, expected) {
  if (actual !== expected) {
    drift("Engine material differs from the exact browser request");
  }
}

function compactDefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );
}

function immutableCopy(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableCopy(item)));
  }
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, immutableCopy(item)])
      )
    );
  }
  return value;
}

function wellFormed(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function invalid(code, message) {
  throw new HcnBrowserActionContractError(code, 400, message);
}

function drift(message) {
  throw new HcnBrowserActionContractError(
    "action_engine_contract_drift",
    502,
    message
  );
}
