import { recordActionReceipt, recordEpisode, saveMemory } from "./store.js";
import { appendActionReceiptToFileSnapshot } from "./fileSnapshot.js";

// Successful actions become private receipts. Routine sends/writes do not
// flood the session handoff log, and reusable lessons stay unverified until
// Chance explicitly promotes them.
export function closeoutAction(config, input = {}) {
  const saved = recordActionReceipt(config, input);
  let snapshotUpdate;
  try {
    snapshotUpdate = appendActionReceiptToFileSnapshot(config, saved.receipt);
  } catch (error) {
    snapshotUpdate = {
      updated: false,
      error: config?.redact ? config.redact(error.message || String(error)) : String(error.message || error)
    };
  }
  if (saved.deduped) {
    return { receipt: saved.receipt, deduped: true, episode: null, candidates: [], snapshotUpdate };
  }

  const receipt = saved.receipt;
  const episode = input.recordEpisode === true
    ? recordEpisode(config, {
      summary: receipt.summary,
      decisions: input.decisions || [],
      commitments: receipt.followUps,
      openQuestions: input.openQuestions || [],
      corrections: input.corrections || []
    })
    : null;

  const candidates = [];
  for (const lesson of Array.isArray(input.learningCandidates) ? input.learningCandidates : []) {
    const content = String(lesson?.content || lesson || "").trim();
    if (!content) continue;
    const savedLesson = saveMemory(config, {
      lane: "company",
      kind: lesson.kind || "lesson",
      content,
      subjectKey: lesson.subjectKey || `action:${receipt.channel}`,
      confidence: lesson.confidence ?? 0.6,
      importance: lesson.importance ?? 5,
      evidence: [{
        type: "action_receipt",
        id: receipt.id,
        note: `Observed after ${receipt.channel}/${receipt.action}`,
        verification: "observed"
      }]
    });
    candidates.push(savedLesson.record);
  }

  return { receipt, deduped: false, episode, candidates, snapshotUpdate };
}

// A successful external action must never appear failed because recording its
// receipt failed. This helper is called only after the external API succeeds.
export function safeCloseoutAction(config, input = {}) {
  try {
    return { recorded: true, ...closeoutAction(config, input) };
  } catch (error) {
    const message = config?.redact ? config.redact(error.message || String(error)) : String(error.message || error);
    return { recorded: false, error: message };
  }
}
