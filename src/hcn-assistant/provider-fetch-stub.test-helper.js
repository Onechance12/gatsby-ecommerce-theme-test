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
const calendarToolPromptMarker =
  String(
    process.env.HCN_TEST_THRESHER_CALENDAR_TOOL_PROMPT_MARKER || ""
  ).trim();
const noToolPromptMarker =
  String(process.env.HCN_TEST_THRESHER_NO_TOOL_PROMPT_MARKER || "").trim();
const historyNegativePromptMarker = String(
  process.env.HCN_TEST_THRESHER_HISTORY_NEGATIVE_PROMPT_MARKER || ""
).trim();

if (!recordPath || !responseText) {
  throw new Error("HCN test provider stub is not configured.");
}

globalThis.fetch = async function hcnTestFetch(input, init = {}) {
  const url =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : String(input?.url || "");
  if (
    calendarToolPromptMarker
    && url.startsWith(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?"
    )
  ) {
    return new Response(JSON.stringify({
      items: [{
        status: "confirmed",
        start: { dateTime: "2026-08-03T13:00:00-05:00" },
        end: { dateTime: "2026-08-03T14:00:00-05:00" },
        summary: "Assigned File Fixture inspection file 2739"
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
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
  const serializedContext = JSON.stringify({
    instructions: body.instructions || "",
    input: body.input || []
  });
  const latestUserMessage = Array.isArray(body.input)
    ? [...body.input].reverse().find(
      (item) => item?.role === "user" && typeof item?.content === "string"
    )?.content || ""
    : "";
  const functionCallNames = new Set(
    Array.isArray(body.input)
      ? body.input
          .filter(
            (item) =>
              item?.type === "function_call"
              && typeof item?.name === "string"
          )
          .map((item) => item.name)
      : []
  );
  const advertisedToolNames = new Set(
    Array.isArray(body.tools)
      ? body.tools
          .filter((tool) => typeof tool?.name === "string")
          .map((tool) => tool.name)
      : []
  );
  if (
    body.tool_choice === "required"
    && Array.isArray(body.tools)
    && body.tools.length === 1
    && body.tools[0]?.name === "review_file"
    && (!noToolPromptMarker || !latestUserMessage.includes(noToolPromptMarker))
  ) {
    const fileRef = serializedContext.match(/subject_[a-f0-9]{32}/)?.[0];
    if (!fileRef) {
      throw new Error(
        "HCN test required file review is missing the bound file_ref."
      );
    }
    return new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            id: "rs_review_file_fixture",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted_review_file_fixture"
          },
          {
            id: "fc_review_file_fixture",
            type: "function_call",
            call_id: "call_review_file_fixture",
            name: "review_file",
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
  if (
    noToolPromptMarker
    && latestUserMessage.includes(noToolPromptMarker)
  ) {
    return new Response(
      JSON.stringify({ status: "completed", output: [] }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  }
  if (
    calendarToolPromptMarker
    && latestUserMessage.includes(calendarToolPromptMarker)
  ) {
    if (!functionCallNames.has("read_calendar_day")) {
      if (!advertisedToolNames.has("read_calendar_day")) {
        throw new Error(
          "HCN test Calendar tool call was not advertised by the server."
        );
      }
      const fileRef = serializedContext.match(
        /subject_[a-f0-9]{32}/
      )?.[0];
      if (!fileRef) {
        throw new Error(
          "HCN test Calendar tool call is missing the bound file_ref."
        );
      }
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              id: "rs_calendar_fixture",
              type: "reasoning",
              summary: [],
              encrypted_content: "encrypted_calendar_fixture"
            },
            {
              id: "fc_calendar_fixture",
              type: "function_call",
              call_id: "call_calendar_fixture",
              name: "read_calendar_day",
              arguments: JSON.stringify({
                date: "2026-08-03",
                file_ref: fileRef
              }),
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
  if (toolPromptMarker && latestUserMessage.includes(toolPromptMarker)) {
    if (!functionCallNames.has("read_file_document_catalog")) {
      if (!advertisedToolNames.has("read_file_document_catalog")) {
        throw new Error(
          "HCN test document-catalog tool was not advertised by the server."
        );
      }
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
              text:
                historyNegativePromptMarker
                && latestUserMessage.includes(historyNegativePromptMarker)
                  ? "There are no JobNimbus notes or tasks on this file."
                  : responseText
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
