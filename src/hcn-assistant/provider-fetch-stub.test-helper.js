import { appendFileSync } from "node:fs";

const THRESHER_GROQ_RESPONSES_URL =
  "https://api.groq.com/openai/v1/responses";
const originalFetch = globalThis.fetch;
const recordPath =
  String(process.env.HCN_TEST_THRESHER_RECORD_PATH || "").trim();
const responseText =
  String(process.env.HCN_TEST_THRESHER_RESPONSE_TEXT || "").trim();
const toolPromptMarker =
  String(process.env.HCN_TEST_THRESHER_TOOL_PROMPT_MARKER || "").trim();

if (!recordPath || !responseText) {
  throw new Error("HCN test provider stub is not configured.");
}

globalThis.fetch = async function hcnTestFetch(input, init = {}) {
  const url =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : String(input?.url || "");
  if (url !== THRESHER_GROQ_RESPONSES_URL) {
    return originalFetch(input, init);
  }

  const body = JSON.parse(String(init.body || "{}"));
  appendFileSync(
    recordPath,
    `${JSON.stringify({
      url,
      method: String(init.method || "GET").toUpperCase(),
      body
    })}\n`,
    "utf8"
  );

  const serializedInput = JSON.stringify(body.input || []);
  const latestUserMessage = Array.isArray(body.input)
    ? [...body.input].reverse().find(
      (item) => item?.role === "user" && typeof item?.content === "string"
    )?.content || ""
    : "";
  if (toolPromptMarker && latestUserMessage.includes(toolPromptMarker)) {
    const hasToolOutput = Array.isArray(body.input)
      && body.input.some(
        (item) => item?.type === "function_call_output"
      );
    if (!hasToolOutput) {
      const fileRef = serializedInput.match(/subject_[a-f0-9]{32}/)?.[0];
      if (!fileRef) {
        throw new Error("HCN test document-catalog tool call is missing file_ref.");
      }
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              id: "rs_catalog_fixture",
              type: "reasoning",
              summary: [],
              encrypted_content: "encrypted_catalog_fixture"
            },
            {
              id: "fc_catalog_fixture",
              type: "function_call",
              call_id: "call_catalog_fixture",
              name: "read_file_document_catalog",
              arguments: JSON.stringify({ file_ref: fileRef }),
              status: "completed"
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  }

  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: responseText
            }
          ]
        }
      ]
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    }
  );
};
