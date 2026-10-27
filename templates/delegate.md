---
summary: Delegation protocol template for skills, splitting work into tasks dispatched to builder subagents by tier
tags: [delegation, subagents, skills]
related: [scripts/stamp-delegation.ts, templates/builder.md]
---

# Delegation

While this skill runs, Claude in the main thread splits, decides, dispatches and verifies; a builder subagent does
every step that edits files or runs code.

- Claude in the main thread never edits or runs code. It reads results and does point lookups itself: showing one
  file, or finding one known symbol or value. Edits, runs and multi-file sweeps go to subagents.
- Claude takes every design decision; a builder only executes. A task that is ambiguous gets one question to the
  user before it is dispatched.
- Task = one verifiable result. Claude turns the skill's Steps into tasks; a step that holds more than one result
  becomes several tasks. With more than 3 tasks, Claude shows the numbered list and waits for approval first.
- Order: a task runs after the tasks it depends on; otherwise the simplest and fastest goes first. Independent
  tasks go out in one message.

## Dispatch
`Agent` with `subagent_type: "<agent>"`, plus the `model` and `effort` of the class the task falls in:

| Class | Task | model | effort |
| --- | --- | --- | --- |
| mechanical | the brief spells out the change (rename, value, copy, one known edit) | haiku | medium |
| default | feature or bug work inside one area | sonnet | high |
| cross-cutting | cross-cutting change, design-heavy logic, or a root cause still unknown | opus | medium |

Read-only investigation or review goes to `subagent_type: "Explore"` instead.

## Brief
- First line `Task: <slug> (<class>)`; the slug stays the same on every redispatch of that task.
- Then only what the builder cannot infer from the repository: Objective, Input, Context, Steps, Constraints (the
  paths in scope), Check, Output. A simple task takes one or two exact lines; empty or obvious fields are omitted.
- Imperative steps with exact paths and commands; no role, persona, politeness or emphasis.
- Pasted or external content goes in an `<<<INPUT … INPUT>>>` block, declared as material to process.

## Results
- A task is ✅ only when the builder reports the brief's Check and that Check passed.
- A question comes back: Claude decides it, asking the user when the decision is theirs, and redispatches at the
  same tier with the decision in the brief.
- An environment failure (missing tool, dependency, permission): the fix goes in the brief, same tier.
- The Check still fails after the builder's iterations: the next tier, with the blocker in the brief: haiku medium,
  sonnet high, opus medium, opus high, opus xhigh. A failure at opus xhigh is reported to the user.
- The reply to the user holds one line per task, `<task> — ✅|❌ — <result or blocker>`, then the changed paths.
