---
name: migrate-safeguard
description: >-
  Phase 3 of the migration-harness: capture a behavioral baseline BEFORE any code is changed, so a later
  phase can prove behavior was preserved. Use when you're about to start transforming code in a large
  migration and need a safety net first — a green test suite, characterization/golden-master tests that
  pin current behavior where coverage is thin, and an initial checkpoint. Reach for it when the user asks
  to "pin current behavior before we migrate", "capture a baseline / add characterization tests", "set up
  a safety net before we change anything", or right after `/migration-harness:migrate` sets status to
  `safeguarding`. This is the *before* snapshot, not the *after* check — verifying a wave you already
  transformed is `migrate-verify`. You cannot prove a migration preserved behavior without first
  recording that behavior.
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

2. **Find the behavior no test protects.** First, **ensure the parity standard exists**: run
   `migration.py get-standard --name parity`; if it's absent, run
   `/migration-harness:migrate-parity-standard`. It defines HOW to write characterization tests in THIS
   target framework and what "observable behavior" means here, so your baseline is captured the right way
   — read `.migration/standards/parity.md` before you write any. Focus on the areas the plan will touch,
   especially high-risk units. Where behavior is important but untested, write **characterization tests**
   (a.k.a. golden-master): tests that capture what the code *currently* does — not what it *should* do —
   by pinning current outputs for representative inputs. Save any golden outputs under
   `.migration/baseline/` so they're versioned with the migration. These are temporary scaffolding that
   makes the migration safe; note which are throwaway vs. worth keeping.

   **Worktree caveat (worktree mode).** Each wave later transforms in a worktree forked from the
   integration branch `migration/<name>`, so a wave's suite only sees what is *committed on that branch*.
   The project's existing suite scaffolding is already committed, so it runs there automatically — but
   the characterization tests you author now are **not yet on the integration branch**. Before you hand
   off to execute (step 7), commit these new test files onto `migration/<name>` — there is no migration.py
   command for this; do it as a git step (e.g. `git worktree add` a short-lived worktree on that branch,
   `git add` the test files, `git commit`, then remove the worktree). Skip it and the wave worktrees will
   run without your new tests and the baseline will protect nothing.

3. **Prefer characterization over faith.** For pure functions, snapshot input→output pairs. For modules
   with side effects, capture the observable contract (returned values, emitted events, written files,
   HTTP shapes). The point is a cheap, mechanical "did the observable behavior change?" check that the
   verify phase can re-run per wave.

4. **Prove the tests are real — mutation check (negative control).** A green characterization test is
   worthless if it would stay green no matter what the code did. Before you trust the baseline, confirm
   each test actually *catches* a change: dispatch the `mutation-checker` subagent (one per risky area,
   in a single message) to inject small deliberate mutations into the code a test pins and verify the
   test then goes **red**. Any mutation that survives (tests stay green) is a **false test** — the
   pinned behavior is unprotected — so add the missing characterization there and re-check. The
   mutation-checker reverts every mutation and leaves the tree clean. Only a suite that demonstrably
   fails when the code changes earns the word "baseline"; a suite that can't fail is a green light
   painted over a hole.

5. **Record the baseline.** `migration.py set-baseline --suite-cmd "<cmd>" --captured true
   --characterization <paths>`. This flips the manifest's `baseline.captured` flag that later phases
   check before they trust a green run. The flag is no longer free to flip on faith: `set-baseline
   --captured true` **refuses** unless a `suite_cmd` is actually set **and** the characterization
   artifacts you named exist on disk. So capture the artifacts (steps 2–3) *first*, then set the flag —
   `captured: true` can't be a bare promise with no suite and no baseline behind it.

6. **Take the first checkpoint.** In worktree mode the durable floor already exists as a real commit —
   the integration branch's fork point (`strategy.base_ref`), which the user's working tree is never
   moved off for the whole migration. So do **not** `--commit` here: that would land a commit on the
   user's branch — the one thing this backbone promises to leave untouched. Take a non-committing baseline
   record: `migration.py checkpoint --label baseline` (no `--commit`). The floor you can always return to
   if the whole migration goes sideways is that integration-branch base, not a new commit on the user's
   branch. (Legacy `main-tree` model only: `migration.py checkpoint --label baseline --commit` still
   applies — there the committed checkpoint itself is the floor.)

7. **Hand off.** `migration.py set-status executing`, then continue with
   `/migration-harness:migrate-execute` to run the first wave. This transition is gated: the harness
   **refuses** `set-status executing` until `baseline.captured` is set (step 5), so you cannot start
   transforming without a baseline — the discipline is enforced, not just advised.

## Output

```
Suite: <cmd> → <green | green-except-known: N tests>
Characterization added: <count> tests covering <areas>  (baseline artifacts in .migration/baseline/)
Baseline checkpoint: <cp-id>  (worktree: floor = integration base <base_ref>, uncommitted | main-tree: committed)
```

Invest the most characterization where the plan marked the most risk and where existing coverage is
thinnest — that's exactly where a silent behavior change would otherwise slip through.
