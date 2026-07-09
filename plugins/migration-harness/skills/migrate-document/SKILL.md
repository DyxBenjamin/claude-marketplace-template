---
name: migrate-document
description: >-
  Phase 6 of the migration-harness: document a migrated-and-verified wave. Use after a wave passes
  verification to record what changed and why — update the migration ledger, write ADRs for notable
  decisions, and maintain a migration changelog with breaking changes and follow-ups. Reach for it when
  the user asks to "document the migration", "write up what we changed", or right after
  `/migration-harness:migrate` sets status to `documenting`. A migration nobody can explain later is a
  liability; this phase leaves the audit trail.
---

# Document — leave an audit trail future maintainers can trust

An automated migration touches a lot of code fast. Without a record, the next person (or the next
agent) can't tell an intentional migration change from a bug, or reconstruct *why* a tricky unit was
done a certain way. This phase turns the state the harness already tracked into durable, human-facing
documentation. Drive state through `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py"`; see
`references/manifest-schema.md`.

**Precondition:** an active manifest with a `verified` wave. If none, run
`/migration-harness:migrate-verify` first.

## Steps

1. **Update the ledger.** The state commands already log transitions; add the *reasoning* they can't
   capture with `migration.py ledger "<note>"`: why a unit was split, a surprise found during
   verification, a deviation from the plan, a deliberate behavior change (flagged), or a follow-up owed.
   The ledger is the narrative; keep it truthful and specific.

2. **Write ADRs for decisions that outlive the migration.** When a wave settled a real question — chose
   one target API over another, introduced a compatibility shim, changed a public contract — record a
   short Architecture Decision Record (context → decision → alternatives → consequences). Put ADRs where
   this project already keeps them (`docs/adr/`, `docs/decisions/`) or under `.migration/` if there's no
   convention. One ADR per genuine decision, not per file.

3. **Maintain the migration changelog.** Append a per-wave entry: units migrated, any breaking changes
   for downstream consumers, new deprecations/shims introduced, and follow-ups still owed (e.g. "remove
   the compat shim in cleanup"). This is what you'd hand someone reviewing the migration or writing
   release notes.

4. **Commit the wave.** With a verified, documented wave, make a conventional-commit that groups it
   (e.g. `feat(migration): migrate wave-<id> — <theme>`), so history stays bisectable and Release Please
   can version it. Note breaking changes with `!`/`BREAKING CHANGE:` when they exist.

5. **Route to the next step.**
   - **More waves remain** → `migration.py set-status executing` and continue with
     `/migration-harness:migrate-execute` for the next wave.
   - **All waves are `verified`** → `migration.py set-status cleaning` and continue with
     `/migration-harness:migrate-cleanup`.

## Output

```
Wave <id> documented:
  ledger: <n> notes added
  ADRs: <list or none>
  changelog: wave-<id> entry (breaking: <y/n>, follow-ups: <list>)
  commit: <hash/subject>
Next: <execute next wave | cleanup>
```

Keep it incremental and proportionate — document decisions and surprises, not every mechanical edit
(the diff already shows those). The test of good migration docs: could someone six months from now
understand why, and safely finish or reverse it?
