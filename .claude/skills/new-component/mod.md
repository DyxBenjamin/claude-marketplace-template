---
summary: Specifies a mod plugin's hooks module, tests and types files, its runtime rules, and the checks it passes
tags: [mod, hooks, plugin-components]
related: [.claude/skills/new-component/SKILL.md, plugins/example-mod/hooks/register.ts, plugins/example-mod/tests/example-mod.test.ts]
---

# Mod spec

A mod is a plugin whose hooks module runs inside Claude Code: it draws panes and bands, adds `/commands` that run
code with no Claude turn, and observes, rewrites or answers tool calls and prompts. `plugins/example-mod/` is a
working reference. The built-in `plugin-authoring` skill covers the API in depth.

## Files
- `hooks/hooks.json`: `{"description": "...", "modules": ["./register.ts"]}`. It can also hold settings hooks under
  `hooks`, so a plugin that already has a `hooks.json` adds the `modules` key to the same file. A settings hook
  command runs `node "${CLAUDE_PLUGIN_ROOT}/hooks/<name>.ts"`.
- `hooks/register.ts`, an ES module exporting `register(on, options)`; `options` holds the `userConfig` values,
  parsed with zod from `../vendor/zod.generated.js` like every `$.store` value. Each
  `on('<event>', [matcher], async ($, e, next) => ...)` is a hook: return `next(e)` to observe, `next({...e, ...})`
  to rewrite, or a result without calling `next` to answer.
- `tests/<name>.test.ts`, importing `{ expect, test } from 'claude-code/testing'`. Each test fires events through
  the test's `$` (`$.tool.call`, `$.command.run`, `$.session.start`) and stubs what Claude Code would answer with
  `on(...)`, registered before the first call on `$`.
- `types/index.d.ts` only when the mod uses `$.state` or adds a namespace to the mods API.

## Rules
- A mod runs with the user's permissions and is not sandboxed: it registers only the hooks it needs, and the
  README says what it reaches (files, network, models).
- Module-level variables reset on each reload. `$.state` lasts the session and redraws what reads it (declare
  it in `types/index.d.ts`); `$.store` is a JSON key-value store that lasts across sessions.
- Events, methods and elements change between releases. Loading the mod with `claude --plugin-dir` writes
  version-exact declarations to `.claude-plugin/types/` (gitignored); they win over any page when they disagree.

## Check
- `npm run typecheck` passes, and a sample event piped into each settings hook script
  (`echo '<event json>' | node plugins/<plugin>/hooks/<name>.ts`) exits as the hook intends.
- `cd plugins/<plugin> && claude plugin test` passes, with at least one test per hook that changes behavior.
- `claude plugin validate plugins/<plugin> --strict` passes, and its `hooks:` and `calls:` lines list exactly the
  events and calls the mod is meant to use.
