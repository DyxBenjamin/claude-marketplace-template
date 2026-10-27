---
summary: Adapts the skill-creator workflow to Claude.ai and Cowork, where subagents, browser or `claude -p` may be missing
tags: [skill-creator, platforms]
---

# Platform notes: Claude.ai and Cowork

Claude reads this file when it runs outside Claude Code. The core workflow stays the same everywhere (draft → test
→ review → improve → repeat); what changes is the mechanics.

## Claude.ai

Claude.ai has no subagents, so these mechanics adapt:

- **Running test cases**: no subagents means no parallel runs. For each test case, Claude reads the skill's
  SKILL.md and follows its instructions to accomplish the test prompt itself, one at a time. This is less rigorous
  than independent subagents (Claude wrote the skill and also runs it, with full context), but it is a useful
  sanity check, and the human review compensates. Claude skips the baseline runs and uses the skill to complete
  each task as requested.
- **Reviewing results**: when no browser can open (the Claude.ai VM has no display, or the session runs on a
  remote server), Claude skips the browser viewer and presents results in the conversation. For each test case it
  shows the prompt and the output. An output the user needs to see as a file (a .docx or .xlsx) is saved to the
  filesystem and Claude says where it is so the user can download and inspect it. Claude asks for feedback inline,
  for example whether the result looks right and what the user would change.
- **Benchmarking**: Claude skips quantitative benchmarking; it relies on baseline comparisons, which mean little
  without subagents. Qualitative feedback from the user drives the iterations.
- **The iteration loop**: the same as in Claude Code (improve the skill, rerun the test cases, ask for feedback),
  without the browser viewer in the middle. Results still go into iteration directories when a filesystem is
  available.
- **Description optimization**: needs the `claude` CLI (`claude -p`), available only in Claude Code. Claude skips
  it on Claude.ai.
- **Blind comparison**: needs subagents. Claude skips it.
- **Packaging**: `package_skill.ts` runs anywhere with Node and a filesystem. On Claude.ai, Claude runs it and the
  user downloads the resulting `.skill` file (see [packaging](packaging.md)).
- **Updating an existing skill**: the user may be asking to update an existing skill rather than create one. Then
  Claude:
  - **Keeps the original name.** It notes the skill's directory name and `name` frontmatter field and uses them
    unchanged: an installed `research-helper` produces `research-helper.skill`, not `research-helper-v2`.
  - **Copies to a writable location before editing.** The installed skill path may be read-only, so Claude copies
    it into a fresh `mktemp -d` folder, edits there and packages from the copy.
  - **Stages in that `mktemp -d` folder first when packaging by hand**, then copies to the output directory: direct writes may
    fail for lack of permissions.

## Cowork

- Cowork has subagents, so the main workflow (parallel test cases, baselines, grading) works. When timeouts become
  a severe problem, Claude runs the test prompts in series instead of in parallel.
- Cowork has no browser or display, so Claude generates the eval viewer with `--static <output_path>`, which
  writes a standalone HTML file instead of starting a server, and offers the user a link to open it in their
  browser.
- After running tests, Claude generates the eval viewer with `generate_review.ts` (not custom HTML) before it
  evaluates or revises anything itself, in Cowork as in Claude Code: the next revision is built on the user's
  review of those examples.
- Feedback arrives differently: with no running server, the viewer's "Submit All Reviews" button downloads
  `feedback.json` as a file. Claude reads it from there (it may need to request access first).
- Packaging works: `package_skill.ts` needs only Node and a filesystem.
- Description optimization (`run_loop.ts` / `run_eval.ts`) works in Cowork, since it uses `claude -p` through a
  subprocess, not a browser. Claude holds it until the skill is finished and the user agrees it is in good shape.
- **Updating an existing skill**: Claude follows the update guidance in the Claude.ai section above.
