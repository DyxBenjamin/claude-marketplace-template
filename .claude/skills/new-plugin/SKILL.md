---
name: new-plugin
description: 'Creates plugins/<name>/ with plugin.json and a README, listed in marketplace.json and the release
  config, with strict validation passing.'
when_to_use: 'Use when "nuevo plugin", "crea un plugin", "agrega un plugin al marketplace", "scaffold a plugin",
  "create a plugin". Complement of new-component: runs first, then add parts with it. Variant: new-plugin-external
  for a plugin whose code lives in another repo.'
argument-hint: '<plugin-name> [what it does]'
---
# New plugin

Objective: `plugins/<name>/` exists, `marketplace.json` lists it, and both validate under `--strict`.

Claude runs the Steps as `delegate.md` says.

## Steps
1. Settle the name: kebab-case, no spaces, `@`, `:` or `/`, not starting with `cc-plugin-` (reserved for built-in
   mods), and unused under `plugins/` and in `.claude-plugin/marketplace.json`. The folder name equals the plugin
   `name`, because `scripts/generate-release-config.ts` maps one to the other.
2. Ask for a one-line description when `$ARGUMENTS` has none. It is what users read in `/plugin`: what the plugin
   does, in plain words.
3. Write `plugins/<name>/.claude-plugin/plugin.json` from the template in `CLAUDE.md`, with `version` `0.1.0`,
   `author` copied from an existing plugin, and a few `keywords`. The version lives only here: the release workflow
   bumps it, and a `marketplace.json` entry never carries one.
4. Write `plugins/<name>/README.md`: what it does, its file tree, how to try it
   (`claude --plugin-dir ./plugins/<name>`), and how to install it
   (`/plugin install <name>@<marketplace name from marketplace.json>`).
5. Run `node scripts/generate-release-config.ts`. It adds the plugin to `marketplace.json` and
   to the two release config files at the repo root; those three are never edited by hand.
6. Run `claude plugin validate . --strict` and `claude plugin validate plugins/<name> --strict`, and fix until both
   pass. An `ICON_MISSING` warning does not fail strict mode.
7. Offer `new-component` for what the plugin should contain: a plugin with no component loads and does nothing.

## Output
- Plugin scaffolded, listed and valid. Check:
  `claude plugin validate . --strict && claude plugin validate plugins/<name> --strict`
- Listed in the catalog. Check: `grep -q '"name": "<name>"' .claude-plugin/marketplace.json`
