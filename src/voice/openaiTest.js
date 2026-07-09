export async function runOpenAiTest(config) {
  if (!config.openai.apiKey) {
    console.log("OpenAI test blocked: set OPENAI_API_KEY in .env first.");
    process.exitCode = 1;
    return;
  }

  console.log("OpenAI API key test (key is never printed)");
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${config.openai.apiKey}` }
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`models request failed with ${response.status}: ${config.redact(text.slice(0, 300))}`);
    }
    const payload = await response.json();
    const models = Array.isArray(payload?.data) ? payload.data.map((model) => model.id) : [];
    console.log(`- OK: key accepted, ${models.length} models visible`);
    const realtime = models.filter((id) => id.includes("realtime")).slice(0, 5);
    if (realtime.length) {
      console.log(`- realtime models available: ${realtime.join(", ")}`);
    }
    console.log(`- configured realtime model: ${config.openai.realtimeModel}`);
    console.log(`- configured voice: ${config.openai.voice}`);
  } catch (error) {
    console.log(`- FAIL: ${config.redact(error.message)}`);
    process.exitCode = 1;
  }
}
