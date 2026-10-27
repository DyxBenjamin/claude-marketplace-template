---
summary: How the skill-authoring workflow adapts its test runs, review and packaging on Claude.ai and Cowork
tags: [skill-creator, packaging, platforms]
related: [plugins/base-plugin/skills/ship-skill/SKILL.md, plugins/base-plugin/scripts/package_skill.ts]
---

# Platform notes: Claude.ai and Cowork

Claude reads this file before running write-skill, test-skill, fix-description or ship-skill outside Claude Code.
The workflow stays the same everywhere (draft, test, review, improve, repeat); the mechanics change.

## Claude.ai
Claude.ai has no subagents.
- Test runs: no parallel runs. For each test case Claude reads the skill's SKILL.md and follows it to complete the
  prompt itself, one at a time. This is less rigorous than independent subagents (the author also runs it, with
  full context), but it is a useful sanity check and the human review compensates. Claude skips the baseline runs.
- Review: with no browser that can open (the Claude.ai VM has no display, or the session runs on a remote
  server), Claude skips the viewer and shows each case's prompt and output in the conversation. An output the
  user needs as a file (a .docx, an .xlsx) is saved to the filesystem with its path given for download. Claude
  asks for feedback inline: does it look right, what would change.
- Benchmarking: skipped; baseline comparisons mean little without subagents, and the user's qualitative feedback
  drives the iterations.
- The iteration loop: the same as in Claude Code without the viewer. Results still go into iteration directories
  when a filesystem is available.
- Description optimization (fix-description) needs `claude -p`: skipped.
- Blind comparison needs subagents: skipped.
- Packaging: `package_skill.ts` runs; the user downloads the `.skill` file.
- Updating an existing skill: Claude keeps the original folder name and `name` field, copies the installed skill
  into a fresh `mktemp -d` folder before editing (the installed path may be read-only), packages from the copy,
  and stages a hand-built package in that folder before copying it to the output directory.

## Cowork
- Subagents exist, so parallel test cases, baselines and grading work. When timeouts become a severe problem,
  Claude runs the test prompts in series.
- No browser or display: Claude generates the viewer with `--static <output_path>` and offers the user a link to
  open it. The viewer is still `generate_review.ts`, never custom HTML, and it comes before Claude evaluates or
  revises anything itself: the next revision is built on the user's review.
- Feedback: with no server, "Submit All Reviews" downloads `feedback.json`; Claude reads it from there,
  requesting access first when needed.
- Packaging works with Node and a filesystem.
- Description optimization works (`run_loop.ts` and `run_eval.ts` use `claude -p` through a subprocess, not a
  browser); Claude holds it until the skill is finished and the user agrees it is in good shape.
- Updating an existing skill follows the Claude.ai guidance above.
