# base-plugin

Example plugin for the marketplace. It contains one working skill
(`skill-creator`), an eval suite for it, and a sample hook.

```text
base-plugin/
├── .claude-plugin/
│   └── plugin.json          # plugin metadata (the only required file)
├── evals/
│   ├── create-skill/        # skill-creator fires on a matching request and helps
│   └── no-trigger/          # skill-creator stays silent on an unrelated question
├── hooks/
│   ├── hooks.json           # sample hook wiring (replace or delete)
│   └── example-guard.sh     # sample no-op PreToolUse hook (replace or delete)
└── skills/
    └── skill-creator/       # scaffolds new skills (Anthropic, Apache-2.0)
```

- **`skill-creator`** — a working skill that helps author new skills. Claude can
  invoke it when you ask to create a skill, or you can run it directly. It is
  Anthropic's, under the Apache License 2.0 (see its `LICENSE.txt`).
- **Evals (`evals/`)** — two cases for `claude plugin eval ./plugins/base-plugin`.
  Each has a `prompt.md` (the user request and run limits) and `graders/*.md`
  (how the run is scored). Runs call the model and cost API credit.
- **Hook (`hooks.json` + `example-guard.sh`)** — a no-op `PreToolUse` hook that
  allows everything. Add real rules or delete the `hooks/` directory and its
  wiring.

A plugin only needs `.claude-plugin/plugin.json`. Keep the parts you use and
delete the rest.

## Make it yours

1. Set `author` (and optionally `name`, `description`, `keywords`) in
   `.claude-plugin/plugin.json`.
2. Replace or remove the sample hook.
3. Use `skill-creator` to build your own skills, and replace the eval cases with
   requests your skills should (and should not) handle. `claude plugin eval
   init` interviews you and writes cases.

`marketplace.json`, the Release Please config, and version bumps are handled by
CI — you don't edit them by hand.
