---
name: migrate-safeguard
description: >-
  Phase 3 of the migration-harness: capture a behavioral baseline before any code is changed. Use when
  you're about to start transforming code in a large migration and need a safety net — a green test
  suite, characterization/golden-master tests for behavior that isn't covered, and an initial
  checkpoint. Reach for it when the user asks to "make sure we don't break anything", "pin current
  behavior before we migrate", or right after `/migration-harness:migrate` sets status to
  `safeguarding`. You cannot prove a migration preserved behavior without a record of the behavior.
---

# Safeguard — capture the baseline before touching anything

This phase builds the safety net the whole harness leans on. Verification later works by comparing
*after* against *before* — so you must capture *before* first. Skipping this is how migrations
"pass their tests" and still change behavior in the parts no test looked at. Drive state through
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py"`; see `references/manifest-schema.md`.

**Precondition:** an active manifest with a wave plan. If missing, run `/migration-harness:migrate-plan`.

## Steps

1. **Get to green first.** Run the `suite_cmd` recorded in the manifest (test/typecheck/build). If it's
   already red, you cannot use it as a baseline — triage with the user: fix the failures, or record the
   exact set of known-failing tests so "no *new* failures" becomes the bar. A migration started on a red
   suite has no signal.

2. **Find the behavior no test protects.** Focus on the areas the plan will touch, especially
   high-risk units. Where behavior is important but untested, write **characterization tests**
   (a.k.a. golden-master): tests that capture what the code *currently* does — not what it *should* do —
   by pinning current outputs for representative inputs. Save any golden outputs under
   `.migration/baseline/` so they're versioned with the migration. These are temporary scaffolding that
   makes the migration safe; note which are throwaway vs. worth keeping.

3. **Prefer characterization over faith.** For pure functions, snapshot input→output pairs. For modules
   with side effects, capture the observable contract (returned values, emitted events, written files,
   HTTP shapes). The point is a cheap, mechanical "did the observable behavior change?" check that the
   verify phase can re-run per wave.

4. **Record the baseline.** `migration.py set-baseline --suite-cmd "<cmd>" --captured true
   --characterization <paths>`. This flips the manifest's `baseline.captured` flag that later phases
   check before they trust a green run.

5. **Take the first checkpoint.** `migration.py checkpoint --label baseline --commit` (commit is worth
   it here — a clean, known-good restore point at the start). This is the floor you can always return
   to if the whole migration goes sideways.

6. **Hand off.** `migration.py set-status executing`, then continue with
   `/migration-harness:migrate-execute` to run the first wave.

## Output

```
Suite: <cmd> → <green | green-except-known: N tests>
Characterization added: <count> tests covering <areas>  (baseline artifacts in .migration/baseline/)
Baseline checkpoint: <cp-id> (committed)
```

Invest the most characterization where the plan marked the most risk and where existing coverage is
thinnest — that's exactly where a silent behavior change would otherwise slip through.
