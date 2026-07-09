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
have no way back. The harness fixes that with **durable state, checkpoints + rollback, small waves,
and adversarial verification**. Your job here is to be the conductor: figure out where the migration
is, then run the right phase — mostly by following the dedicated phase skill for that phase.

Read `references/manifest-schema.md` once now (the shared state contract). Everything runs through:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" <command>
```

## First, orient yourself

Run `migration.py status`. There are two situations:

- **No `.migration/` yet (fresh start).** Confirm the migration goal with the user in one or two
  sentences (what's moving from what, to what, and what "done" looks like). Confirm this is a git
  repo — if `git status` fails, the rollback backbone is missing; offer to `git init` and commit a
  baseline before doing anything. Then `migration.py init --name <slug> --goal "<goal>"
  --transform "<the rule in plain words>"` and proceed to **assess**.
- **A manifest exists (resume).** Trust the state, not your memory. Read `status` and jump straight
  to the phase it names — do not redo completed phases. Skim `.migration/ledger.md` to recover
  context on what happened and why.

## The lifecycle and where to hand off

Each phase has its own skill with the detailed playbook. Advance the top-level status with
`migration.py set-status <phase>` as you enter each one, and **invoke the matching skill** rather than
improvising the phase:

| `status` | Phase | Follow this skill | In one line |
| --- | --- | --- | --- |
| `assessing` | Assess | `/migration-harness:migrate-assess` | Inventory every site, map dependencies, register risks. |
| `planning` | Plan | `/migration-harness:migrate-plan` | Order the work into small, dependency-clean waves with success criteria + rollback plan. |
| `safeguarding` | Safeguard | `/migration-harness:migrate-safeguard` | Capture a behavioral baseline: green suite, characterization tests, first checkpoint. |
| `executing` | Execute | `/migration-harness:migrate-execute` | Run **one** wave: checkpoint, then fan out transformers. |
| `verifying` | Verify | `/migration-harness:migrate-verify` | Run tests + independent adversarial verifiers → gate → auto-rollback on failure. |
| `documenting` | Document | `/migration-harness:migrate-document` | Update ledger, ADRs, migration changelog. |
| `cleaning` | Cleanup | `/migration-harness:migrate-cleanup` | Remove dead code, shims, flags, deprecated paths. |

`execute → verify` repeats once per wave. After a wave verifies green, `document` it, then either take
the next wave (`execute`) or, when all waves are `verified`, move to `cleaning` and finally
`migration.py set-status done`.

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

1. **Checkpoint before you transform.** Every wave `execute` begins with
   `migration.py checkpoint --wave <id> --label pre-<id>`. The checkpoint auto-derives the wave's
   target files from its units and snapshots their **pre-edit** content — that snapshot is exactly what
   a `rollback --wave <id>` restores (modified files reverted, files the wave created removed, files it
   deleted restored).
2. **Never advance past a red gate.** A wave is not done until `verify` is green. On failure the wave is
   rolled back and left `rolled-back`, and a `rolled-back` wave is **not** "finished": you must either
   **reset it and redo it** (`migration.py reset-wave --wave <id>` → re-plan → execute → verify) or
   **abort the whole migration** (`migration.py set-status rolled-back`, the terminal abort). This is
   **enforced by the harness, not just advised**: `set-wave-status verified` refuses while any unit is
   unverified, and `set-status cleaning|done` now refuse until **every** wave is `verified` — a failed,
   never-redone wave can no longer let the migration quietly "complete" (`--force` overrides but is
   logged to the ledger as a deliberate exception). Don't grind forever, either: if the same unit fails
   verify twice (its `attempts` hits the retry budget), stop and escalate to the user — narrow further
   or take the terminal abort.
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
- **Execute** → `migration-transformer`, one per unit, editing the **main working tree** (the pre-wave
  checkpoint is the safety net, so rollback is a true revert). Units whose `paths` are disjoint may run
  in parallel. Do **not** put units that *share* files in separate worktrees — that only defers the
  collision to an unowned 3-way merge; merge them into one unit (one transformer owns the shared file)
  or serialize them. If you isolate disjoint units with `isolation: worktree` for parallelism, the
  orchestrator MUST merge each worktree's diff back into the main tree before verify (see
  migrate-execute). Verify always runs on the merged main tree.
- **Verify** → several independent `migration-verifier` agents per migrated unit, each told to *prove*
  behavior changed; take a majority vote. Independence is what makes the green trustworthy.

For very large migrations — or when you genuinely need **hard isolation** between concurrent units
rather than the merge-back-into-main-tree discipline above — tell the user they can opt into the
Workflow engine ("use a workflow") for deterministic fan-out with token budgeting and enforced
isolation boundaries; the default is the Agent tool as above.

## Talking to the user

Migrations are high-stakes, so keep the user in the loop at the seams: confirm the goal before
`init`, show the wave plan before executing, and report each wave's verify result. Between waves is a
natural place to pause for a human gate if they want one. Explain *why* a step matters (the checkpoint,
the adversarial check) rather than just doing it silently — the safety is the value.
