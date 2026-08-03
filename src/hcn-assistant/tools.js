const FILE_REF_PATTERN = /^subject_[a-f0-9]{32}$/;
const EVIDENCE_REF_PATTERN = /^ref_[a-f0-9]{32}$/;

/**
 * The complete model-facing Thresher toolbelt.
 *
 * Every entry is a read. There is intentionally no plan, approval, send,
 * write, upload, call, delete, credential, identity-selection, or generic
 * HTTP tool in this registry. The server injects and rechecks the signed-in
 * employee identity for every call.
 */
export const HCN_ASSISTANT_TOOL_NAMES = Object.freeze([
  "read_work_center",
  "review_file",
  "read_file_document_catalog",
  "read_file_document",
  "read_file_photo_catalog",
  "research_file_hail_dates",
  "read_calendar_day",
  "run_management_sweep",
  "read_closed_file_benchmark"
]);

const TOOL_NAME_SET = new Set(HCN_ASSISTANT_TOOL_NAMES);

export const HCN_ASSISTANT_TOOLS = deepFreeze([
  {
    type: "function",
    name: "read_work_center",
    description:
      "Read one page of the signed-in employee's active assigned JobNimbus files. Page through results to locate an exact file_ref.",
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
    description:
      "Read fresh JobNimbus, Gmail, and Quo evidence plus deterministic HCN workflow intelligence for one exact active file assigned to the signed-in employee.",
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
    name: "read_file_document_catalog",
    description:
      "Read the complete opaque metadata catalog of operational JobNimbus documents for one exact assigned file, including older documents not present in the recent file review.",
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
    name: "read_file_document",
    description:
      "Read and analyze one exact JobNimbus document already listed by review_file or read_file_document_catalog. Requires both opaque file_ref and document_ref and never uploads or changes the document.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        file_ref: {
          type: "string",
          pattern: "^subject_[a-f0-9]{32}$"
        },
        document_ref: {
          type: "string",
          pattern: "^ref_[a-f0-9]{32}$"
        }
      },
      required: ["file_ref", "document_ref"]
    }
  },
  {
    type: "function",
    name: "read_file_photo_catalog",
    description:
      "Read an opaque metadata catalog of JobNimbus photos for one exact assigned file. This proves what photo batches exist but does not claim visual findings.",
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
    name: "research_file_hail_dates",
    description:
      "Research bounded hail-date candidates for the exact assigned file's verified JobNimbus property address. Results are research evidence only and never update a date of loss.",
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
    name: "read_calendar_day",
    description:
      "Read the signed-in employee's Google Calendar for one exact YYYY-MM-DD day. Use file_ref as an empty string for privacy-minimized free/busy only. In a client-file chat, use that chat's exact opaque file_ref to find only strongly correlated appointment times; raw event titles, descriptions, locations, attendees, contacts, links, and provider ids are never returned.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$"
        },
        file_ref: {
          type: "string",
          pattern: "^(?:|subject_[a-f0-9]{32})$"
        }
      },
      required: ["date", "file_ref"]
    }
  },
  {
    type: "function",
    name: "run_management_sweep",
    description:
      "Run the role-authorized company activity-gap sweep. The server rejects this tool unless the signed-in HCN role has management access.",
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
    name: "read_closed_file_benchmark",
    description:
      "Read the role-authorized four-year JobNimbus closed-file benchmark and repeatability leaders. The server rejects this tool unless the signed-in HCN role has management access.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          minimum: 5,
          maximum: 30
        }
      },
      required: ["limit"]
    }
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
    case "read_file_document_catalog":
    case "read_file_photo_catalog":
    case "research_file_hail_dates":
      exactRecord(input, ["file_ref"], `${name} input`);
      requireFileRef(input.file_ref, name);
      return Object.freeze({ fileRef: input.file_ref });
    case "read_file_document":
      exactRecord(
        input,
        ["file_ref", "document_ref"],
        "read_file_document input"
      );
      requireFileRef(input.file_ref, "read_file_document");
      if (
        typeof input.document_ref !== "string"
        || !EVIDENCE_REF_PATTERN.test(input.document_ref)
      ) {
        malformed(
          "read_file_document requires one opaque document_ref"
        );
      }
      return Object.freeze({
        fileRef: input.file_ref,
        documentRef: input.document_ref
      });
    case "read_calendar_day":
      exactRecord(
        input,
        ["date", "file_ref"],
        "read_calendar_day input"
      );
      if (
        typeof input.date !== "string"
        || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
        || !validCalendarDate(input.date)
      ) {
        malformed("read_calendar_day requires date as YYYY-MM-DD");
      }
      if (
        input.file_ref !== ""
        && !FILE_REF_PATTERN.test(input.file_ref)
      ) {
        malformed(
          "read_calendar_day file_ref must be empty or one opaque file_ref"
        );
      }
      return Object.freeze({
        date: input.date,
        fileRef: input.file_ref
      });
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
        malformed(
          "limit_per_adjuster must be an integer from 1 through 10"
        );
      }
      return Object.freeze({
        limitPerAdjuster: input.limit_per_adjuster
      });
    case "read_closed_file_benchmark":
      exactRecord(input, ["limit"], "read_closed_file_benchmark input");
      if (
        !Number.isSafeInteger(input.limit)
        || input.limit < 5
        || input.limit > 30
      ) {
        malformed("limit must be an integer from 5 through 30");
      }
      return Object.freeze({ limit: input.limit });
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

function requireFileRef(value, toolName) {
  if (typeof value !== "string" || !FILE_REF_PATTERN.test(value)) {
    malformed(`${toolName} requires one opaque file_ref`);
  }
}

function validCalendarDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day
  );
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
    || ownKeys.some(
      (key) => typeof key !== "string" || !keys.includes(key)
    )
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
