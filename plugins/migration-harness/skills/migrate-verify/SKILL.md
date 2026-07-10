---
name: migrate-verify
description: >-
  Phase 5 of the migration-harness: verify that an already-transformed wave preserved behavior, and gate
  on it. Use right AFTER transforming a wave — run the test suite and characterization tests against the
  baseline, then dispatch independent adversarial verifier agents that actively try to prove a
  regression, take a majority vote, and roll back automatically on failure. Reach for it when the user
  says "verify this wave", "did this change regress behavior", "check the wave we just transformed", or
  right after `/migration-harness:migrate` sets status to `verifying`. This is the *after* check against
  an existing baseline — capturing that baseline *before* any code changes is `migrate-safeguard`. Green
  here must be trustworthy — that's why verification is adversarial and independent.
---

# Verify — prove the wave preserved behavior, or roll it back

A migration's core promise is "same behavior, different code". This phase is where that promise is
checked, and it's deliberately skeptical: tests passing is necessary but not sufficient, because the
transformer that wrote the code is a poor judge of whether it's correct. So verification is done by
*independent* agents whose job is to *break* the claim, not confirm it. Drive state through
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py"`; see `references/manifest-schema.md`.

**Precondition:** an active manifest with a wave whose units are `migrated`. If none, run
`/migration-harness:migrate-execute` first.

## Steps

1. **Run the mechanical gate — inside the wave's worktree.** Run `migration.py check --wave <id>`. It
   executes the recorded `baseline.suite_cmd` **inside the wave's isolated worktree**
   (`.migration/worktrees/<id>`) — where execute applied every unit's edits, on the wave branch forked
   from the never-checked-out integration branch — writes a report to `.migration/reports/<id>/_suite.md`,
   and its **exit code *is* the suite's pass/fail**. `check` sets the worktree as its own cwd, so **do
   not `cd` anywhere** — you never point verify at the main tree, which is still un-migrated. This is the
   mechanical floor of the whole phase: the green must come from a real suite run against the migrated
   code, not a self-reported pass, so you can't record `pass` on a wave whose suite never actually ran
   green. If the wave's characterization tests aren't already part of `suite_cmd`, run them too and treat
   any failure the same way. A non-zero exit here is an immediate red — go to step 4.

2. **Layer adversarial verifiers — each on a *distinct* attack lens, all reading the worktree.** Only
   once the step-1 `check` is green, and for each migrated unit, launch several independent
   `migration-verifier` subagents in one message (2–3 for normal units, more for high-risk) — the
   mechanical suite pass is the floor the adversarial check sits on, not a substitute for it. Point every
   verifier at the migrated code with `migration.py worktree-path --wave <id>` (the transformed tree
   lives in the worktree; the main working tree still holds the un-migrated code). **Do not dispatch
   identical clones.** N copies of
   one prompt over the same inputs share the same blind spots, so their agreement cuts *variance* but not
   *systematic bias* — three verifiers that all skip the concurrency angle vote green in unison on a race.
   Instead give each a **different lens** to attack hardest, and pass that lens in its prompt:
   - **(a) correctness — call sites & signatures:** every match site updated, no half-updated caller,
     signatures / return shapes / imports still resolve, the transform applied *completely*.
   - **(b) null / boundary / error paths:** empty and null inputs, boundaries, exceptions and error
     handling, defaults — the edges the tests don't cover.
   - **(c) concurrency / perf / serialization / numeric:** races and evaluation order, added latency or
     allocation, serialization / contract shape, numeric precision and overflow.
   Every verifier still runs the common baseline (review the diff against the transform rule, confirm the
   unit's **stored `success` criterion** actually holds — that is the definition-of-done — and compare
   against the baseline / characterization) and still reports anything else it notices; the lens is where
   it digs *deepest*, not blinders. With 2 verifiers use lenses (a) and (b); add (c) at 3; for high-risk
   units double up the lens that fits the unit's risk. Each returns a verdict
   `{ regression: true|false, confidence, evidence, missed_sites }`. They do not see each other's
   verdicts — independence is the whole point.

3. **Vote — and require completeness.** A unit passes only if the mechanical gate is green **and** a
   majority of verifiers find no regression. Two things override the vote. First, any verifier that
   produces concrete evidence of a real regression (not a vague worry) fails the unit regardless of the
   vote — one solid counterexample beats three shrugs. Second, **any non-empty `missed_sites` from *any*
   verifier blocks the unit outright, independent of the regression vote**: a migration that left sites
   un-migrated is *incomplete*, and incomplete is not "pass" no matter how green the regression check.
   Record such a unit `fail`, and carry the missed sites into re-plan (step 4) so the follow-up wave
   actually covers them.

4. **Gate.** Record each unit: `migration.py record --wave <id> --unit <uid> --result pass|fail
   --report <file>` (or `--note`). `record --result pass` is the **only** sanctioned path to `verified`
   (it stores the report) — `set-unit-status … verified` now refuses without a logged `--force`, so
   don't reach for it.
   - **All units pass** → `migration.py set-wave-status --wave <id> verified`, then
     **`migration.py integrate --wave <id>`**, then `migration.py set-status documenting` and continue
     with `/migration-harness:migrate-document`. **Integrate is what lands the wave:** it commits the
     worktree's edits on the wave branch, fast-forwards the integration branch `migration/<name>` to it,
     removes the worktree, and deletes the wave branch. A verified-but-**not**-integrated wave has not
     reached `migration/<name>` — the harness **refuses** `set-status cleaning|done` until every wave is
     integrated, so never skip it. (`set-wave-status verified` likewise refuses unless every unit
     recorded `pass`; a red unit mechanically cannot advance — a logged `--force` is the only override.)
   - **Any unit fails** → **do not push through**. The failing `record` already **discarded the wave's
     worktree and branch** (`git worktree remove --force` + `branch -D`) — an instant, total rollback
     that leaves the integration branch and the main working tree completely untouched, with nothing
     half-applied. (Explicit equivalent, if you recorded elsewhere: `migration.py rollback --wave <id>`.)
     The discard leaves the wave `rolled-back`, and execute **skips** `rolled-back` waves — so the
     re-plan loop dead-ends unless you make the wave redoable. **Reset it:** `migration.py reset-wave
     --wave <id>` returns the wave **and its units** to `pending`. Then shrink the wave (split the
     failing unit out), add the characterization test that would have caught this, fold in any
     `missed_sites` from step 3, and re-plan just the affected units via `/migration-harness:migrate-plan`
     → execute again (execute re-opens a fresh worktree). Set status back to `planning` or `executing`
     accordingly. A red gate is the harness working, not a setback to route around.

     **Bound the retry, and wire the abort.** `record --result fail` increments the failing unit's
     `attempts`. After **K = 2** failed attempts on the *same* unit, stop the re-plan loop — you are not
     converging, and re-shrinking a unit that keeps failing burns trust. Escalate to the user with the
     accumulated evidence (what keeps failing and why the last fix didn't take), and offer the documented
     terminal abort of the whole migration: `migration.py set-status rolled-back`. Grinding the same unit
     indefinitely is the failure mode this budget exists to stop.

   - **If the discard itself fails → STOP.** If git refuses to remove the worktree or delete the branch,
     the wave is set to `rollback-failed` — git is in an unknown, possibly half-reverted state. Do **not**
     `reset-wave` or re-execute (that would re-checkpoint over it, and `reset-wave` refuses a
     `rollback-failed` wave anyway). Halt, tell the user to repair git by hand (remove the stale
     worktree/branch), then `migration.py set-wave-status --wave <id> rolled-back` before any redo.

5. **Report.** Tell the user the wave result plainly: what passed, what failed and why, and what the
   rollback/next step is. Never soften a red result.

## Output

```
Wave <id> verification:
  check (suite): <green|red — details>   characterization: <green|red>
  <uid>: PASS  (verifiers 3/3, no regression, no missed sites)
  <uid>: FAIL  (verifier found: <concrete evidence>)  → rolled back
  <uid>: FAIL  (missed_sites: <file:line …>)  → incomplete, blocked
Gate: <verified → integrate → document | failed → discard worktree → reset-wave → re-plan (or abort after K attempts) | rollback-failed → STOP, repair git by hand>
```

The value of this phase is entirely in its honesty. If you catch yourself rationalizing a failure as
"probably fine", that's the exact moment the harness is earning its keep — trust the gate.
