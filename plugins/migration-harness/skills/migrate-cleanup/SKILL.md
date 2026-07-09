---
name: migrate-cleanup
description: >-
  Phase 7 (final) of the migration-harness: clean up after a completed migration. Use once all waves are
  migrated and verified, to remove what the migration made obsolete — dead code, compatibility shims,
  flipped feature flags, deprecated APIs, and now-unused imports — safely and reversibly. Reach for it
  when the user says "remove the old code", "delete the compat layer now that we've migrated", "tidy up
  after the migration", or right after `/migration-harness:migrate` sets status to `cleaning`. Deletion
  is still a change: it's checkpointed and re-verified like any other.
---

# Cleanup — remove the old paths, carefully

The migration isn't finished when the new code works; it's finished when the old code is gone and the
codebase reads as if the new way was always the way. But deletion is deceptively risky — the thing you
"know" is unused often isn't (reflection, config, a caller you missed). So cleanup runs with the same
guardrails as any wave: checkpoint, remove, re-verify. Drive state through
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py"`; see `references/manifest-schema.md`.

**Precondition:** an active manifest where every wave's status is `verified`. If waves remain
unmigrated or unverified, finish them first (`/migration-harness:migrate-execute` /
`/migration-harness:migrate-verify`). Do not delete the old path while anything still depends on it.

## Steps

1. **Create the cleanup wave, then checkpoint.** Cleanup is a real wave and needs a real manifest wave
   and unit(s) to hang its checkpoint/record/rollback off — without them, `checkpoint --wave`,
   `record --wave --unit`, and `rollback --wave` all have no valid target (they reference a wave that
   doesn't exist). So first create them: `migration.py add-wave --title cleanup [--risk low|med|high]`,
   then, over the code you're about to delete, `migration.py add-unit --wave <id> --paths <targets>`
   (one unit, or one per grouped deletion). Use the cleanup targets the document phase flagged; if you
   need step 2's scan to pin the exact paths first, do that scan, then create the wave/unit over the
   confirmed paths — but the wave, its unit(s), and the checkpoint must all exist **before** you delete
   anything in step 3. Only then checkpoint: `migration.py checkpoint --wave <id> --label pre-<id>`.
   The checkpoint auto-derives the files this cleanup touches from the wave's units and captures their
   **pre-edit** content (no `--paths` needed), so `rollback --wave <id>` can restore anything a deletion
   turns out to have broken. Cleanup is mostly deletion; it must be as reversible as every other wave.

2. **Find what's genuinely dead.** Fan out `migration-scanner` subagents (read-only) to locate: old
   imports/exports with no remaining callers, compatibility shims introduced during the migration whose
   consumers are all migrated, feature flags now permanently in one state, and deprecated APIs with zero
   references. Cross-check against the follow-ups the document phase recorded. Search for
   dynamic/string/config references too, the same blind spots assess flagged. **A scanner "unused"
   result is a deletion *candidate*, not proof.** A scanner does *static* resolution — even with its
   read-only Bash it cannot prove a negative, because dynamic, reflective, string-keyed, and config/DI
   references evade static search. So scanner output **alone never authorizes a deletion**: a candidate
   only becomes safe to remove once step 4's re-verify runs green with it gone. Let the scan *narrow* the
   list; let the re-verify — not the scanner — be what *sanctions* each delete.

3. **Remove in a reviewable batch.** Delete the confirmed-dead code and flip permanently-true flags to
   their final form, keeping the diff mechanical and grouped. When you can't *prove* something is unused,
   don't delete it — leave it deprecated with a note, and say so. A wrongly-kept shim is a wart; a
   wrongly-deleted one is an outage.

4. **Re-verify.** Deletion can break things (an import you removed was load-bearing, a flag guarded a
   real branch). Run the mechanical gate the same way verify does — `migration.py check --wave <id>`
   (the real suite, exit code = pass/fail) — plus, for anything non-trivial, a round of
   `migration-verifier` agents. If it goes red, `migration.py rollback --wave <id>` — a true revert of
   the cleanup to its pre-cleanup checkpoint — and narrow the deletion. Record the result against the
   cleanup wave and unit you created in step 1: `migration.py record --wave <id> --unit <uid>
   --result pass|fail`. Now that the wave and unit exist, `record` has a valid target — previously it
   had none.

5. **Close out.** Update the ledger and changelog (what was removed, what was intentionally kept and
   why). When the tree is clean and green, mark the cleanup wave verified
   (`migration.py set-wave-status --wave <id> verified`) — `set-status done` now refuses until **every**
   wave, this cleanup wave included, is verified — then `migration.py set-status done` and give the user
   a final summary: what migrated, what was removed, what (if anything) was deliberately left behind, and
   any remaining follow-ups.

## Output

```
Cleanup:
  removed: <dead imports/shims/flags/APIs — grouped>
  kept (couldn't prove unused): <list + why>
  re-verify: <green | red → rolled back + narrowed>
Migration <name>: DONE — <W> waves, <U> units, <files> files changed
Follow-ups: <list or none>
```

The finish line is a codebase where a newcomer would never guess a migration happened — no half-removed
old path, no dangling shim, no mystery flag. Get there only by deletion you can defend, verified like
everything else.
