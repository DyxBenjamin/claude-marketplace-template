# Migration state — schema & CLI reference

This is the shared contract every `migration-harness` skill relies on. Read it once when you enter
a migration; you don't need to re-read it per phase. All state lives under `.migration/` at the repo
root and is managed by `scripts/migration.py` — **go through the script, never hand-edit
`manifest.json`**, so the ledger and snapshots are never skipped and the JSON stays valid.

Invoke the script with its plugin-root path:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" <command> [options]
```

## Layout

```
.migration/
├── manifest.json              # the plan + live state (schema below)
├── ledger.md                  # append-only human-readable decision/change log
├── snapshots/<cp-id>/         # per-checkpoint: meta.json + files/<mirrored tree>
├── reports/<wave>/<unit>.md   # verification reports
└── baseline/                  # captured baseline behavior (characterization outputs)
```

## `manifest.json` (schema v1)

```jsonc
{
  "schema": 1,
  "name": "string",                 // short migration name
  "goal": "string",                 // what "done" means, in one or two sentences
  "status": "assessing",            // lifecycle status (see below)
  "created": "ISO-8601Z",
  "updated": "ISO-8601Z",
  "strategy": {
    "transform": "string",          // the transformation rule, plainly stated
    "rollback": "git+snapshots",
    "parallelism": 4                // max transformer/verifier subagents in flight
  },
  "risk_register": [
    { "id": "risk-1", "area": "string", "risk": "string",
      "severity": "low|med|high", "mitigation": "string" }
  ],
  "baseline": {
    "captured": false,
    "suite_cmd": "string",          // command that runs the project's tests/checks
    "characterization": []          // paths to characterization artifacts
  },
  "checkpoints": [
    { "id": "cp-...", "label": "string", "created": "ISO-8601Z",
      "git_head": "sha|null", "git_dirty": true, "committed": false, "files": ["..."] }
  ],
  "waves": [
    {
      "id": "wave-1", "title": "string",
      "status": "pending|active|verified|rolled-back",
      "checkpoint": "cp-id",        // checkpoint taken before this wave
      "units": [
        { "id": "wave-1-u1", "title": "string", "paths": ["src/a.ts"],
          "risk": "low|med|high",
          "status": "pending|in-progress|migrated|verified|failed|rolled-back",
          "depends_on": ["wave-1-u0"], "report": "path" }
      ]
    }
  ]
}
```

### Lifecycle status (top-level `status`)

`assessing` → `planning` → `safeguarding` → `executing` ⇄ `verifying` → `documenting` → `cleaning`
→ `done`. `rolled-back` is a terminal state for an aborted attempt.

The **active** statuses (everything except `done` and `rolled-back`) are what the safety hook treats
as "a migration is in progress". A unit is a single reviewable, reversible transformation. A wave is
a batch of units with no unmet cross-dependencies, so its units can run in parallel.

## Command quick-reference

| Command | Purpose |
| --- | --- |
| `init --name N [--goal G] [--transform T] [--parallelism K]` | Create `.migration/` + manifest. |
| `show` / `status` | Print full manifest / short summary. |
| `set-status <value>` | Advance the lifecycle status. |
| `set-strategy [--transform] [--rollback] [--parallelism]` | Update strategy fields. |
| `add-risk --area --risk --severity --mitigation [--id]` | Append to the risk register. |
| `set-baseline [--suite-cmd] [--captured true|false] [--characterization a,b]` | Record baseline. |
| `add-wave [--id] [--title]` | Add a wave. |
| `add-unit --wave W [--id] [--title] [--paths a,b] [--risk] [--depends x,y]` | Add a unit. |
| `set-wave-status --wave W <value>` | Set a wave's status. |
| `set-unit-status --wave W --unit U <value> [--report path]` | Set a unit's status. |
| `checkpoint [--label] [--paths a,b] [--wave W] [--commit] [--tag]` | Snapshot + record HEAD. |
| `list-checkpoints` | List recorded checkpoints. |
| `rollback [--to cp-id] [--wave W] [--git-reset]` | Restore files from a checkpoint. |
| `record --wave W --unit U --result pass|fail [--report path] [--note text]` | Record verification. |
| `ledger "message"` | Append a line to the ledger. |

### Checkpoint & rollback semantics

- `checkpoint` copies the current version of the target files (`--paths`, or all current git changes
  if omitted) into `.migration/snapshots/<id>/files/`, and records the current `git HEAD` and dirty
  flag. With `--commit` it also makes a `migration: checkpoint <label>` commit (and `--tag` tags it).
  **Always checkpoint before a wave transforms code** — it's the thing rollback restores.
- `rollback` copies the snapshot files back over the working tree (targeted, least-destructive). Add
  `--git-reset` only when you want a hard reset to the recorded HEAD as well. Running rollback via
  this script is the sanctioned path — it does the git operations internally, so the destructive
  guard hook does not stand in its way.

## Conventions

- IDs are stable: `wave-N`, `wave-N-uM`, `risk-N`, `cp-<timestamp>-<label>`. Let the script generate
  them (omit `--id`) unless you need a specific name.
- Every state transition already appends to the ledger. Use `ledger "..."` only for extra context
  (a decision, a surprise, a deviation from plan) that the state fields don't capture.
- Order units within a wave by `depends_on`; never put a unit in a wave whose dependency is still
  `pending` in a later wave.
