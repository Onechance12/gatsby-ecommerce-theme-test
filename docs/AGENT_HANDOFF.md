# Agent Handoff

Last updated: 2026-07-10 (Claude — portable claim-filing core extracted)

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

- Claude operations branch: `claude/jobnimbus-tool-search-cpeh4n` at `2e2717e`
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
- Claude — 2026-07-10 — DONE (Codex-closed) — `t-20260710-scope-note-update`
  — `update_jobnimbus_note` now requires {query, noteId}, resolves the Chance file,
  and verifies the activity belongs to it before any PUT. On `claude/...` at `2e2717e`.
- Claude — 2026-07-10 — DONE (Codex-closed) — `t-20260710-claim-filer-production-review`
  — all 7 review questions answered in PR #1; fixture-safe hardening landed on
  `claude/...` at `2e2717e`. See "Claim Filer — Operational State" below.
- Claude — open task — extract the verified filer into a portable, bridge-ready
  core with no local sweep/CLI/JobNimbus-client dependencies —
  `t-20260710-extract-portable-claim-core`.
- Codex — next task after portable-core review — integrate that core into the
  existing Render bridge using direct fresh JobNimbus reads, strict Chance-only
  resolution, approval digests, Retell result polling, OpenAPI actions, and the
  existing gated `processJobNimbusUpdate` write path.

## Claim Filer — Operational State (2026-07-10)

- **Deployment truth:** `file:claim` is **local CLI only**. It is NOT exposed on
  the Render bridge or any custom GPT/connector. The bridge does not place carrier
  calls, run `file:claim`, or write to JobNimbus. Live calling stays double-gated
  (`ALLOW_RETELL_CALLS=true` + `execute:true`).
- **Post-call analysis (Q3):** now configured in **code** — `postCallAnalysisSchema()`
  in `src/voice/retell.js`, wired into the agent body, field names matched to what
  `postCallWriteback.js` reads. Structured extraction is preferred; transcript-derived
  values stay flagged `transcript-guess` (never high-confidence).
- **Policy readiness (Q5):** carrier-aware — a missing policy number is a warning,
  not a universal blocker; hard-blocks only for carriers flagged `requiresPolicyNumber`.
- **Writeback hygiene (Q6):** claim/adjuster/status go to JobNimbus fields; the
  note is one short operational line, no field dump.
- **Outcome (Q7):** `existing_claim_confirmed` (status_follow_up goal) is now
  distinct from `claim_filed` (new filing); goal is carried in call metadata.
- **Business defaults (Q4):** the four intentional defaults (no injuries, habitable,
  temp repairs, Titan) are PRESERVED per Chance; not copied into routine notes.
- **Redacted record:** `docs/operational-record-claim-filing.md` documents the
  end-to-end filing path and boundary with no PII/IDs/secrets.
- **Tests:** fixture-safe checks in `src/selftest.js` cover extraction, new-vs-existing
  outcome, note hygiene, no-result, spelled-out claim parse, and note-ownership.
  `npm run check` exit 0.

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

1. Claude completes `t-20260710-extract-portable-claim-core` without editing the
   production bridge.
2. Codex independently reviews the portable core, then builds the Render adapter
   and OpenAPI actions on a separate branch.
3. The bridge must resolve and re-verify a Chance-owned file on every prepare,
   call, result, and writeback step; first-match-only resolution is insufficient.
4. Claim filing uses Retell. Keep the older OpenAI/Twilio path available only for
   generic calls; do not route carrier filing through it.
5. Use normal Git first; use `docs/ARTIFACT_HANDOFF.md` only when Git transport fails.
6. Chance approves deployment, Retell-agent updates, environment changes, the
   first live bridge call, and every JobNimbus write.

## Log

- 2026-07-10 — Codex — Reviewed Claude's `2e2717e` claim-filer and note-scope
  hardening. `npm ci`, `npm run check`, `npm run sweep:fixture`, and diff checks
  pass. Official Retell documentation confirms the post-call analysis mechanism.
  Closed both review tasks. Compared the local filer with live bridge `20c86e3`:
  the bridge already has fresh JobNimbus reads/gated writes, while the filer has
  the proven Retell behavior but depends on local sweep files. Assigned Claude a
  portable-core extraction; Codex owns the Chance-only Render adapter and deploy.
- 2026-07-10 — Codex — Audited Claude's AI claim filer and exercised fixture
  dry runs. Confirmed the deterministic live-refresh/call/duplicate-guard design
  is strong and recorded Claude's report of a successful real Allstate filing.
  Chance confirmed the standard filing answers are intentional defaults: no
  injuries, habitable home, temporary repairs made, and Titan Reconstruction as
  contractor, unless current evidence or Chance identifies an exception. Opened
  a production-readiness task for carrier-aware policy gates, Retell post-call
  analysis configuration, existing-
  claim outcome handling, and JobNimbus note hygiene before bridge exposure.
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
- 2026-07-10 — Claude — Landed `t-20260710-scope-note-update` and
  `t-20260710-claim-filer-production-review` on `claude/...` at `2e2717e`.
  Note-update is now scoped to a resolved Chance file with activity-ownership
  verification. Claim filer hardened: post-call analysis schema in code,
  carrier-aware policy readiness, field/note writeback hygiene, existing-vs-new
  outcome distinction, and a redacted operational record. Business defaults
  preserved per Chance. Answered all 7 review questions in PR #1. `npm run check`
  exit 0; no live call/write/deploy. Both tasks set to needs_review — Codex to verify.
- 2026-07-10 — Claude — Extracted the portable claim-filing core
  (`src/claim-filing-core/`) on `claude/...` at `02d55c6` for
  `t-20260710-extract-portable-claim-core`. The proven filer's business logic
  (packet, standard answers, damage/cause, carrier directory, carrier-aware
  readiness, duplicate guard, Retell dynamic vars + prompt/tools + post-call
  schema, result extraction with per-field confidence, dry-run writeback proposal)
  now lives in dependency-light modules with NO imports from fileReview, sweep,
  CLI, JobNimbus clients, Gmail, Quo, or fs, and no `process.env` reads — so the
  Render bridge can import/cherry-pick it. The local CLI is now a thin wrapper
  around the same core (one implementation, not two; `reviewToClaimInput` adapts a
  sweep review to the canonical input contract in
  `docs/claim-filing-core-contract.md`). Business defaults preserved and
  overrideable; Retell stays the engine (press_digit DTMF). `npm run check` exit 0;
  fixture dry runs verified. jobnimbus-bridge branch untouched. Codex owns the
  Render/JobNimbus/OpenAPI adapter on top of this core — task set to needs_review.
