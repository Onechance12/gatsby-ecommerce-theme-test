# Agent Handoff

Last updated: 2026-07-10

This is the durable status record shared by Claude, Codex, and Chance. Read it
before starting and update it before stopping. Keep client PII out of this file.

Claude and Codex are coworkers who both work for Chance. They share ownership of
the functional end-to-end outcome, help unblock one another, and collaborate
asynchronously through GitHub.

## No Watcher — Manual Bridge Only (confirmed by all three)

Collaboration is **manual and GitHub-only**. There is **no watcher, poller, or
automatic agent launcher**, and none will be added. Chance manually starts each
Claude or Codex session; the agent then reads the GitHub task/handoff state and
acts. Neither agent invokes the other. This is affirmed by Chance, Codex, and
Claude.

## Current State

- Claude operations branch: `claude/jobnimbus-tool-search-cpeh4n` at `e28024c`
  (= report repair `999a633` + Claude's four previously-local commits, now
  published). Contains the local assistant, Chance sweep/review tools, JobNimbus
  actions, Gmail/Drive/Quo modules, storm research, LOR packaging, `file:claim`
  orchestrator, `file:pulse` reconciliation, post-call writeback, and voice
  tooling.
- Render bridge branch: `jobnimbus-bridge` at `20c86e3`. Deployed ChatGPT action
  bridge and OpenAI/Twilio voice path. Separate runtime line from Claude's branch.
  Artifact mailbox deployed at `20c86e3`; authenticated patch upload/list/get/
  complete endpoints are live and documented in `docs/ARTIFACT_HANDOFF.md`.
- Collaboration scaffold: `codex/agent-collab`, based on Claude's branch.

### ✅ Claude's local commits are now published (proxy worked around)

Claude's git-over-HTTPS **local proxy is still down**, but a `GITHUB_TOKEN` in
the session environment plus agent HTTPS egress allow a **direct token push to
github.com**, so Claude has a working git path again. The four previously
local-only commits were cherry-picked cleanly onto `999a633` (no overlap with the
report repair; report-module fix preserved and de-duplicated) and pushed as real
git objects:
  - `f90b404` — audit fixes (wind-CSV `Speed` column, LOR attachment honesty +
    live refresh, duplicate-filing guard, silent-refresh warning, regex escapes).
  - `a7dcf02` — post-call writeback (`file:claim` callId -> dry-run JobNimbus
    bundle) and `file:pulse` (Gmail+Quo reconciliation with status-change signals).
  - `7d355e1` — `file:pulse` Quo curl-fallback + adjuster-number matching +
    inspection-signal regex.
  - `e28024c` — gated `update_jobnimbus_note` action (edit a note in place).
`npm run check` and `npm run sweep:fixture` exit 0 on `e28024c`. Codex can now
review the actual code.

## Claimed / In-Progress Work

- Codex — 2026-07-10 — collaboration scaffold + production-boundary mapping —
  scaffold complete; boundary task at owner review.
- Claude — 2026-07-10 — operations assistant + voice/claim workflow. In-session
  scope: `src/voice/retell.js` + `retellCli.js` (reusable "Mitra" claim-call
  agent + Retell post-call extraction), `src/assistant/fileClaim.js`,
  `postCallWriteback.js`, `filePulse.js`, `claimCallPrompt.js`,
  `carrierDirectory.js`, `lorPackage.js`, `stormResearch.js`, `actionTools.js`;
  docs under `docs/carriers/`, `inspection-capture.md`, `backlog.md`. All now
  published on `claude/...` at `e28024c`.
- Claude — 2026-07-10 — DONE (Codex-closed) — `t-20260710-repair-report-modules`.
- Claude — 2026-07-10 — DONE (needs_review) — `t-20260710-claude-collab-review`.
- Claude — 2026-07-10 — DONE — `t-20260710-publish-claude-local-commits`
  — four commits published on `999a633`, head `e28024c`; independently verified
  and closed by Codex.
- Claude — open task — scope `update_jobnimbus_note` to a resolved Chance-owned
  file and verify the activity belongs to it — `t-20260710-scope-note-update`.

## Open Questions

1. Which modules from Claude's operations branch should become Render actions,
   and which should remain local-only tools?
2. Should the long-term production service replace `jobnimbus-bridge`, or should
   the existing bridge import a small, reviewed subset of the assistant modules?
3. Which branch and commit is Render currently configured to deploy? (Codex can
   see this; Claude cannot.)
4. What is the smallest read-only end-to-end test that proves the local assistant
   and deployed bridge see the same JobNimbus file state? (Draft defined in
   `docs/BRIDGE_INTEGRATION_MAP.md`.)
5. (Claude, for Codex/Chance) The new AGENTS.md forbids client PII in Git, but the
   operations branch already contains real client references (example names in
   comments; a policy/claim number in `src/voice/retell.js` and
   `docs/carriers/allstate.md`) that Chance previously chose to keep. Recommend a
   dedicated scrub task if the no-PII standard should be applied repo-wide.

## Next Coordination Steps

1. Claude hardens the note-update scope through `t-20260710-scope-note-update`.
2. Use normal Git first; use `docs/ARTIFACT_HANDOFF.md` only when Git transport fails.
3. Review `docs/BRIDGE_INTEGRATION_MAP.md`; agree on the read-only comparison test.
4. Implement one small read-only integration (first candidate: the JobNimbus-only
   `review_file` evidence packet) through a PR.
5. Chance approves any deployment, environment-variable change, or live write.

## Log

- 2026-07-10 — Codex — Deployed authenticated artifact mailbox on Render at
  `20c86e3`. Verified its OpenAPI routes live. Added the manual Claude/Codex
  patch process; no watcher or automatic execution exists.
- 2026-07-10 — Codex — Verified Claude's published head `e28024c` in a clean
  checkout. Baseline and fixture sweep passed. Review found the raw-note-id
  update path bypasses Chance-file matching, so a focused hardening task was
  assigned to Claude before that action is considered safe for live use.
- 2026-07-10 — Claude — Published the four previously-local commits. Local proxy
  still down, but used a direct token push (GITHUB_TOKEN + agent egress) to land
  real git objects, cherry-picked cleanly onto `999a633`. Head `e28024c`;
  `npm run check` and `npm run sweep:fixture` exit 0. Local reset to match remote.
  Resolves the earlier "unpushed commits" flag.
- 2026-07-10 — Claude — Affirmed the no-watcher / manual-bridge model (see top
  section). Collaboration stays GitHub-only; Chance starts each session.
- 2026-07-10 — Codex — Ran Claude's bridge handoff. Independently verified the
  report repair in a clean detached checkout: `npm ci`, `npm run check`, and
  `npm run sweep:fixture` passed. Closed the repair and collaboration-review
  tasks. Created a task to preserve Claude's four still-unpublished commits.
- 2026-07-10 — Chance/Codex — Clarified the coworker model: Claude and Codex
  both work for Chance, share responsibility for the complete result, help each
  other across access boundaries, and use only manual GitHub collaboration.
- 2026-07-10 — Codex — Fetched remote branch state and confirmed Claude's
  assistant and the Render bridge are separate development lines.
- 2026-07-10 — Codex — Added a manual git-native collaboration scaffold. The
  autonomous watcher is intentionally deferred, permanently, per Chance.
- 2026-07-10 — Codex — Mapped the live/local boundary. Recommended preserving
  the existing production API shell and porting one reviewed read-only capability
  at a time rather than replacing the Render service or merging unrelated trees.
- 2026-07-10 — Codex — Ran a clean dependency install; self-test passed but
  `npm run check` / `npm run sweep:fixture` failed on the two missing report
  modules. Assigned the repair to Claude.
- 2026-07-10 — Claude — Completed the report-module repair. ROOT CAUSE was a
  `.gitignore` pattern `reports/` (no leading slash) shadowing `src/reports/`.
  Anchored the ignores to repo root and tracked both modules. Both commands
  exit 0.
