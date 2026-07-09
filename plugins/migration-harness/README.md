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
  4. execute    run one wave: checkpoint+snapshot → fan-out transformers → apply
  5. verify     run tests + independent adversarial verifiers → gate → auto-rollback on failure
  6. document   ledger + ADRs + migration changelog (audit trail)
  7. cleanup    remove dead code, compat shims, flags, deprecated paths after cutover
```

`execute → verify` repeats per wave. `document` runs incrementally. `cleanup` is the final phase.

Start with `/migration-harness:migrate` and describe the migration you want. The orchestrator reads
(or initializes) the migration state and walks you through each phase — or Claude reaches for it
automatically when you ask for a large migration.

## Durable state: the Migration Manifest

Everything the harness tracks lives under `.migration/` in your repo (not in the plugin):

| Path | What it holds |
| --- | --- |
| `.migration/manifest.json` | The plan and its live state — waves, units, statuses, risk register, baseline. The backbone that lets an agent resume mid-migration. |
| `.migration/snapshots/<checkpoint>/` | File-level backups per checkpoint (belt-and-suspenders on top of git). |
| `.migration/ledger.md` | Human-readable decision/change log. |
| `.migration/reports/<wave>/` | Verification reports per unit/wave. |
| `.migration/baseline/` | Captured baseline behavior (characterization outputs). |

The state is managed deterministically by `scripts/migration.py` so agents never hand-edit the JSON
into an inconsistent shape. See [`skills/references/manifest-schema.md`](skills/references/manifest-schema.md)
for the schema and conventions.

## Safety model

- **Git + explicit snapshots.** Every wave is preceded by a checkpoint: a git commit/tag plus a
  copy of the touched files into `.migration/snapshots/`. Rollback restores both.
- **Adversarial verification.** After a wave, independent verifier subagents actively try to *prove*
  the migration changed behavior. A wave only advances when the gate is green; otherwise it rolls
  back automatically.
- **Destructive-command guard.** While a migration is active, a `PreToolUse` hook blocks clearly
  destructive shell commands (`git reset --hard`, `rm -rf`, force pushes, `DROP TABLE`, …) unless a
  fresh checkpoint exists or you set an explicit override. It stays out of the way when no migration
  is active.

## Multi-agent orchestration

The harness fans work out to specialized subagents (in `agents/`):

- `migration-scanner` — read-only inventory & dependency mapping (used in *assess* / *cleanup*).
- `migration-transformer` — applies one migration unit in isolation (used in *execute*).
- `migration-verifier` — independent, adversarial behavior check (used in *verify*).
- `risk-analyzer` — deep risk assessment for high-risk units (used in *plan*).

For very large runs you can also opt into the Workflow engine ("use a workflow" / ultracode) for
deterministic fan-out; by default the skills drive the subagents via the Agent tool.

## Requirements

- A git repository (the rollback backbone). The harness will offer to `git init` if needed.
- `python3` on PATH (for `scripts/migration.py` and the safety hook).
