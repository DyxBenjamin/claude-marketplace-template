---
name: migrate-profile
description: >-
  Profile a project's tech stack once, at the start of a migration, and freeze the result as a reusable
  project standard. Use this the moment a migration enters assessment — or whenever the user says
  "profile the project", "what stack is this", "detect our build/test commands", or "set the migration
  up for THIS repo". It scans languages, frameworks, build/test/lint tooling, module system, layout and
  entry points, plus the migration's source→target, researches the current toolchain via Context7, and
  writes `.migration/standards/profile.md`. Run it FIRST: it pins down the source and target that every
  other self-specializing skill (translation, conventions, parity) builds on, and wires the
  orchestrator's suite command and transform rule. Generated exactly once; a cheap no-op thereafter.
---

# Migrate-profile — fingerprint this stack, once

Every later phase and every fan-out agent needs the same facts: which languages and versions are here,
which frameworks and tools, how the project builds/tests/lints, and precisely what is moving from what
to what. Re-detecting that in each phase is wasteful and, worse, *inconsistent* — one agent guesses
`pytest`, another `unittest`, and the migration wobbles. So detect it **once**, write it down, and have
everyone read the same file. Because the plugin lives in a read-only cache, that file goes in the
**project**: `.migration/standards/profile.md`. This skill runs first because it establishes the
**source and target** that translation, conventions, and parity all depend on. The assess phase
ensures it on demand; the `migrate` orchestrator, `migrate-assess`, and the `migration-scanner` agent
all consume it.

Drive all state through `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py"`; see
`references/manifest-schema.md`.

## Artifact-guard — run this first, before anything else

A self-specializing skill does its expensive work **exactly once** and is otherwise a no-op. The guard
is the project artifact itself:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" get-standard --name profile
```

- **Exit 0 — it prints a path** (e.g. `.migration/standards/profile.md`): the standard already exists.
  **Read that file and STOP.** Do not re-scan, do not call Context7, do not regenerate — this
  specialization is done and everything downstream reads that file. Return its contents (or just
  confirm it's in place) and end here.
- **Exit 1 — absent:** the standard has never been built for this project. Run the **one-time
  bootstrap** below, then register it so this same guard short-circuits every future invocation.

## One-time bootstrap (only when `profile` is absent)

**a. Scan the repo for stack facts.** Read them off real files, never from memory:
   - **Languages + versions** — `.tool-versions`, `.python-version`, `package.json` `engines`,
     `go.mod`, `composer.json` `require.php`, `*.csproj` `TargetFramework`, `pom.xml`,
     `build.gradle`, `Cargo.toml`, `Gemfile`.
   - **Frameworks** — from the dependency manifests above.
   - **Package manager + build tool** — the lockfile present decides it (`package-lock.json` /
     `yarn.lock` / `pnpm-lock.yaml` / `poetry.lock` / `composer.lock` / `Cargo.lock` / `go.sum`),
     plus any `Makefile`, `Taskfile`, or build config.
   - **Test runner** — `jest`/`vitest` config, `pytest.ini` or `[tool.pytest]`, `phpunit.xml`,
     `go test`, `cargo test`, and the test directory layout.
   - **Lint / format** — `.eslintrc`, `.prettierrc`, `ruff.toml`, `[tool.black]`, `.php-cs-fixer`,
     `golangci.yml`, `rustfmt.toml`, `.editorconfig`.
   - **Module system, directory layout, entry points** — ESM vs CJS (`"type": "module"`), PSR-4
     autoload, package roots; `src/` vs flat; `bin`/`main`/`index`/`main.go`/`manage.py`.
   - **Source → target of THIS migration** — read `strategy.transform` and `goal` from
     `migration.py show`. If they're vague, **confirm the exact source and target with the user now** —
     the other three skills inherit them from here.

**b. Research the current toolchain (Context7).** For the source and target stacks, `resolve-library-id`
   then `query-docs` to confirm the *current* canonical build/test/lint/package-manager commands and the
   live version facts — not what you remember. Web search only as a fallback. You are about to hard-code
   commands that the orchestrator will run for the rest of the migration; get them right.

**c. Synthesize `profile.md`.** Cover **only what this repo actually uses**: the stack facts above and
   the concrete, copy-pasteable **build / test / lint commands**, plus the confirmed source→target.

**d. Write it** to `.migration/standards/profile.md`.

**e. Register it and wire the manifest** so downstream phases pick the facts up automatically:
```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" set-standard --name profile \
  --path .migration/standards/profile.md --source "<src>" --target "<tgt>"
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" set-baseline --suite-cmd "<detected test cmd>"
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/migration.py" set-strategy --transform "<refined source → target rule>"
```

**f. Human review (once).** Show the user the generated `profile.md` — the detected commands and the
   source→target — and get an explicit thumbs-up. This one file steers assess, planning, and the suite
   command every wave runs against; a wrong detection here is cheapest to fix now, before hundreds of
   transforms inherit it.

## Refresh

The profile is generated **once** and then only read. If the stack or the target genuinely changes
(new package manager, a re-scoped target), delete `.migration/standards/profile.md` and re-invoke this
skill — the artifact-guard will see it absent and rebuild. Otherwise it stays a no-op.
