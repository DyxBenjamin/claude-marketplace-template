---
name: new-component
description: 'Adds a skill, agent, hook, MCP or LSP server, output style, monitor, userConfig option or mod to an
  existing plugin, with strict validation (and mod tests) passing.'
when_to_use: 'Use when "agrega un hook", "añade un agente", "agrega un MCP", "crea un mod", "agrega una skill al
  plugin", "add a component". Complement of new-plugin: use after it. Writing a skill's body belongs to
  base-plugin:write-skill and testing it to base-plugin:test-skill; this skill places and wires it.'
argument-hint: '<plugin> <kind> [name]'
---
# New component

Objective: the component exists at its documented location in `plugins/<plugin>/`, `claude plugin validate
plugins/<plugin> --strict` passes, and the kind's own check in its spec passes.

Claude runs the Steps as `delegate.md` says.

## Steps
1. Resolve the plugin (a folder under `plugins/`) and the kind from `$ARGUMENTS`. When the user describes a need
   instead of a kind, pick it: a rule that must hold every time is a hook; instructions or a workflow are a
   skill; delegated work with its own context is an agent; an external system's tools are an MCP server; a pane,
   a band, a `/command` that runs code with no Claude turn, or a rewritten tool call is a mod.
2. Read the kind's spec before writing anything: `components.md` for every kind except mods, `mod.md` for mods.
   Every file also follows `.claude/skills/review-marketplace/rules.md` (data, language, tone, technologies, tools).
3. Write the files at the plugin root, never inside `.claude-plugin/`. Paths to the plugin's own files use
   `${CLAUDE_PLUGIN_ROOT}`; state that must survive updates uses `${CLAUDE_PLUGIN_DATA}`. An absolute or `../`
   path breaks once the plugin is copied to the install cache.
4. For a skill, write the frontmatter and a first draft of the body with `/base-plugin:write-skill`, then offer
   `/base-plugin:test-skill` to test and improve it.
5. Add the new files to the tree in `plugins/<plugin>/README.md`, with one line on what each does.
6. Run `claude plugin validate plugins/<plugin> --strict` and the kind's check from its spec. Fix until both pass.
7. For a skill or an agent, offer `new-eval` so a case proves it fires and helps.

## Output
- Component in place and valid. Check: `claude plugin validate plugins/<plugin> --strict`
- The kind's own check from `components.md` or `mod.md` passes.
