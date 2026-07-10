---
name: migrate-parity-standard
description: >-
  Define exactly how this migration proves behavior is preserved, once, and freeze it as a reusable
  standard. Use this as a migration enters the safeguard phase — or whenever the user says "define how
  we prove parity", "how do we know behavior didn't change", "set up characterization/golden-master
  tests", or "can we dual-run old vs new". It detects the test command and target framework, how
  characterization tests are written for this stack, whether a dual-run is feasible, and what
  "observable behavior" means for this app (HTTP shapes, CLI output, DB effects, files), researches the
  target test framework via Context7, and writes `.migration/standards/parity.md`. Generated exactly
  once; safeguard writes characterization from it and every verify wave proves parity the same way.
---

# Migrate-parity-standard — how we prove parity, once

Preserving behavior is the entire contract of a migration, so "did it still behave the same?" cannot be
answered ad-hoc, differently, in every wave. It needs one agreed definition: which command runs the
suite, how a characterization (golden-master) test is written for *this* stack, whether the old and new
implementations can be **dual-run** and diffed, and what counts as **observable behavior** for this
particular app. Decide it **once**, write it down, and every phase proves parity the same way:
`migrate-safeguard` writes characterization tests from it, `migrate-verify`'s mechanical `check` and
comparison follow it, and the `mutation-checker` agent uses it to confirm the tests actually detect
change. Because the plugin is a read-only cache, the standard lives in the **project**:
`.migration/standards/parity.md`.

The safeguard phase ensures this on demand. Drive state through
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py"`; see `references/manifest-schema.md`.

**Source and target** come from the `profile` standard — read them from `.migration/standards/profile.md`
(or `migration.py show`). If profile doesn't exist yet, run `/migration-harness:migrate-profile` first.

## Artifact-guard — run this first, before anything else

A self-specializing skill does its expensive work **exactly once** and is otherwise a no-op. The guard
is the project artifact itself:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" get-standard --name parity
```

- **Exit 0 — it prints a path** (e.g. `.migration/standards/parity.md`): the standard already exists.
  **Read that file and STOP.** Do not re-detect, do not call Context7, do not regenerate — this
  specialization is done and safeguard/verify read that file. Return its contents (or just confirm it's
  in place) and end here.
- **Exit 1 — absent:** the standard has never been built for this project. Run the **one-time
  bootstrap** below, then register it so this same guard short-circuits every future invocation.

## One-time bootstrap (only when `parity` is absent)

**a. Detect how this app proves itself.**
   - **Suite command + framework** — the test command (prefer the `profile` standard's detected
     `suite_cmd`) and which target framework runs it (Jest/Vitest, PyTest, PHPUnit, Go `testing`,
     JUnit, …).
   - **Characterization style** — how golden-master / snapshot tests are written in that target
     framework (snapshot files, approval tests, table-driven fixtures).
   - **Dual-run feasibility** — can the old and new implementations run side by side on the same inputs
     and have their outputs diffed? Note what makes it possible or not (shared fixtures, a stable seam,
     nondeterminism to pin: time, randomness, ordering).
   - **Observable behavior for THIS app** — what a user/consumer can actually see and therefore what
     must stay identical: HTTP response shapes/status, CLI stdout/stderr and exit codes, database
     effects, files written, emitted events/messages.

**b. Research the target test framework (Context7).** `resolve-library-id` then `query-docs` for the
   framework's *current* snapshot/golden/approval-testing APIs and assertion style, so the template you
   write matches today's framework, not memory. Web search only as a fallback.

**c. Synthesize `parity.md`:**
   - The **suite command** verify will run.
   - A concrete **characterization-test template** for this stack (copy-paste starting point).
   - The **dual-run approach** (or an explicit statement that only characterization-of-old is feasible,
     and why).
   - The **observable-contract definition** — precisely how `migrate-verify`'s `check` proves parity
     here: what is captured before, what is compared after, and what a mismatch means.

**d. Write it** to `.migration/standards/parity.md`.

**e. Register it:**
```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" set-standard --name parity \
  --path .migration/standards/parity.md --source "<src>" --target "<tgt>"
```

**f. Human review (once).** Show the user the observable contract and the characterization approach and
   get explicit approval. This defines what "still correct" *means* for the whole migration; if it
   omits a real observable (a side effect, an error path), every wave will verify green while quietly
   breaking it — so pin it down here, before any wave is gated on it.

## Refresh

Generated **once**, then only read. If the test framework changes or the app grows a new observable
surface, delete `.migration/standards/parity.md` and re-invoke this skill — the artifact-guard will see
it absent and rebuild it. Otherwise it stays a no-op.
