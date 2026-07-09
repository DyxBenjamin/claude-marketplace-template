---
name: migrate-assess
description: >-
  Phase 1 of the migration-harness: assess and inventory a large code migration, as the first step of
  actually migrating something. Use when starting or scoping a codebase-wide migration/upgrade/port and
  you need a complete inventory of every site to change, a dependency map, and a risk register before
  planning. Reach for it when the user asks "how big is this migration", "as the first step of migrating
  X, find every site that uses it", or "what's the blast radius of upgrading Y", or right after
  `/migration-harness:migrate` sets status to `assessing`. A plain "find everything that uses X" with no
  intent to migrate is just a code search — do that directly; only pull in the harness when the goal is
  actually to *migrate* X. You can't plan or verify what you haven't enumerated — this phase enumerates it.
---

# Assess — inventory, dependencies, and risk

The goal of this phase is a *complete, honest picture* of the migration before anyone edits code. A
migration that's planned on a partial inventory breaks in the sites you forgot. Read
`references/manifest-schema.md` if you haven't; drive all state through
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py"`.

**Precondition:** a `.migration/manifest.json` with an active status. If there is none, stop and run
`/migration-harness:migrate` first — that's the entry point.

## Steps

1. **Pin down the match rule.** State precisely what identifies a site that must change — the old
   import, API, pattern, config key, or type. Write it into the manifest with
   `migration.py set-strategy --transform "<from> → <to>: <rule>"`. This rule is reused by every later
   phase, so make it unambiguous.

2. **Fan out scanners.** Split the repo into regions (top-level packages/dirs) and launch one
   `migration-scanner` subagent per region *in a single message* so they run concurrently (cap at
   `strategy.parallelism`). Each scanner is read-only and returns, per region: files touched, exact
   match sites (path + line + snippet), imports/exports involved, and which other modules depend on
   the touched code. For a small repo, one scan inline is fine.

3. **Build the dependency view.** Merge the scanner results into "what depends on what". This is the
   input to wave ordering later: shared/core modules that many things import are migrated late (or
   characterized first); leaf modules with no dependents are safe early wins. Note cycles explicitly —
   they force a unit to be migrated atomically.

4. **Register risks.** For each hotspot, record a risk with
   `migration.py add-risk --area <a> --risk "<r>" --severity low|med|high --mitigation "<m>"`. Treat as
   higher-risk: shared/core utilities, public API surface, dynamic/reflective/string-keyed usage
   (grep can't fully find it), generated code, and any area with thin test coverage. High-risk areas
   drive both the plan order and how much baseline you capture.

5. **Find the verification command.** Detect how this project proves itself (test runner, typecheck,
   build, lint) and record it with `migration.py set-baseline --suite-cmd "<cmd>"`. Note where coverage
   is missing in the areas you'll touch — the safeguard phase fills those gaps.

6. **Summarize and hand off.** Report to the user: total sites across N files, the dependency hotspots,
   the risk register, and the biggest unknowns. Then `migration.py set-status planning` and continue
   with `/migration-harness:migrate-plan`.

## Output

End the phase with a short, scannable summary:

```
Inventory: <N> sites across <M> files in <K> regions
Hotspots (many dependents): <list>
Dynamic/uncertain usage (needs manual review): <list>
Risk register: <count> (<high> high) — see manifest
Verification command: <suite_cmd>   Coverage gaps: <areas>
```

Bias toward over-inventorying: a site you list and skip is cheap; a site you miss becomes a
production incident. When the match rule can't find something statically (reflection, config,
codegen), say so loudly and flag it for manual review rather than assuming it's absent.
