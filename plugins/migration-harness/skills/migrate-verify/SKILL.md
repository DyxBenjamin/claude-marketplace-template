---
name: migrate-verify
description: >-
  Phase 5 of the migration-harness: verify that a migrated wave preserved behavior, and gate on it. Use
  right after transforming a wave — run the test suite and characterization tests, then dispatch
  independent adversarial verifier agents that actively try to prove a regression, take a majority vote,
  and roll back automatically on failure. Reach for it when the user says "make sure the migration
  didn't break anything", "verify this wave", or right after `/migration-harness:migrate` sets status to
  `verifying`. Green here must be trustworthy — that's why verification is adversarial and independent.
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

1. **Run the mechanical checks.** Execute the `suite_cmd` plus the wave's characterization tests.
   Capture full output. A failure here is an immediate red — go to step 4.

2. **Dispatch adversarial verifiers.** For each migrated unit, launch several independent
   `migration-verifier` subagents in one message (2–3 for normal units, more for high-risk). Each is
   told to *prove behavior changed*: review the diff against the transform rule, reason about edge cases
   the tests miss, check that every call site and import was updated, and compare against the baseline /
   characterization. Each returns a verdict `{ regression: true|false, confidence, evidence }`. They do
   not see each other's verdicts — independence is the whole point.

3. **Vote.** A unit passes only if the mechanical checks are green **and** a majority of verifiers find
   no regression. Any verifier that produces concrete evidence of a real regression (not a vague worry)
   fails the unit regardless of the vote — one solid counterexample beats three shrugs.

4. **Gate.** Record each unit: `migration.py record --wave <id> --unit <uid> --result pass|fail
   --report <file>` (or `--note`).
   - **All units pass** → `migration.py set-wave-status --wave <id> verified`,
     `migration.py set-status documenting`, continue with `/migration-harness:migrate-document`.
   - **Any unit fails** → **do not push through**. Roll the wave back:
     `migration.py rollback --wave <id>`. Then decide: shrink the wave (split the failing unit out), add
     the characterization test that would have caught this, and re-plan just the affected units via
     `/migration-harness:migrate-plan` → execute again. Set status back to `planning` or `executing`
     accordingly. A red gate is the harness working, not a setback to route around.

5. **Report.** Tell the user the wave result plainly: what passed, what failed and why, and what the
   rollback/next step is. Never soften a red result.

## Output

```
Wave <id> verification:
  suite: <green|red — details>   characterization: <green|red>
  <uid>: PASS  (verifiers 3/3, no regression)
  <uid>: FAIL  (verifier found: <concrete evidence>)  → rolled back
Gate: <verified → document | failed → rollback + re-plan>
```

The value of this phase is entirely in its honesty. If you catch yourself rationalizing a failure as
"probably fine", that's the exact moment the harness is earning its keep — trust the gate.
