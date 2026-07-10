# migration-harness

A harness that lets AI agents run **large-scale code migrations safely and automatically** —
preventing risk, generating verifications and tests, documenting, organizing, restructuring, and
cleaning up as it goes.

A big migration driven ad-hoc by an agent is fragile: it loses the thread across hundreds of files,
silently breaks behavior, leaves no record of *why* a change was made, and has no way back. This
plugin replaces that with a disciplined lifecycle backed by **durable state, checkpoints/rollback,
and adversarial verification**, so the agent advances in small, reversible, verified waves.

## The flow

```
/migration-harness:migrate   ← orchestrator (entry point + state machine)
  1. assess     inventory + dependency graph + risk register
  2. plan       order the work into small incremental waves + success criteria + rollback plan
  3. safeguard  capture a behavioral baseline (characterization tests, green suite, checkpoint)
  4. execute    open the wave's isolated worktree → fan-out transformers → apply inside it
  5. verify     run tests + independent adversarial verifiers in the worktree → gate → integrate (green) / discard (red)
  6. document   ledger + ADRs + migration changelog (audit trail)
  7. cleanup    remove dead code, compat shims, flags, deprecated paths after cutover
```

`execute → verify` repeats per wave. `document` runs incrementally. `cleanup` is the final phase.

By default every wave runs in its own git worktree forked from a dedicated **integration branch**
(`migration/<name>`, created at `init` from your current branch without switching or touching your
working tree). A green wave fast-forwards onto that one branch; a red wave is discarded whole. Verified
waves accumulate on the integration branch, which you review and merge at the end.

Start with `/migration-harness:migrate` and describe the migration you want. The orchestrator reads
(or initializes) the migration state and walks you through each phase — or Claude reaches for it
automatically when you ask for a large migration.

## Durable state: the Migration Manifest

Everything the harness tracks lives under `.migration/` in your repo (not in the plugin):

| Path | What it holds |
| --- | --- |
| `.migration/manifest.json` | The plan and its live state — waves, units, statuses, risk register, baseline. The backbone that lets an agent resume mid-migration. |
| `.migration/worktrees/<wave>/` | The wave's isolated git checkout on its own branch (worktree model). Transformers edit here and the suite/verifiers run here, so verify sees the real migrated code. |
| `.migration/snapshots/<checkpoint>/` | File-level backups per checkpoint (belt-and-suspenders on top of git). |
| `.migration/ledger.md` | Human-readable decision/change log. |
| `.migration/reports/<wave>/` | Verification reports per unit/wave. |
| `.migration/baseline/` | Captured baseline behavior (characterization outputs). |
| `.migration/.gitignore` | Keeps all of `.migration/` (worktrees, snapshots, manifest) out of git. |

The state is managed deterministically by `scripts/migration.py` so agents never hand-edit the JSON
into an inconsistent shape. See [`skills/references/manifest-schema.md`](skills/references/manifest-schema.md)
for the schema and conventions.

## Safety model

- **Isolated worktrees, discardable branches.** In the default worktree model a red wave rolls back
  by *discarding* its worktree and branch outright (`git worktree remove --force` + `branch -D`) —
  instant and total, leaving the integration branch and your main working tree untouched. A green
  wave instead fast-forwards onto the integration branch. If a discard git-fails the wave is left in
  a `rollback-failed` state (stop-and-repair). File snapshots under `.migration/snapshots/` remain as
  a belt-and-suspenders backup. (The legacy `main-tree` model, auto-selected when there's no git
  repo, edits in place and rolls back from those snapshots.)
- **Adversarial verification.** After a wave, independent verifier subagents actively try to *prove*
  the migration changed behavior. A wave only advances when the gate is green; otherwise it rolls
  back automatically.
- **Destructive-command guard.** While a migration is active, a `PreToolUse` hook blocks clearly
  destructive shell commands (`git reset --hard`, `rm -rf`, force pushes, `DROP TABLE`, …) and
  protects the harness's `.migration/` state (manifest, lock, snapshots) from being clobbered. Writes
  under its own work subtrees (`worktrees/`, `standards/`, `baseline/`, `reports/`) are allowed, and
  an explicit one-shot override lets you run the very next command anyway. It stays out of the way
  when no migration is active.

## Multi-agent orchestration

The harness fans work out to specialized subagents (in `agents/`):

- `migration-scanner` — read-only inventory & dependency mapping (used in *assess* / *cleanup*).
- `migration-transformer` — applies one migration unit inside the wave's worktree (used in *execute*).
- `migration-verifier` — independent, adversarial behavior check (used in *verify*).
- `mutation-checker` — negative-control validator: deliberately breaks characterization tests to prove
  they actually catch regressions, flagging any false test (used in *safeguard*; also in *verify*).
- `risk-analyzer` — deep risk assessment for high-risk units (used in *plan*).

For very large runs you can also opt into the Workflow engine ("use a workflow" / ultracode) for
deterministic fan-out; by default the skills drive the subagents via the Agent tool.

## Visibility & resume

A migration is long and stateful — and because all of its state is durable, an interrupted run is
recoverable. Two tools surface that state (both derived by `scripts/migration.py`, so the human view
and the agent's decisions never diverge):

- **Live dashboard** — `python3 scripts/migration_tui.py` renders the plan, the phase, every wave/unit
  with live status, the recent ledger, and **the next action**, re-drawing whenever the manifest
  changes. Run it in a second terminal to watch a long run; `--once` / `--json` give a one-shot
  snapshot when there's no TTY. Stdlib + `curses`, no dependencies.
- **Deterministic resume** — `migration.py next` prints the single next action computed from state
  (which wave is active, which unit is mid-transform, what's blocking), and `migration.py progress`
  the at-a-glance metrics. This is the answer to *"a 3-hour session broke halfway — now what?"*: a
  fresh session reads where to pick up from `.migration/`, not from lost chat context. The
  `/migration-harness:migrate-monitor` skill wires both up.

## Requirements

- A git repository (the rollback backbone). The harness will offer to `git init` if needed.
- `python3` on PATH (for `scripts/migration.py` and the safety hook).
