---
name: migrate-plan
description: >-
  Phase 2 of the migration-harness: turn a migration inventory into a safe, incremental wave plan. Use
  after assessment, when you need to sequence a large migration into small dependency-ordered batches
  with success criteria and a rollback plan — or when the user asks "how should we stage this
  migration", "what order do we migrate these in", or right after `/migration-harness:migrate` sets
  status to `planning`. Small reversible waves are what make a large migration survivable.
---

# Plan — sequence the work into small, reversible waves

Assessment told you *what* to migrate. Planning decides *in what order and in what batches*, so that
each step is small enough to verify and cheap to undo. The enemy is the one giant irreversible change;
the antidote is many small waves. Drive state through
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py"`; see `references/manifest-schema.md`.

**Precondition:** an active manifest with the inventory + risk register from assess. If missing, run
`/migration-harness:migrate-assess` first.

## Steps

1. **Order by dependency.** Using the dependency view from assess, sort units topologically. Migrate
   leaves first (nothing depends on them → cheap, contained wins that build confidence), and shared or
   heavily-depended-on modules later — but only *after* they're well characterized (see safeguard),
   because a mistake there has wide blast radius. Break cycles by treating the cycle as one atomic unit.

2. **Batch into waves.** A wave is a set of units with *no unmet dependencies* among them, so they can
   be transformed and verified together (and in parallel). Keep waves small and homogeneous — a wave
   you could review, verify, and if necessary roll back in one sitting. Prefer more small waves over
   fewer big ones. Front-load low-risk waves; isolate high-risk units into their own small waves.

3. **Record the plan.** For each wave, `migration.py add-wave --title "<what>"`; for each unit,
   `migration.py add-unit --wave <id> --paths <a,b> --risk low|med|high --depends <unit-ids>
   --title "<what>"`. Every unit needs an explicit **success criterion**: the concrete test or check
   that will prove it migrated correctly (a passing test file, a green typecheck, a characterization
   match). If no such check exists yet, note it — safeguard must create it before this unit runs.

4. **Deep-dive the risky units.** For each high-risk unit, launch a `risk-analyzer` subagent to produce
   a mitigation plan (what could break, how to detect it, whether to split the unit further, whether it
   needs extra characterization). Fold its output back into the risk register and, if warranted, split
   the unit.

5. **Define the rollback + gate cadence.** Confirm the strategy: one checkpoint per wave (the default),
   rollback = restore snapshot (+ optional git reset). Decide with the user where human gates go — at
   minimum before the first high-risk wave and before cleanup.

6. **Get sign-off, then hand off.** Present the wave plan to the user (waves, unit counts, risk, order,
   gates) and adjust to their feedback — this is the cheapest moment to change course. Then
   `migration.py set-status safeguarding` and continue with `/migration-harness:migrate-safeguard`.

## Output

```
Plan: <W> waves, <U> units total
  wave-1 [low]   <n> units — <theme>
  wave-2 [med]   <n> units — <theme>
  ...
  wave-k [high]  <n> units — <theme>  ← human gate before this
Rollback: checkpoint per wave (git + snapshots)
Units still missing a success check: <list>  → safeguard must cover these
```

A good plan reads like a sequence of moves each of which you'd be comfortable shipping on its own.
If a wave feels scary, it's too big — split it.
