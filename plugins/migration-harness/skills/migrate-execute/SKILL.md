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

1. **Pick — or resume — the wave.** Choose the next wave whose status is `pending` and whose units'
   `depends_on` are all already `verified`. A wave that failed verify and was reset with
   `migration.py reset-wave --wave <id>` is back to `pending`, so it re-qualifies here — that is how a
   re-planned wave gets redone. **If a wave is already `active` on entry** (you crashed or were resumed
   mid-execute), do **not** skip it and do **not** start a newer one — resume *that* wave; and do
   **not** re-checkpoint it if `wave.checkpoint` is already set (a second checkpoint would snapshot the
   half-transformed tree and destroy the real pre-edit restore point). Otherwise mark the chosen wave
   active: `migration.py set-wave-status --wave <id> active`. Do not start a new wave while a previous
   one is still unverified.

   **Honor the human gate.** If the wave carries `gate: true` (set in plan), pause here and get the
   user's explicit go-ahead before checkpointing or transforming. The gate is persisted on the wave
   precisely so a resumed agent still stops for it, rather than rolling through a pause that was only
   agreed verbally.

2. **Checkpoint before editing.** `migration.py checkpoint --wave <id> --label pre-<id>` — **unless you
   are resuming an already-`active` wave that already has a `wave.checkpoint`** (step 1), in which case
   keep the existing one. The checkpoint auto-derives the wave's target files from its units (no
   `--paths` needed) and snapshots their **pre-edit** content — it is exactly what
   `rollback --wave <id>` restores if verification fails. Never transform a fresh wave without a fresh
   checkpoint. This ordering isn't left to the model's goodwill:
   the workflow requires it and the (now script-enforced) verify gate won't let an un-checkpointed wave
   advance, and `.migration/` state is protected from accidental clobbering. Do **not** rely on the Bash
   guard to remind you here — transforms go through Edit/Write, which that guard does not gate.

   **Ensure both project standards exist before transforming.** Run
   `migration.py get-standard --name translation` and `migration.py get-standard --name conventions`; if
   either is absent, run `/migration-harness:migrate-translation-standard` and
   `/migration-harness:migrate-conventions` first. Then pass each transformer (step 3) the paths to
   `.migration/standards/translation.md` (the source→target rules) and `.migration/standards/conventions.md`
   (house style) — a transform that doesn't follow the project's own standard is how a migration drifts.

3. **Fan out transformers — onto the main tree.** **Before dispatching each unit, mark it touched:**
   `migration.py set-unit-status --wave <id> --unit <uid> in-progress`. This is what makes a mid-execute
   crash recoverable: `in-progress` records "a transformer has started on this unit," so on resume you
   never blindly re-dispatch it (see the resume note below). Then launch one `migration-transformer`
   subagent per unit, in a single message so they run concurrently (cap at `strategy.parallelism`).
   Transformers edit the **main working tree** by default; the step-2 checkpoint is the safety net, so a
   `rollback --wave <id>` is a true revert of everything the wave touched. Give each agent: the transform
   rule — the unit's **own `transform`** if plan set one with `add-unit --transform`, otherwise the
   global `strategy.transform` — the unit's `paths`, its **stored `success` criterion** (the one plan
   persisted with `add-unit --success`), the paths to the project standards
   `.migration/standards/translation.md` and `.migration/standards/conventions.md`, and the standing
   constraint below.
   Two rules keep parallel edits from silently colliding — verify (next phase) runs on the **main** tree,
   so any edit that never reaches it reads as a green no-op migration:
   - **Overlapping/shared files → never isolate.** If two units touch the same file, do **not** hand
     them separate worktrees — that just defers the collision to a 3-way merge no step owns, and one
     unit's edit gets silently clobbered. Instead **merge them into one unit** (one transformer owns the
     shared file) or **serialize** them in the main tree. Only truly disjoint-file units may run in
     parallel.
   - **Disjoint files → parallel is fine; if you use `isolation: worktree`, you MUST merge back.** A
     worktree transformer's edits live in an isolated tree and do **not** reach the main tree on their
     own. So after each such transformer returns, *you* (the orchestrator) apply that unit's diff/patch
     to the main tree and resolve any conflict — **before** the step-5 bookkeeping that marks the unit
     `migrated`, and **before** verify. Skipping the merge-back is the exact bug this rule exists to
     prevent.

   **Resume note.** A unit left `in-progress` on re-entry means "already touched — a transformer ran on
   it but it was never recorded `migrated`". Never blindly re-dispatch such a unit: for a non-idempotent
   transform, re-running would double-apply it. Instead diff/verify the current state first, then either
   finish it forward to `migrated` or `rollback --wave <id>` and redo the wave cleanly.

4. **Hold the line on scope.** Every transformer must: apply the transform, update all call sites and
   imports it creates or breaks, and **preserve behavior** — no drive-by refactors, reformatting, or
   "while I'm here" changes. Small, mechanical, reviewable diffs are what make verification meaningful
   and rollback clean. If a unit turns out to need a genuine behavior change, that's a finding: stop,
   note it in the ledger, and raise it with the user rather than quietly changing behavior.

5. **Collect and record — on the main tree.** Gather each unit's diff and self-check result (does it
   compile/lint/typecheck locally?). For any unit you ran under `isolation: worktree`, first confirm its
   edits are already merged back into the main tree (step 3) — an unmerged unit must **not** be marked
   migrated. Then mark each transformed unit `migration.py set-unit-status --wave <id> --unit <uid>
   migrated`. A transformer's local self-check is a smoke test, not the gate.

6. **Hand off to verification.** Do **not** declare success here. `migration.py set-status verifying`
   and continue with `/migration-harness:migrate-verify`. The wave is only real once it's verified.

## Output

```
Wave <id>: <n> units transformed
  <uid>  <paths>  → migrated  (self-check: <pass/notes>)
  <uid>  <paths>  → deferred  (blocker: <what's blocking it>)
  ...
Checkpoint: pre-<id> (<cp-id>)
Next: verify
```

If a transformer reports it couldn't complete a unit cleanly (ambiguous sites, a dependency that isn't
migrated yet, behavior it can't preserve), it returns `deferred`. Record that explicitly — don't leave
the unit as `pending`: `migration.py set-unit-status --wave <id> --unit <uid> deferred`, and capture the
blocker with `migration.py ledger "<uid> deferred: <blocker>"`. `deferred` is a real, persisted unit
status now, so the blocked-on-dependency signal survives a resume instead of decaying into an
indistinguishable `pending`. Surface it to the user and feed it back to plan for resequencing — a
half-applied unit is worse than a deferred one.
