#!/usr/bin/env node

import { loadConfig } from "./lib/config.js";
import { ensureRuntimeDirs } from "./lib/paths.js";
import { runProbe } from "./jobnimbus/probe.js";
import { runAudit } from "./audit/runAudit.js";
import { runFieldMap } from "./audit/runFieldMap.js";
import { runPaginationAudit } from "./audit/runPaginationAudit.js";
import { runSweep } from "./sweep/runSweep.js";
import { runChanceSweep } from "./sweep/runChanceSweep.js";
import { runFileReview, runSearch } from "./assistant/fileReview.js";
import { runClaimPrep } from "./assistant/claimPrep.js";
import { runChatTool } from "./assistant/chatTools.js";
import { runClaimCallPrompt } from "./assistant/claimCallPrompt.js";
import { runTwilioTestCall } from "./voice/twilioTestCall.js";
import { runRealtimeVoiceServer } from "./voice/realtimeServer.js";
import { runTwilioRealtimeCall } from "./voice/twilioRealtimeCall.js";
import { runOpenAiTest } from "./voice/openaiTest.js";
import { runActionTool } from "./assistant/actionTools.js";
import { runChanceAgents, runChanceApprove, runChanceQueue } from "./assistant/chanceQueue.js";
import { runStormResearch } from "./assistant/stormResearch.js";
import { runFileLedger } from "./assistant/fileLedger.js";
import { runClaimBrainAudit } from "./assistant/auditClaimBrain.js";
import { runChanceReviewPackets } from "./assistant/chanceReviewPackets.js";
import { runGmailTool } from "./google/gmail.js";
import { runDriveTool } from "./google/drive.js";
import { runQuoTool } from "./quo/quo.js";
import { runChanceBrief } from "./assistant/chanceBrief.js";

const command = process.argv[2] || "help";
const commandArgs = process.argv.slice(3);

async function main() {
  const config = loadConfig();
  ensureRuntimeDirs(config);

  if (command === "sweep") {
    await runSweep(config);
    return;
  }

  if (command === "chance:sweep") {
    await runChanceSweep(config);
    return;
  }

  if (command === "probe") {
    await runProbe(config);
    return;
  }

  if (command === "audit") {
    await runAudit(config);
    return;
  }

  if (command === "pagination:audit") {
    await runPaginationAudit(config);
    return;
  }

  if (command === "map:fields") {
    await runFieldMap(config);
    return;
  }

  if (command === "search") {
    runSearch(config, commandArgs.join(" "));
    return;
  }

  if (command === "review:file") {
    runFileReview(config, commandArgs.join(" "));
    return;
  }

  if (command === "claim:prep") {
    await runClaimPrep(config);
    return;
  }

  if (command === "storm:research") {
    await runStormResearch(config, commandArgs);
    return;
  }

  if (command === "ledger:build") {
    runFileLedger(config, commandArgs);
    return;
  }

  if (command === "ledger:audit") {
    runClaimBrainAudit(config);
    return;
  }

  if (command === "chat:tool") {
    runChatTool(config, commandArgs);
    return;
  }

  if (command === "claim:call") {
    await runClaimCallPrompt(config, commandArgs);
    return;
  }

  if (command === "voice:test-call") {
    await runTwilioTestCall(config, commandArgs);
    return;
  }

  if (command === "voice:server") {
    await runRealtimeVoiceServer(config, commandArgs);
    return;
  }

  if (command === "voice:realtime-call") {
    await runTwilioRealtimeCall(config, commandArgs);
    return;
  }

  if (command === "openai:test") {
    await runOpenAiTest(config);
    return;
  }

  if (command === "chat:action") {
    await runActionTool(config, commandArgs);
    return;
  }

  if (command === "chance:queue") {
    await runChanceQueue(config, commandArgs);
    return;
  }

  if (command === "chance:review-packets") {
    await runChanceReviewPackets(config, commandArgs);
    return;
  }

  if (command === "chance:approve") {
    await runChanceApprove(config, commandArgs);
    return;
  }

  if (command === "chance:agents") {
    runChanceAgents();
    return;
  }

  if (command === "gmail") {
    await runGmailTool(config, commandArgs);
    return;
  }

  if (command === "drive") {
    await runDriveTool(config, commandArgs);
    return;
  }

  if (command === "quo") {
    await runQuoTool(config, commandArgs);
    return;
  }

  if (command === "chance:brief") {
    runChanceBrief(config, commandArgs);
    return;
  }

  if (command === "doctor") {
    console.log("JobNimbus ops assistant doctor");
    console.log(`- mode: ${config.useFixtures ? "fixture" : "live API"}`);
    console.log(`- project root: ${config.projectRoot}`);
    console.log(`- api base url: ${config.apiBaseUrl || "(not set)"}`);
    console.log(`- api key: ${config.apiKey ? "[set]" : "(not set)"}`);
    console.log("- read tools: enabled");
    console.log(`- JobNimbus action execution: ${config.allowJobNimbusWrites ? "enabled" : "blocked by default"}`);
    console.log(`- OpenAI API key: ${config.openai.apiKey ? "[set]" : "(not set)"}`);
    console.log(`- OpenAI realtime model: ${config.openai.realtimeModel}`);
    console.log(`- OpenAI voice: ${config.openai.voice}`);
    console.log(`- Twilio account SID: ${config.twilio.accountSid ? "[set]" : "(not set)"}`);
    console.log(`- Twilio auth token: ${config.twilio.authToken ? "[set]" : "(not set)"}`);
    console.log(`- Twilio from number: ${config.twilio.fromNumber || "(not set)"}`);
    console.log(`- Twilio verified test number: ${config.twilio.verifiedTestNumber || "(not set)"}`);
    console.log(`- Twilio media stream URL: ${config.twilio.mediaStreamUrl || "(not set)"}`);
    console.log(`- Voice server port: ${config.voice.serverPort}`);
    console.log(`- Voice public base URL: ${config.voice.publicBaseUrl || "(not set)"}`);
    console.log(`- Voice call execution: ${config.twilio.allowVoiceCalls ? "enabled" : "blocked by default"}`);
    return;
  }

  console.log("JobNimbus operations assistant");
  console.log("");
  console.log("Commands:");
  console.log("  npm run sweep          Generate a sweep report");
  console.log("  npm run chance:sweep   Generate a Chance Pearson-only sweep report");
  console.log("  npm run sweep:fixture  Generate a sweep report from sample data");
  console.log("  npm run probe          Read-only API endpoint/auth probe");
  console.log("  npm run pagination:audit");
  console.log("                         Verify JobNimbus pagination/high-offset behavior");
  console.log("  npm run map:fields     Summarize statuses/custom fields from raw data");
  console.log("  npm run search -- TERM Search local synced JobNimbus files");
  console.log("  npm run review:file -- TERM");
  console.log("                         Review one file by name, claim #, address, carrier, or id");
  console.log("  npm run claim:prep     Download/read filing docs and build claim filing prep");
  console.log("  npm run storm:research -- \"Alice Gonzales\"");
  console.log("                         Research likely hail/wind DOLs from public NOAA/SPC data");
  console.log("  npm run ledger:build   Build/update local claim brain ledger");
  console.log("  npm run ledger:audit   Audit JobNimbus/local claim brain storage model");
  console.log("  npm run chat:tool -- list");
  console.log("                         List chat-callable local assistant tools");
  console.log("  npm run claim:call -- '{\"query\":\"Raj Thamizhan\",\"goal\":\"file_new_claim\"}'");
  console.log("                         Build a Mitra/future voice-agent claim call prompt");
  console.log("  npm run voice:test-call -- '{\"to\":\"+18065551212\"}'");
  console.log("                         Dry-run a Twilio voice test call");
  console.log("  npm run voice:server  Start local Twilio <-> OpenAI realtime bridge");
  console.log("  npm run voice:realtime-call -- '{\"to\":\"+18065551212\"}'");
  console.log("                         Dry-run a Twilio/OpenAI realtime voice call");
  console.log("  npm run openai:test   Verify the OpenAI API key without printing it");
  console.log("  npm run chat:tool -- review_file '{\"query\":\"Rosa Sanchez\"}'");
  console.log("                         Return structured JSON for a chat assistant");
  console.log("  npm run chat:action -- list");
  console.log("                         List dry-run/execute JobNimbus action tools");
  console.log("  npm run chance:queue   Build Chance Pearson approval queue");
  console.log("  npm run chance:review-packets");
  console.log("                         Build evidence-first Chance review packets, not action decisions");
  console.log("  npm run chance:approve -- '{\"ids\":[\"chance-001\"]}'");
  console.log("                         Dry-run approved queue items");
  console.log("  npm run chance:agents  List Chance-specific specialist agents");
  console.log("  npm run audit          Write local system audit notes");
  console.log("  npm run check          Basic local health check");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
