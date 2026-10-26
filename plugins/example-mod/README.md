---
summary: Documents example-mod, a tool-call counter mod with a spinner suffix and /tally command, and how to run and test it
tags: [mod, hooks, slash-command, spinner-ui]
related: [plugins/example-mod/hooks/register.js, plugins/example-mod/tests/example-mod.test.ts]
---

# example-mod

Example mod for the marketplace. It counts the tool calls Claude makes, shows the
count beside the spinner (`Thinking · tool calls: 3…`), and adds a `/tally`
command that prints it without starting a Claude turn.

```text
example-mod/
├── .claude-plugin/
│   └── plugin.json          # plugin metadata; mods add no required fields
├── hooks/
│   ├── hooks.json           # "modules": ["./register.js"] makes this a mod
│   └── register.js          # the hooks module: exports register(on)
└── tests/
    └── example-mod.test.ts  # offline tests for `claude plugin test`
```

## Try it

```sh
claude --plugin-dir ./plugins/example-mod
```

Ask Claude for something that takes a few tool calls, then type `/tally`. Edits to
`register.js` hot-reload in the open session, which resets the count to zero.

## Test it

```sh
cd plugins/example-mod
claude plugin test               # runs *.test.ts with no session or network
claude plugin validate . --strict  # lists the hooks and calls Claude Code finds
```

Loading the mod with `--plugin-dir` writes TypeScript declarations for your
Claude Code version to `.claude-plugin/types/` (gitignored), for editor
autocomplete and `tsc` type checks.

## Make it yours

A mod runs inside Claude Code with the user's permissions and is not sandboxed.
Keep its hooks to what the mod needs, and check the `hooks:` and `calls:` lines
of `claude plugin validate` before you publish it. Events, mods API methods and
elements are in the [mods reference](https://code.claude.com/docs/en/plugins/mods/reference).
