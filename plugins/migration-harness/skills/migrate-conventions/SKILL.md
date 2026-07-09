---
name: migrate-conventions
description: >-
  Establish the house style migrated code must follow, once, and freeze it as a reusable standard. Use
  this as a migration enters execution — or whenever the user says "establish conventions", "match our
  code style", "what naming/formatting should the new code use", or "make the migrated code look like
  ours". It scans existing target-language code in the repo for the real house style (or, if none exists
  yet, researches the target ecosystem's canonical style plus the project's linter/formatter config via
  Context7) and writes `.migration/standards/conventions.md`: naming, formatting, file/module layout,
  import ordering, error-handling and logging patterns, test-file conventions, and the lint rules
  migrated code must pass. Generated exactly once; every transformer then writes to the SAME style.
---

# Migrate-conventions — the house style, once

"Match the surrounding code" is the right instruction for a transformer, but it only works if there is
one written answer to *what surrounds it*. Left to improvise, ten transformers produce ten dialects —
`camelCase` here, `snake_case` there, three logging patterns — and the migrated codebase reads like it
was written by strangers. So decide the conventions **once**, write them down, and have every
`migration-transformer` conform; `migrate-cleanup` uses the same file to sand off the stragglers.
Because the plugin is a read-only cache, the standard lives in the **project**:
`.migration/standards/conventions.md`. It is generated once and human-approved before it governs the
sweep.

The execute phase ensures this on demand (alongside `translation`). Drive state through
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py"`; see `references/manifest-schema.md`.

**Target** comes from the `profile` standard — read it from `.migration/standards/profile.md` (or
`migration.py show`). If profile doesn't exist yet, run `/migration-harness:migrate-profile` first.

## Artifact-guard — run this first, before anything else

A self-specializing skill does its expensive work **exactly once** and is otherwise a no-op. The guard
is the project artifact itself:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" get-standard --name conventions
```

- **Exit 0 — it prints a path** (e.g. `.migration/standards/conventions.md`): the standard already
  exists. **Read that file and STOP.** Do not re-scan, do not call Context7, do not regenerate — this
  specialization is done and every transformer reads that file. Return its contents (or just confirm
  it's in place) and end here.
- **Exit 1 — absent:** the standard has never been built for this project. Run the **one-time
  bootstrap** below, then register it so this same guard short-circuits every future invocation.

## One-time bootstrap (only when `conventions` is absent)

**a. Scan for the real house style.** If the repo already contains **target-language** code, read a
   representative sample and extract what's actually practiced: naming, indentation/quotes/line width,
   file and module layout, import grouping/ordering, how errors are raised/handled, how things are
   logged, and how test files are named and structured. The existing code — not an ideal — is the
   standard. Also read the machine-enforced config: `.eslintrc`/`.prettierrc`, `ruff`/`black`,
   `.php-cs-fixer`, `gofmt`/`golangci`, `rustfmt`, `.editorconfig`.

**b. Research the target ecosystem (Context7)** — needed especially when little or no target code
   exists yet. `resolve-library-id` then `query-docs` for the target language/framework's *current*
   canonical style guide and the linter/formatter in use, so the conventions reflect today's ecosystem
   norms rather than memory. Web search only as a fallback.

**c. Synthesize `conventions.md`** — cover only what this project needs, and prefer observed practice
   over external ideals where they conflict:
   - **Naming** (files, types, functions, variables, constants).
   - **Formatting** (indentation, quotes, line length, trailing commas) — anchored to the formatter.
   - **File / module layout** and where new files go.
   - **Import ordering / grouping.**
   - **Error-handling and logging patterns.**
   - **Test-file conventions** (location, naming, structure).
   - **The lint rules migrated code must satisfy** to pass the project's linter clean.

**d. Write it** to `.migration/standards/conventions.md`.

**e. Register it:**
```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" set-standard --name conventions \
  --path .migration/standards/conventions.md --target "<tgt>"
```

**f. Human review (once).** Show the user the conventions and get explicit approval — teams have strong,
   specific style opinions, and this file is applied to every migrated file. Approving it once here is
   far cheaper than re-formatting hundreds of files after the fact.

## Refresh

Generated **once**, then only read. If the team adopts a new formatter or restyles the codebase, delete
`.migration/standards/conventions.md` and re-invoke this skill — the artifact-guard will see it absent
and rebuild it. Otherwise it stays a no-op.
