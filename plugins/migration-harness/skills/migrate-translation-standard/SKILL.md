---
name: migrate-translation-standard
description: >-
  Build the project's source→target translation guide once and freeze it as a reusable standard. Use
  this as a language/framework port enters execution — or whenever the user says "build the translation
  guide", "how do we map <old lang> to <new lang>", "define the idiom mapping", or "what's the
  equivalent of <lib> in the target". It scans which source-language constructs THIS repo actually uses,
  researches the source and target languages plus their key libraries via Context7, and writes
  `.migration/standards/translation.md`: an idiom-mapping table, a stdlib/dependency equivalence table,
  and the semantic gotchas of this exact pair (equality, null/undefined, numerics, encoding, sync/async,
  errors, imports). Generated exactly once; every transformer then applies the SAME mapping.
---

# Migrate-translation-standard — the idiom map, once

A language or framework port is really hundreds of small translations, and the danger is that each one
is decided independently: transformer A maps the source's `Map` one way, transformer B another, and
verifier C flags neither. The fix is a single written **translation standard** that every
`migration-transformer` applies identically, every `migration-verifier` uses as its pitfall lens, and
`risk-analyzer` reads to spot the hazardous mappings. Because the plugin is a read-only cache, that
standard lives in the **project**: `.migration/standards/translation.md`. It is generated **once**,
researched against current docs rather than memory, and human-approved before it governs the sweep.

The execute phase ensures this on demand (alongside `conventions`). Drive state through
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py"`; see `references/manifest-schema.md`.

**Source and target** come from the `profile` standard. Read them from `.migration/standards/profile.md`
(or `migration.py show` → `strategy.transform` / `goal`). If the profile standard doesn't exist yet, run
`/migration-harness:migrate-profile` first — it establishes source→target for all of us.

## Artifact-guard — run this first, before anything else

A self-specializing skill does its expensive work **exactly once** and is otherwise a no-op. The guard
is the project artifact itself:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" get-standard --name translation
```

- **Exit 0 — it prints a path** (e.g. `.migration/standards/translation.md`): the standard already
  exists. **Read that file and STOP.** Do not re-scan, do not call Context7, do not regenerate — this
  specialization is done and every transformer/verifier reads that file. Return its contents (or just
  confirm it's in place) and end here.
- **Exit 1 — absent:** the standard has never been built for this project. Run the **one-time
  bootstrap** below, then register it so this same guard short-circuits every future invocation.

## One-time bootstrap (only when `translation` is absent)

**a. Scan which source constructs the repo ACTUALLY uses.** Don't map the whole language — map only
   what's present. Grep the source tree for the constructs and library calls in use: collections/maps,
   generics, decorators/annotations, closures, comprehensions, magic methods, concurrency primitives,
   the specific stdlib and third-party APIs called. The dependency manifest (`composer.json`,
   `requirements.txt`, `go.mod`, …) is your list of libraries that need a target equivalent.

**b. Research source AND target (Context7).** For the source language, the target language, and each
   key library in use, `resolve-library-id` then `query-docs` for the *current* APIs and idioms — the
   mapping must reflect today's docs, not your training memory. Web search only as a fallback.

**c. Synthesize `translation.md`** — cover only what this repo uses:
   - **Idiom-mapping table**: source construct → target idiom (e.g. PHP `array` → JS `Map`/object/array
     as appropriate; list comprehension → `.map()/.filter()`).
   - **Stdlib / library equivalence table** (the dependency map): each source dependency → its target
     replacement (e.g. Composer package → npm package), with the call-shape difference noted.
   - **Semantic gotchas of THIS pair**: the traps that silently change behavior — equality (`==` vs
     `===`), `null` vs `undefined`, int/float and integer overflow, string/byte encoding, sync vs
     async execution, the error/exception model (checked vs thrown vs returned), truthiness.
   - **Module / import translation**: how source imports/namespaces map to target imports/modules.

**d. Write it** to `.migration/standards/translation.md`.

**e. Register it:**
```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" set-standard --name translation \
  --path .migration/standards/translation.md --source "<src>" --target "<tgt>"
```

**f. Human review (once).** Walk the user through the mapping and gotchas and get explicit approval.
   This table is applied uniformly across the whole port; a wrong mapping approved here becomes the same
   bug reproduced in every transformed file, so catch it now rather than in verification.

## Refresh

Generated **once**, then only read. If the source, target, or a key library changes, delete
`.migration/standards/translation.md` and re-invoke this skill — the artifact-guard will see it absent
and rebuild it. Otherwise it stays a no-op.
