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

1. **Checkpoint first.** `migration.py checkpoint --label pre-cleanup --commit`. Cleanup is mostly
   deletion; it must be as reversible as every other phase.

2. **Find what's genuinely dead.** Fan out `migration-scanner` subagents (read-only) to locate: old
   imports/exports with no remaining callers, compatibility shims introduced during the migration whose
   consumers are all migrated, feature flags now permanently in one state, and deprecated APIs with zero
   references. Cross-check against the follow-ups the document phase recorded. **Prove** each item is
   unused rather than assuming — search for dynamic/string/config references too, the same blind spots
   assess flagged.

3. **Remove in a reviewable batch.** Delete the confirmed-dead code and flip permanently-true flags to
   their final form, keeping the diff mechanical and grouped. When you can't *prove* something is unused,
   don't delete it — leave it deprecated with a note, and say so. A wrongly-kept shim is a wart; a
   wrongly-deleted one is an outage.

4. **Re-verify.** Deletion can break things (an import you removed was load-bearing, a flag guarded a
   real branch). Run the suite + characterization again and, for anything non-trivial, a round of
   `migration-verifier` agents. If it goes red, `migration.py rollback --to <pre-cleanup cp>` and narrow
   the deletion. Record the result with `migration.py record`.

5. **Close out.** Update the ledger and changelog (what was removed, what was intentionally kept and
   why). When the tree is clean and green, `migration.py set-status done` and give the user a final
   summary: what migrated, what was removed, what (if anything) was deliberately left behind, and any
   remaining follow-ups.

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
