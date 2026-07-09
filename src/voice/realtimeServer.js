import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { buildStreamUrl } from "./twilioRealtimeCall.js";

const DEFAULT_INSTRUCTIONS = [
  "You are a polite, efficient phone assistant for Wave Public Adjusting / Home Claim Network.",
  "You call insurance carriers on behalf of policyholders (with authorization on file) to file claims,",
  "get claim numbers, confirm adjuster assignments, and check claim status.",
  "Speak naturally and briefly. Confirm key facts (claim number, adjuster name/phone, next steps) by repeating them back.",
  "Never invent policy details. If asked something you do not know, say you will follow up."
].join(" ");

export async function runRealtimeVoiceServer(config) {
  if (!config.openai.apiKey) {
    console.log("Voice server blocked: set OPENAI_API_KEY in .env first.");
    process.exitCode = 1;
    return;
  }

  const port = config.voice.serverPort;
  const server = http.createServer((request, response) => {
    if (request.url === "/health" || request.url === "/") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "voice-realtime-bridge" }));
      return;
    }
    if (request.url?.startsWith("/twiml")) {
      const streamUrl = buildStreamUrl(config);
      response.writeHead(200, { "content-type": "text/xml" });
      response.end(`<Response><Connect><Stream url="${streamUrl}"/></Connect></Response>`);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const wss = new WebSocketServer({ server, path: "/media-stream" });

  wss.on("connection", (twilioSocket, request) => {
    if (config.voice.streamToken) {
      const url = new URL(request.url, "http://localhost");
      if (url.searchParams.get("token") !== config.voice.streamToken) {
        console.log("- rejected media stream connection: bad token");
        twilioSocket.close(1008, "unauthorized");
        return;
      }
    }
    console.log("- Twilio media stream connected");
    bridgeCall(config, twilioSocket);
  });

  await new Promise((resolve) => server.listen(port, resolve));
  console.log("Twilio <-> OpenAI realtime voice bridge");
  console.log(`- listening on port ${port}`);
  console.log(`- health: http://localhost:${port}/health`);
  console.log(`- twiml: http://localhost:${port}/twiml`);
  console.log(`- media stream: ws://localhost:${port}/media-stream`);
  console.log(`- model: ${config.openai.realtimeModel}, voice: ${config.openai.voice}`);
  console.log("- waiting for calls (Ctrl+C to stop)");
}

function bridgeCall(config, twilioSocket) {
  let streamSid = "";
  let openaiReady = false;
  const pendingAudio = [];

  const openaiSocket = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.openai.realtimeModel)}`,
    { headers: { authorization: `Bearer ${config.openai.apiKey}` } }
  );

  openaiSocket.on("open", () => {
    openaiSocket.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        audio: {
          input: { format: { type: "audio/pcmu" }, turn_detection: { type: "server_vad" } },
          output: { format: { type: "audio/pcmu" }, voice: config.openai.voice }
        },
        instructions: process.env.VOICE_AGENT_INSTRUCTIONS || DEFAULT_INSTRUCTIONS
      }
    }));
    openaiReady = true;
    for (const chunk of pendingAudio.splice(0)) {
      openaiSocket.send(chunk);
    }
    console.log("- OpenAI realtime session opened");
  });

  openaiSocket.on("message", (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (event.type === "response.output_audio.delta" && event.delta && streamSid) {
      twilioSocket.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: event.delta }
      }));
    }
    if (event.type === "input_audio_buffer.speech_started" && streamSid) {
      // Barge-in: clear queued assistant audio when the caller starts talking.
      twilioSocket.send(JSON.stringify({ event: "clear", streamSid }));
    }
    if (event.type === "error") {
      console.log(`- OpenAI realtime error: ${config.redact(JSON.stringify(event.error || event)).slice(0, 300)}`);
    }
  });

  openaiSocket.on("close", () => {
    if (twilioSocket.readyState === WebSocket.OPEN) twilioSocket.close();
  });
  openaiSocket.on("error", (error) => {
    console.log(`- OpenAI socket error: ${config.redact(error.message)}`);
  });

  twilioSocket.on("message", (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (event.event === "start") {
      streamSid = event.start?.streamSid || "";
      console.log(`- call started (streamSid ${streamSid})`);
    }
    if (event.event === "media" && event.media?.payload) {
      const append = JSON.stringify({ type: "input_audio_buffer.append", audio: event.media.payload });
      if (openaiReady && openaiSocket.readyState === WebSocket.OPEN) {
        openaiSocket.send(append);
      } else {
        pendingAudio.push(append);
      }
    }
    if (event.event === "stop") {
      console.log("- call ended");
      if (openaiSocket.readyState === WebSocket.OPEN) openaiSocket.close();
    }
  });

  twilioSocket.on("close", () => {
    if (openaiSocket.readyState === WebSocket.OPEN) openaiSocket.close();
  });
}
