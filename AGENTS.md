# HCN/Wave JobNimbus Operations Assistant

This repository contains the assistant that reviews and advances Chance Pearson's
JobNimbus claim files. The operational rules live in `docs/hcn-wave-ops.md` and
the account/tool map lives in `docs/operating-context.md`.

## Multiple Agents Work Here

Claude and Codex are peer collaborators. Chance is the owner and final decision
maker.

Before starting work:

1. Read `docs/AGENT_HANDOFF.md`.
2. Read the relevant open files in `agent-tasks/`.
3. Check the claimed-work section before editing overlapping files.
4. Pull the latest branch state before making claims about current behavior.

Before stopping work:

1. Update the relevant task file with facts, verification, and the branch or
   commit containing the result.
2. Update `docs/AGENT_HANDOFF.md` with current state and unresolved questions.
3. Commit only code and documentation. Never commit runtime data or secrets.

## Division Of Strengths

- Claude: broad audits, clean-room implementation, documentation synthesis,
  carrier/voice behavior design, and pull-request review.
- Codex: local JobNimbus/API access, authenticated browser context, live Render
  verification, connector testing, and tactical integration.
- Both: review each other's claims against code and observed behavior. Neither
  agent marks work complete based only on a plausible explanation.

Use `claude/*` and `codex/*` branches. Do not push directly to `main`, deploy to
Render, change live environment variables, or write to JobNimbus without
Chance's explicit approval.

## Repository Boundaries

The repository currently has two distinct runtime lines:

- `claude/jobnimbus-tool-search-cpeh4n`: the larger operations-assistant system.
- `jobnimbus-bridge`: the currently deployed ChatGPT/Render bridge line.

Do not assume code on one line is live on the other. Any integration task must
name its source branch, target branch, deployment target, and verification plan.

This repository is separate from Jobrolo. Never access, edit, import, deploy, or
reuse Jobrolo code or infrastructure from this project.

## Safety And Data Handling

- Never commit `.env`, OAuth credentials, API keys, tokens, recordings, call
  transcripts, raw JobNimbus exports, generated client packets, or client PII.
- Keep `data/`, `reports/`, and `work/` local and git-ignored.
- Operational tools gather evidence; the reviewing agent decides what the
  evidence means.
- JobNimbus writes, emails, texts, calls, calendar changes, and deployments need
  an explicit approval step unless Chance directly authorizes that exact action.
- Preserve the dry-run and `execute` gates. Never weaken them to make a test pass.
- Treat production verification as read-only unless the task explicitly allows
  a reversible test.

## Collaboration Channels

- Current truth and ownership: `docs/AGENT_HANDOFF.md`
- Concrete work: `agent-tasks/*.task.json`
- Code review and discussion: GitHub pull requests or issues
- Product source code: agent-specific work branches

Task-state files are coordination metadata, not a place for client facts. Use
JobNimbus IDs only when unavoidable and never include names, addresses, policy
numbers, claim numbers, phone numbers, email addresses, or document contents.

## Verification

Run the smallest relevant checks, plus the baseline when code changes:

```bash
npm ci
npm run check
```

For fixture-safe review logic, also run:

```bash
npm run sweep:fixture
```

Never claim a live connector or deployment works until it has been verified in
the environment where it will run.
