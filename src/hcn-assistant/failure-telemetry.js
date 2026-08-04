const SAFE_ERROR_CODES = Object.freeze([
  "THRESHER_AI_PROVIDER_FAILED",
  "assistant_context_limit_exceeded",
  "duplicate_tool_call_id",
  "incomplete_provider_output",
  "invalid_assistant_input",
  "malformed_provider_output",
  "malformed_tool_call",
  "missing_assistant_message",
  "mixed_assistant_output",
  "mixed_refusal_and_tool_call",
  "parallel_tool_calls_rejected",
  "provider_output_error",
  "provider_request_failed",
  "required_first_tool_call_mismatch",
  "required_first_tool_call_missing",
  "tool_call_limit_exceeded",
  "tool_execution_failed",
  "tool_round_limit_exceeded",
  "unsupported_provider_output"
]);

const SAFE_ERROR_NAMES = Object.freeze([
  "BoundedJsonProviderError",
  "Error",
  "HcnAssistantError",
  "RangeError",
  "TypeError"
]);

export function hcnAssistantFailureStatus(value) {
  const statusCode = Number(value);
  return Number.isSafeInteger(statusCode)
    && statusCode >= 400
    && statusCode <= 599
    ? statusCode
    : 500;
}

export function createHcnAssistantFailureTelemetry({
  error,
  statusCode,
  durationMs
}) {
  const safeStatusCode = hcnAssistantFailureStatus(statusCode);
  const candidateCode = String(error?.code || "");
  const errorCode = SAFE_ERROR_CODES.includes(candidateCode)
    ? candidateCode
    : `HTTP_${safeStatusCode}`;
  const candidateName = String(error?.name || "");
  const errorName = SAFE_ERROR_NAMES.includes(candidateName)
    ? candidateName
    : "Error";
  const elapsed = Number(durationMs);
  const safeDurationMs = Number.isSafeInteger(elapsed)
    ? Math.max(0, Math.min(60_000, elapsed))
    : 0;

  return Object.freeze({
    type: "hcn_assistant_turn_failed",
    errorCode,
    errorName,
    statusCode: safeStatusCode,
    durationMs: safeDurationMs
  });
}
