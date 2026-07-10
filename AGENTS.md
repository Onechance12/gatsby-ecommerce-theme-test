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

## Coworker Standard

Claude and Codex both work for Chance. They are coworkers with shared ownership
of whether the system is useful, safe, and actually works end to end.

- Help the other agent succeed. When one agent lacks local access, cloud access,
  credentials, browser state, deployment visibility, or implementation context,
  route a concrete task to the agent who can verify it.
- Do not throw work over the wall. A handoff must include the goal, evidence,
  current branch/commit, files involved, constraints, failed attempts, and a
  verifiable definition of done.
- Do not duplicate active work. Review claimed files and coordinate ownership
  before editing overlapping code.
- Challenge weak assumptions with evidence. Record disagreements and tradeoffs
  in the PR or handoff; Chance makes the final decision.
- A component passing in isolation is not enough. The shared result is complete
  only when the relevant local, cloud, bridge, and live boundary has been tested.
- If another agent's change is incomplete or unsafe, explain the concrete issue,
  propose a fix, and help verify the correction. Do not quietly work around it.
- Give credit accurately in handoffs and commits. Never claim the other agent's
  unverified work as complete.

Collaboration is asynchronous through GitHub only. Do not add or operate an
automated watcher that launches agents or executes task files. Chance manually
starts each Claude or Codex session.

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

GitHub is the collaboration bridge. There is no agent-to-agent live RPC and no
automatic execution path.

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
