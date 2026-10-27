---
summary: Describes base-plugin's five skill-authoring skills, shared agents and scripts, eval cases and sample hook
tags: [skill-creator, evals, hook, plugin-components]
related: [plugins/base-plugin/.claude-plugin/plugin.json, plugins/base-plugin/hooks/example-guard.ts, plugins/base-plugin/hooks/hooks.json]
---

# base-plugin

Example plugin for the marketplace. It contains five working skills that take a
skill from idea to package, the agents and scripts they share, an eval suite,
and a sample hook.

```text
base-plugin/
├── .claude-plugin/
│   └── plugin.json            # plugin metadata (the only required file)
├── agents/
│   ├── builder.md             # stamped builder subagent every skill delegates to
│   ├── grader.md              # grades one eval run into grading.json
│   ├── comparator.md          # blind A/B judgment into comparison.json
│   └── analyzer.md            # post-hoc analysis and benchmark notes
├── assets/
│   └── eval_review.html       # page where the user reviews trigger queries
├── eval-viewer/
│   ├── generate_review.ts     # builds and serves (or writes --static) the review page
│   ├── review_data.ts         # reads runs, gradings and benchmark into the page data
│   ├── review_server.ts       # HTTP server for the page and the feedback API
│   ├── mime_types.ts          # content types for inline output files
│   └── viewer.html            # review page template
├── evals/
│   ├── create-skill/          # new-skill or write-skill fires on a matching request and helps
│   └── no-trigger/            # no skill-authoring skill fires on an unrelated question
├── hooks/
│   ├── hooks.json             # sample hook wiring (replace or delete)
│   └── example-guard.ts       # sample no-op PreToolUse hook (replace or delete)
├── scripts/
│   ├── aggregate_benchmark.ts # writes benchmark.json and benchmark.md for an iteration
│   ├── benchmark_load.ts      # loads run results for the benchmark
│   ├── benchmark_md.ts        # renders benchmark.md
│   ├── benchmark_stats.ts     # mean, stddev and deltas per configuration
│   ├── check_skill.ts         # checks skill folders against the marketplace skill rules
│   ├── check-skills.ts        # stamped skill rules that check_skill.ts runs
│   ├── verbs.txt              # stamped verb list for skill names
│   ├── cli.ts                 # argument parsing shared by the scripts
│   ├── embed_delegation.ts    # writes delegate.md and builder.md into a generated skill
│   ├── generate_report.ts     # HTML report of a description optimization run
│   ├── improve_description.ts # asks Claude for a better description from failed queries
│   ├── mini_yaml.ts           # frontmatter parser for quick_validate.ts
│   ├── package_skill.ts       # validates and zips a skill into a .skill archive
│   ├── py_json.ts             # JSON formatting shared by the scripts
│   ├── py_random.ts           # seeded shuffle for the train/test split
│   ├── quick_validate.ts      # validates SKILL.md frontmatter for packaging
│   ├── run_eval.ts            # measures how often queries trigger a skill (claude -p)
│   ├── run_loop.ts            # description optimization loop over run_eval and improve_description
│   ├── schemas.ts             # zod schemas of every JSON file the scripts read and write
│   └── utils.ts               # file, JSON and CLI helpers
├── skills/
│   ├── new-skill/             # chains the four skills below
│   ├── write-skill/           # captures intent and writes the SKILL.md draft and evals.json
│   ├── test-skill/            # runs, grades, benchmarks, reviews and revises the skill
│   ├── fix-description/       # optimizes the description for triggering
│   └── ship-skill/            # packages the skill as a .skill file
└── vendor/
    └── zod.generated.js       # vendored zod (npm run vendor)
```

- **Skills** — `new-skill` runs the whole path; each stage also runs alone as
  `/base-plugin:write-skill`, `/base-plugin:test-skill`,
  `/base-plugin:fix-description` and `/base-plugin:ship-skill`. They derive
  from Anthropic's `skill-creator` (anthropics/skills), under the Apache
  License 2.0: each skill folder keeps a copy of `LICENSE.txt`. Every skill
  holds its stamped `delegate.md`.
- **Agents** — `grader`, `comparator` and `analyzer` are the subagents
  `test-skill` dispatches; `builder` is the stamped builder every skill
  delegates to.
- **Evals (`evals/`)** — two cases for `claude plugin eval ./plugins/base-plugin`.
  Each has a `prompt.md` (the user request and run limits) and `graders/*.md`
  (how the run is scored). Runs call the model and cost API credit.
- **Hook (`hooks.json` + `example-guard.ts`)** — a no-op `PreToolUse` hook that
  allows everything. `hooks.json` runs it with `node` (24 or later); it parses
  the event on stdin with the vendored zod (`vendor/zod.generated.js`) and exits
  0 (allow) or 2 (block, reason on stderr). Add real rules or delete the
  `hooks/` directory and its wiring.

A plugin only needs `.claude-plugin/plugin.json`. Keep the parts you use and
delete the rest.

## Make it yours

1. Set `author` (and optionally `name`, `description`, `keywords`) in
   `.claude-plugin/plugin.json`.
2. Replace or remove the sample hook.
3. Use `new-skill` to build your own skills, and replace the eval cases with
   requests your skills should (and should not) handle. `claude plugin eval
   init` interviews you and writes cases.

`marketplace.json`, the Release Please config, and version bumps are handled by
CI — you don't edit them by hand.
