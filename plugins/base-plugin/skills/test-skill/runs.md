---
summary: Eval workspace layout, with-skill and baseline run briefs, benchmark aggregation and the review viewer
tags: [skill-creator, evals, benchmark, eval-viewer]
related: [plugins/base-plugin/skills/test-skill/SKILL.md, plugins/base-plugin/skills/test-skill/schemas.md, plugins/base-plugin/eval-viewer/generate_review.ts, plugins/base-plugin/scripts/aggregate_benchmark.ts]
---

# Runs and viewer

Claude reads this file at steps 1 and 6 of test-skill.

## Workspace layout
`<workspace>/iteration-<N>/<eval-name>/` per eval, with `eval_metadata.json`, and one run directory per
configuration (`with_skill/`, `without_skill/` or `old_skill/`) holding `outputs/`, `timing.json` and
`grading.json`. Claude creates directories as it goes, not all upfront. Each eval gets a descriptive name from what
it tests, used for the directory too. A new or changed eval prompt in an iteration gets a new
`eval_metadata.json`; these files do not carry over.

## Spawning
Per eval, Claude spawns the with-skill subagent and the baseline subagent in the same turn, never the with-skill
runs first and the baselines later: launched together, they finish around the same time.

With-skill brief:

```text
Execute this task:
- Skill path: <path-to-skill>
- Task: <eval prompt>
- Input files: <eval files if any, or "none">
- Save outputs to: <workspace>/iteration-<N>/<eval-name>/with_skill/outputs/
- Outputs to save: <what the user cares about, e.g. "the .docx file", "the final CSV">
```

Baseline: the same brief, with the baseline the context calls for.
- New skill: no skill path at all, saved to `without_skill/outputs/`. It stays the same across iterations.
- Existing skill: before the first edit, Claude snapshots it (`cp -r <skill-path> <workspace>/skill-snapshot/`)
  and points the baseline at the snapshot, saved to `old_skill/outputs/`. On later iterations Claude judges
  which baseline fits: the version the user came in with, or the previous iteration.

When timeouts become a severe problem, Claude runs the prompts in series instead of in parallel.

## Benchmark
`aggregate_benchmark.ts` reports `pass_rate`, time and tokens per configuration as mean ± stddev, plus the delta.
A `benchmark.json` written by hand follows the schema in `schemas.md` exactly, with each with-skill entry before
its baseline counterpart; the viewer shows empty or zero values for any other field name.

## Viewer
Claude builds the review with `generate_review.ts`, never with custom HTML:

```bash
nohup node "${CLAUDE_PLUGIN_ROOT}/eval-viewer/generate_review.ts" <workspace>/iteration-<N> \
  --skill-name "<name>" --benchmark <workspace>/iteration-<N>/benchmark.json > /dev/null 2>&1 &
VIEWER_PID=$!
```

- From iteration 2, Claude adds `--previous-workspace <workspace>/iteration-<N-1>`.
- With no display, or a browser that cannot open (Cowork, a remote server), Claude adds `--static <output_path>`,
  which writes a standalone HTML file instead of serving, and offers the user a link to it. "Submit All Reviews"
  then downloads `feedback.json`; Claude copies it into the iteration directory (requesting access first when
  needed).
- In served mode, feedback auto-saves to `feedback.json` in the iteration directory.
- Once the feedback is read, Claude stops the server: `kill $VIEWER_PID 2>/dev/null`.

"Outputs" shows one case at a time: Prompt, Output (files rendered inline where possible), Previous Output
(iteration 2+, collapsed), Formal Grades (collapsed pass/fail), Feedback (a textbox that auto-saves) and Previous
Feedback (iteration 2+). "Benchmark" shows pass rates, timing and tokens per configuration, with per-eval
breakdowns and the analyzer's notes. Navigation is by prev/next buttons or arrow keys.
