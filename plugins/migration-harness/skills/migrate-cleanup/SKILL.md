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
"know" is unused often isn't (reflection, config, a caller you missed). So cleanup runs as a real wave
through the same worktree backbone as every other wave: open the wave's isolated worktree, delete inside
it, re-verify there, then integrate on green — or discard the worktree to undo. The worktree **is** the
checkpoint. Drive state through `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py"`; see
`references/manifest-schema.md`.

**Precondition:** an active manifest where every wave is `verified` **and integrated**. If waves remain
unmigrated, unverified, or unintegrated, finish them first (`/migration-harness:migrate-execute` /
`/migration-harness:migrate-verify`). Do not delete the old path while anything still depends on it.

## Steps

1. **Create the cleanup wave + unit(s), then open its worktree.** Cleanup is a real wave and needs a real
   manifest wave and unit(s) to hang its record/rollback off — without them, `record --wave --unit` and
   `rollback --wave` have no valid target (they reference a wave that doesn't exist). So first create
   them: `migration.py add-wave --title cleanup [--risk low|med|high]`, then, over the code you're about
   to delete, `migration.py add-unit --wave <id> --paths <targets>` (one unit, or one per grouped
   deletion). Use the cleanup targets the document phase flagged; if you need step 2's scan to pin the
   exact paths first, do that scan, then create the wave/unit over the confirmed paths. Then activate and
   open the worktree: `migration.py set-wave-status --wave <id> active`, then
   `migration.py worktree-open --wave <id>` — this creates the wave's isolated worktree at
   `.migration/worktrees/<id>` on a branch off the integration-branch tip and prints its absolute path.
   Every deletion, and its re-verify, happens **inside** that worktree; the main tree isn't touched until
   `integrate`. The worktree is this cleanup's checkpoint — discarding it restores everything, so nothing
   is ever half-deleted.

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

3. **Delete inside the worktree, in a reviewable batch.** Remove the confirmed-dead code and flip
   permanently-true flags to their final form **inside `.migration/worktrees/<id>/`** — `rm`/`git rm`
   run against the worktree path, or edit files there — keeping the diff mechanical and grouped. Because
   these deletions land inside the worktree, a path the harness guard permits, they run without the
   destructive-command guard blocking the same `rm` on the main tree — which is the whole reason cleanup
   runs here. When you can't *prove* something is unused, don't delete it — leave it deprecated with a
   note, and say so. A wrongly-kept shim is a wart; a wrongly-deleted one is an outage.

4. **Re-verify in the worktree.** Deletion can break things (an import you removed was load-bearing, a
   flag guarded a real branch). Run the mechanical gate the same way verify does —
   `migration.py check --wave <id>`, which runs the real suite **inside the worktree** (exit code =
   pass/fail), proving the deletions didn't break anything — plus, for anything non-trivial, a round of
   `migration-verifier` agents. Record the result against the cleanup wave and unit you created in step 1:
   `migration.py record --wave <id> --unit <uid> --result pass|fail`. If it goes red,
   `migration.py rollback --wave <id>` **discards the worktree and its branch outright** — instant and
   total, the dead code simply isn't removed and nothing is left half-deleted — then
   `migration.py reset-wave --wave <id>`, narrow the deletion set, and redo from step 1's worktree-open.
   The worktree is the checkpoint; discarding it is the rollback.

5. **Integrate, then close out.** On green, mark the cleanup wave verified
   (`migration.py set-wave-status --wave <id> verified`) and land it: `migration.py integrate --wave <id>`
   fast-forwards the integration branch to include the deletions and removes the worktree. Only once the
   last cleanup wave has integrated does `migration.py set-status done` succeed — it refuses until
   **every** wave, this cleanup wave included, is verified and integrated. Update the ledger and changelog
   (what was removed, what was intentionally kept and why), then give the user a final summary: what
   migrated, what was removed, what (if anything) was deliberately left behind, and any remaining
   follow-ups.

## Output

```
Cleanup:
  removed: <dead imports/shims/flags/APIs — grouped>
  kept (couldn't prove unused): <list + why>
  re-verify: <green → integrated | red → worktree discarded + narrowed>
Migration <name>: DONE — <W> waves, <U> units, <files> files changed
Follow-ups: <list or none>
```

The finish line is a codebase where a newcomer would never guess a migration happened — no half-removed
old path, no dangling shim, no mystery flag. Get there only by deletion you can defend, verified like
everything else.
