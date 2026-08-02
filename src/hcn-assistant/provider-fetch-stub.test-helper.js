import { appendFileSync } from "node:fs";

const THRESHER_GROQ_RESPONSES_URL =
  "https://api.groq.com/openai/v1/responses";
const originalFetch = globalThis.fetch;
const recordPath =
  String(process.env.HCN_TEST_THRESHER_RECORD_PATH || "").trim();
const responseText =
  String(process.env.HCN_TEST_THRESHER_RESPONSE_TEXT || "").trim();

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
