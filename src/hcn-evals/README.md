# HCN assistant offline evaluations

This folder contains a deterministic, provider-free evaluation harness for
Thresher. It does not read production systems, retain client data, call a
model, or execute an action.

Each fixture contains synthetic evidence plus expected routing, workflow,
next-step, evidence, action, gate, style, and escalation outcomes. A candidate
supplies a structured trace:

- reasoning lane;
- derived workflow, next step, and blockers;
- material fact IDs with their evidence references;
- evidence references used;
- employee-facing message;
- prepared action types and their supporting facts/evidence;
- approval/execution state; and
- escalation decision.

The result schema is `hcn.assistant-evaluation.v1`. Results deliberately omit
messages, action inputs, and evidence bodies. They contain only allowlisted
case/scenario identifiers, metric counts, pass/fail booleans, style flags, and
failure codes, making them suitable for a future pilot dashboard.

Run the tests directly:

```powershell
node --test src/hcn-evals/evaluator.test.js
```
