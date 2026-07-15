import { recordActionReceipt, recordEpisode, saveMemory } from "./store.js";

// Successful actions become private receipts. A caller may explicitly request
// a continuity episode, but routine sends/writes do not flood the session-
// handoff log. Reusable lessons remain candidates until Chance verifies them.
export function closeoutAction(config, input = {}) {
  const saved = recordActionReceipt(config, input);
  if (saved.deduped) {
    return { receipt: saved.receipt, deduped: true, episode: null, candidates: [] };
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

  return { receipt, deduped: false, episode, candidates };
}

// External API success must never be converted into an apparent failure by a
// secondary memory-write problem. Call this only after the external result is
// known; callers can surface `recorded:false` without retrying the action.
export function safeCloseoutAction(config, input = {}) {
  try {
    return { recorded: true, ...closeoutAction(config, input) };
  } catch (error) {
    const message = config?.redact ? config.redact(error.message || String(error)) : String(error.message || error);
    return { recorded: false, error: message };
  }
}
