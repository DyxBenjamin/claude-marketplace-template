# Migration state — schema & CLI reference

This is the shared contract every `migration-harness` skill relies on. Read it once when you enter
a migration; you don't need to re-read it per phase. All state lives under `.migration/` at the repo
root and is managed by `scripts/migration.py` — **go through the script, never hand-edit
`manifest.json`**, so the ledger and snapshots are never skipped and the JSON stays valid.

Invoke the script with its plugin-root path:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" <command> [options]
```

The script is stdlib-only and requires **Python 3.7+** (the floor comes from
`from __future__ import annotations`, not the 3.10-style `X | Y` type hints — those are never
evaluated at runtime).

## Layout

```
.migration/                    # protected state — written ONLY by migration.py
├── manifest.json              # the plan + live state (schema below)
├── manifest.lock              # advisory flock target for mutating commands
├── ledger.md                  # append-only human-readable decision/change log
├── snapshots/<cp-id>/         # per-checkpoint: meta.json + files/<mirrored tree>
├── reports/<wave>/<unit>.md   # verification reports (+ _suite.md from `check --wave`)
├── baseline/                  # captured baseline behavior (characterization outputs)
└── standards/<name>.md        # project standards generated once by the phase skills
                               #   (profile, translation, conventions, parity)
```

## `manifest.json` (schema v1)

The current `SCHEMA_VERSION` is **1**. `load()` does **not** hard-fail on a mismatch: if the
manifest's `schema` differs from the tool's version, it prints a warning to stderr naming both
versions and reads the file anyway (a forward-compatible read still works — some fields may just be
missing or interpreted differently).

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
    "captured": false,              // set true ONLY via `set-baseline --captured true`,
                                    // which refuses unless suite_cmd is set AND every
                                    // characterization path exists on disk (or --force)
    "suite_cmd": "string",          // command that runs the project's tests/checks
    "characterization": []          // paths to characterization artifacts
  },
  "standards": {                    // project standards generated once by the phase
                                    // skills; {} until a skill calls set-standard.
                                    // (Older manifests without this key load fine —
                                    // load() defaults it to {}.)
    "translation": { "path": ".migration/standards/translation.md",
                     "source": "PHP", "target": "JavaScript",
                     "generated": "ISO-8601Z" }
  },
  "checkpoints": [
    { "id": "cp-<ts>-<label>-<rand>", "label": "string", "created": "ISO-8601Z",
      "git_head": "sha|null",
      "git_dirty": true,        // did the CAPTURED target paths differ from HEAD?
      "committed": false,
      "files": ["..."],         // repo-relative files whose pre-edit content was snapshotted
      "absent": ["..."] }       // declared target paths that did NOT exist at checkpoint;
                                // rollback deletes them if a transform creates them
  ],
  "waves": [
    {
      "id": "wave-1", "title": "string",
      "status": "pending|active|verified|rolled-back",
      "risk": "low|med|high",       // per-wave risk (default low), decided in plan
      "gate": false,                // true = pause for a human before this wave
      "checkpoint": "cp-id",        // checkpoint taken before this wave
      "units": [
        { "id": "wave-1-u1", "title": "string", "paths": ["src/a.ts"],
          "risk": "low|med|high",
          "status": "pending|in-progress|migrated|verified|failed|deferred|rolled-back",
          "depends_on": ["wave-1-u0"],
          "success": "string",      // the per-unit success criterion verify must prove
          "transform": "",          // per-unit transform override; "" = use strategy.transform
          "attempts": 0,            // verify-fail retry counter (record fail increments)
          "report": "path" }
      ]
    }
  ]
}
```

**Unit status `deferred`** = a transformer legitimately blocked on a dependency (distinct from
`pending`, so the "blocked on dep" signal survives a resume). **`success`** persists the per-unit
success criterion the transformer/verifier work against. **`transform`** is an optional per-unit
override of `strategy.transform`: when non-empty, the execute skill applies **this** rule to the unit
instead of the global one — so a heterogeneous migration can give one unit a different transformation
(set it with `add-unit --transform "…"`; default `""` = fall back to `strategy.transform`).
**`attempts`** bounds retries: each `record --result fail` increments it (and `reset-wave`
deliberately preserves it, so the retry bound isn't reset away). Wave **`risk`** and **`gate`**
persist the plan's per-wave risk and human-gate decisions so they survive a resume instead of living
only in prose.

### Project standards

The `standards` map holds project-specific standards that are **generated once** by the self-mutating
phase skills — `migrate-profile`, `migrate-translation-standard`, `migrate-conventions`, and
`migrate-parity-standard` — one entry per name: `profile`, `translation`, `conventions`, `parity`. Each
standard's document lives at `.migration/standards/<name>.md`; the manifest entry records where it is
plus the `source`/`target` stacks it was written for and when it was `generated`.

- `init` seeds `standards: {}` and creates the `.migration/standards/` directory.
- `set-standard --name <name> --path <path> [--source S] [--target T]` registers one (mutating, goes
  through the lock + atomic save, and appends a ledger line). `--name` outside the four known names is
  allowed but **warns**, so the skill family can grow without a code change.
- `get-standard --name <name>` is the **artifact-guard primitive** the skills use to decide whether to
  bootstrap: it takes **no lock**, prints the registered `path` and exits `0` when present, or prints
  nothing and exits `1` when absent. A phase skill "ensures on demand" with, e.g.:

  ```bash
  if ! python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" get-standard --name translation; then
    …generate the standard, then set-standard --name translation --path … …
  fi
  ```

There is **no hard gate** on standards in the script — `set-status`/`record` do not refuse on a missing
standard. The phase skills alone decide when a standard is required and generate it on demand.

### Lifecycle status (top-level `status`)

`assessing` → `planning` → `safeguarding` → `executing` ⇄ `verifying` → `documenting` → `cleaning`
→ `done`. `rolled-back` is a terminal state for an aborted attempt.

The **active** statuses (everything except `done` and `rolled-back`) are what the safety hook treats
as "a migration is in progress". A unit is a single reviewable, reversible transformation. A wave is
a batch of units with no unmet cross-dependencies, so its units can run in parallel.

## Command quick-reference

| Command | Purpose |
| --- | --- |
| `init --name N [--goal G] [--transform T] [--parallelism K] [--force]` | Create `.migration/` + manifest. `--force` first backs up the existing manifest to `manifest.bak-<UTC>.json` and warns about now-orphaned `snapshots/` dirs. |
| `show` / `status` | Print full manifest / short summary. `status` also prints `strategy.parallelism`, any per-unit `transform` override, and a `Standards:` line listing which standards are generated (`none` if empty). |
| `set-standard --name N --path P [--source S] [--target T]` | Register a generated project standard in `standards[N]` (mutating; appends a ledger line). Unknown `N` warns but still registers, so the skill family can grow. |
| `get-standard --name N` | Read-only artifact-guard primitive (no lock): print `standards[N].path` + exit 0 if registered, else print nothing + exit 1. |
| `set-status <value> [--force]` | Advance the lifecycle status (gated — see below). On `done`/`rolled-back` it also clears a stale `.migration/.allow-destructive` guard override if one is present. |
| `set-strategy [--transform] [--rollback] [--parallelism]` | Update strategy fields. |
| `add-risk --area --risk --severity --mitigation [--id]` | Append to the risk register. |
| `set-baseline [--suite-cmd] [--captured true|false] [--characterization a,b] [--force]` | Record baseline (`--captured true` is verified — see below). |
| `add-wave [--id] [--title] [--risk low\|med\|high] [--gate]` | Add a wave (`--gate` = pause for a human before it). |
| `add-unit --wave W [--id] [--title] [--paths a,b] [--risk low\|med\|high] [--depends x,y] [--success "text"] [--transform "text"]` | Add a unit (`--transform` overrides `strategy.transform` for this unit only). |
| `set-wave-status --wave W <value> [--force]` | Set a wave's status (gated — see below). |
| `set-unit-status --wave W --unit U <value> [--report path]` | Set a unit's status. |
| `reset-wave --wave W` | Reset the wave and ALL its units to `pending` (re-plan a failed/rolled-back wave; keeps `attempts`). |
| `checkpoint --wave W [--label] [--paths a,b] [--commit [--no-verify] [--tag]]` | Snapshot the wave's pre-edit files + record HEAD (`--tag` requires `--commit`). |
| `list-checkpoints` | List recorded checkpoints. |
| `rollback --wave W [--to cp-id] [--git-reset]` | True scoped revert of the wave to its checkpoint. |
| `check --wave W` | Run `baseline.suite_cmd` in the repo root; write `.migration/reports/W/_suite.md`; exit code reflects the suite. |
| `record --wave W --unit U --result pass|fail [--report path] [--note text] [--no-rollback]` | Record verification (fail auto-rolls-back the wave + increments `attempts`). |
| `ledger "message"` | Append a line to the ledger. |

### Checkpoint & rollback semantics

- `checkpoint --wave W` **auto-derives** its target set from wave `W`'s units' `paths` (union;
  globs are expanded, directories are walked) unless you pass an explicit `--paths a,b`. It snapshots
  the **current pre-edit content** of those files into `.migration/snapshots/<id>/files/` — correct
  because checkpoints run *before* the wave transforms code. It records:
  - `files` — the paths whose content was captured;
  - `absent` — declared target paths that did **not** exist yet (so rollback can delete them if a
    transform creates them);
  - `git_head` and `git_dirty` (whether the *captured target paths* differ from HEAD).
  It warns on stderr if it captured **0 files** (a misconfigured path set → rollback would restore
  nothing), and stores the checkpoint id on `wave["checkpoint"]`. Checkpoint ids carry a random
  suffix so two same-second checkpoints never collide. With `--commit` it also makes a
  `migration: checkpoint <label>` commit; `--tag` tags that commit `migration/<id>` and therefore
  **requires `--commit`** (passing `--tag` alone is rejected rather than silently ignored). A bare
  `checkpoint --label ... [--commit]`
  with no `--wave`/`--paths` still works, falling back to the current working-tree changes.
  **Always checkpoint before a wave transforms code** — it's the thing rollback restores.
  With `--commit`, only the checkpoint's **own target paths** are staged (`git add -- <paths>`, never
  `git add -A`), so unrelated WIP elsewhere in the tree is left uncommitted. Pre-commit hooks (secret
  scanners, linters) **run by default**; pass `--no-verify` to skip them deliberately.
- `rollback --wave W` is a **true, scoped revert** of wave `W` to **its own** `checkpoint` (not the
  latest one): modified files are restored, files **created** during the wave are **deleted**, and
  files **deleted** during the wave are restored — scoped to the wave's paths only. When git is
  available and the checkpoint's target paths were clean, it uses `git checkout <git_head> -- <paths>`
  + `git clean -fd -- <paths>`; otherwise it copies the snapshot back and deletes now-present `absent`
  files. It sets wave `W`'s status to `rolled-back`. `--git-reset` additionally hard-resets tracked
  files to the recorded HEAD (heavier hammer). Rollback **never touches anything under `.migration/`**
  and never `git clean`s the whole tree. Running rollback via this script is the sanctioned path — it
  does the git operations internally, so the destructive guard hook does not stand in its way.

### Gate enforcement & lifecycle preconditions

The verification gate is enforced by the script, not merely by prose — these commands **refuse**
(non-zero exit + a clear stderr message) rather than silently advancing past unfinished work:

- `record --wave W --unit U --result fail` marks the unit `failed`, **increments `unit["attempts"]`**,
  flags the wave as **not advanceable**, and by default **auto-rolls-back the wave** to its checkpoint
  (pass `--no-rollback` to only mark it failed). `--result pass` marks the unit `verified`.
- `check --wave W` gives verify a **mechanical grounding**: it runs `baseline.suite_cmd` in the repo
  root, writes `.migration/reports/W/_suite.md`, prints `PASS`/`FAIL`, and **exits non-zero if the
  suite failed**. If `suite_cmd` is empty it prints a "no suite configured" notice and exits 0 (never
  crashes). `record` still carries the adversarial pass/fail verdict — `check` is the objective check.
- `set-wave-status --wave W verified` refuses unless **every** unit in `W` is `verified`.
- `set-baseline --captured true` refuses unless `suite_cmd` is non-empty **and** every
  `characterization` path exists on disk — so `captured` is a real claim, not a bare flag.
- `set-status <x>` refuses out-of-order transitions: `executing` needs `baseline.captured` **and a git
  repo** (rollback is unsafe without git); `documenting` needs the active wave fully verified;
  `cleaning`/`done` need **every wave `verified`** — a `rolled-back` wave does **not** count, so a
  failed wave must be `reset-wave`'d and re-done (or the whole migration aborted via `set-status
  rolled-back`) before completing.
- `--force` bypasses any of these refusals (including the `captured=true` and git checks) and records
  the override in the ledger. Use it only deliberately.

### Re-planning a failed wave

When `record --result fail` rolls a wave back, the wave is left `rolled-back` and its units keep their
old statuses. To redo it: `reset-wave --wave W` returns the wave **and all its units** to `pending`
(so `execute`, which picks `pending` waves, re-runs it) while **preserving each unit's `attempts`**
counter — use that counter to bound retries and, once it's exhausted, abort the whole migration with
`set-status rolled-back` rather than looping forever.

### Concurrency & protected state

- **`.migration/` is protected state written ONLY by `migration.py`.** Do not hand-edit it and do not
  let a transform write into it; rollback and every git operation are scoped to exclude it.
- Every **mutating** command takes an exclusive `fcntl.flock` on `.migration/manifest.lock` around its
  load→mutate→save, and `save()` writes to a unique per-process temp file then atomically renames.
  Parallel transformers/verifiers therefore never lose or corrupt each other's writes. A corrupt or
  unparseable manifest fails with a clean error instead of a traceback; a manifest whose `schema`
  doesn't match the tool warns (but still loads).
- The destructive-guard override file `.migration/.allow-destructive` is **cleared automatically** when
  `set-status` reaches `done` or `rolled-back`, so a dangling one-shot override can't leak into a
  reused `.migration/` (the removal is noted in the ledger).

## Conventions

- IDs are stable: `wave-N`, `wave-N-uM`, `risk-N`, `cp-<timestamp>-<label>-<rand>` (the random suffix
  keeps same-second checkpoints from colliding). Let the script generate them (omit `--id`) unless you
  need a specific name. IDs must be unique within their collection — `add-wave`, `add-unit`, **and
  `add-risk`** all reject a duplicate `--id`.
- Every state transition already appends to the ledger. Use `ledger "..."` only for extra context
  (a decision, a surprise, a deviation from plan) that the state fields don't capture.
- Order units within a wave by `depends_on`; never put a unit in a wave whose dependency is still
  `pending` in a later wave.
