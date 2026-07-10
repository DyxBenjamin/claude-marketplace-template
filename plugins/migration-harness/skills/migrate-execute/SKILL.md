---
name: migrate-execute
description: >-
  Phase 4 of the migration-harness: execute one wave of a large migration by transforming its files.
  Use when it's time to actually apply the migration to a batch of files — after the baseline is
  captured — by opening the wave's isolated worktree and fanning transformer agents into it. Reach for
  it when the user says "run the next wave", "apply the migration to <these files>", or right after
  `/migration-harness:migrate` sets status to `executing`. It transforms exactly one wave at a time,
  reversibly; it does not verify (that's the next phase).
---

# Execute — transform one wave, reversibly

This phase does the actual restructuring, but under strict discipline: **one wave, in its own worktree,
minimal mechanical edits, verify separately**. The migration runs in worktree mode by default
(`strategy.execution == "worktree"`): a dedicated integration branch `migration/<name>` was forked from
your branch at init and is **never checked out**, so the main working tree is untouched throughout.
Each wave transforms inside its **own isolated git worktree** — that worktree is the blast-radius
container. If a wave is wrong, `rollback --wave <id>` discards the worktree and its branch instantly and
totally; the integration branch and main tree are left alone, so **a wave is fully reversible by
construction**. Drive state through `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py"`; see
`references/manifest-schema.md`.

**Precondition:** an active manifest with `baseline.captured: true`. If the baseline isn't captured,
stop and run `/migration-harness:migrate-safeguard` — transforming without a baseline defeats the
harness.

## Steps

1. **Pick — or resume — the wave.** Choose the next wave whose status is `pending` and whose units'
   `depends_on` are all already `verified`. A wave that failed verify and was reset with
   `migration.py reset-wave --wave <id>` is back to `pending`, so it re-qualifies here — that is how a
   re-planned wave gets redone. **If a wave is already `active` on entry** (you crashed or were resumed
   mid-execute), do **not** skip it and do **not** start a newer one — resume *that* wave, and do
   **not** re-open its worktree if one already exists (step 2 is idempotent, but re-attach via
   `worktree-path` rather than assuming). Otherwise mark the chosen wave active:
   `migration.py set-wave-status --wave <id> active`. Do not start a new wave while a previous one is
   still unverified.

   **Honor the human gate.** If the wave carries `gate: true` (set in plan), pause here and get the
   user's explicit go-ahead before opening the worktree or transforming. The gate is persisted on the
   wave precisely so a resumed agent still stops for it, rather than rolling through a pause that was
   only agreed verbally.

2. **Open the wave's worktree.** `migration.py worktree-open --wave <id>`. This creates
   `.migration/worktrees/<id>` on a per-wave branch forked from the integration branch tip, symlinks the
   project's git-ignored dependency dirs (`node_modules`, `.venv`, …) so the suite can run, snapshots
   the pre-edit files as a backup, and **prints the worktree's absolute path**. It is idempotent and
   resume-safe — a wave that already has a live worktree is returned as-is, so **never open twice**.
   Capture that path; you can re-fetch it any time with `migration.py worktree-path --wave <id>`. Every
   edit in this wave happens under that path — the main tree is never touched.

   **Ensure both project standards exist before transforming.** Run
   `migration.py get-standard --name translation` and `migration.py get-standard --name conventions`; if
   either is absent, run `/migration-harness:migrate-translation-standard` and
   `/migration-harness:migrate-conventions` first. Each transformer (step 3) gets the paths to
   `.migration/standards/translation.md` (the source→target rules) and
   `.migration/standards/conventions.md` (house style) — a transform that doesn't follow the project's
   own standard is how a migration drifts.

3. **Fan out transformers — inside the wave's worktree.** **Before dispatching each unit, mark it
   touched:** `migration.py set-unit-status --wave <id> --unit <uid> in-progress`. This is what makes a
   mid-execute crash recoverable: `in-progress` records "a transformer has started on this unit," so on
   resume you never blindly re-dispatch it (see the resume note below). Then launch one
   `migration-transformer` subagent per unit, in a single message so they run concurrently (cap at
   `strategy.parallelism`). Give each agent the **worktree path** and tell it to make **all** its edits
   under that path — never the main tree — along with: the transform rule — the unit's **own `transform`**
   if plan set one with `add-unit --transform`, otherwise the global `strategy.transform` — the unit's
   `paths` (relative to the worktree), its **stored `success` criterion** (the one plan persisted with
   `add-unit --success`), the paths to the project standards `.migration/standards/translation.md` and
   `.migration/standards/conventions.md`, and the standing constraint below.

   Units with disjoint files may run in parallel in the same worktree. **Units that share a file must
   not run in parallel** — a second transformer would silently clobber the first's edit. Either **merge
   them into one unit** (one transformer owns the shared file) or **serialize** them within the wave's
   single worktree. There are **no per-unit worktrees** and **no manual merge-back**: the edits already
   live in the wave worktree, and integration happens later (in verify, via `integrate`).

   **Resume note.** A unit left `in-progress` on re-entry means "already touched — a transformer ran on
   it but it was never recorded `migrated`". Never blindly re-dispatch such a unit: for a non-idempotent
   transform, re-running would double-apply it. Diff the worktree state first, then either finish it
   forward to `migrated` or `rollback --wave <id>` and redo the wave cleanly. The worktree persists
   across a crash, so resume re-attaches to it via `worktree-path` / `worktree-open` (idempotent).

4. **Hold the line on scope.** Every transformer must: apply the transform, update all call sites and
   imports it creates or breaks, and **preserve behavior** — no drive-by refactors, reformatting, or
   "while I'm here" changes. Small, mechanical, reviewable diffs are what make verification meaningful
   and rollback clean. If a unit turns out to need a genuine behavior change, that's a finding: stop,
   note it in the ledger, and raise it with the user rather than quietly changing behavior.

5. **Collect and record — from the worktree.** Gather each unit's diff and self-check result (does it
   compile/lint/typecheck locally?) **from the worktree**, then mark each transformed unit
   `migration.py set-unit-status --wave <id> --unit <uid> migrated`. There is **no merge-back step** —
   the edits already live in the worktree; integration happens later, in verify, via `integrate`. A
   transformer's local self-check is a smoke test, not the gate.

6. **Hand off to verification.** Do **not** declare success here. `migration.py set-status verifying`
   and continue with `/migration-harness:migrate-verify`. Verify runs the suite **inside the wave's
   worktree**; if it fails, `rollback --wave <id>` (or the auto-rollback on a failed `record`) discards
   the worktree and branch — instant, total, main tree untouched. The wave is only real once it's
   verified.

## Output

```
Wave <id>: <n> units transformed  (worktree: .migration/worktrees/<id>)
  <uid>  <paths>  → migrated  (self-check: <pass/notes>)
  <uid>  <paths>  → deferred  (blocker: <what's blocking it>)
  ...
Next: verify
```

If a transformer reports it couldn't complete a unit cleanly (ambiguous sites, a dependency that isn't
migrated yet, behavior it can't preserve), it returns `deferred`. Record that explicitly — don't leave
the unit as `pending`: `migration.py set-unit-status --wave <id> --unit <uid> deferred`, and capture the
blocker with `migration.py ledger "<uid> deferred: <blocker>"`. `deferred` is a real, persisted unit
status now, so the blocked-on-dependency signal survives a resume instead of decaying into an
indistinguishable `pending`. Surface it to the user and feed it back to plan for resequencing — a
half-applied unit is worse than a deferred one.
