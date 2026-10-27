---
name: test-skill
description: 'Runs a skill''s test prompts with and without it, grades and benchmarks the runs, shows them in the eval
  viewer, and revises the skill from the user''s feedback until the user is satisfied.'
when_to_use: 'Use when "test this skill", "run the evals", "benchmark the skill", "improve this skill", "compare
  two versions", "prueba la skill", "mejora la skill". Complement of write-skill: use after it, on its draft and
  evals/evals.json. Step 2 of new-skill.'
argument-hint: '<skill-dir>'
---
# Test skill

> Modified from anthropics/skills skill-creator (Apache-2.0); original terms in `LICENSE.txt`.

Objective: `<workspace>/iteration-<N>/benchmark.json` covers every eval with and without the skill, the user
reviewed it in the viewer, and the skill holds the revisions from that feedback.

Claude runs the Steps as `delegate.md` says.

`<workspace>` is the project's `.claude/base-plugin/<skill-name>-workspace/`; JSON field names follow
`schemas.md`, whose path every agent brief carries. Steps 1-6 are one continuous sequence Claude runs to the end
without stopping, itself rather than through another testing skill: the grader, the benchmark script and the
viewer all read this workspace layout. Outside Claude Code, Claude first reads
`${CLAUDE_PLUGIN_ROOT}/skills/ship-skill/platforms.md`, which adapts these mechanics.

## Steps
1. Spawn every run in one turn: per eval, a with-skill subagent and a baseline subagent, from the briefs and the
   baseline rules in `runs.md`. Claude writes each eval's `eval_metadata.json` with a descriptive `eval_name`.
2. While they run, draft objectively verifiable assertions with descriptive names for each eval (or review the
   ones in `evals/evals.json`), explain them and what the viewer will show, and write them into
   `eval_metadata.json` and `evals/evals.json`. Subjective skills are judged qualitatively, not forced into
   assertions.
3. As each run's notification arrives, save its `total_tokens` and `duration_ms` to `<run-dir>/timing.json`
   (with `total_duration_seconds`) at once: the notification is the only place this data exists.
4. Grade each run with the `base-plugin:grader` agent (brief: `expectations`, `transcript_path`, `outputs_dir`,
   the path of `schemas.md`). An assertion a script can check gets a script instead of an eyeball check.
5. Aggregate: `node "${CLAUDE_PLUGIN_ROOT}/scripts/aggregate_benchmark.ts" <workspace>/iteration-<N>
   --skill-name <name>`, which writes `benchmark.json` and `benchmark.md`. Then the `base-plugin:analyzer`
   agent in benchmark mode writes the notes the aggregates hide (non-discriminating assertions, flaky evals,
   time and token tradeoffs).
6. Launch the viewer with the command in `runs.md`, before Claude evaluates or revises anything itself, and tell
   the user its two tabs ("Outputs" to leave feedback per case, "Benchmark" for the numbers) and to come back
   when done.
7. Read `feedback.json` once the user says they are done; empty feedback means that case is fine. Stop the viewer.
8. Revise the skill as `improve.md` says, focused on the cases with specific complaints.
9. Repeat steps 1-8 into `iteration-<N+1>/`, until the user is happy, the feedback is all empty, or the
   iterations stop making meaningful progress.

For a rigorous "is the new version actually better?" between two versions, Claude runs the blind comparison in
`compare.md`; it is optional and needs subagents, and the human review loop is usually enough.

When a todo list is available, Claude adds the loop to it (run the test prompts, generate the viewer, read the
feedback, improve) so no step is skipped. In Cowork, it carries "Create evals JSON and run
`eval-viewer/generate_review.ts` so human can review test cases".

## Output
- Benchmark of the last iteration. Check: `node -e 'JSON.parse(fs.readFileSync(process.argv[1]))'
  <workspace>/iteration-<N>/benchmark.json`
- User feedback read. Check: `test -f <workspace>/iteration-<N>/feedback.json`
- Revised skill still passes the rules. Check: `node "${CLAUDE_PLUGIN_ROOT}/scripts/check_skill.ts" <skill-dir>`
