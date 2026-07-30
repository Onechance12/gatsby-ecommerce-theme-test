import {
  HCN_ASSISTANT_ACTION_PLAN_SCHEMA,
  translateAssistantActionPlan
} from "./action-plan.js";

const FILE_REF_PATTERN = /^subject_[a-f0-9]{32}$/;

export const HCN_ASSISTANT_TOOL_NAMES = Object.freeze([
  "read_work_center",
  "review_file",
  "run_management_sweep",
  "prepare_action_plan"
]);

const TOOL_NAME_SET = new Set(HCN_ASSISTANT_TOOL_NAMES);

export const HCN_ASSISTANT_TOOLS = deepFreeze([
  {
    type: "function",
    name: "read_work_center",
    description: "Read one page of the signed-in employee's assigned work center. Page through results when an exact file is not in the first page.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        offset: {
          type: "integer",
          minimum: 0,
          maximum: 5000
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50
        }
      },
      required: ["offset", "limit"]
    }
  },
  {
    type: "function",
    name: "review_file",
    description: "Read fresh evidence for one exact assigned HCN file.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        file_ref: {
          type: "string",
          pattern: "^subject_[a-f0-9]{32}$"
        }
      },
      required: ["file_ref"]
    }
  },
  {
    type: "function",
    name: "run_management_sweep",
    description: "Run the authorized management activity-gap sweep.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit_per_adjuster: {
          type: "integer",
          minimum: 1,
          maximum: 10
        }
      },
      required: ["limit_per_adjuster"]
    }
  },
  {
    type: "function",
    name: "prepare_action_plan",
    description:
      "Prepare exact file actions for human review; this never executes them.",
    strict: true,
    parameters: HCN_ASSISTANT_ACTION_PLAN_SCHEMA
  }
]);

/**
 * Validate and normalize one model tool call. Authentication and authorization
 * are intentionally absent; the server injects the assigned identity later.
 */
export function normalizeHcnAssistantToolCall(name, input) {
  if (typeof name !== "string" || !TOOL_NAME_SET.has(name)) {
    throw new HcnAssistantToolError(
      "unknown_tool",
      "The requested assistant tool is not enabled."
    );
  }

  switch (name) {
    case "read_work_center":
      exactRecord(
        input,
        ["offset", "limit"],
        "read_work_center input"
      );
      if (
        !Number.isSafeInteger(input.offset)
        || input.offset < 0
        || input.offset > 5000
        || !Number.isSafeInteger(input.limit)
        || input.limit < 1
        || input.limit > 50
      ) {
        malformed(
          "read_work_center requires offset 0-5000 and limit 1-50"
        );
      }
      return Object.freeze({
        offset: input.offset,
        limit: input.limit
      });
    case "review_file":
      exactRecord(input, ["file_ref"], "review_file input");
      if (
        typeof input.file_ref !== "string"
        || !FILE_REF_PATTERN.test(input.file_ref)
      ) {
        malformed("review_file requires one opaque file_ref");
      }
      return Object.freeze({ fileRef: input.file_ref });
    case "run_management_sweep":
      exactRecord(
        input,
        ["limit_per_adjuster"],
        "run_management_sweep input"
      );
      if (
        !Number.isSafeInteger(input.limit_per_adjuster)
        || input.limit_per_adjuster < 1
        || input.limit_per_adjuster > 10
      ) {
        malformed("limit_per_adjuster must be an integer from 1 through 10");
      }
      return Object.freeze({
        limitPerAdjuster: input.limit_per_adjuster
      });
    case "prepare_action_plan":
      return translateAssistantActionPlan(input);
    default:
      throw new HcnAssistantToolError(
        "unknown_tool",
        "The requested assistant tool is not enabled."
      );
  }
}

export class HcnAssistantToolError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "HcnAssistantToolError";
    this.code = code;
  }
}

function exactRecord(value, keys, label) {
  let prototype;
  let ownKeys;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    malformed(`${label} must be a plain object`);
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)
  ) {
    malformed(`${label} must be a plain object`);
  }
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    malformed(`${label} must contain only its documented fields`);
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, "value")
    ) {
      malformed(`${label} must contain plain enumerable data fields`);
    }
  }
}

function malformed(message) {
  throw new HcnAssistantToolError("malformed_tool_arguments", message);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
