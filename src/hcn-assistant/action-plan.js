import {
  HCN_BROWSER_ACTION_TYPES,
  validateHcnBrowserActionPrepareInput
} from "../hcn-actions/browser-contracts.js";

const FILE_REF_PATTERN = "^subject_[a-f0-9]{32}$";
const ITEM_REF_PATTERN = "^ref_[a-f0-9]{32}$";
const ISO_DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const ISO_INSTANT_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
const MIN_ACTIONS = 1;
const MAX_ACTIONS = 12;

export const HCN_ASSISTANT_ACTION_INPUT_FIELDS = Object.freeze([
  "note",
  "title",
  "description",
  "due_date",
  "task_ref",
  "completed",
  "status",
  "date_of_loss",
  "event_ref",
  "starts_at",
  "ends_at",
  "to",
  "cc",
  "bcc",
  "subject",
  "body",
  "draft_ref",
  "content"
]);

const NULLABLE_TEXT = Object.freeze({
  type: ["string", "null"],
  maxLength: 8192
});

const ACTION_INPUT_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    note: { ...NULLABLE_TEXT },
    title: {
      type: ["string", "null"],
      maxLength: 256
    },
    description: {
      type: ["string", "null"],
      maxLength: 4096
    },
    due_date: {
      type: ["string", "null"],
      pattern: ISO_DATE_PATTERN
    },
    task_ref: {
      type: ["string", "null"],
      pattern: ITEM_REF_PATTERN
    },
    completed: {
      type: ["boolean", "null"]
    },
    status: {
      type: ["string", "null"],
      maxLength: 128
    },
    date_of_loss: {
      type: ["string", "null"],
      pattern: ISO_DATE_PATTERN
    },
    event_ref: {
      type: ["string", "null"],
      pattern: ITEM_REF_PATTERN
    },
    starts_at: {
      type: ["string", "null"],
      pattern: ISO_INSTANT_PATTERN
    },
    ends_at: {
      type: ["string", "null"],
      pattern: ISO_INSTANT_PATTERN
    },
    to: {
      type: ["string", "null"],
      maxLength: 2048
    },
    cc: {
      type: ["string", "null"],
      maxLength: 2048
    },
    bcc: {
      type: ["string", "null"],
      maxLength: 2048
    },
    subject: {
      type: ["string", "null"],
      maxLength: 998
    },
    body: {
      type: ["string", "null"],
      maxLength: 49152
    },
    draft_ref: {
      type: ["string", "null"],
      pattern: ITEM_REF_PATTERN
    },
    content: {
      type: ["string", "null"],
      maxLength: 1600
    }
  },
  required: [...HCN_ASSISTANT_ACTION_INPUT_FIELDS]
});

/**
 * One uniform strict action shape keeps the function schema compatible with
 * strict mode. Fields that do not apply to the selected action type are null.
 */
export const HCN_ASSISTANT_ACTION_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: [...HCN_BROWSER_ACTION_TYPES]
    },
    input: ACTION_INPUT_SCHEMA
  },
  required: ["type", "input"]
});

export const HCN_ASSISTANT_ACTION_PLAN_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    file_ref: {
      type: "string",
      pattern: FILE_REF_PATTERN
    },
    actions: {
      type: "array",
      minItems: MIN_ACTIONS,
      maxItems: MAX_ACTIONS,
      items: HCN_ASSISTANT_ACTION_SCHEMA
    }
  },
  required: ["file_ref", "actions"]
});

/**
 * Translate strict model action material into the existing browser action
 * contract. This function is pure; it cannot execute or persist the plan.
 */
export function translateAssistantActionPlan(value) {
  exactRecord(value, ["file_ref", "actions"], "action plan");
  if (
    !Array.isArray(value.actions)
    || value.actions.length < MIN_ACTIONS
    || value.actions.length > MAX_ACTIONS
  ) {
    invalid("actions must contain 1-12 items");
  }

  const operations = value.actions.map((action, index) =>
    translateAction(action, index)
  );

  return validateHcnBrowserActionPrepareInput({
    fileRef: value.file_ref,
    operations
  });
}

function translateAction(action, index) {
  const label = `actions[${index}]`;
  exactRecord(action, ["type", "input"], label);
  if (
    typeof action.type !== "string"
    || !HCN_BROWSER_ACTION_TYPES.includes(action.type)
  ) {
    invalid(`${label}.type is not enabled`);
  }
  exactRecord(
    action.input,
    HCN_ASSISTANT_ACTION_INPUT_FIELDS,
    `${label}.input`
  );

  const allowed = relevantFields(action.type);
  for (const field of HCN_ASSISTANT_ACTION_INPUT_FIELDS) {
    if (!allowed.has(field) && action.input[field] !== null) {
      invalid(`${label}.input.${field} must be null for ${action.type}`);
    }
  }

  return {
    type: action.type,
    input: translateInput(action.type, action.input, label)
  };
}

function relevantFields(type) {
  switch (type) {
    case "jobnimbus.create_note":
      return new Set(["note"]);
    case "jobnimbus.create_task":
      return new Set(["title", "description", "due_date"]);
    case "jobnimbus.update_task":
      return new Set([
        "task_ref",
        "title",
        "description",
        "due_date",
        "completed"
      ]);
    case "jobnimbus.update_status":
      return new Set(["status"]);
    case "jobnimbus.update_contact":
      return new Set(["date_of_loss"]);
    case "jobnimbus.create_calendar_event":
      return new Set(["title", "description", "starts_at", "ends_at"]);
    case "jobnimbus.update_calendar_event":
      return new Set([
        "event_ref",
        "title",
        "description",
        "starts_at",
        "ends_at"
      ]);
    case "gmail.create_draft":
      return new Set(["to", "cc", "bcc", "subject", "body"]);
    case "gmail.send":
      return new Set(["draft_ref"]);
    case "quo.send_text":
      return new Set(["to", "content"]);
    default:
      invalid("Action type is not enabled");
  }
}

function translateInput(type, input, label) {
  switch (type) {
    case "jobnimbus.create_note":
      return {
        note: requiredValue(input.note, `${label}.input.note`)
      };
    case "jobnimbus.create_task":
      return compact({
        title: requiredValue(input.title, `${label}.input.title`),
        description: optionalValue(input.description),
        dueDate: optionalValue(input.due_date)
      });
    case "jobnimbus.update_task": {
      const changes = compact({
        title: optionalValue(input.title),
        description: optionalValue(input.description),
        dueDate: optionalValue(input.due_date),
        completed: optionalValue(input.completed)
      });
      if (Object.keys(changes).length === 0) {
        invalid(`${label} must contain at least one task change`);
      }
      return {
        taskRef: requiredValue(input.task_ref, `${label}.input.task_ref`),
        ...changes
      };
    }
    case "jobnimbus.update_status":
      return {
        status: requiredValue(input.status, `${label}.input.status`)
      };
    case "jobnimbus.update_contact":
      return {
        dateOfLoss: requiredValue(
          input.date_of_loss,
          `${label}.input.date_of_loss`
        )
      };
    case "jobnimbus.create_calendar_event":
      return compact({
        title: requiredValue(input.title, `${label}.input.title`),
        description: optionalValue(input.description),
        startsAt: requiredValue(
          input.starts_at,
          `${label}.input.starts_at`
        ),
        endsAt: requiredValue(input.ends_at, `${label}.input.ends_at`)
      });
    case "jobnimbus.update_calendar_event": {
      if ((input.starts_at === null) !== (input.ends_at === null)) {
        invalid(`${label} time changes require starts_at and ends_at`);
      }
      const changes = compact({
        title: optionalValue(input.title),
        description: optionalValue(input.description),
        startsAt: optionalValue(input.starts_at),
        endsAt: optionalValue(input.ends_at)
      });
      if (Object.keys(changes).length === 0) {
        invalid(`${label} must contain at least one calendar change`);
      }
      return {
        eventRef: requiredValue(
          input.event_ref,
          `${label}.input.event_ref`
        ),
        ...changes
      };
    }
    case "gmail.create_draft":
      return compact({
        to: requiredValue(input.to, `${label}.input.to`),
        cc: optionalValue(input.cc),
        bcc: optionalValue(input.bcc),
        subject: requiredValue(input.subject, `${label}.input.subject`),
        body: requiredValue(input.body, `${label}.input.body`)
      });
    case "gmail.send":
      return {
        draftRef: requiredValue(
          input.draft_ref,
          `${label}.input.draft_ref`
        )
      };
    case "quo.send_text":
      return {
        to: requiredValue(input.to, `${label}.input.to`),
        content: requiredValue(input.content, `${label}.input.content`)
      };
    default:
      invalid("Action type is not enabled");
  }
}

function optionalValue(value) {
  return value === null ? undefined : value;
}

function requiredValue(value, label) {
  if (value === null) invalid(`${label} is required`);
  return value;
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );
}

function exactRecord(value, keys, label) {
  let prototype;
  let ownKeys;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    invalid(`${label} must be a plain object`);
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)
  ) {
    invalid(`${label} must be a plain object`);
  }
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    invalid(`${label} must contain only the documented exact fields`);
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, "value")
    ) {
      invalid(`${label} must contain plain enumerable data fields`);
    }
  }
}

function invalid(message) {
  throw new HcnAssistantActionPlanError(message);
}

export class HcnAssistantActionPlanError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "HcnAssistantActionPlanError";
    this.code = "invalid_assistant_action_plan";
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
