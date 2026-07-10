---
name: migrate-monitor
description: >-
  Show where a large migration stands and what to do next — the visibility + resume tool of the
  migration-harness. Use whenever the user asks "where are we", "show the migration status", "what's
  the plan / what's left", "is it still running", "how do I resume", or when YOU (a fresh or resumed
  session) inherit a half-finished migration and need to recover from durable state instead of memory.
  It reads `.migration/` (manifest + ledger) and renders a live terminal dashboard for the human, and a
  deterministic next-action directive for the agent. Reach for it after any interruption, at the start
  of a resumed session, or any time someone wants a picture of a long run in flight.
---

# Monitor — see where the migration is, and what's next

A large migration is long, stateful, and survivable: **everything needed to resume lives in
`.migration/`** (the manifest is the backbone; the ledger is the audit trail). This skill turns that
durable state into visibility — for the human watching, and for you when a session broke mid-run.

Two consumers, one source of truth (`scripts/migration.py` computes both):

## For you (the agent): recover from state, not memory

**Always start a resumed or fresh-on-an-existing-migration session here.** Run:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" next
```

It reads the manifest and prints **the single next action**, deterministically derived from the phase,
the active wave, and per-unit status — e.g. "resume-wave w3: a transformer started u2 but never
recorded it migrated; re-attach the worktree and diff before re-dispatching", with the exact commands
to run. This is the answer to *"a 3-hour session broke halfway — now what?"*: you don't reconstruct it
from chat history (which is gone), you read it from state.

- `migration.py next --json` — the same directive as a machine-readable object (`action`, `wave`,
  `severity`, `hint`, `commands[]`) when you want to branch on it programmatically.
- `migration.py progress` — at-a-glance metrics (phase, waves verified/integrated, units by status,
  attempts spent, baseline/standards/checkpoints).
- `migration.py status` / `show` — the existing summary / full manifest.

Trust `next` over your recollection. If it says a wave is `rolled-back` or `rollback-failed`, act on
that, not on what you *think* happened before the interruption.

## For the human: a live dashboard

Launch the terminal dashboard so the user can watch the run:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration_tui.py"
```

It renders the migration name/goal/status, the phase strip, the **NEXT action** box (the same
directive as above), every wave and unit with live status, and the recent ledger — and **re-renders
whenever the manifest changes**, so it updates itself as waves execute and verify. Keys: `q` quit,
`r` refresh, `j`/`k` or arrows scroll the ledger. It has no dependencies beyond `python3`.

Tell the user they can run it themselves from anywhere in the repo (it finds `.migration/` via the git
root), in a second terminal, to watch a long run without interrupting it.

Non-interactive forms (no TTY needed — safe for you to capture, or for scripting/CI):

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration_tui.py" --once    # one plain-text snapshot
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration_tui.py" --json    # full structured snapshot
```

When stdout isn't a terminal the dashboard automatically prints a single snapshot instead of trying to
start the live UI, so piping it never hangs.

## What to report

When the user asks for status, don't dump the manifest — give them the picture: what phase we're in,
which wave is in flight and its verify state, what's blocking (a gate, a red wave, a `rollback-failed`
that needs manual git repair), and the single next step. Offer to open the live dashboard if the run is
ongoing. Lead with where we are and what's next; keep the rest brief.
