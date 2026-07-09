---
name: migrate-execute
description: >-
  Phase 4 of the migration-harness: execute one wave of a large migration by transforming its files.
  Use when it's time to actually apply the migration to a batch of files — after the baseline is
  captured — checkpointing first and fanning out transformer agents. Reach for it when the user says
  "run the next wave", "apply the migration to <these files>", or right after
  `/migration-harness:migrate` sets status to `executing`. It transforms exactly one wave at a time,
  reversibly; it does not verify (that's the next phase).
---

# Execute — transform one wave, reversibly

This phase does the actual restructuring, but under strict discipline: **one wave, checkpoint first,
minimal mechanical edits, verify separately**. The reason it's one wave at a time is blast-radius
control — if something is wrong, you roll back one small, well-understood batch, not the whole repo.
Drive state through `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py"`; see
`references/manifest-schema.md`.

**Precondition:** an active manifest with `baseline.captured: true`. If the baseline isn't captured,
stop and run `/migration-harness:migrate-safeguard` — transforming without a baseline defeats the
harness.

## Steps

1. **Pick the wave.** Choose the next wave whose status is `pending` and whose units' `depends_on` are
   all already `verified`. Mark it active: `migration.py set-wave-status --wave <id> active`. Do not
   start a new wave while a previous one is still unverified.

2. **Checkpoint before editing.** `migration.py checkpoint --wave <id> --label pre-<id>`. This snapshots
   the current version of the wave's files — it is exactly what a rollback restores if verification
   fails. Never transform a wave without a fresh checkpoint; the destructive-command guard hook will
   also remind you.

3. **Fan out transformers.** Launch one `migration-transformer` subagent per unit, in a single message
   so they run concurrently (cap at `strategy.parallelism`). When units in the wave touch overlapping
   files or shared modules, pass `isolation: worktree` so their edits don't collide. Give each agent:
   the transform rule (`strategy.transform`), the unit's `paths`, its success criterion, and the
   standing constraint below.

4. **Hold the line on scope.** Every transformer must: apply the transform, update all call sites and
   imports it creates or breaks, and **preserve behavior** — no drive-by refactors, reformatting, or
   "while I'm here" changes. Small, mechanical, reviewable diffs are what make verification meaningful
   and rollback clean. If a unit turns out to need a genuine behavior change, that's a finding: stop,
   note it in the ledger, and raise it with the user rather than quietly changing behavior.

5. **Collect and record.** Gather each unit's diff and self-check result (does it compile/lint/typecheck
   locally?). Mark each transformed unit `migration.py set-unit-status --wave <id> --unit <uid>
   migrated`. A transformer's local self-check is a smoke test, not the gate.

6. **Hand off to verification.** Do **not** declare success here. `migration.py set-status verifying`
   and continue with `/migration-harness:migrate-verify`. The wave is only real once it's verified.

## Output

```
Wave <id>: <n> units transformed
  <uid>  <paths>  → migrated  (self-check: <pass/notes>)
  ...
Checkpoint: pre-<id> (<cp-id>)
Next: verify
```

If a transformer reports it couldn't complete a unit cleanly (ambiguous sites, a dependency that isn't
migrated yet, behavior it can't preserve), leave that unit unmigrated and surface it — a half-applied
unit is worse than a deferred one.
