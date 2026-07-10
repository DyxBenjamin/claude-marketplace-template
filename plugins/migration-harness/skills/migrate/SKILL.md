---
name: migrate
description: >-
  Orchestrate a large-scale, multi-file code migration safely and automatically — the entry point to
  the migration-harness. Use this whenever the user wants to migrate, upgrade, port, restructure, or
  sweep a change across a whole codebase: framework/library upgrades, language ports, API version
  bumps, monorepo restructures, dependency migrations, or large codemods — especially when the change
  touches many files and existing behavior must be preserved. Reach for it even when the user only
  says "migrate X to Y", "upgrade our whole app to …", "port this project from … to …", or "refactor
  everything that uses …". It sets up durable state, checkpoints with rollback, incremental waves, and
  adversarial verification instead of editing files ad-hoc.
---

# Migration Harness — Orchestrator

You are running a large migration through a harness. A big migration edited file-by-file is fragile:
you lose the thread across hundreds of files, silently change behavior, leave no record of *why*, and
have no way back. The harness fixes that with **durable state, an isolated worktree per wave with
instant rollback, small waves, and adversarial verification**. Your job here is to be the conductor:
figure out where the migration is, then run the right phase — mostly by following the dedicated phase
skill for that phase.

Read `references/manifest-schema.md` once now (the shared state contract). Everything runs through:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" <command>
```

**Execution model.** By default (`init --execution worktree`) each wave transforms *and* verifies in
its own git worktree on a per-wave branch forked from a dedicated **integration branch**
(`migration/<slug>`); the user's working tree is never touched during the migration. Verified waves
fast-forward onto the integration branch, which the user reviews and merges at the end. `--execution
main-tree` is the legacy in-place model (transform the working tree + snapshots); a non-git repo
auto-falls back to it.

## First, orient yourself

Run `migration.py status` for the overview, then `migration.py next` for the **single next action** —
a deterministic directive computed from durable state (which wave is active, which units are
in-progress, what's blocking), so a resumed session recovers from `.migration/`, not from chat memory.
There are two situations:

- **No `.migration/` yet (fresh start).** Confirm the migration goal with the user in one or two
  sentences (what's moving from what, to what, and what "done" looks like). Confirm this is a git
  repo — if `git status` fails, the rollback backbone is missing; offer to `git init` and commit a
  baseline before doing anything. Then `migration.py init --name <slug> --goal "<goal>"
  --transform "<the rule in plain words>"` — this forks a dedicated integration branch
  (`migration/<slug>`) from the current branch **without switching the working tree** — and proceed to
  **assess**. (A non-git repo falls back to the legacy `main-tree` model automatically.)
- **A manifest exists (resume).** Trust the state, not your memory. Do exactly what `migration.py next`
  says — it names the phase, the wave, and any mid-wave recovery (e.g. an `in-progress` unit to diff
  before re-dispatching, or a `rollback-failed` wave to stop on) — and skim `.migration/ledger.md` to
  recover *why*. Do not redo completed phases. For a live picture (yours or the user's), see
  `/migration-harness:migrate-monitor` (a terminal dashboard + `migration.py progress`).

## The lifecycle and where to hand off

Each phase has its own skill with the detailed playbook. Advance the top-level status with
`migration.py set-status <phase>` as you enter each one, and **invoke the matching skill** rather than
improvising the phase:

| `status` | Phase | Follow this skill | In one line |
| --- | --- | --- | --- |
| `assessing` | Assess | `/migration-harness:migrate-assess` | Inventory every site, map dependencies, register risks. |
| `planning` | Plan | `/migration-harness:migrate-plan` | Order the work into small, dependency-clean waves with success criteria + rollback plan. |
| `safeguarding` | Safeguard | `/migration-harness:migrate-safeguard` | Capture a behavioral baseline: green suite, characterization tests, first checkpoint. |
| `executing` | Execute | `/migration-harness:migrate-execute` | Run **one** wave: open the wave worktree, then fan out transformers inside it. |
| `verifying` | Verify | `/migration-harness:migrate-verify` | Run tests + independent adversarial verifiers inside the worktree → gate → on green `integrate`, on failure auto-rollback. |
| `documenting` | Document | `/migration-harness:migrate-document` | Update ledger, ADRs, migration changelog. |
| `cleaning` | Cleanup | `/migration-harness:migrate-cleanup` | Remove dead code, shims, flags, deprecated paths. |

`execute → verify` repeats once per wave. After a wave verifies green it is `integrate`d — the
dedicated integration branch (`migration/<slug>`) accumulates every verified wave for the user to
review and merge at the end — then `document` it, then either take the next wave (`execute`) or, when
all waves are `verified` and integrated, move to `cleaning` and finally `migration.py set-status done`.

```
init → assess → plan → safeguard → ┌── execute → verify ──┐ → document ─┐
                                    └──────── next wave ◄──┘             │
                                                     (all waves done) → cleaning → done
```

## Project specialization (standards)

The harness starts generic and **specializes to each repo** through four self-mutating *standard*
skills. Each generates a project-specific standard **once** into `.migration/standards/<name>.md` (via
Context7 research on the actual source/target stack) and is inert thereafter — the standard is a durable
artifact, not a step you rerun. Every phase **ensures its standard on demand**: it checks with
`migration.py get-standard --name <name>` and, only if the standard is absent, runs the matching
generator skill before proceeding, then reads the file.

| Phase | Standard | Generator skill |
| --- | --- | --- |
| Assess | `profile` | `/migration-harness:migrate-profile` |
| Safeguard | `parity` | `/migration-harness:migrate-parity-standard` |
| Execute | `translation` + `conventions` | `/migration-harness:migrate-translation-standard`, `/migration-harness:migrate-conventions` |

Standards live in `.migration/standards/` and are generated via Context7 research, once; regenerate one
only when the source/target stack itself changes.

## Golden rules (do not skip these — they are the point of the harness)

1. **Open the wave's worktree before you transform.** Every wave `execute` begins with
   `migration.py worktree-open --wave <id>`, which creates `.migration/worktrees/<id>` on a per-wave
   branch forked from the integration tip, symlinks git-ignored dep dirs so the suite can run, and
   snapshots the pre-edit files as a backup. That worktree **is** the blast-radius container: every edit
   and every test happens inside it, so `rollback --wave <id>` simply **discards the worktree + branch**
   — instant and total, leaving the integration branch and the user's working tree untouched.
2. **Never advance past a red gate.** A wave is not done until `verify` is green. On failure the wave is
   rolled back — its worktree + branch **discarded** — and left `rolled-back`, and a `rolled-back` wave
   is **not** "finished": you must either **reset it and redo it** (`migration.py reset-wave --wave
   <id>` → re-plan → execute → verify) or **abort the whole migration** (`migration.py set-status
   rolled-back`, the terminal abort). If a discard/revert itself git-fails, the wave is left
   `rollback-failed` — **terminal-bad: STOP**, repair git by hand (remove the stale worktree/branch), do
   not re-checkpoint. This is **enforced by the harness, not just advised**: `set-wave-status verified`
   refuses while any unit is unverified, and `set-status cleaning|done` refuse until **every** wave is
   `verified` **and** `integrate`d — a verified wave still living in its worktree hasn't landed on the
   integration branch, and a failed, never-redone wave can no longer let the migration quietly
   "complete" (`--force` overrides but is logged to the ledger as a deliberate exception). Don't grind
   forever, either: if the same unit fails verify twice (its `attempts` hits the retry budget), stop and
   escalate to the user — narrow further or take the terminal abort.
3. **Keep waves small.** A wave you can verify and, if needed, revert in one sitting. Prefer more,
   smaller waves over one big risky one. Order units so no unit runs before its `depends_on`.
4. **Go through `migration.py` for all state.** Never hand-edit `manifest.json`; it keeps the ledger
   and snapshots honest and the JSON valid.
5. **Preserve behavior.** This is the contract of a migration: the code should *do* the same thing
   afterward. When you genuinely change behavior, that's a feature change — call it out explicitly and
   record it in the ledger.

## Multi-agent strategy

The harness scales by fanning work out to the plugin's specialized subagents via the Agent tool
(launch independent ones in a single message so they run concurrently). Cap concurrency at
`strategy.parallelism` from the manifest.

- **Assess / Cleanup** → `migration-scanner` (read-only) across code regions, one region per agent.
- **Plan** → `risk-analyzer` for any unit you'd mark high-risk.
- **Execute** → `migration-transformer`, one per unit, editing **the wave's isolated worktree** (never
  the main tree). Units whose `paths` are disjoint may run in parallel *within that one worktree*. Do
  **not** split units that *share* files apart — that only defers the collision to an unowned 3-way
  merge; merge them into one unit (one transformer owns the shared file) or serialize them. Waves are
  **sequential** (one worktree open at a time), which is what keeps this clean — there are no inter-wave
  merge conflicts to resolve.
- **Verify** → several independent `migration-verifier` agents per migrated unit, run **inside the
  worktree**, each told to *prove* behavior changed; take a majority vote. Independence is what makes
  the green trustworthy. On green, `integrate` the wave onto the integration branch.

For very large migrations, tell the user they can opt into the Workflow engine ("use a workflow") for
deterministic fan-out with token budgeting; the default is the Agent tool as above.

## Talking to the user

Migrations are high-stakes, so keep the user in the loop at the seams: confirm the goal before
`init`, show the wave plan before executing, and report each wave's verify result. Between waves is a
natural place to pause for a human gate if they want one. Explain *why* a step matters (the checkpoint,
the adversarial check) rather than just doing it silently — the safety is the value.
